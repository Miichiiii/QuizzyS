const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { Canvas } = require('skia-canvas');

class Streamer {
  constructor(roomCode) {
    this.roomCode = roomCode;
    this.hlsDir = path.join(__dirname, '..', 'frontend', 'hls', roomCode);
    this.proc = null;
    this.renderInterval = null;
    this.fps = 15;
    
    this.canvas = new Canvas(1280, 720);
    this.ctx = this.canvas.getContext('2d');
    
    // Internal state
    this.state = {
      view: 'LOBBY', // LOBBY, CATEGORY, QUESTION, REVEAL, FINISHED
      joinUrl: '',
      playerCount: 0,
      chooserName: '',
      questionText: '',
      answers: [],
      secondsLeft: 0,
      answerCount: 0,
      totalPlayers: 0,
      correctIndex: -1,
      ranking: []
    };
    
    this.lastBuffer = null;
    this.needsRender = true;
  }

  start() {
    fs.mkdirSync(this.hlsDir, { recursive: true });
    
    const args = [
      '-hide_banner', '-loglevel', 'warning',
      '-re', 
      '-f', 'image2pipe', 
      '-vcodec', 'png', 
      '-r', `${this.fps}`, 
      '-i', 'pipe:0',
      '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency',
      '-pix_fmt', 'yuv420p',
      '-g', `${this.fps}`, '-keyint_min', `${this.fps}`, '-sc_threshold', '0',
      '-c:a', 'aac', '-b:a', '32k',
      '-f', 'hls',
      '-hls_time', '1',
      '-hls_list_size', '6',
      '-hls_flags', 'delete_segments+independent_segments',
      '-hls_segment_filename', path.join(this.hlsDir, 'seg_%05d.ts'),
      path.join(this.hlsDir, 'stream.m3u8')
    ];
    
    this.proc = spawn('ffmpeg', args, { stdio: ['pipe', 'ignore', 'pipe'] });
    this.proc.stderr.on('data', d => process.stderr.write(`[ffmpeg ${this.roomCode}] ` + d));
    this.proc.on('exit', code => {
      console.log(`[streamer ${this.roomCode}] ffmpeg beendet, code`, code);
      this.stop();
    });
    
    console.log(`[streamer ${this.roomCode}] HLS-Stream läuft -> /hls/${this.roomCode}/stream.m3u8`);
    
    // Start Render Loop
    this.renderInterval = setInterval(() => {
      if (!this.proc || !this.proc.stdin) return;
      
      if (this.needsRender) {
        this.renderCanvas();
        // toBuffer is async/sync in skia-canvas. We use Sync for simplicity in the loop, or async.
        // Sync is fast enough for 15fps.
        this.lastBuffer = this.canvas.toBufferSync('png');
        this.needsRender = false;
      }
      
      try {
        this.proc.stdin.write(this.lastBuffer);
      } catch (err) {
        console.error("Fehler beim Schreiben in FFmpeg Pipe:", err.message);
      }
    }, 1000 / this.fps);
  }

  stop() {
    if (this.renderInterval) {
      clearInterval(this.renderInterval);
      this.renderInterval = null;
    }
    if (this.proc) { 
      this.proc.kill('SIGTERM'); 
      this.proc = null; 
    }
    // Optional: Aufräumen des HLS-Verzeichnisses
    try { fs.rmSync(this.hlsDir, { recursive: true, force: true }); } catch(e) {}
  }

  // --- State Updates ---
  
  showLobby(joinUrl, playerCount) {
    this.state = { ...this.state, view: 'LOBBY', joinUrl, playerCount };
    this.needsRender = true;
  }

  showCategorySelect(chooserName) {
    this.state = { ...this.state, view: 'CATEGORY', chooserName };
    this.needsRender = true;
  }

  showQuestion(q, secondsLeft, answerCount, totalPlayers) {
    this.state = {
      ...this.state, 
      view: 'QUESTION',
      questionText: q.question,
      answers: q.answers,
      secondsLeft,
      answerCount,
      totalPlayers
    };
    this.needsRender = true;
  }

