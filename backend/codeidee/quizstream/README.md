# QuizStream — Second-Screen Quiz mit echtem HLS-Video-Stream

Der Fernseher spielt einen **echten Live-Video-Stream** (HLS) ab — kein Screen
Mirroring, kein Receiver-HTML. FFmpeg rendert die Quizfragen serverseitig
direkt ins Video. Die Handys sind das Eingabegerät (Socket.io).

## Stack (Caveman Style)

- Node.js + Express + Socket.io — sonst nichts
- FFmpeg (System-Binary) rendert das TV-Bild: Hintergrund, Boxen und Text
  per `drawtext` mit `reload=1` — der Server schreibt nur Textdateien um
- Kein Build-Step, Vanilla JS Frontends

## Start

```bash
npm install
node server.js          # braucht ffmpeg im PATH
```

- **Host Dashboard:** `http://<LAN-IP>:3000/host.html`
- **Handy (Spieler):** `http://<LAN-IP>:3000/mobile.html`
- **TV-Stream (HLS):** `http://<LAN-IP>:3000/hls/stream.m3u8`

## Auf den TV bringen (Chromecast)

Drei Wege, alle nutzen den Standard-HLS-Stream:

1. **Cast-Button im Host-Dashboard** — nutzt den Google Cast Default Media
   Receiver und lädt die Stream-URL. (Cast SDK braucht Chrome; die Seite muss
   über `localhost` oder HTTPS laufen, sonst blockiert Chrome das SDK.)
2. **VLC:** Stream-URL öffnen → Wiedergabe → Renderer → Chromecast wählen.
3. Jede App, die HLS-URLs casten kann (z. B. "Web Video Cast").

Der Chromecast lädt die Segmente **direkt vom Server** (CORS ist gesetzt) —
Handy/Laptop müssen danach nicht an bleiben.

## Sync-Konzept (der wichtige Teil)

HLS hat bauartbedingt **3–8 Sekunden Latenz** (Segmentierung + Player-Buffer).
Deshalb ist der **Server die Single Source of Truth** für alles Timing:

```
t0                    Server rendert Frage ins Video (FFmpeg)
t0 + STREAM_DELAY     Frage erscheint (dank Latenz) jetzt auf dem TV
                      → genau jetzt schickt der Server die Frage an die Handys
                      → Antwortfenster öffnet
t0 + STREAM_DELAY + duration
                      Antwortfenster zu, Auflösung auf TV + Handys
```

- Antworten vor `t0 + STREAM_DELAY` oder nach Fensterende lehnt der Server ab.
- `correctAnswer` verlässt den Server **nie** vor dem Reveal (per Smoke-Test
  mit Leak-Detektor abgesichert).
- Punkte: 100 Basis + bis zu 100 Speed-Bonus (linear nach Restzeit),
  berechnet mit Server-Zeitstempeln — Client-Uhren sind egal.

### Kalibrierung

`STREAM_DELAY` (Default 6000 ms) an die echte Latenz deines Setups anpassen:

```bash
STREAM_DELAY=8000 node server.js
```

Faustregel: Quiz starten, stoppen wie lange die Frage bis zum TV braucht,
Wert setzen. Muss nicht exakt sein — das Antwortfenster ist serverseitig,
nur das *Gefühl* der Gleichzeitigkeit hängt davon ab.

## Konfiguration

| Env | Default | Bedeutung |
|---|---|---|
| `PORT` | 3000 | HTTP-Port |
| `STREAM_DELAY` | 6000 | Angenommene HLS-Latenz in ms |
| `QUESTIONS_FILE` | questions.json | Fragen-Datei |
| `FONT_FILE` | DejaVuSans-Bold | Font für drawtext |
| `STREAM_DISABLED` | – | `1` = kein FFmpeg (für Tests) |

## Fragenformat (`questions.json`)

```json
{
  "questionId": "q1",
  "text": "Was ist die Hauptstadt von Deutschland?",
  "options": ["Berlin", "Paris", "Rom", "Madrid"],
  "correctAnswer": 0,
  "duration": 15
}
```

## Socket.io Events

**Spieler → Server:** `player_join {name}`, `answer {questionId, selectedOption}` (mit Ack-Callback)
**Server → Spieler:** `question_start {questionId, text, options, index, total, endsAt, serverNow}` (ohne Lösung!), `answer_result {correctIndex, correct, gained}`, `scoreboard`, `quiz_finished {ranking}`, `back_to_lobby`
**Host → Server:** `host_join`, `start_quiz`, `next_question`, `end_quiz`, `reset_quiz`
**Server → Host:** `host_state` (kompletter Zustand inkl. Antwortzähler live)

State Machine: `LOBBY → QUESTION → REVEAL → (next) → … → FINISHED`

## Tests

```bash
npm test
```

21 Assertions gegen den echten Server (Socket.io-Client), inkl.
Leak-Detektor: jedes Event an Spieler wird auf `correctAnswer`/`correctIndex`
vor dem Reveal geprüft. Läuft ohne FFmpeg (`STREAM_DISABLED=1`).

## Skalierung & Grenzen (ehrlich)

- **Zuschauer skalieren gut:** HLS ist statisches File-Serving; für viele TVs
  einfach die `/hls`-Dateien hinter einen Reverse-Proxy/CDN legen.
- **Spieler:** Socket.io schafft auf einer kleinen Node-Instanz problemlos
  hunderte gleichzeitige Antworten (die Events sind winzig).
- **Ein Quiz pro Server-Instanz** (MVP). Räume/Multi-Session wäre v2.
- **HLS-Latenz bleibt.** Für <1 s Latenz wäre ein Custom Cast Receiver
  (HTML-App auf dem Chromecast + WebSocket) der richtige Weg — das wäre
  weiterhin kein Screen Mirroring, aber eben kein Video-Stream. Das
  Sync-Konzept hier macht die Latenz für den Quiz-Flow unsichtbar.
- Kein Reconnect-Handling im MVP (Spieler fliegt bei Disconnect raus).

## v2-Ideen

Reconnect-Tokens, QR-Code in der Lobby (im Video gerendert), Highscore-
Persistenz (SQLite), Umfrage-Fragetyp ohne richtige Antwort, mehrere Räume.
