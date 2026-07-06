# QuizCast - 8-Bit 2-Spieler Quiz

Ein kleines Arcade-Quiz fuer Chrome, Chromecast und Browser-Fallback.
Node.js, Express und Socket.io sind die Arcade-Maschine dahinter.
Der Server ist die Single Source of Truth: Timer, Punkte und Antwort-Pruefung laufen serverseitig.

## Start

```bash
npm install
npm start
```

Dann im Browser:

- Host: http://localhost:3000/host/
- Spieler: http://localhost:3000/player/
- TV/Fallback: http://localhost:3000/receiver/?code=XXXXXX

## Was schon laeuft

Der Browser-zu-Browser-Weg funktioniert bereits.
Du brauchst dafuer kein Render und keinen Chromecast.
Der Host erstellt einen Raum, Spieler joinen per Code, und der Receiver kann im normalen Browser als TV laufen.

## So laeuft das Spiel

1. Host startet das Spiel und bekommt einen 6-stelligen Code.
2. Zwei Spieler joinen ueber den Player-Link.
3. Blau waehlt die Kategorie.
4. Der Server laedt 5 Fragen nach und rechnet die Punkte.
5. Am Ende werden Sieger und Highscores gezeigt.

## Wenn du echtes Chrome-Casting willst

Fuer Chromecast reicht lokales localhost nicht.
Du brauchst eine HTTPS-URL, also zum Beispiel Render, Fly.io oder einen anderen HTTPS-Host.

Pflichtpunkte:

1. App per HTTPS deployen.
2. In der Google Cast Developer Console eine Custom Receiver App anlegen.
3. Als Receiver-URL deine HTTPS-Adresse eintragen, zum Beispiel `https://DEINE-DOMAIN/receiver/`.
4. Die erhaltene Cast App ID in `frontend/host/index.html` eintragen oder als `CAST_APP_ID` im Deployment setzen.
5. Den Host neu laden und den Cast-Button testen.

Kurz gesagt:

- Browser-zu-Browser = sofort lokal spielbar.
- Chromecast = HTTPS + Cast App ID + Receiver-URL.

## 8-Bit-Style

Die UI ist bewusst als kleine Retro-Arena gebaut.

- Press-Start-2P-Schrift
- CRT-Scanlines
- Blau und Rot als Teamfarben
- Grobe Pixel-Kanten statt glatter App-Optik
- Getrennte Screens fuer Host, Player und TV

## Testen

```bash
npm test
```

Der Smoke-Test prueft:

- create_game
- 2x join_game
- join_as_spectator
- start_game
- Kategorieauswahl
- Fragen-Loop
- Reconnect
- Kick-Funktion
- QR-Code-Endpoint
- Highscore-Endpoint

## Troubleshooting

- Wenn Cast nicht startet, fehlt meist HTTPS oder die Cast App ID.
- Wenn der Receiver im Browser nicht kommt, pruefe den code in der URL.
- Wenn der TV nichts zeigt, lade zuerst den Host und dann den Receiver neu.
- Wenn du nur lokal testen willst, nutze den Browser-Fallback mit /receiver/?code=XXXXXX.

## Projektstruktur

- backend/server.js - HTTP-Server, Socket-Events, QR und Highscores
- backend/game/gameRoom.js - Spiellogik und Zustandsmaschine
- frontend/host/index.html - Host-Arena und Cast-Start
- frontend/player/index.html - Spieler-Client
- frontend/receiver/index.html - TV-Ansicht und Browser-Fallback
- test/smoke.js - End-to-End-Smoke-Test
