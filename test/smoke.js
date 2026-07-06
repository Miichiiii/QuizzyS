// Smoke-Test (Akzeptanzkriterium aus dem Master-Prompt):
// create_game -> 2x join_game -> start_game -> Kategorie -> alle Fragen -> game_finished.
// Laeuft mit 2 simulierten socket.io-Clients + 1 Spectator gegen den ECHTEN Server-Prozess.
// Muss vor jeder Auslieferung gruen sein.

process.env.PORT = "3555";
process.env.SHOW_RESULT_MS = "50";   // Test soll Sekunden dauern, nicht Minuten
process.env.SCOREBOARD_MS = "50";
process.env.RECONNECT_TIMEOUT_MS = "3000"; // kurz fuer Reconnect-Test

const { io: Client } = require("socket.io-client");
require("../backend/server"); // startet den Server im selben Prozess

const URL = "http://localhost:3555";
let passed = 0, failed = 0;

function assert(cond, msg) {
  if (cond) { passed++; console.log("  ✅ " + msg); }
  else { failed++; console.error("  ❌ " + msg); }
}

function connect() {
  return new Promise((res, rej) => {
    const s = Client(URL, { transports: ["websocket"] });
    s.on("connect", () => res(s));
    s.on("connect_error", rej);
  });
}

function emit(socket, event, payload) {
  return new Promise(res => socket.emit(event, payload, res));
}

const timeout = setTimeout(() => {
  console.error("❌ TIMEOUT: Spiel nicht innerhalb von 30s beendet.");
  process.exit(1);
}, 30000);