  showReveal(q, correctIndex, answerCount, totalPlayers) {
    this.state = {
      ...this.state,
      view: 'REVEAL',
      questionText: q.question,
      answers: q.answers,
      correctIndex,
      answerCount,
      totalPlayers
    };
    this.needsRender = true;
  }

  showFinished(ranking) {
    this.state = { ...this.state, view: 'FINISHED', ranking };
    this.needsRender = true;
  }

  updateCountdown(secondsLeft) {
    this.state.secondsLeft = secondsLeft;
    this.needsRender = true;
  }

  updateAnswerCount(answerCount, totalPlayers) {
    this.state.answerCount = answerCount;
    this.state.totalPlayers = totalPlayers;
    this.needsRender = true;
  }

  // --- Rendering ---

  renderCanvas() {
    const { width, height } = this.canvas;
    const ctx = this.ctx;
    
    // 1. Hintergrund (Premium Dark Gradient)
    const bgGrad = ctx.createRadialGradient(width/2, height/2, 0, width/2, height/2, width);
    bgGrad.addColorStop(0, '#1e2638');
    bgGrad.addColorStop(1, '#0f141e');
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, width, height);

    // Deko-Elemente (weiche Kreise)
    ctx.fillStyle = 'rgba(53, 208, 127, 0.05)';
    ctx.beginPath(); ctx.arc(100, 100, 300, 0, Math.PI*2); ctx.fill();
    ctx.fillStyle = 'rgba(74, 144, 226, 0.05)';
    ctx.beginPath(); ctx.arc(1100, 600, 400, 0, Math.PI*2); ctx.fill();

