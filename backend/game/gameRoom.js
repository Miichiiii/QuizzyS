// GameRoom: State Machine pro Spiel-Raum. In-Memory, kein DB-Zwang (Spec).
// Server ist Single Source of Truth. Alle Timer laufen HIER, nie im Client.
//
// States: LOBBY -> WAITING_FOR_PLAYERS -> CATEGORY_SELECT -> QUESTION_ACTIVE
//         -> ANSWER_LOCKED -> SHOW_RESULT -> SCOREBOARD -> (naechste Frage | GAME_FINISHED)
//
// v2: Reconnect – Spieler-Disconnect pausiert Raum 60s, kein sofortiger Kill.

const { getCategories, getQuestionsForCategory } = require("./questions");
const { Streamer } = require("../streamer");
const os = require('os');
const PORT = parseInt(process.env.PORT || "3000", 10);
// Standardmäßig 0 für Zero-Latency (Web-Receiver/Tab-Cast).
// Für echtes HLS per App auf 6000 setzen (z.B. per Env-Variable STREAM_DELAY=6000)
const STREAM_DELAY = parseInt(process.env.STREAM_DELAY || "0", 10);

function getJoinUrl(origin) {
  if (origin) return origin + "/player";
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        return `http://${net.address}:${PORT}/player`;
      }
    }
  }
  return `http://localhost:${PORT}/player`;
}

// Delays konfigurierbar, damit der Smoke-Test nicht 30s wartet. Kostet nichts, hilft viel.
const SHOW_RESULT_MS = parseInt(process.env.SHOW_RESULT_MS || "3000", 10);
const SCOREBOARD_MS = parseInt(process.env.SCOREBOARD_MS || "3000", 10);
const RECONNECT_TIMEOUT_MS = parseInt(process.env.RECONNECT_TIMEOUT_MS || "60000", 10);
const QUESTIONS_PER_GAME = 5;

const AVATARS = ['🦖', '👻', '👾', '🤖', '🍄', '⭐', '🦊', '🐙', '🐵', '🐸'];
const COLORS = ["blau", "rot", "gruen", "gelb", "orange", "pink", "violett", "cyan", "braun", "weiss"];

class GameRoom {
  constructor(code, io, origin) {
    this.origin = origin;
    this.code = code;
    this.io = io; // socket.io Server-Instanz
    this.state = "LOBBY";
    this.streamer = new Streamer(code);
    this.streamer.start();
    this.hostSocketId = null;
    this.players = []; // { socketId, name, color, score }
    this.spectators = new Set(); // Socket-IDs (TV/Receiver). Senden NIE Daten zurueck.
    this.questions = [];
    this.currentIndex = -1;
    this.answers = {}; // socketId -> { index, ms } pro Frage
    this.questionStartedAt = 0;
    this.tickInterval = null;
    this.pendingTimeout = null;
    this.finished = false;
    this.maxPlayers = 2; // Standard: 2 Spieler, Host kann auf bis zu 10 erhoehen
    this.musicVolume = 0.5;
    this.musicSpeed = 1.0;
    // v2 Reconnect: color -> { name, score, answerThisRound, reconnectTimer }
    this.disconnectedPlayers = new Map();
  }

  // Alle im Raum (Host + Player + Spectators) benachrichtigen
  broadcast(event, data) {
    this.io.to(this.code).emit(event, data);
  }

  broadcastTv(event, data) {
    this.spectators.forEach(s => this.io.to(s).emit(event, data));
  }

  setHost(socketId) {
    this.hostSocketId = socketId;
    this.state = "WAITING_FOR_PLAYERS";
    this.streamer.showLobby(getJoinUrl(this.origin), this.players.length);
  }

  addPlayer(socketId, name) {
    if (this.state !== "WAITING_FOR_PLAYERS") return { ok: false, error: "Spiel läuft bereits oder existiert nicht." };
    if (this.players.length >= this.maxPlayers) return { ok: false, error: `Raum ist voll (max. ${this.maxPlayers} Spieler).` };
    const color = COLORS[this.players.length];
    const player = { socketId, name: String(name || "Spieler").slice(0, 20), color, score: 0 };
    this.players.push(player);
    // Getrennte Events (Spec-Warnung): player_joined NUR fuer Lobby-Update.
    this.broadcast("player_joined", { players: this.publicPlayers(), maxPlayers: this.maxPlayers });
    return { ok: true, color, code: this.code };
  }

