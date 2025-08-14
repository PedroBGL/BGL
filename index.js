const express = require("express");
const fs = require("fs");
const fetch = (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));
require("dotenv").config();

const app = express();

// ---- Config ----
const PORT = process.env.PORT || 3000; // fallback for local dev; Render sets PORT
const API_KEY = process.env.RIOT_API_KEY;

const REGION = "americas";     // match-v5 router region
const LEAGUE_REGION = "na1";   // league-v4 region/platform (na1/euw1/kr/etc.)
const SEASON_START = new Date("2025-07-09T00:00:00Z").getTime();
const CACHE_FILE = "cache.json";

// How many pages of match IDs to try (each page = 100)
const MAX_PAGES = 20;

// ====== Your PUUIDs (keep) ======
const puuids = [
  "Yd31laKpHbFE7Hwjh1tHyrNVzYwaCj_vKZWNFFLGKj3RnvGO7CZuJaDFndOKfeNLKjKQUTO59YP5EA",
  "GjTtoWxns42nUfeqYSBftixDwj6ht9CPqoBksR0VB9sUHiH4JXCjhf1Xeq_Cvv6X427zPtfKjOT8rw",
  "b-FT89rX9vC0YS9nIvPaFHukttLmEK_rytKRJmZ5MMtBr0lDJ7wcpNPhAnZL-b14libQXuaxxOY80g",
  "ElKIhMvxt51I2Ko_MZcNXvqz4DLIXfXm-m6l1i61VSAJxq1kxs9yttVddsyxbPEx-NfDgE3tyjYsYw",
  "RRT4-anZRvG23G4X5OXdAKZb1WPtpHHuixw1PKc_sYs1QPP9FQ3swagTSOeXVPXhg3PDNa6Tx3zmfQ",
  "YVOQWMOpmS4aj2CqiobzWNGBcMLWJhnIC_-BGEVK5yPGc_abJmmERmaB4cHSpLM49X_TDpMxyzn0gA",
  "6ckB0ilRl8Wh9h0RJbqJo4Tkljarg4OIZszCOBMOXBIUblzKySlFZWF23i6k-Hu3wuAAq4Hdsb4JTA",
  "DIG6vOz6kJvN29vRLnirmUg01Ji9P-Km_7dltrgjB8ugTx_3AKfaab2WZEuuebKgLyI8h8Kjd-Kibg"
];

// ====== Persistent cache ======
let cache = {};
if (fs.existsSync(CACHE_FILE)) {
  try {
    cache = JSON.parse(fs.readFileSync(CACHE_FILE));
    console.log("💾 Cache loaded from disk");
  } catch {
    console.warn("⚠️ Failed to load cache, starting fresh");
    cache = {};
  }
}
function saveCache() {
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
}

// Serve frontend
app.use(express.static("public"));

// ====== Helpers ======
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchWithRateLimit(url, options = {}, attempt = 1) {
  const res = await fetch(url, {
    ...options,
    headers: {
      ...(options.headers || {}),
      "X-Riot-Token": API_KEY,
    },
  });

  if (res.status === 429 || res.status === 503) {
    const retryAfter = Number(res.headers.get("Retry-After"));
    const waitMs = retryAfter ? retryAfter * 1000 : Math.min(3000 * attempt, 15000);
    console.warn(`⏳ Rate limit ${res.status}. Backing off ${waitMs}ms [attempt ${attempt}]`);
    await sleep(waitMs);
    return fetchWithRateLimit(url, options, attempt + 1);
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status} ${text || res.statusText}`);
  }

  try {
    return await res.json();
  } catch {
    return null;
  }
}

// Fetch only new match IDs; stop when a page yields no new IDs
async function getAllMatchIdsIncremental(puuid, knownIdsSet) {
  const allNew = [];
  let start = 0;

  for (let page = 0; page < MAX_PAGES; page++) {
    const url = `https://${REGION}.api.riotgames.com/lol/match/v5/matches/by-puuid/${puuid}/ids?start=${start}&count=100`;
    let ids;
    try {
      ids = await fetchWithRateLimit(url);
    } catch (e) {
      console.error("❌ Error fetching match IDs:", e.message);
      break;
    }

    if (!ids || ids.length === 0) break;

    // Filter to truly new IDs
    const newThisPage = ids.filter((id) => !knownIdsSet.has(id));

    // If nothing new in this entire page, older pages likely all known → stop early
    if (newThisPage.length === 0) break;

    allNew.push(...newThisPage);

    if (ids.length < 100) break; // last page anyway
    start += 100;

    // polite delay
    await sleep(150);
  }

  return allNew;
}

