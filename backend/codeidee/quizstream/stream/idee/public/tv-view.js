// tv-view.js — Gemeinsame TV-Ansicht fuer tv.html (Browser / Tab-Cast)
// und receiver.html (Custom Cast Receiver). Rendert den Spielzustand live
// per Socket.io — null Latenz, kein Video noetig.
(function () {
  var socket = io();
  var countdownTimer = null;

  function $(id) { return document.getElementById(id); }
  function show(id) {
    ['tv-lobby', 'tv-question', 'tv-final'].forEach(function (s) {
      $(s).style.display = s === id ? 'flex' : 'none';
    });
  }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  socket.on('connect', function () { socket.emit('tv_join'); });

  socket.on('tv_state', function (s) {
    if (s.state === 'QUESTION') renderQuestion(s.question, s.index, s.total, s.endsAt, s.serverNow, s.playerCount, s.answerCount || 0);
    else if (s.state === 'REVEAL') { renderQuestion(s.question, s.index, s.total, 0, 0, s.playerCount, 0); reveal(s.correctIndex, s.ranking); }
    else if (s.state === 'FINISHED') renderFinal(s.ranking);
    else renderLobby(s.joinUrl, s.playerCount);
  });

  socket.on('tv_lobby', function (d) { renderLobby(d.joinUrl, d.playerCount); });
  socket.on('tv_question', function (d) {
    renderQuestion(d.question, d.index, d.total, d.endsAt, d.serverNow, d.playerCount, 0);
  });
  socket.on('tv_answers', function (d) {
    $('tv-answers').textContent = 'Antworten: ' + d.answerCount + '/' + d.playerCount;
  });
  socket.on('tv_reveal', function (d) { reveal(d.correctIndex, d.ranking); });
  socket.on('tv_finished', function (d) { renderFinal(d.ranking); });

  function renderLobby(joinUrl, playerCount) {
    clearInterval(countdownTimer);
    $('tv-join-url').textContent = joinUrl || '';
    $('tv-player-count').textContent = 'Spieler: ' + (playerCount || 0);
    show('tv-lobby');
  }

  function renderQuestion(q, index, total, endsAt, serverNow, playerCount, answerCount) {
    clearInterval(countdownTimer);
    $('tv-qnum').textContent = 'Frage ' + (index + 1) + ' / ' + total;
    $('tv-qtext').textContent = q.text;
    $('tv-answers').textContent = 'Antworten: ' + answerCount + '/' + (playerCount || 0);
    var letters = ['A', 'B', 'C', 'D'];
    var opts = $('tv-opts');
    opts.innerHTML = '';
    q.options.forEach(function (opt, i) {
      var d = document.createElement('div');
      d.className = 'tv-opt';
      d.id = 'tv-opt-' + i;
      d.innerHTML = '<span class="letter">' + letters[i] + '</span><span>' + esc(opt) + '</span>';
      opts.appendChild(d);
    });

    if (endsAt && serverNow) {
      var total_ms = endsAt - serverNow;
      var start = Date.now();
      var tick = function () {
        var left = Math.max(0, total_ms - (Date.now() - start));
        $('tv-timer').textContent = 'Noch ' + Math.ceil(left / 1000) + 's';
        $('tv-bar').style.width = (100 * left / total_ms) + '%';
        if (left <= 0) clearInterval(countdownTimer);
      };
      tick();
      countdownTimer = setInterval(tick, 200);
    } else {
      $('tv-timer').textContent = '';
      $('tv-bar').style.width = '0%';
    }
    show('tv-question');
  }

  function reveal(correctIndex, ranking) {
    clearInterval(countdownTimer);
    $('tv-timer').textContent = 'AUFLÖSUNG';
    $('tv-bar').style.width = '0%';
    var el = $('tv-opt-' + correctIndex);
    if (el) el.classList.add('correct');
    if (ranking && ranking.length) {
      $('tv-answers').textContent = 'Führung: ' + ranking[0].name + ' (' + ranking[0].score + ')';
    }
  }

  function renderFinal(ranking) {
    clearInterval(countdownTimer);
    var el = $('tv-board');
    el.innerHTML = '';
    (ranking || []).slice(0, 8).forEach(function (p, i) {
      var row = document.createElement('div');
      row.className = 'tv-row';
      row.innerHTML = '<span>' + (i + 1) + '. ' + esc(p.name) + '</span><span>' + p.score + '</span>';
      el.appendChild(row);
    });
    show('tv-final');
  }
})();
