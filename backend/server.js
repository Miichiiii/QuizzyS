// QuizCast Server: Express liefert statisches Frontend, Socket.io macht Spiellogik.
// Kein Build-Step, keine DB, ein Prozess. Laeuft auf jedem billigen VPS / Free-Tier.

const fs = require("fs");
const path = require("path");
const http = require("http");
const express = require("express");
const { Server } = require("socket.io");
const QRCode = require("qrcode");
const { GameRoom } = require("./game/gameRoom");
const { saveGameResult, getHighscores } = require("./db");

const PORT = process.env.PORT || 3000;

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } }); // Receiver laeuft auf Chromecast-Origin

// Statisches Frontend direkt ausliefern
const FRONTEND = path.join(__dirname, "..", "frontend");
app.use(express.json()); // Fuer POST-Requests

app.use("/host", express.static(path.join(FRONTEND, "host")));
app.use("/receiver", express.static(path.join(FRONTEND, "receiver")));
app.use("/player", express.static(path.join(FRONTEND, "player")));
app.use("/editor", express.static(path.join(FRONTEND, "editor")));
app.use("/sounds", express.static(path.join(__dirname, "sounds")));
app.use("/", express.static(path.join(FRONTEND, "landing")));

const { loadQuestions, saveQuestions } = require("./game/questions");

app.get("/api/questions", (req, res) => {
  res.json(loadQuestions());
});

app.post("/api/questions", (req, res) => {
  if (Array.isArray(req.body)) {
    saveQuestions(req.body);
    res.json({ ok: true });
  } else {
    res.status(400).json({ ok: false, error: "Ungültiges Format" });
  }
});

app.get("/api/sounds", (req, res) => {
  try {
    const soundsDir = path.join(__dirname, "sounds");
    const files = fs.readdirSync(soundsDir)
      .filter(file => file.endsWith(".mp3") || file.endsWith(".wav"));
    res.json(files);
  } catch (e) {
    res.status(500).json([]);
  }
});

app.get("/health", (req, res) => res.send("ok"));

// v2: QR-Code-Endpunkt – generiert SVG serverseitig, kein externer API-Dienst.
// Aufruf: GET /api/qr?url=<urlencoded>
app.get("/api/qr", async (req, res) => {
  const url = req.query.url;
  if (!url || typeof url !== "string" || url.length > 512) {
    return res.status(400).send("url-Parameter fehlt oder zu lang.");
  }
  try {
    const svg = await QRCode.toString(url, { type: "svg", margin: 1, color: { dark: "#fcfcfc", light: "#1a1a35" } });
    res.setHeader("Content-Type", "image/svg+xml");
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.send(svg);
  } catch (e) {
    res.status(500).send("QR-Generierung fehlgeschlagen.");
  }
});

// v2: Highscore-Endpunkt – Top-10 aus JSON-Datei.
app.get("/api/highscores", (req, res) => {
  try {
    const rows = getHighscores(10);
    res.json(rows);
  } catch (e) {
    res.status(500).json([]);
  }
});

// Chromecast App-ID aus Umgebungsvariable (wird in Render Settings gesetzt).
// Solange leer: Cast-Button zeigt Fallback-URL, nichts crasht.
app.get("/api/config", (req, res) => {
  res.json({ castAppId: process.env.CAST_APP_ID || "" });
});

// ── Room-Management (in-memory) ─────────────────────────
const rooms = new Map(); // code -> GameRoom
const socketRoom = new Map(); // socketId -> code (fuer Disconnect-Cleanup)

function makeCode() {
  // 6-stellig, ohne verwechselbare Zeichen. Kollision? Nochmal wuerfeln.
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code;
  do {
    code = "";
    for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  } while (rooms.has(code));
  return code;
}

