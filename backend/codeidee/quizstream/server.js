// server.js — QuizStream MVP
// Second-Screen-Quiz: TV bekommt einen echten HLS-Video-Stream (FFmpeg),
// Handys antworten per Socket.io. Der Server ist Single Source of Truth
// fuer Timing, Punkte und die richtige Antwort.
//
// SYNC-KONZEPT:
//   t0                : Server startet Frage -> FFmpeg rendert sie sofort ins Video
//   t0 + STREAM_DELAY : Frage erscheint (durch HLS-Latenz) ungefaehr jetzt auf dem TV
//                       -> genau jetzt schickt der Server die Frage an die Handys
//   Antwortfenster    : STREAM_DELAY bis STREAM_DELAY + duration
//   correctAnswer verlaesst den Server NIE vor dem Reveal.

const path = require('path');
const os = require('os');
const fs = require('fs');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const PORT = parseInt(process.env.PORT || '3000', 10);
// Gemessene/angenommene HLS-Latenz in ms. Am TV kalibrierbar (siehe README).
const STREAM_DELAY = parseInt(process.env.STREAM_DELAY || '6000', 10);
const STREAM_DISABLED = process.env.STREAM_DISABLED === '1'; // fuer Tests ohne ffmpeg

const QUESTIONS_FILE = process.env.QUESTIONS_FILE || path.join(__dirname, 'questions.json');
const questions = JSON.parse(fs.readFileSync(QUESTIONS_FILE, 'utf8'));
const streamer = require('./streamer');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// HLS mit CORS ausliefern (Chromecast verlangt CORS-Header)
app.use('/hls', (req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-cache');
  next();
}, express.static(path.join(__dirname, 'public', 'hls')));

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.send('<h1>QuizStream</h1><ul>' +
    '<li><a href="/host.html">Host Dashboard</a></li>' +
    '<li><a href="/mobile.html">Mitspielen (Handy)</a></li>' +
    '<li><a href="/hls/stream.m3u8">HLS Stream (TV)</a></li></ul>');
});

// ---------- Game State ----------
const STATES = { LOBBY: 'LOBBY', QUESTION: 'QUESTION', REVEAL: 'REVEAL', FINISHED: 'FINISHED' };

const game = {
  state: STATES.LOBBY,
  players: new Map(),        // socketId -> { name, score }
  currentIndex: -1,
  answers: new Map(),        // socketId -> { optionIndex, timestamp }
  questionOpensAt: 0,        // Serverzeit, ab der Antworten zaehlen
  questionEndsAt: 0,
  timers: []
};

function clearTimers() {
  game.timers.forEach(t => clearTimeout(t));
  game.timers = [];
}

function lanUrl() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        return 'http://' + net.address + ':' + PORT;
      }
    }
  }
  return 'http://localhost:' + PORT;
}

function publicPlayers() {
  return [...game.players.values()].map(p => ({ name: p.name, score: p.score }));
}

function ranking() {
  return publicPlayers().sort((a, b) => b.score - a.score);
}

function hostState() {
  return {
    state: game.state,
    players: ranking(),
    currentIndex: game.currentIndex,
    totalQuestions: questions.length,
    answerCount: game.answers.size,
    streamUrl: lanUrl() + '/hls/stream.m3u8',
    joinUrl: lanUrl() + '/mobile.html',
    streamDelayMs: STREAM_DELAY
  };
}

function pushHostState() {
  io.to('hosts').emit('host_state', hostState());
}

function tvLobby() {
  if (!STREAM_DISABLED) streamer.showLobby(lanUrl() + '/mobile.html', game.players.size);
}

// Oeffentliche Version einer Frage — OHNE correctAnswer. Sicherheitsregel.
function publicQuestion(q) {
  return { questionId: q.questionId, text: q.text, options: q.options, duration: q.duration };
}

// ---------- Game Flow ----------
function startQuestion(index) {
  const q = questions[index];
  if (!q) return finishQuiz();

  clearTimers();
  game.state = STATES.QUESTION;
  game.currentIndex = index;
  game.answers = new Map();

  const t0 = Date.now();
  game.questionOpensAt = t0 + STREAM_DELAY;
  game.questionEndsAt = game.questionOpensAt + q.duration * 1000;

  // 1) Sofort ins Video rendern — der Stream braucht ~STREAM_DELAY bis zum TV.
  if (!STREAM_DISABLED) streamer.showQuestion(q, q.duration, 0, game.players.size);

  // 2) TV-Countdown: Sekunden-Ticks ab t0 (kommen durch die Latenz "richtig" am TV an).
  for (let s = q.duration - 1; s >= 0; s--) {
    game.timers.push(setTimeout(() => {
      if (!STREAM_DISABLED) streamer.updateCountdown(s);
    }, (q.duration - s) * 1000));
  }

  // 3) Frage an die Handys erst nach STREAM_DELAY — synchron zum TV-Bild.
  game.timers.push(setTimeout(() => {
    io.to('players').emit('question_start', {
      ...publicQuestion(q),
      index,
      total: questions.length,
      endsAt: game.questionEndsAt,
      serverNow: Date.now()
    });
    pushHostState();
  }, STREAM_DELAY));

  // 4) Antwortfenster schliessen + Aufloesung.
  game.timers.push(setTimeout(() => revealQuestion(), STREAM_DELAY + q.duration * 1000));

  pushHostState();
}