(async () => {
  console.log("── QuizCast Smoke-Test ──");

  const host = await connect();
  const p1 = await connect();
  const p2 = await connect();
  const p3 = await connect();
  const p4 = await connect();
  const tv = await connect();

  // Sicherheits-Assertion: correctIndex darf NIE vor reveal_answer rausgehen
  let leakDetected = false;
  [p1, p2, p3, p4, tv].forEach(s => s.on("next_question", d => {
    if ("correctIndex" in d) leakDetected = true;
  }));

  // 1) create_game
  const created = await emit(host, "create_game", {});
  assert(created.ok && /^[A-Z0-9]{6}$/.test(created.code), "create_game liefert 6-stelligen Code: " + created.code);
  const code = created.code;

  // Spielerlimit auf 4 ändern
  const limitRes = await emit(host, "change_player_limit", { code, limit: 4 });
  assert(limitRes.ok && limitRes.maxPlayers === 4, "Host ändert Spielerlimit auf 4");

  // 2) 4x join_game + Spectator
  const j1 = await emit(p1, "join_game", { code, name: "Micha" });
  assert(j1.ok && j1.color === "blau", "Spieler 1 joint als BLAU");
  const j2 = await emit(p2, "join_game", { code, name: "Gegner" });
  assert(j2.ok && j2.color === "rot", "Spieler 2 joint als ROT");
  const j3 = await emit(p3, "join_game", { code, name: "Dritt" });
  assert(j3.ok && j3.color === "gruen", "Spieler 3 joint als GRUEN");
  const j4 = await emit(p4, "join_game", { code, name: "Viert" });
  assert(j4.ok && j4.color === "gelb", "Spieler 4 joint als GELB");

  const jSpec = await emit(tv, "join_as_spectator", { code });
  assert(jSpec.ok, "TV joint als Spectator");

  // 5. Spieler muss abgelehnt werden (Limit = 4)
  const p5 = await connect();
  const j5 = await emit(p5, "join_game", { code, name: "Eindringling" });
  assert(!j5.ok, "5. Spieler wird abgelehnt (max 4)");

  // Falscher Code (vor dem Disconnect testen, sonst kommt kein Callback mehr)
  const jBad = await emit(p5, "join_game", { code: "XXXXXX", name: "Geist" });
  assert(!jBad.ok, "Join mit falschem Code wird abgelehnt");
  p5.disconnect();

  // 3) start_game -> game_starting + category_select
  const gotStarting = new Promise(res => tv.once("game_starting", res));
  const gotCatSelect = new Promise(res => p1.once("category_select", res));
  const started = await emit(host, "start_game", { code });
  assert(started.ok, "start_game vom Host akzeptiert");
  await gotStarting;
  assert(true, "game_starting kam beim TV an (getrenntes Event, nicht game_ready)");
  const catData = await gotCatSelect;
  assert(catData.chooserColor === "blau" && catData.categories.length >= 2, "category_select: Blau wählt aus " + catData.categories.length + " Kategorien");

  // Antwort ausserhalb aktiver Frage muss abgelehnt werden
  const early = await emit(p1, "submit_answer", { code, answerIndex: 0 });
  assert(!early.ok, "submit_answer vor Fragestart wird abgelehnt");

  // Roter Spieler darf NICHT die Kategorie waehlen
  const wrongChooser = await emit(p2, "select_category", { code, category: catData.categories[0] });
  assert(!wrongChooser.ok, "Roter Spieler darf Kategorie nicht wählen");

  // 4) Fragen-Loop: p1, p3 antworten 0, p2, p4 antworten 1.
  let questionCount = 0, revealCount = 0, tickSeen = false, lockSeen = false;
  let expectedBlau = 0, expectedRot = 0, expectedGruen = 0, expectedGelb = 0;

  tv.on("timer_tick", () => tickSeen = true);
  tv.on("lock_answer", () => lockSeen = true);

  p1.on("next_question", async d => {
    questionCount++;
    await emit(p1, "submit_answer", { code, answerIndex: 0 });
    // Doppelte Antwort muss abgelehnt werden
    const dup = await emit(p1, "submit_answer", { code, answerIndex: 2 });
    if (dup.ok) { failed++; console.error("  ❌ Doppelte Antwort wurde akzeptiert!"); }
    await emit(p2, "submit_answer", { code, answerIndex: 1 });
    await emit(p3, "submit_answer", { code, answerIndex: 0 });
    await emit(p4, "submit_answer", { code, answerIndex: 1 });
  });

  tv.on("reveal_answer", d => {
    revealCount++;
    if (d.correctIndex === 0) {
      expectedBlau += 150;  // richtig + schnellster
      expectedGruen += 100; // richtig
    } else if (d.correctIndex === 1) {
      expectedRot += 150;   // richtig + schnellster
      expectedGelb += 100;  // richtig
    }
    assert(typeof d.correctIndex === "number", `reveal_answer #${revealCount} enthält correctIndex`);
  });

  // Jetzt waehlt Blau wirklich die Kategorie -> Fragen-Loop startet
  const sel = await emit(p1, "select_category", { code, category: catData.categories[0] });
  assert(sel.ok, "Blau wählt Kategorie: " + catData.categories[0]);

  // 5) game_finished abwarten
  const finished = await new Promise(res => tv.once("game_finished", res));

  assert(questionCount === 5, `5 Fragen durchlaufen (waren: ${questionCount})`);
  assert(revealCount === 5, `5x reveal_answer (waren: ${revealCount})`);
  assert(tickSeen, "timer_tick vom Server empfangen");
  assert(lockSeen, "lock_answer broadcast empfangen");
  assert(!leakDetected, "correctIndex ist NIE vor reveal_answer geleakt");

  const blau = finished.players.find(p => p.color === "blau");
  const rot = finished.players.find(p => p.color === "rot");
  const gruen = finished.players.find(p => p.color === "gruen");
  const gelb = finished.players.find(p => p.color === "gelb");
  assert(blau.score === expectedBlau, `Scoreboard Blau korrekt: ${blau.score} (erwartet ${expectedBlau})`);
  assert(rot.score === expectedRot, `Scoreboard Rot korrekt: ${rot.score} (erwartet ${expectedRot})`);
  assert(gruen.score === expectedGruen, `Scoreboard Grün korrekt: ${gruen.score} (erwartet ${expectedGruen})`);
  assert(gelb.score === expectedGelb, `Scoreboard Gelb korrekt: ${gelb.score} (erwartet ${expectedGelb})`);

  let maxScore = Math.max(expectedBlau, expectedRot, expectedGruen, expectedGelb);
  let expectedWinners = [];
  if (expectedBlau === maxScore) expectedWinners.push("blau");
  if (expectedRot === maxScore) expectedWinners.push("rot");
  if (expectedGruen === maxScore) expectedWinners.push("gruen");
  if (expectedGelb === maxScore) expectedWinners.push("gelb");
  const expectedWinner = expectedWinners.length === 1 ? expectedWinners[0] : null;

  assert(finished.winner === expectedWinner, `Gewinner korrekt: ${finished.winner === null ? "Unentschieden" : finished.winner}`);


  // ─────────────────────────────────────────────────────
  // 6) v2 Reconnect-Test: Neues Spiel, Spieler trennt mitten in der 1. Frage die Verbindung.
  // ─────────────────────────────────────────────────────
  console.log("\n── Reconnect-Test ──");
  const rHost = await connect();
  const rP1   = await connect();
  const rP2   = await connect();

  const rCreated = await emit(rHost, "create_game", {});
  const rCode = rCreated.code;
  const rJ1 = await emit(rP1, "join_game", { code: rCode, name: "ReconBlau" });
  await emit(rP2, "join_game", { code: rCode, name: "ReconRot" });
  assert(rJ1.ok && rJ1.color === "blau", "Reconnect-Test: Spieler 1 joint als BLAU");

  // Auf category_select lauschen BEVOR start_game gesendet wird.
  const rCatPromise = new Promise(res => rP1.once("category_select", res));
  await emit(rHost, "start_game", { code: rCode });
  await rCatPromise; // Kategorie-Auswahl angekommen

  // Auf next_question lauschen BEVOR select_category gesendet wird.
  const rFirstQ = new Promise(res => rP2.once("next_question", res));
  await emit(rP1, "select_category", { code: rCode, category: "Tiere" });
  const firstQuestion = await rFirstQ;
  assert(!!firstQuestion.question, "Reconnect-Test: erste Frage empfangen");

  // Spieler 1 trennt Verbindung
  const rDisconnectPromise = new Promise(res => rP2.once("player_disconnected", res));
  rP1.disconnect();
  const disconnectEvent = await rDisconnectPromise;
  assert(disconnectEvent.color === "blau", "Reconnect-Test: player_disconnected fuer blau empfangen");

  // Spieler 1 verbindet sich neu und sendet reconnect_player
  const rP1new = await connect();
  const reconResult = await emit(rP1new, "reconnect_player", { code: rCode, color: "blau", name: "ReconBlau" });
  assert(reconResult.ok, "Reconnect-Test: reconnect_player akzeptiert");

  // Aufraumen
  rP1new.disconnect();
  rP2.disconnect();
  rHost.disconnect();

  // ─────────────────────────────────────────────────────
  // 7) v2 Kick-Test: Host kickt Spieler in der Lobby.
  // ─────────────────────────────────────────────────────
  console.log("\n── Kick-Test ──");
  const kHost = await connect();
  const kP1   = await connect();
  const kP2   = await connect();

  const kCreated = await emit(kHost, "create_game", {});
  const kCode = kCreated.code;
  await emit(kP1, "join_game", { code: kCode, name: "KickBlau" });
  await emit(kP2, "join_game", { code: kCode, name: "KickRot" });

  // Nicht-Host darf nicht kicken
  const kickByPlayer = await emit(kP1, "kick_player", { code: kCode, color: "rot" });
  assert(!kickByPlayer.ok, "Kick-Test: Nicht-Host darf nicht kicken");

  // Host kickt Spieler 2 (rot)
  const kickedMsg = new Promise(res => kP2.once("kicked", res));
  const playerJoinedAfterKick = new Promise(res => kHost.once("player_joined", res));
  const kickResult = await emit(kHost, "kick_player", { code: kCode, color: "rot" });
  assert(kickResult.ok, "Kick-Test: Host kickt Rot erfolgreich");
  await kickedMsg;
  assert(true, "Kick-Test: Gekickter Spieler erhaelt 'kicked'-Event");
  const afterKick = await playerJoinedAfterKick;
  assert(afterKick.players.length === 1, "Kick-Test: Slot nach Kick wieder frei (1 Spieler)");

  // Dritter Spieler kann jetzt joinen
  const kP3 = await connect();
  const kJ3 = await emit(kP3, "join_game", { code: kCode, name: "NeuRot" });
  assert(kJ3.ok, "Kick-Test: Neuer Spieler kann den freien Slot belegen");

  kHost.disconnect(); kP1.disconnect(); kP2.disconnect(); kP3.disconnect();

  // ─────────────────────────────────────────────────────
  // 8) v2 QR-Code-Test: GET /api/qr gibt SVG zurueck.
  // ─────────────────────────────────────────────────────
  console.log("\n── QR-Code-Test ──");
  const qrRes = await new Promise((resolve, reject) => {
    const http = require("http");
    const req = http.get(`http://localhost:${process.env.PORT}/api/qr?url=${encodeURIComponent("http://localhost:3555/player/?code=TEST12")}`, res => {
      let body = "";
      res.on("data", d => body += d);
      res.on("end", () => resolve({ status: res.statusCode, ct: res.headers["content-type"], body }));
    });
    req.on("error", reject);
  });
  assert(qrRes.status === 200, "QR-Test: GET /api/qr gibt HTTP 200");
  assert(qrRes.ct && qrRes.ct.includes("svg"), "QR-Test: Content-Type ist image/svg+xml");
  assert(qrRes.body.includes("<svg"), "QR-Test: Body enthaelt SVG-Markup");

  // ─────────────────────────────────────────────────────
  // 9) v2 SQLite-Highscore-Test
  // ─────────────────────────────────────────────────────
  console.log("\n── Highscore-Test ──");
  const hsRes = await new Promise((resolve, reject) => {
    const http = require("http");
    const req = http.get(`http://localhost:${process.env.PORT}/api/highscores`, res => {
      let body = "";
      res.on("data", d => body += d);
      res.on("end", () => resolve({ status: res.statusCode, json: JSON.parse(body) }));
    });
    req.on("error", reject);
  });
  assert(hsRes.status === 200, "Highscore-Test: GET /api/highscores gibt HTTP 200");
  assert(Array.isArray(hsRes.json) && hsRes.json.length >= 2, `Highscore-Test: mind. 2 Eintraege vorhanden (${hsRes.json.length})`);
  const hsBlau = hsRes.json.find(r => r.name === "Micha");
  assert(hsBlau && hsBlau.score === expectedBlau, `Highscore-Test: Blau-Score korrekt in DB (${hsBlau ? hsBlau.score : "nicht gefunden"})`);
  const hsWinner = hsRes.json.find(r => r.name === "Micha");
  assert(hsWinner && hsWinner.is_winner === 1, "Highscore-Test: Gewinner-Flag korrekt gesetzt");

  console.log(`\n── Ergebnis: ${passed} bestanden, ${failed} fehlgeschlagen ──`);
  clearTimeout(timeout);
  process.exit(failed > 0 ? 1 : 0);
})().catch(e => { console.error("❌ Test-Crash:", e); process.exit(1); });