    // Top Bar
    ctx.fillStyle = 'rgba(255, 255, 255, 0.1)';
    ctx.roundRect(40, 30, width - 80, 60, 30);
    ctx.fill();

    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 24px sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(\`QUIZZY • RAUM \${this.roomCode}\`, 70, 60);

    ctx.textAlign = 'right';
    if (this.state.view === 'QUESTION' || this.state.view === 'REVEAL') {
      ctx.fillText(\`Antworten: \${this.state.answerCount} / \${this.state.totalPlayers}\`, width - 70, 60);
    } else if (this.state.view === 'LOBBY') {
      ctx.fillText(\`Spieler: \${this.state.playerCount}\`, width - 70, 60);
    }

    ctx.textAlign = 'center';
    ctx.fillStyle = '#f0c674';
    if (this.state.view === 'QUESTION') {
      ctx.fillText(\`Verbleibende Zeit: \${this.state.secondsLeft}s\`, width/2, 60);
    } else if (this.state.view === 'REVEAL') {
      ctx.fillText("AUFLÖSUNG", width/2, 60);
    } else if (this.state.view === 'FINISHED') {
      ctx.fillText("ENDE", width/2, 60);
    }

    // Main Content
    if (this.state.view === 'LOBBY') {
      this.drawLobby(ctx, width, height);
    } else if (this.state.view === 'CATEGORY') {
      this.drawCategory(ctx, width, height);
    } else if (this.state.view === 'QUESTION' || this.state.view === 'REVEAL') {
      this.drawQuestion(ctx, width, height);
    } else if (this.state.view === 'FINISHED') {
      this.drawFinished(ctx, width, height);
    }
  }

  drawLobby(ctx, width, height) {
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 50px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText("Willkommen in der Lobby!", width/2, height/2 - 50);
    
    ctx.fillStyle = '#a0aabf';
    ctx.font = '30px sans-serif';
    ctx.fillText(\`Auf dem Handy öffnen: \${this.state.joinUrl}\`, width/2, height/2 + 30);
    
    ctx.fillStyle = '#35d07f';
    ctx.font = 'bold 36px sans-serif';
    ctx.fillText(\`Warte auf den Host...\`, width/2, height/2 + 120);
  }

  drawCategory(ctx, width, height) {
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 50px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText("Kategorie wählen", width/2, height/2 - 30);
    
    ctx.fillStyle = '#35d07f';
    ctx.font = '36px sans-serif';
    ctx.fillText(\`\${this.state.chooserName} wählt gerade aus...\`, width/2, height/2 + 40);
  }

  drawQuestion(ctx, width, height) {
    // Question Text (Wrapped)
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 44px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const lines = this.wrapText(ctx, this.state.questionText, 1000);
    let startY = 150;
    for (const line of lines) {
      ctx.fillText(line, width/2, startY);
      startY += 55;
    }

    // Answers 2x2 Grid
    const letters = ['A', 'B', 'C', 'D'];
    const colors = ['#e53935', '#1e88e5', '#ffb300', '#43a047']; // Kahoot-like colors or brand colors
    
    const boxW = 500;
    const boxH = 120;
    const gapX = 40;
    const gapY = 30;
    const startX = (width - (boxW * 2 + gapX)) / 2;
    const boxesY = Math.max(380, startY + 50); // Push down if question is long

    for (let i = 0; i < this.state.answers.length; i++) {
      if (i >= 4) break;
      const x = startX + (i % 2) * (boxW + gapX);
      const y = boxesY + Math.floor(i / 2) * (boxH + gapY);
      
      const isCorrect = this.state.view === 'REVEAL' && this.state.correctIndex === i;
      const isWrong = this.state.view === 'REVEAL' && this.state.correctIndex !== i;

      // Box Background
      ctx.beginPath();
      ctx.roundRect(x, y, boxW, boxH, 20);
      if (isCorrect) {
        ctx.fillStyle = '#35d07f'; // Green glow
        ctx.shadowColor = '#35d07f';
        ctx.shadowBlur = 20;
      } else if (isWrong) {
        ctx.fillStyle = 'rgba(255, 255, 255, 0.05)'; // Dimmed
        ctx.shadowBlur = 0;
      } else {
        ctx.fillStyle = colors[i];
        ctx.shadowBlur = 0;
      }
      ctx.fill();
      ctx.shadowBlur = 0; // reset
      
      // Letter
      ctx.fillStyle = 'rgba(0,0,0,0.3)';
      ctx.font = 'bold 60px sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(letters[i], x + 25, y + boxH/2 + 5);

      // Text
      ctx.fillStyle = isWrong ? 'rgba(255,255,255,0.5)' : '#ffffff';
      ctx.font = 'bold 32px sans-serif';
      
      // wrap answer if too long
      const ansLines = this.wrapText(ctx, this.state.answers[i], boxW - 120);
      let ansY = y + boxH/2 - ((ansLines.length - 1) * 18);
      for(const line of ansLines) {
          ctx.fillText(line, x + 90, ansY);
          ansY += 36;
      }
    }
  }

  drawFinished(ctx, width, height) {
    ctx.fillStyle = '#f0c674';
    ctx.font = 'bold 60px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText("ENDSTAND", width/2, 180);
    
    ctx.font = '40px sans-serif';
    let y = 280;
    const top = this.state.ranking.slice(0, 5);
    for (let i = 0; i < top.length; i++) {
      const r = top[i];
      if (i === 0) {
        ctx.fillStyle = '#35d07f';
        ctx.font = 'bold 48px sans-serif';
      } else {
        ctx.fillStyle = '#ffffff';
        ctx.font = '36px sans-serif';
      }
      ctx.fillText(\`\${i + 1}. \${r.name} - \${r.score} Punkte\`, width/2, y);
      y += 60;
    }
  }

  wrapText(ctx, text, maxWidth) {
    if(!text) return [];
    const words = text.split(' ');
    const lines = [];
    let currentLine = words[0];

    for (let i = 1; i < words.length; i++) {
      const word = words[i];
      const width = ctx.measureText(currentLine + " " + word).width;
      if (width < maxWidth) {
        currentLine += " " + word;
      } else {
        lines.push(currentLine);
        currentLine = word;
      }
    }
    lines.push(currentLine);
    return lines;
  }
}

module.exports = { Streamer };