function revealQuestion() {
  const q = questions[game.currentIndex];
  if (!q || game.state !== STATES.QUESTION) return;
  game.state = STATES.REVEAL;

  // Punkte: 100 Basis + bis zu 100 Speed-Bonus (linear nach Restzeit).
  const results = [];
  for (const [sid, ans] of game.answers) {
    const player = game.players.get(sid);
    if (!player) continue;
    const correct = ans.optionIndex === q.correctAnswer;
    let gained = 0;
    if (correct) {
      const remaining = Math.max(0, game.questionEndsAt - ans.timestamp);
      gained = 100 + Math.round(100 * (remaining / (q.duration * 1000)));
      player.score += gained;
    }
    results.push({ sid, correct, gained });
  }

  if (!STREAM_DISABLED) streamer.showReveal(q, game.answers.size, game.players.size);

  // Jetzt (und erst jetzt) darf correctAnswer raus.
  for (const r of results) {
    io.to(r.sid).emit('answer_result', {
      questionId: q.questionId,
      correctIndex: q.correctAnswer,
      correct: r.correct,
      gained: r.gained
    });
  }
  // Spieler ohne Antwort bekommen nur die Aufloesung.
  for (const sid of game.players.keys()) {
    if (!game.answers.has(sid)) {
      io.to(sid).emit('answer_result', {
        questionId: q.questionId,
        correctIndex: q.correctAnswer,
        correct: false,
        gained: 0
      });
    }
  }
  io.to('players').emit('scoreboard', ranking());
  pushHostState();
}

function finishQuiz() {
  clearTimers();
  game.state = STATES.FINISHED;
  const finalRanking = ranking();
  if (!STREAM_DISABLED) streamer.showFinished(finalRanking);
  io.to('players').emit('quiz_finished', { ranking: finalRanking });
  pushHostState();
}

function resetQuiz() {
  clearTimers();
  game.state = STATES.LOBBY;
  game.currentIndex = -1;
  game.answers = new Map();
  for (const p of game.players.values()) p.score = 0;
  tvLobby();
  io.to('players').emit('back_to_lobby');
  pushHostState();
}

// ---------- Socket.io ----------
io.on('connection', socket => {
  socket.on('host_join', () => {
    socket.join('hosts');
    socket.emit('host_state', hostState());
  });

  socket.on('player_join', (data, cb) => {
    const name = String((data && data.name) || '').trim().slice(0, 20);
    if (!name) return cb && cb({ ok: false, error: 'Name fehlt' });
    if (game.state !== STATES.LOBBY) return cb && cb({ ok: false, error: 'Quiz laeuft bereits' });
    game.players.set(socket.id, { name, score: 0 });
    socket.join('players');
    tvLobby();
    pushHostState();
    cb && cb({ ok: true, name });
  });

  socket.on('answer', (data, cb) => {
    const player = game.players.get(socket.id);
    if (!player) return cb && cb({ ok: false, error: 'Nicht angemeldet' });
    if (game.state !== STATES.QUESTION) return cb && cb({ ok: false, error: 'Keine aktive Frage' });

    const q = questions[game.currentIndex];
    const now = Date.now();
    if (now < game.questionOpensAt || now > game.questionEndsAt) {
      return cb && cb({ ok: false, error: 'Antwortfenster geschlossen' });
    }
    if (!data || data.questionId !== q.questionId) {
      return cb && cb({ ok: false, error: 'Falsche Frage-ID' });
    }
    const idx = Number(data.selectedOption);
    if (!Number.isInteger(idx) || idx < 0 || idx >= q.options.length) {
      return cb && cb({ ok: false, error: 'Ungueltige Option' });
    }
    if (game.answers.has(socket.id)) {
      return cb && cb({ ok: false, error: 'Bereits geantwortet' });
    }
    game.answers.set(socket.id, { optionIndex: idx, timestamp: now });
    if (!STREAM_DISABLED) streamer.updateAnswerCount(game.answers.size, game.players.size);
    pushHostState();
    cb && cb({ ok: true });
  });

  // Host-Steuerung
  socket.on('start_quiz', () => {
    if (!socket.rooms.has('hosts')) return;
    if (game.state !== STATES.LOBBY) return;
    startQuestion(0);
  });
  socket.on('next_question', () => {
    if (!socket.rooms.has('hosts')) return;
    if (game.state !== STATES.REVEAL) return;
    startQuestion(game.currentIndex + 1);
  });
  socket.on('end_quiz', () => {
    if (!socket.rooms.has('hosts')) return;
    finishQuiz();
  });
  socket.on('reset_quiz', () => {
    if (!socket.rooms.has('hosts')) return;
    resetQuiz();
  });

  socket.on('disconnect', () => {
    if (game.players.delete(socket.id)) {
      game.answers.delete(socket.id);
      if (game.state === STATES.LOBBY) tvLobby();
      pushHostState();
    }
  });
});

// ---------- Start ----------
server.listen(PORT, () => {
  console.log('QuizStream laeuft auf ' + lanUrl());
  console.log('  Host:   ' + lanUrl() + '/host.html');
  console.log('  Mobile: ' + lanUrl() + '/mobile.html');
  console.log('  Stream: ' + lanUrl() + '/hls/stream.m3u8   (STREAM_DELAY=' + STREAM_DELAY + 'ms)');
  if (!STREAM_DISABLED) {
    streamer.start();
    tvLobby();
  } else {
    console.log('  [Stream deaktiviert: STREAM_DISABLED=1]');
  }
});

process.on('SIGINT', () => { streamer.stop(); process.exit(0); });

module.exports = { server, game }; // fuer Tests