  addSpectator(socketId) {
    this.spectators.add(socketId);
    // Spectator bekommt den aktuellen Lobby-Stand sofort, egal wann er joint.
    this.io.to(socketId).emit("player_joined", { players: this.publicPlayers(), maxPlayers: this.maxPlayers });
    this.io.to(socketId).emit("tv_state", this._tvSnapshot());
    // Audio initialisieren
    this.io.to(socketId).emit("init_audio_settings", { volume: this.musicVolume, speed: this.musicSpeed });
  }

  // v2: Host kickt Spieler aus der Lobby.
  kickPlayer(hostSocketId, color) {
    if (hostSocketId !== this.hostSocketId) return { ok: false, error: "Nur der Host darf kicken." };
    if (this.state !== "WAITING_FOR_PLAYERS") return { ok: false, error: "Kick nur in der Lobby moeglich." };
    const idx = this.players.findIndex(p => p.color === color);
    if (idx === -1) return { ok: false, error: "Spieler nicht gefunden." };
    const kicked = this.players[idx];
    this.players.splice(idx, 1);
    // Farben neu vergeben, damit der naechste Spieler den freien Slot bekommt.
    this.players.forEach((p, i) => { p.color = COLORS[i]; });
    // Dem gekickten Spieler direkt Bescheid geben.
    this.io.to(kicked.socketId).emit("kicked", { reason: "Du wurdest vom Host aus dem Spiel entfernt." });
    this.broadcast("player_joined", { players: this.publicPlayers(), maxPlayers: this.maxPlayers });
    return { ok: true, kickedSocketId: kicked.socketId };
  }

  changePlayerLimit(hostSocketId, limit) {
    if (hostSocketId !== this.hostSocketId) return { ok: false, error: "Nur der Host darf das Spielerlimit ändern." };
    if (this.state !== "WAITING_FOR_PLAYERS") return { ok: false, error: "Spielerlimit kann nur in der Lobby geändert werden." };
    const newLimit = parseInt(limit, 10);
    if (isNaN(newLimit) || newLimit < 2 || newLimit > 10) {
      return { ok: false, error: "Spielerlimit muss zwischen 2 und 10 liegen." };
    }
    if (newLimit < this.players.length) {
      return { ok: false, error: "Spielerlimit kann nicht kleiner als die aktuelle Spielerzahl sein." };
    }
    this.maxPlayers = newLimit;
    this.broadcast("player_joined", { players: this.publicPlayers(), maxPlayers: this.maxPlayers });
    return { ok: true, maxPlayers: this.maxPlayers };
  }

  // v2: Spieler hat Verbindung verloren – Slot 60s offen halten.
  playerDisconnected(socketId) {
    const player = this.players.find(p => p.socketId === socketId);
    if (!player) return;
    // Slot haengen lassen (socketId bleibt), aber als offline markieren.
    const answer = this.answers[socketId] || null;
    const timer = setTimeout(() => {
      // Zeit abgelaufen, kein Reconnect – Raum zerstoeren.
      this.disconnectedPlayers.delete(player.color);
      this.destroy("Spieler hat sich nicht rechtzeitig wieder verbunden.");
    }, RECONNECT_TIMEOUT_MS);
    this.disconnectedPlayers.set(player.color, {
      name: player.name,
      score: player.score,
      answerThisRound: answer,
      reconnectTimer: timer
    });
    this.broadcast("player_disconnected", { color: player.color });
  }

