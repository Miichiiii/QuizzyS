// streamer.js — Caveman Style Video-Renderer
// Kein node-canvas, kein Puppeteer: FFmpeg rendert den kompletten TV-Screen
// selbst. Wir schreiben nur Textdateien, FFmpeg liest sie jede Sekunde neu
// (drawtext reload=1) und gibt einen echten HLS-Stream aus, den jeder
// Chromecast als Standard-Video abspielt. Kein Screen Mirroring.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const FONT = process.env.FONT_FILE || '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';
const STREAM_DIR = path.join(__dirname, 'stream');   // Textdateien (Renderer-Input)
const HLS_DIR = path.join(__dirname, 'public', 'hls'); // HLS-Output

// Alle Text-Slots, die im Videobild vorkommen.
// Pro Option gibt es zwei Slots: normal (weiss) und hl (gruen, fuer Reveal).
const SLOTS = [
  'status', 'question', 'answers',
  'opt0', 'opt1', 'opt2', 'opt3',
  'opt0hl', 'opt1hl', 'opt2hl', 'opt3hl'
];

let proc = null;

function slotPath(name) {
  return path.join(STREAM_DIR, name + '.txt');
}

// Atomarer Write: tmp + rename, damit FFmpeg beim reload nie eine halbe Datei liest.
function writeSlot(name, text) {
  const p = slotPath(name);
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, text || ' ');
  fs.renameSync(tmp, p);
}

function initSlots() {
  fs.mkdirSync(STREAM_DIR, { recursive: true });
  fs.mkdirSync(HLS_DIR, { recursive: true });
  for (const s of SLOTS) writeSlot(s, ' ');
}

// drawtext-Baustein. expansion=none => Dateiinhalt wird 1:1 gerendert,
// keine %-Expansion, keine Escaping-Fallen.
function dt(slot, opts) {
  const file = slotPath(slot).replace(/\\/g, '/').replace(/:/g, '\\:');
  const parts = [
    `fontfile='${FONT}'`,
    `textfile='${file}'`,
    'reload=1',
    'expansion=none',
    `fontsize=${opts.size}`,
    `fontcolor=${opts.color}`,
    `x=${opts.x}`,
    `y=${opts.y}`,
    'line_spacing=12'
  ];
  return 'drawtext=' + parts.join(':');
}

function buildFilter() {
  // Layout 1280x720:
  //  - Statuszeile oben (Countdown / Lobby-Info)
  //  - Frage mittig oben
  //  - 4 Antwortboxen als 2x2-Grid unten
  //  - "Antworten: N" unten rechts
  const boxes = [
    'drawbox=x=70:y=380:w=550:h=130:color=0x2a3550@1:t=fill',
    'drawbox=x=660:y=380:w=550:h=130:color=0x2a3550@1:t=fill',
    'drawbox=x=70:y=540:w=550:h=130:color=0x2a3550@1:t=fill',
    'drawbox=x=660:y=540:w=550:h=130:color=0x2a3550@1:t=fill'
  ];
  const texts = [
    dt('status',   { size: 36, color: 'white@0.9', x: '(w-text_w)/2', y: 40 }),
    dt('question', { size: 48, color: 'white',     x: '(w-text_w)/2', y: 180 }),
    dt('answers',  { size: 28, color: 'white@0.7', x: 'w-text_w-40',  y: 'h-text_h-30' }),
    dt('opt0',   { size: 38, color: 'white',    x: 100, y: 425 }),
    dt('opt1',   { size: 38, color: 'white',    x: 690, y: 425 }),
    dt('opt2',   { size: 38, color: 'white',    x: 100, y: 585 }),
    dt('opt3',   { size: 38, color: 'white',    x: 690, y: 585 }),
    dt('opt0hl', { size: 38, color: '0x35d07f', x: 100, y: 425 }),
    dt('opt1hl', { size: 38, color: '0x35d07f', x: 690, y: 425 }),
    dt('opt2hl', { size: 38, color: '0x35d07f', x: 100, y: 585 }),
    dt('opt3hl', { size: 38, color: '0x35d07f', x: 690, y: 585 })
  ];
  return boxes.concat(texts).join(',');
}