io.on("connection", (socket) => {

  // Host erstellt Spiel
  socket.on("create_game", (payload, cb) => {
    const code = makeCode();
    const room = new GameRoom(code, io);
    room.setHost(socket.id);
    // v2: Highscore nach Spielende in DB schreiben.
    room.onFinish = (players, winner) => {
      try { saveGameResult(players, winner); } catch (e) { /* DB-Fehler darf Spiel nicht crashen */ }
    };
    rooms.set(code, room);
    socket.join(code);
    socketRoom.set(socket.id, code);
    if (cb) cb({ ok: true, code });
  });

  // Spieler joint
  socket.on("join_game", (payload, cb) => {
    const room = rooms.get((payload?.code || "").toUpperCase());
    if (!room) return cb && cb({ ok: false, error: "Raum nicht gefunden." });
    const result = room.addPlayer(socket.id, payload?.name);
    if (result.ok) {
      socket.join(room.code);
      socketRoom.set(socket.id, room.code);
    }
    if (cb) cb(result);
  });

  // TV/Receiver joint als reiner Zuschauer
  socket.on("join_as_spectator", (payload, cb) => {
    const room = rooms.get((payload?.code || "").toUpperCase());
    if (!room) return cb && cb({ ok: false, error: "Raum nicht gefunden." });
    socket.join(room.code);
    socketRoom.set(socket.id, room.code);
    room.addSpectator(socket.id);
    if (cb) cb({ ok: true });
  });

  // Host startet
  socket.on("start_game", (payload, cb) => {
    const room = rooms.get((payload?.code || "").toUpperCase());
    if (!room) return cb && cb({ ok: false, error: "Raum nicht gefunden." });
    const result = room.start(socket.id);
    if (cb) cb(result);
  });

  // Blauer Spieler waehlt Kategorie
  socket.on("select_category", (payload, cb) => {
    const room = rooms.get((payload?.code || "").toUpperCase());
    if (!room) return cb && cb({ ok: false, error: "Raum nicht gefunden." });
    const result = room.selectCategory(socket.id, payload?.category);
    if (cb) cb(result);
  });

  // v2: Host kickt Spieler in der Lobby.
  socket.on("kick_player", (payload, cb) => {
    const room = rooms.get((payload?.code || "").toUpperCase());
    if (!room) return cb && cb({ ok: false, error: "Raum nicht gefunden." });
    const result = room.kickPlayer(socket.id, payload?.color);
    if (result.ok) {
      // Gekickten Socket aus dem Socket.io-Room entfernen.
      const kickedSocket = io.sockets.sockets.get(result.kickedSocketId);
      if (kickedSocket) {
        kickedSocket.leave(room.code);
        socketRoom.delete(result.kickedSocketId);
      }
    }
    if (cb) cb(result);
  });

  // Host ändert Spielerlimit in der Lobby.
  socket.on("change_player_limit", (payload, cb) => {
    const room = rooms.get((payload?.code || "").toUpperCase());
    if (!room) return cb && cb({ ok: false, error: "Raum nicht gefunden." });
    const result = room.changePlayerLimit(socket.id, payload?.limit);
    if (cb) cb(result);
  });

  // Spieler antwortet - Server validiert alles
  socket.on("submit_answer", (payload, cb) => {
    const room = rooms.get((payload?.code || "").toUpperCase());
    if (!room) return cb && cb({ ok: false, error: "Raum nicht gefunden." });
    const result = room.submitAnswer(socket.id, payload?.answerIndex);
    if (cb) cb(result);
  });

  // Host ändert Lautstärke.
  socket.on("change_volume", (payload, cb) => {
    const room = rooms.get((payload?.code || "").toUpperCase());
    if (!room) return cb && cb({ ok: false, error: "Raum nicht gefunden." });
    room.musicVolume = payload.volume;
    room.broadcast("volume_changed", { volume: payload.volume });
    if (cb) cb({ ok: true });
  });

  // Host ändert Geschwindigkeit.
  socket.on("change_speed", (payload, cb) => {
    const room = rooms.get((payload?.code || "").toUpperCase());
    if (!room) return cb && cb({ ok: false, error: "Raum nicht gefunden." });
    room.musicSpeed = payload.speed;
    room.broadcast("speed_changed", { speed: payload.speed });
    if (cb) cb({ ok: true });
  });

  socket.on("disconnect", () => {
    const code = socketRoom.get(socket.id);
    socketRoom.delete(socket.id);
    if (!code) return;
    const room = rooms.get(code);
    if (!room) return;

    // Spectator weg? Egal, Spiel laeuft weiter.
    if (room.spectators.has(socket.id)) {
      room.spectators.delete(socket.id);
      return;
    }
    // Nach GAME_FINISHED lassen wir den Raum noch kurz leben.
    if (room.finished) return;

    // Host weg -> Raum stirbt sofort (Spec).
    if (socket.id === room.hostSocketId) {
      room.destroy("Host hat die Verbindung getrennt.");
      rooms.delete(code);
      return;
    }
    // Spieler weg -> v2: 60s Reconnect-Fenster, kein sofortiger Kill.
    room.playerDisconnected(socket.id);
  });

  // v2: Spieler kehrt nach Disconnect zurueck.
  socket.on("reconnect_player", (payload, cb) => {
    const room = rooms.get((payload?.code || "").toUpperCase());
    if (!room) return cb && cb({ ok: false, error: "Raum nicht gefunden." });
    const result = room.reconnectPlayer(socket.id, payload?.color, payload?.name);
    if (result.ok) {
      socket.join(room.code);
      socketRoom.set(socket.id, room.code);
    }
    if (cb) cb(result);
  });
});

// Fertige Raeume nach 10 Minuten wegwerfen, damit der RAM nicht vollmuellt.
setInterval(() => {
  for (const [code, room] of rooms) {
    if (room.finished && Date.now() - room.questionStartedAt > 10 * 60 * 1000) {
      rooms.delete(code);
    }
  }
}, 60 * 1000);

server.listen(PORT, () => console.log(`QuizCast läuft auf http://localhost:${PORT}`));

module.exports = { server, io };