  // v2: Spieler kehrt zurueck. Gibt { ok, color } oder { ok: false, error } zurueck.
  reconnectPlayer(newSocketId, color, name) {
    if (this.finished) return { ok: false, error: "Spiel bereits beendet." };
    const entry = this.disconnectedPlayers.get(color);
    if (!entry) return { ok: false, error: "Kein offener Reconnect-Slot fuer diese Farbe." };
    // Timer stoppen, Slot wieder aktivieren.
    clearTimeout(entry.reconnectTimer);
    this.disconnectedPlayers.delete(color);
    const player = this.players.find(p => p.color === color);
    if (!player) return { ok: false, error: "Interner Fehler: Spieler-Slot fehlt." };
    player.socketId = newSocketId;
    // Falls Antwort fuer diese Runde schon da war, wiederherstellen.
    if (entry.answerThisRound) {
      this.answers[newSocketId] = entry.answerThisRound;
      // Alte socketId-Schluesselbindung entfernen (war aber schon verloren).
    }
    this.broadcast("player_joined", { players: this.publicPlayers(), maxPlayers: this.maxPlayers });
    // Reconnected Spieler bekommt aktuellen State-Snapshot.
    const snap = this._stateSnapshot();
    this.io.to(newSocketId).emit("reconnect_ok", snap);
    return { ok: true, color };
  }

  // Liefert einen Snapshot des aktuellen Spielstands fuer den reconnecteten Spieler.
  _stateSnapshot() {
    const base = { state: this.state, players: this.publicPlayers(), maxPlayers: this.maxPlayers };
    if (this.state === "CATEGORY_SELECT") return { ...base, view: 'CATEGORY', chooserName: this.players[0].name };
    if (this.state === "QUESTION_ACTIVE" || this.state === "ANSWER_LOCKED") {
      const q = this.questions[this.currentIndex];
      const elapsed = Math.floor((Date.now() - this.questionStartedAt) / 1000);
      const remaining = Math.max(0, q.timeLimit - elapsed);
      return {
        ...base,
        question: {
          index: this.currentIndex + 1,
          total: this.questions.length,
          category: q.category,
          question: q.question,
          answers: q.answers,
          timeLimit: q.timeLimit,
          remaining
        }
      };
    }
    return base;
  }

  _tvSnapshot() {
    const base = { view: this.state === "LOBBY" || this.state === "WAITING_FOR_PLAYERS" ? "LOBBY" : (this.state === "CATEGORY_SELECT" ? "CATEGORY" : this.state), joinUrl: getJoinUrl(this.origin), playerCount: this.players.length };
    if (this.state === "QUESTION_ACTIVE" || this.state === "ANSWER_LOCKED") {
      const q = this.questions[this.currentIndex];
      return { ...base, view: 'QUESTION', question: { question: q.question, answers: q.answers }, 
               endsAt: this.questionStartedAt + (q.timeLimit * 1000), 
               playerCount: this.players.length, answerCount: Object.keys(this.answers).length };
    }
    if (this.state === "SHOW_RESULT") {
      const q = this.questions[this.currentIndex];
      return { ...base, view: 'REVEAL', question: { question: q.question, answers: q.answers },
               correctIndex: q.correctIndex, answerCount: Object.keys(this.answers).length, playerCount: this.players.length };
    }
    if (this.state === "SCOREBOARD" || this.state === "GAME_FINISHED") {
      return { ...base, view: 'FINISHED', ranking: this.publicPlayers().sort((a,b)=>b.score - a.score) };
    }
    return { ...base, view: 'LOBBY' };
  }

  publicPlayers() {
    return this.players.map(p => ({ name: p.name, color: p.color, score: p.score }));
  }

  // Host drueckt Start. Getrenntes Event game_starting (Spec-Warnung: NICHT game_ready doppelt nutzen).
  start(socketId) {
    if (socketId !== this.hostSocketId) return { ok: false, error: "Nur der Host darf starten." };
    if (this.players.length < 2) return { ok: false, error: "Es müssen mindestens 2 Spieler im Raum sein." };
    if (this.players.length !== this.maxPlayers) return { ok: false, error: `Es müssen genau ${this.maxPlayers} Spieler im Raum sein.` };
    if (this.state !== "WAITING_FOR_PLAYERS") return { ok: false, error: "Spiel wurde bereits gestartet." };
    this.state = "CATEGORY_SELECT";
    this.broadcast("game_starting", { players: this.publicPlayers() });
    // Blauer Spieler (Spieler 1) waehlt die Kategorie.
    this.streamer.showCategorySelect(this.players[0].name);
    this.broadcastTv("tv_category_select", { chooserName: this.players[0].name });
    this.broadcast("category_select", {
      chooserColor: "blau",
      chooserName: this.players[0].name,
      categories: getCategories()
    });
    return { ok: true };
  }

