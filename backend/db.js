// v2: SQLite-Persistenz fuer Highscores.
// Nur Endergebnisse werden geschrieben; Spiellogik bleibt komplett in-memory.
// Datenbank liegt neben server.js in backend/quizcast.db.

const path = require("path");
const Database = require("better-sqlite3");

const DB_PATH = path.join(__dirname, "quizcast.db");
const db = new Database(DB_PATH);

// Schema einmalig anlegen (idempotent).
db.exec(`
  CREATE TABLE IF NOT EXISTS highscores (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    name      TEXT    NOT NULL,
    score     INTEGER NOT NULL,
    is_winner INTEGER NOT NULL DEFAULT 0,
    played_at INTEGER NOT NULL
  );
`);

const insertScore = db.prepare(
  "INSERT INTO highscores (name, score, is_winner, played_at) VALUES (?, ?, ?, ?)"
);

// Schreibt Endergebnisse eines Spiels in einem Transaction-Block.
function saveGameResult(players, winnerColor) {
  const now = Date.now();
  const save = db.transaction(() => {
    for (const p of players) {
      insertScore.run(p.name, p.score, p.color === winnerColor ? 1 : 0, now);
    }
  });
  save();
}

// Liefert die Top-N Eintraege nach Score.
function getHighscores(limit = 10) {
  return db.prepare(
    "SELECT name, score, is_winner, played_at FROM highscores ORDER BY score DESC, played_at DESC LIMIT ?"
  ).all(limit);
}

module.exports = { saveGameResult, getHighscores };