async function getRankByPuuid(puuid) {
  try {
    const url = `https://${LEAGUE_REGION}.api.riotgames.com/lol/league/v4/entries/by-puuid/${puuid}`;
    const entries = await fetchWithRateLimit(url);
    const solo = Array.isArray(entries)
      ? entries.find((e) => e.queueType === "RANKED_SOLO_5x5")
      : null;
    if (solo) return `${solo.tier} ${solo.rank} (${solo.leaguePoints} LP)`;
  } catch (e) {
    console.warn(`⚠️ Rank fetch failed for ${puuid}: ${e.message}`);
  }
  return "Unranked";
}

// ====== Core ======
async function getSummonerStats(puuid) {
  const now = Date.now();

  if (!cache[puuid]) {
    cache[puuid] = {
      timestamp: now,
      matchIds: [],
      wins: 0,
      gamesPlayed: 0,
      champCounts: {},
      rank: "Unranked",
    };
  }

  const c = cache[puuid];
  const known = new Set(c.matchIds);

  // 1) Only fetch new IDs
  const newIds = await getAllMatchIdsIncremental(puuid, known);
  if (newIds.length === 0) {
    console.log(`🧠 No new matches for ${puuid}, using cached stats.`);
    return buildStats(c);
  }

  console.log(`🔄 Found ${newIds.length} new matches for ${puuid}`);

  // 2) Process matches one-by-one (low pressure) and ALWAYS record the ID so we never refetch it again
  for (const matchId of newIds) {
    const matchUrl = `https://${REGION}.api.riotgames.com/lol/match/v5/matches/${matchId}`;

    try {
      const match = await fetchWithRateLimit(matchUrl);
      const info = match?.info;
      if (!info) {
        c.matchIds.push(matchId);
        continue;
      }

      const isRanked = [420].includes(info.queueId);
      const isInSeason = info.gameCreation >= SEASON_START;
      const isNotRemake = info.gameDuration >= 300;

      // Record the ID regardless so we won't refetch it next time
      c.matchIds.push(matchId);

      if (!isRanked || !isInSeason || !isNotRemake) {
        // skip counting but keep the id in cache
        await sleep(120);
        continue;
      }

      const player = info.participants?.find((p) => p.puuid === puuid);
      if (!player) {
        await sleep(120);
        continue;
      }

      c.gamesPlayed++;
      if (player.win) c.wins++;

      const champ = player.championName || "Unknown";
      c.champCounts[champ] = (c.champCounts[champ] || 0) + 1;

      await sleep(120);
    } catch (e) {
      console.warn(`⚠️ Match ${matchId} failed: ${e.message}`);
      // still mark it to avoid hammering this same ID repeatedly
      c.matchIds.push(matchId);
      await sleep(150);
    }
  }

  // 3) Refresh rank (light)
  c.rank = await getRankByPuuid(puuid);

  c.timestamp = now;
  saveCache();

  return buildStats(c);
}

function buildStats(c) {
  const mostPlayedChampion =
    Object.entries(c.champCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || "N/A";

  return {
    summonerName: "",
    gamesPlayed: c.gamesPlayed,
    winrate: c.gamesPlayed > 0 ? `${((c.wins / c.gamesPlayed) * 100).toFixed(1)}%` : "N/A",
    mostPlayedChampion,
    rank: c.rank || "Unranked",
  };
}

// ====== Route (sequential per request to stay within limits) ======
app.get("/api/players", async (req, res) => {
  console.log("📡 Incoming request to /api/players");
  try {
    const results = [];
    for (const puuid of puuids) {
      const stats = await getSummonerStats(puuid);
      results.push(stats);
      await sleep(200); // small gap between players
    }
    console.log("✅ Stats generated:", results);
    res.json(results);
  } catch (err) {
    console.error("❌ Backend error:", err);
    res.status(500).send("Server error fetching stats");
  }
});

app.listen(PORT, () => console.log(`🚀 Server running on http://localhost:${PORT}`));