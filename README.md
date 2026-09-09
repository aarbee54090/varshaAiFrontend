# Personal AI Assistant — Frontend

Static chat interface for the personal AI assistant backend, running on
its **own port**, separate from the backend API.

## Structure

```
index.html   Page structure: sidebar (priority/goals/tasks) + conversation feed
styles.css   Ink background, single amber accent, quiet sidebar, chat bubbles
app.js       All logic: fetch calls to the backend, feed merging/polling
server.js    Minimal static file server (just serves the three files above)
```

## Voice input/output

Click the 🎤 button once — it records until you stop talking (auto-detects
~1.5s of silence, no need to click again), transcribes via the backend's
`/api/voice/transcribe` (Groq Whisper), sends the text through the normal
message pipeline, and speaks the reply back.

Text-to-speech runs **entirely in your browser** via
[`kokoro-js`](https://www.npmjs.com/package/kokoro-js) — no server, no
Docker, no separate deployment. The first time you use voice, it downloads
a ~86MB model (quantized) via WebAssembly; your browser caches it after
that, so it's instant on later visits. This preloads automatically when
the page loads, so it's usually ready before you need it.

## Setup

This must run **alongside** the backend, as two separate processes on two
separate ports.

```bash
cp .env.example .env   # optional, defaults to port 5173
npm install
npm run dev
```

Open **http://localhost:5173**.

Make sure the backend is also running (default `http://localhost:3000`)
— `app.js` has the backend's URL hardcoded near the top:

```js
const API = 'http://localhost:3000/api';
```

Change that line if your backend runs on a different host/port.

## Why two servers instead of one

The backend serves a plain REST API with CORS enabled (`cors()` in
`app.js`), so any frontend — this one, a future React rewrite, a mobile
app — can talk to it from a different origin. Keeping them as separate
processes also means you can restart/redeploy either one independently.
