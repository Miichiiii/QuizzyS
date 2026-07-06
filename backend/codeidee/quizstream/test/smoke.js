// test/smoke.js — Live-Smoke-Test gegen den echten Server (ohne FFmpeg).
// Start: npm test
// Prueft: Join, Sync-Fenster (STREAM_DELAY), Antwort-Validierung,
// Leak-Detection (correctAnswer darf NIE vor dem Reveal rausgehen),
// Scoring, Ranking, Reset.

process.env.STREAM_DISABLED = '1';
process.env.STREAM_DELAY = '400';
process.env.PORT = '3999';
process.env.QUESTIONS_FILE = __dirname + '/questions.test.json';

const fs = require('fs');
fs.writeFileSync(process.env.QUESTIONS_FILE, JSON.stringify([
  { questionId: 'q1', text: 'Test 1?', options: ['a', 'b', 'c', 'd'], correctAnswer: 1, duration: 1 },
  { questionId: 'q2', text: 'Test 2?', options: ['a', 'b', 'c', 'd'], correctAnswer: 3, duration: 1 }
]));

require('../server.js');
const ioc = require('socket.io-client');

const URL = 'http://localhost:3999';
let passed = 0, failed = 0;
function assert(cond, name) {
  if (cond) { passed++; console.log('  PASS  ' + name); }
  else { failed++; console.log('  FAIL  ' + name); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Leak-Detektor: jedes Event, das an Spieler geht, darf vor answer_result
// niemals correctAnswer/correctIndex enthalten.
function watchForLeaks(socket, label) {
  socket.onAny((event, ...args) => {
    if (event === 'answer_result' || event === 'quiz_finished' || event === 'scoreboard') return;
    const json = JSON.stringify(args);
    if (/correctAnswer|correctIndex/.test(json)) {
      failed++;
      console.log('  FAIL  LEAK bei ' + label + ' / ' + event + ': ' + json);
    }
  });
}

async function main() {
  await sleep(300);

  const host = ioc(URL);
  const p1 = ioc(URL);
  const p2 = ioc(URL);
  watchForLeaks(p1, 'p1');
  watchForLeaks(p2, 'p2');

  const emitCb = (sock, ev, data) => new Promise(r => sock.emit(ev, data, r));

  host.emit('host_join');

  // 1) Join
  const j1 = await emitCb(p1, 'player_join', { name: 'Anna' });
  const j2 = await emitCb(p2, 'player_join', { name: 'Ben' });
  assert(j1.ok && j2.ok, 'Beide Spieler koennen joinen');
  const jEmpty = await emitCb(p1, 'player_join', { name: '   ' });
  assert(!jEmpty.ok, 'Leerer Name wird abgelehnt');

  // 2) Antworten vor Quizstart unmoeglich
  const early = await emitCb(p1, 'answer', { questionId: 'q1', selectedOption: 0 });
  assert(!early.ok, 'Antwort vor Quizstart wird abgelehnt');

  // 3) Frage-Events sammeln
  let q1p1 = null, q1ReceivedAt = 0;
  p1.on('question_start', q => { if (!q1p1) { q1p1 = q; q1ReceivedAt = Date.now(); } });

  const startedAt = Date.now();
  host.emit('start_quiz');

  // 4) Sofortige Antwort (vor STREAM_DELAY) muss abgelehnt werden
  await sleep(100);
  const tooEarly = await emitCb(p1, 'answer', { questionId: 'q1', selectedOption: 1 });
  assert(!tooEarly.ok, 'Antwort vor STREAM_DELAY (TV-Sync-Fenster) wird abgelehnt');

  // 5) Warten bis Frage bei den Handys ankommt
  await sleep(450);
  assert(q1p1 !== null, 'question_start kommt bei Spielern an');
  assert(q1p1 && q1p1.questionId === 'q1', 'Richtige Frage-ID');
  assert(q1p1 && q1p1.options.length === 4, 'Optionen vorhanden');
  assert(q1p1 && !('correctAnswer' in q1p1) && !('correctIndex' in q1p1),
    'question_start enthaelt KEINE richtige Antwort (Leak-Check)');
  assert(q1ReceivedAt - startedAt >= 350, 'Frage kam erst nach STREAM_DELAY (Sync)');

  // 6) Antworten: Anna richtig (schnell), Ben falsch
  const a1 = await emitCb(p1, 'answer', { questionId: 'q1', selectedOption: 1 });
  assert(a1.ok, 'Gueltige Antwort wird angenommen');
  const dup = await emitCb(p1, 'answer', { questionId: 'q1', selectedOption: 2 });
  assert(!dup.ok, 'Doppelte Antwort wird abgelehnt');
  const badIdx = await emitCb(p2, 'answer', { questionId: 'q1', selectedOption: 99 });
  assert(!badIdx.ok, 'Ungueltiger Optionsindex wird abgelehnt');
  const badQ = await emitCb(p2, 'answer', { questionId: 'qXX', selectedOption: 0 });
  assert(!badQ.ok, 'Falsche Frage-ID wird abgelehnt');
  const a2 = await emitCb(p2, 'answer', { questionId: 'q1', selectedOption: 0 });
  assert(a2.ok, 'Zweiter Spieler kann antworten');

  // 7) Reveal abwarten
  const r1 = await new Promise(r => p1.once('answer_result', r));
  const r2 = await new Promise(r => p2.once('answer_result', r));
  assert(r1.correct === true && r1.gained > 100, 'Richtige Antwort: Punkte inkl. Speed-Bonus');
  assert(r1.correctIndex === 1, 'correctIndex erst im Reveal sichtbar');
  assert(r2.correct === false && r2.gained === 0, 'Falsche Antwort: 0 Punkte');

  // 8) Antwort nach Ende abgelehnt
  const late = await emitCb(p1, 'answer', { questionId: 'q1', selectedOption: 1 });
  assert(!late.ok, 'Antwort nach Antwortfenster wird abgelehnt');

  // 9) Naechste Frage + Finish
  const finished = new Promise(r => p1.once('quiz_finished', r));
  host.emit('next_question');
  await sleep(500);
  await emitCb(p1, 'answer', { questionId: 'q2', selectedOption: 3 });
  await new Promise(r => p1.once('answer_result', r));
  host.emit('next_question'); // keine Frage 3 -> FINISHED
  const fin = await finished;
  assert(fin.ranking.length === 2, 'Endstand enthaelt beide Spieler');
  assert(fin.ranking[0].name === 'Anna' && fin.ranking[0].score > fin.ranking[1].score,
    'Ranking korrekt sortiert (Anna vorne)');

  // 10) Reset
  const backToLobby = new Promise(r => p1.once('back_to_lobby', r));
  host.emit('reset_quiz');
  await backToLobby;
  const j3 = await emitCb(p1, 'player_join', { name: 'Neu' }); // p1 ist schon Spieler, egal — Lobby-Join erlaubt
  assert(j3.ok, 'Nach Reset ist die Lobby wieder offen');

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  fs.unlinkSync(process.env.QUESTIONS_FILE);
  process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