function start() {
  initSlots();
  const args = [
    '-hide_banner', '-loglevel', 'warning',
    // Video: dunkler Hintergrund, 15 fps, echtzeit (-re)
    '-re', '-f', 'lavfi', '-i', 'color=c=0x101828:s=1280x720:r=15',
    // Stille Audiospur -> maximale Chromecast-Kompatibilitaet
    '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo',
    '-vf', buildFilter(),
    '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency',
    '-pix_fmt', 'yuv420p',
    '-g', '15', '-keyint_min', '15', '-sc_threshold', '0',
    '-c:a', 'aac', '-b:a', '32k',
    '-f', 'hls',
    '-hls_time', '1',
    '-hls_list_size', '6',
    '-hls_flags', 'delete_segments+independent_segments',
    '-hls_segment_filename', path.join(HLS_DIR, 'seg_%05d.ts'),
    path.join(HLS_DIR, 'stream.m3u8')
  ];
  proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
  proc.stderr.on('data', d => process.stderr.write('[ffmpeg] ' + d));
  proc.on('exit', code => {
    console.log('[streamer] ffmpeg beendet, code', code);
    proc = null;
  });
  console.log('[streamer] HLS-Stream laeuft -> /hls/stream.m3u8');
}

function stop() {
  if (proc) { proc.kill('SIGTERM'); proc = null; }
}

// ---- High-Level API fuer die Game-Engine ----

function showLobby(joinUrl, playerCount) {
  writeSlot('status', 'QUIZ LOBBY');
  writeSlot('question', 'Mitspielen:\n' + joinUrl + '\n\nSpieler: ' + playerCount);
  writeSlot('answers', ' ');
  for (let i = 0; i < 4; i++) { writeSlot('opt' + i, ' '); writeSlot('opt' + i + 'hl', ' '); }
}

function showQuestion(q, secondsLeft, answerCount, totalPlayers) {
  writeSlot('status', 'Noch ' + secondsLeft + 's');
  writeSlot('question', wrap(q.text, 44));
  writeSlot('answers', 'Antworten: ' + answerCount + '/' + totalPlayers);
  const letters = ['A', 'B', 'C', 'D'];
  q.options.forEach((opt, i) => {
    writeSlot('opt' + i, letters[i] + ')  ' + opt);
    writeSlot('opt' + i + 'hl', ' ');
  });
}

function showReveal(q, answerCount, totalPlayers) {
  writeSlot('status', 'AUFLOESUNG');
  writeSlot('answers', 'Antworten: ' + answerCount + '/' + totalPlayers);
  const letters = ['A', 'B', 'C', 'D'];
  q.options.forEach((opt, i) => {
    if (i === q.correctAnswer) {
      writeSlot('opt' + i, ' ');
      writeSlot('opt' + i + 'hl', letters[i] + ')  ' + opt + '  \u2713');
    } else {
      writeSlot('opt' + i, letters[i] + ')  ' + opt);
      writeSlot('opt' + i + 'hl', ' ');
    }
  });
}

function showFinished(ranking) {
  writeSlot('status', 'QUIZ BEENDET');
  const lines = ranking.slice(0, 5).map((r, i) => (i + 1) + '. ' + r.name + '  -  ' + r.score + ' Punkte');
  writeSlot('question', 'ENDSTAND\n\n' + (lines.join('\n') || 'Keine Spieler'));
  writeSlot('answers', ' ');
  for (let i = 0; i < 4; i++) { writeSlot('opt' + i, ' '); writeSlot('opt' + i + 'hl', ' '); }
}

function updateCountdown(secondsLeft) {
  writeSlot('status', 'Noch ' + secondsLeft + 's');
}

function updateAnswerCount(answerCount, totalPlayers) {
  writeSlot('answers', 'Antworten: ' + answerCount + '/' + totalPlayers);
}

// Einfacher Zeilenumbruch, damit lange Fragen nicht aus dem Bild laufen.
function wrap(text, maxLen) {
  const words = text.split(' ');
  const lines = [];
  let line = '';
  for (const w of words) {
    if ((line + ' ' + w).trim().length > maxLen) { lines.push(line.trim()); line = w; }
    else line += ' ' + w;
  }
  if (line.trim()) lines.push(line.trim());
  return lines.join('\n');
}

module.exports = {
  start, stop,
  showLobby, showQuestion, showReveal, showFinished,
  updateCountdown, updateAnswerCount
};
