// v2: Highscore-Persistenz via JSON-Datei.
// Kein nativer Compiler nötig – funktioniert auf jedem OS (Windows, Linux, Mac).
// Gleiche öffentliche API wie die frühere SQLite-Version.

const fs = require("fs");
const path = require("path");

const DB_PATH = path.join(__dirname, "highscores.json");
const MAX_ENTRIES = 1000; // Datei nicht unbegrenzt wachsen lassen

function _load() {
  try {
    if (fs.existsSync(DB_PATH)) return JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
  } catch (e) { /* korrupte Datei -> leer starten */ }
  return [];
}

function _save(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data), "utf8");
}

// Schreibt Endergebnisse eines Spiels.
function saveGameResult(players, winnerColor) {
  const data = _load();
  const now = Date.now();
  for (const p of players) {
    data.push({ name: p.name, score: p.score, is_winner: p.color === winnerColor ? 1 : 0, played_at: now });
  }
  _save(data.slice(-MAX_ENTRIES));
}

// Liefert die Top-N Einträge nach Score.
function getHighscores(limit = 10) {
  const data = _load();
  return [...data]
    .sort((a, b) => b.score - a.score || b.played_at - a.played_at)
    .slice(0, limit);
}

module.exports = { saveGameResult, getHighscores };
