const express = require("express");
const fs = require("fs");
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.RIOT_API_KEY;

// ✅ List up to 8 PUUIDs here
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

const REGION = "americas";
const LEAGUE_REGION = "na1";
const SEASON_START = new Date("2025-01-09T00:00:00Z").getTime();
const CACHE_FILE = "cache.json";

// ✅ Load persistent cache from disk
let cache = {};
if (fs.existsSync(CACHE_FILE)) {
  try {
    cache = JSON.parse(fs.readFileSync(CACHE_FILE));
    console.log("💾 Cache loaded from disk");
  } catch (err) {
    console.warn("⚠️ Failed to load cache, starting fresh");
    cache = {};
  }
}

// ✅ Save cache to disk
function saveCache() {
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
}

app.use(express.static("public"));

async function getAllMatchIds(puuid) {
  let allMatchIds = [];
  let start = 0;
  const MAX_MATCHES = 1000;

  while (true) {
    const url = `https://${REGION}.api.riotgames.com/lol/match/v5/matches/by-puuid/${puuid}/ids?start=${start}&count=100`;
    const res = await fetch(url, {
      headers: { "X-Riot-Token": API_KEY },
    });

    if (!res.ok) {
      const errorText = await res.text();
      console.error("❌ Error fetching match IDs:", res.status, errorText);
      break;
    }

    const matchIds = await res.json();
    if (matchIds.length === 0) break;

    allMatchIds.push(...matchIds);
    start += 100;

    if (start >= MAX_MATCHES) break;
  }

  return allMatchIds;
}

async function getSummonerStats(puuid) {
  const now = Date.now();

  // 🧠 Check cache
  if (!cache[puuid]) {
    cache[puuid] = {
      timestamp: now,
      matchIds: [],
      wins: 0,
      gamesPlayed: 0,
      champCounts: {},
      rank: "Unranked"
    };
  }

  const previous = cache[puuid];
  const allMatchIds = await getAllMatchIds(puuid);
  const newMatchIds = allMatchIds.filter(id => !previous.matchIds.includes(id));

  if (newMatchIds.length === 0) {
    console.log(`🧠 No new matches for ${puuid}, using cached stats.`);
    return buildStats(previous);
  }

  console.log(`🔄 Found ${newMatchIds.length} new matches for ${puuid}`);

  for (const matchId of newMatchIds) {
    const matchUrl = `https://${REGION}.api.riotgames.com/lol/match/v5/matches/${matchId}`;
    const matchRes = await fetch(matchUrl, {
      headers: { "X-Riot-Token": API_KEY },
    });

    if (!matchRes.ok) continue;

    const match = await matchRes.json();
    const info = match.info;

    if (!info || ![420, 440].includes(info.queueId)) continue;
    if (info.gameCreation < SEASON_START || info.gameDuration < 300) continue;

    const player = info.participants.find(p => p.puuid === puuid);
    if (!player) continue;

    previous.gamesPlayed++;
    if (player.win) previous.wins++;

    const champ = player.championName;
    previous.champCounts[champ] = (previous.champCounts[champ] || 0) + 1;
    previous.matchIds.push(matchId);
  }

  // 🏆 Update rank if needed
  try {
    const rankRes = await fetch(`https://${LEAGUE_REGION}.api.riotgames.com/lol/league/v4/entries/by-puuid/${puuid}`, {
      headers: { "X-Riot-Token": API_KEY },
    });
    if (rankRes.ok) {
      const ranks = await rankRes.json();
      const solo = ranks.find(entry => entry.queueType === "RANKED_SOLO_5x5");
      previous.rank = solo ? `${solo.tier} ${solo.rank}` : "Unranked";
    }
  } catch (err) {
    console.warn("⚠️ Failed to fetch rank for", puuid);
  }

  previous.timestamp = now;
  saveCache();
  return buildStats(previous);
}

function buildStats(data) {
  const mostPlayedChampion = Object.entries(data.champCounts)
    .sort((a, b) => b[1] - a[1])[0]?.[0] || "N/A";

  return {
    summonerName: "",
    gamesPlayed: data.gamesPlayed,
    winrate: data.gamesPlayed > 0 ? `${((data.wins / data.gamesPlayed) * 100).toFixed(1)}%` : "N/A",
    mostPlayedChampion,
    rank: data.rank || "Unranked"
  };
}

app.get("/api/players", async (req, res) => {
  console.log("📡 Incoming request to /api/players");

  try {
    const stats = await Promise.all(puuids.map(getSummonerStats));
    console.log("✅ Stats generated:", stats);
    res.json(stats);
  } catch (err) {
    console.error("❌ Backend error:", err);
    res.status(500).send("Server error fetching stats");
  }
});

app.listen(PORT, () => console.log(`🚀 Server running on http://localhost:${PORT}`));