// Tiny static server so Chrome treats the app as http://localhost:8137 —
// unlike file://, Chrome remembers the microphone permission for it.
const http = require("http");
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

const PORT = 8137;
const ROOT = path.resolve(__dirname, "..");
const KEY_FILE = path.join(__dirname, "api-key.txt");
const workerReady = import(pathToFileURL(path.join(ROOT, "worker", "index.js")).href);
const ENV_FILE = path.join(ROOT, ".env");
const ALLOWED_ORIGINS = [`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`];

// --- Gemini Live: ephemeral tokens --------------------------------------
// The browser never sees GEMINI_API_KEY. It asks /api/live-token for a
// short-lived, single-use token that is locked to the model and settings
// below, and opens the Live WebSocket with that token instead.
const LIVE_API_VERSION = "v1alpha"; // ephemeral tokens + constrained endpoint
const LIVE_MODEL = "models/gemini-3.8-live";
const LIVE_SESSION_SECONDS = 10 * 60;
const LIVE_SYSTEM_PROMPT = `You are a friendly English conversation partner for a native Hebrew speaker who is practicing spoken English.

How you speak:
- Speak clearly and a little slower than normal, with natural pauses between sentences.
- Use everyday vocabulary and short sentences. Keep each turn to 1-3 sentences, then give the learner room to talk.
- Ask open, simple follow-up questions to keep the conversation going.

Correcting mistakes:
- When the learner makes a grammar, word-choice or pronunciation mistake, correct it gently and briefly, then continue the conversation. For example: "Nice! We usually say 'I went there yesterday'. So, what did you do there?"
- Correct at most one or two important mistakes per turn. Don't correct every small slip, and never lecture.
- Watch for errors typical of Hebrew speakers: missing "do/does/did" in questions, missing articles (a/the), wrong prepositions, present tense instead of present perfect, word order in questions.

Language:
- Speak English only. If the learner speaks Hebrew or is stuck, you may give a very short Hebrew hint (a word or two), then return to English.
- Be warm and encouraging. Start by greeting the learner and asking what they would like to talk about.`;

const LIVE_SETUP = {
  model: LIVE_MODEL,
  generationConfig: {
    responseModalities: ["AUDIO"],
    speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Kore" } } },
  },
  systemInstruction: { parts: [{ text: LIVE_SYSTEM_PROMPT }] },
  // Room noise must not count as speech: start less eagerly, and end the
  // learner's turn after 0.7 s of quiet so the partner replies promptly.
  realtimeInputConfig: {
    automaticActivityDetection: {
      startOfSpeechSensitivity: "START_SENSITIVITY_LOW",
      endOfSpeechSensitivity: "END_SENSITIVITY_HIGH",
      prefixPaddingMs: 300,
      silenceDurationMs: 700,
    },
  },
  inputAudioTranscription: {},
  outputAudioTranscription: {},
};

// Same field-mask rule as the @google/genai SDK: lock every field set above
// (one level deep), leaving sessionResumption free for the client.
function fieldMask(setup) {
  return Object.entries(setup).flatMap(([key, value]) =>
    value && typeof value === "object" && Object.keys(value).length
      ? Object.keys(value).map(k => `${key}.${k}`)
      : [key]
  ).join(",");
}

// Read on every request, so filling in .env needs no server restart.
function geminiKey() {
  try {
    const match = fs.readFileSync(ENV_FILE, "utf8").match(/^\s*GEMINI_API_KEY\s*=\s*["']?([^"'\r\n]*)/m);
    if (match && match[1].trim()) return match[1].trim();
  } catch (e) {}
  return process.env.GEMINI_API_KEY || "";
}

async function handleLiveToken(req, res) {
  const send = (status, body) => {
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(body));
  };
  if (req.method !== "POST") return send(405, { error: "Use POST" });
  // Only this app's own pages may mint tokens.
  if (!ALLOWED_ORIGINS.includes(req.headers.origin)) return send(403, { error: "Forbidden origin" });
  const key = geminiKey();
  if (!key) return send(503, { error: "Missing GEMINI_API_KEY: fill it in the .env file" });

  const now = Date.now();
  const response = await fetch(`https://generativelanguage.googleapis.com/${LIVE_API_VERSION}/auth_tokens`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({
      uses: 1,
      // Long enough for a 10-minute session plus reconnects (session resumption
      // may reuse the token until it expires); must be started within 1 minute.
      expireTime: new Date(now + (LIVE_SESSION_SECONDS + 120) * 1000).toISOString(),
      newSessionExpireTime: new Date(now + 60 * 1000).toISOString(),
      bidiGenerateContentSetup: LIVE_SETUP,
      fieldMask: fieldMask(LIVE_SETUP),
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.name) {
    return send(502, { error: (data.error && data.error.message) || `Token request failed (${response.status})` });
  }
  send(200, {
    token: data.name,
    model: LIVE_MODEL,
    apiVersion: LIVE_API_VERSION,
    maxSeconds: LIVE_SESSION_SECONDS,
    setup: LIVE_SETUP, // the token enforces these fields anyway
  });
}

// The Anthropic key is read on every request, so pasting it into
// api-key.txt takes effect without restarting the server.
function apiKey() {
  try {
    const key = fs.readFileSync(KEY_FILE, "utf8").trim();
    if (key) return key;
  } catch (e) {}
  return process.env.ANTHROPIC_API_KEY || "";
}

// Runs the Cloudflare Worker's handler locally for /api/dialogue.
async function handleDialogue(req, res) {
  const key = apiKey();
  if (!key && req.method === "POST") {
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Missing API key: paste it into local/api-key.txt" }));
    return;
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const request = new Request("http://localhost" + req.url, {
    method: req.method,
    headers: req.headers,
    body: req.method === "POST" ? Buffer.concat(chunks) : undefined,
  });
  const worker = (await workerReady).default;
  const response = await worker.fetch(request, { ANTHROPIC_API_KEY: key });
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
};

http.createServer((req, res) => {
  if (req.url.split("?")[0] === "/api/dialogue") {
    handleDialogue(req, res).catch(err => {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(err) }));
    });
    return;
  }
  if (req.url.split("?")[0] === "/api/live-token") {
    handleLiveToken(req, res).catch(err => {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(err) }));
    });
    return;
  }
  let rel = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  if (rel.endsWith("/")) rel += "index.html";
  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT + path.sep)) { res.writeHead(403); res.end(); return; }
  // Never serve secrets: dotfiles (.env, .git) or the local/ folder (api-key.txt).
  const parts = path.relative(ROOT, file).split(path.sep);
  if (parts.some(part => part.startsWith(".")) || parts[0].toLowerCase() === "local") {
    res.writeHead(404); res.end("Not found"); return;
  }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end("Not found"); return; }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file).toLowerCase()] || "application/octet-stream", "Cache-Control": "no-cache" });
    res.end(data);
  });
}).listen(PORT, "127.0.0.1");
