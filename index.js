const express = require("express");
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.RIOT_API_KEY;

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
const PLATFORM = "na1";
const SEASON_START = new Date("2025-01-09T00:00:00Z").getTime();
const CACHE_TTL = 5 * 60 * 1000;
const cache = {};

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
  if (cache[puuid] && now - cache[puuid].timestamp < CACHE_TTL) {
    console.log(`🧠 Cache hit for ${puuid}`);
    return cache[puuid].data;
  }

  console.log(`🌐 Fetching fresh data for ${puuid}`);
  let totalGames = 0;
  let wins = 0;
  const champCounts = {};

  const matchIds = await getAllMatchIds(puuid);
  console.log(`📦 Found ${matchIds.length} matches for puuid: ${puuid}`);

  for (const matchId of matchIds) {
    const matchUrl = `https://${REGION}.api.riotgames.com/lol/match/v5/matches/${matchId}`;
    const matchRes = await fetch(matchUrl, {
      headers: { "X-Riot-Token": API_KEY },
    });

    if (!matchRes.ok) {
      const err = await matchRes.text();
      console.warn(`⚠️ Match ${matchId} failed: ${matchRes.status} ${err}`);
      continue;
    }

    const match = await matchRes.json();
    const info = match.info;

    if (!info || ![420, 440].includes(info.queueId)) continue;
    if (info.gameCreation < SEASON_START || info.gameDuration < 300) continue;

    const player = info.participants.find(p => p.puuid === puuid);
    if (!player) continue;

    totalGames++;
    if (player.win) wins++;

    const champ = player.championName;
    champCounts[champ] = (champCounts[champ] || 0) + 1;
  }

  const mostPlayedChampion = Object.entries(champCounts)
    .sort((a, b) => b[1] - a[1])[0]?.[0] || "N/A";

  // ✅ Fetch rank directly via PUUID
  let rank = "Unranked";
  const rankUrl = `https://${PLATFORM}.api.riotgames.com/lol/league/v4/entries/by-puuid/${puuid}`;
  const rankRes = await fetch(rankUrl, {
    headers: { "X-Riot-Token": API_KEY },
  });

  if (rankRes.ok) {
    const rankData = await rankRes.json();
    console.log(`🎖️ Rank data for PUUID ${puuid}:`, rankData);
    const solo = rankData.find(entry => entry.queueType === "RANKED_SOLO_5x5");
    if (solo) {
      rank = `${solo.tier} ${solo.rank} (${solo.leaguePoints} LP)`;
    }
  } else {
    const errorText = await rankRes.text();
    console.warn(`⚠️ Failed to fetch rank for ${puuid}: ${rankRes.status} ${errorText}`);
  }

  const result = {
    gamesPlayed: totalGames,
    winrate: totalGames > 0 ? `${((wins / totalGames) * 100).toFixed(1)}%` : "N/A",
    mostPlayedChampion,
    rank,
  };

  cache[puuid] = {
    timestamp: now,
    data: result,
  };

  return result;
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