  selectCategory(socketId, category) {
    if (this.state !== "CATEGORY_SELECT") return { ok: false, error: "Keine Kategoriewahl aktiv." };
    if (socketId !== this.players[0].socketId) return { ok: false, error: "Nur der blaue Spieler wählt die Kategorie." };
    const pool = getQuestionsForCategory(category);
    if (pool.length === 0) return { ok: false, error: "Unbekannte Kategorie." };
    // Einfaches Mischen reicht (caveman shuffle)
    this.questions = pool.slice().sort(() => Math.random() - 0.5).slice(0, QUESTIONS_PER_GAME);
    this.nextQuestion();
    return { ok: true };
  }

  nextQuestion() {
    this.currentIndex++;
    if (this.currentIndex >= this.questions.length) {
      this.finish();
      return;
    }
    const q = this.questions[this.currentIndex];
    this.answers = {};
    this.state = "QUESTION_ACTIVE";
    this.questionStartedAt = Date.now() + STREAM_DELAY;

    this.streamer.showQuestion(q, q.timeLimit, 0, this.players.length);
    this.broadcastTv("tv_question", {
      question: { question: q.question, answers: q.answers },
      endsAt: Date.now() + STREAM_DELAY + (q.timeLimit * 1000),
      playerCount: this.players.length
    });

    this.clearTimers();
    this.pendingTimeout = setTimeout(() => {
      this.broadcast("next_question", {
        index: this.currentIndex + 1,
        total: this.questions.length,
        category: q.category,
        question: q.question,
        answers: q.answers,
        timeLimit: q.timeLimit
      });

      let remaining = q.timeLimit;
      this.broadcast("timer_tick", { remaining });
      this.broadcastTv("tv_timer", { remaining });
      this.streamer.updateCountdown(remaining);
      
      this.tickInterval = setInterval(() => {
        remaining--;
        this.broadcast("timer_tick", { remaining });
        this.broadcastTv("tv_timer", { remaining });
        this.streamer.updateCountdown(remaining);
        if (remaining <= 0) this.lockAndReveal();
      }, 1000);
    }, STREAM_DELAY);
    
    if (this._timers) {
      this._timers.forEach(t => clearTimeout(t));
    } else {
      this._timers = [];
    }
    this._timers.push(this.pendingTimeout);
  }

  submitAnswer(socketId, answerIndex) {
    if (this.state !== "QUESTION_ACTIVE") return { ok: false, error: "Gerade keine aktive Frage." };
    const player = this.players.find(p => p.socketId === socketId);
    if (!player) return { ok: false, error: "Du bist kein Spieler in diesem Raum." };
    if (this.answers[socketId]) return { ok: false, error: "Antwort bereits abgegeben." };

    const idx = parseInt(answerIndex, 10);
    if (isNaN(idx) || idx < 0 || idx > 3) return { ok: false, error: "Ungültige Antwort." };

    this.answers[socketId] = { index: idx, ms: Date.now() - this.questionStartedAt };
    this.streamer.updateAnswerCount(Object.keys(this.answers).length, this.players.length);
    this.broadcastTv("tv_answers", { answerCount: Object.keys(this.answers).length, playerCount: this.players.length });
    // lock_answer: TV zeigt "Blau hat geantwortet", Gegner sieht "Warte auf Gegner".
    // KEINE Info, WAS geantwortet wurde, und keine Scores waehrend aktiver Frage.
    this.broadcast("lock_answer", { color: player.color });

    // Beide fertig? Sofortiger Reveal statt auf Timer warten (Spec).
    if (Object.keys(this.answers).length === this.players.length) this.lockAndReveal();
    return { ok: true };
  }

  lockAndReveal() {
    if (this.state !== "QUESTION_ACTIVE") return;
    this.state = "ANSWER_LOCKED";
    this.clearTimers();

    const q = this.questions[this.currentIndex];

    // Serverseitige Validierung + Scoring: +100 richtig, +50 schnellster Richtiger.
    const correctOnes = [];
    const results = {};
    for (const p of this.players) {
      const a = this.answers[p.socketId];
      const answered = !!a;
      const correct = answered && a.index === q.correctIndex;
      if (correct) {
        p.score += 100;
        correctOnes.push({ p, ms: a.ms });
      }
      results[p.color] = { name: p.name, answered, answerIndex: answered ? a.index : null, correct, gained: correct ? 100 : 0 };
    }
    if (correctOnes.length > 0) {
      correctOnes.sort((x, y) => x.ms - y.ms);
      correctOnes[0].p.score += 50;
      results[correctOnes[0].p.color].gained += 50;
      results[correctOnes[0].p.color].fastest = true;
    }

    // JETZT (und erst jetzt) verlaesst correctIndex den Server.
    this.state = "SHOW_RESULT";
    
    // TV aktualisieren
    this.streamer.showReveal(q, q.correctIndex, Object.keys(this.answers).length, this.players.length);
    this.broadcastTv("tv_reveal", {
      correctIndex: q.correctIndex,
      answerCount: Object.keys(this.answers).length,
      playerCount: this.players.length
    });
    
    // Handys aktualisieren
    this.broadcast("reveal_answer", { correctIndex: q.correctIndex, results });

    this.pendingTimeout = setTimeout(() => {
      this.state = "SCOREBOARD";
      this.streamer.showFinished(this.publicPlayers().sort((a,b)=>b.score - a.score));
      this.broadcastTv("tv_scoreboard", { ranking: this.publicPlayers().sort((a,b)=>b.score - a.score) });
      this.broadcast("update_score", { players: this.publicPlayers() });
      
      this.pendingTimeout = setTimeout(() => this.nextQuestion(), SCOREBOARD_MS);
      if (this._timers) this._timers.push(this.pendingTimeout);
    }, SHOW_RESULT_MS);
    if (this._timers) this._timers.push(this.pendingTimeout);
  }

  finish() {
    this.state = "GAME_FINISHED";
    this.finished = true;
    this.clearTimers();
    
    let maxScore = -1;
    let winners = [];
    for (const p of this.players) {
      if (p.score > maxScore) {
        maxScore = p.score;
        winners = [p];
      } else if (p.score === maxScore) {
        winners.push(p);
      }
    }
    
    let winner = null; // null = Unentschieden
    if (winners.length === 1 && this.players.length >= 2) {
      winner = winners[0].color;
    }
    
    const finalLog = this.questions.map(q => ({
      category: q.category,
      question: q.question,
      answers: q.answers,
      correctIndex: q.correctIndex
    }));
    
    this.streamer.showFinished(this.publicPlayers().sort((a,b)=>b.score - a.score));
    this.broadcastTv("tv_finished", { ranking: this.publicPlayers().sort((a,b)=>b.score - a.score) });
    this.broadcast("game_finished", { players: this.publicPlayers(), winner, log: finalLog });
    
    // Kill streamer after 10 seconds of scoreboard
    setTimeout(() => { this.streamer.stop(); }, 10000);
    // v2: Optionaler Callback fuer Persistenz (DB-Schreiben in server.js, nicht hier).
    if (typeof this.onFinish === "function") this.onFinish(this.publicPlayers(), winner);
  }

  clearTimers() {
    if (this.tickInterval) { clearInterval(this.tickInterval); this.tickInterval = null; }
    if (this.pendingTimeout) { clearTimeout(this.pendingTimeout); this.pendingTimeout = null; }
    if (this._timers) {
      this._timers.forEach(t => clearTimeout(t));
      this._timers = [];
    }
  }

  // Raum aufraeumen. Laedt alle laufenden Reconnect-Timer ab.
  destroy(reason) {
    this.clearTimers();
    for (const entry of this.disconnectedPlayers.values()) {
      clearTimeout(entry.reconnectTimer);
    }
    this.disconnectedPlayers.clear();
    this.streamer.stop();
    this.broadcast("game_aborted", { reason });
  }
}

module.exports = { GameRoom };
