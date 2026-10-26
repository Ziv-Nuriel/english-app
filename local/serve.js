// Tiny static server so Chrome treats the app as http://localhost:8137 ג€”
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
// Stages and accents the learner can pick; the page reads the same file.
const TOPICS_FILE = path.join(ROOT, "voice-topics.json");
const LIVE_BASE_PROMPT = `You are a friendly English conversation partner for a native Hebrew speaker who is practicing spoken English.

How you speak:
- Sound like a real person chatting with a friend, not a robot, a teacher or a customer-service agent.
- Vary your pace like a real person, never one steady speed: speed up a little on easy, excited or casual bits, slow down on key words, new words and questions, and take short natural pauses to think ("hmm...", "um", "you know..."). Overall stay easy to follow.
- Use real, expressive intonation: let your voice rise and fall, laugh, sound surprised, curious or excited when it fits. Never flat or monotone.
- Never cut the learner off. They are learning and often pause in the middle of a sentence to find a word; wait until they have clearly finished. If what they said sounds unfinished, just give a tiny nudge ("Mm-hm?", "Go on...") and let them continue.
- Use simple, casual street-level English: the basic everyday words people really say ("cool", "really?", "no way", "yeah", "kind of", "gonna", "wanna"). No fancy or formal words, no long sentences.
- Keep each turn very short: one or two simple sentences, then stop and let the learner talk.
- Ask lots of simple, easy questions ("Do you like it?", "Where do you live?", "What did you eat today?"), one question at a time.
- Give simple, short answers when the learner asks you something.

Correcting mistakes:
- When the learner makes a grammar, word-choice or pronunciation mistake, fix it casually in a few words, the way a friend would, then keep chatting. For example: "Oh nice! You mean 'I went there yesterday'. So what did you do there?"
- Correct at most one or two important mistakes per turn. Don't correct every small slip, and never lecture.
- Watch for errors typical of Hebrew speakers: missing "do/does/did" in questions, missing articles (a/the), wrong prepositions, present tense instead of present perfect, word order in questions.

Language:
- Speak English only. If the learner speaks Hebrew or is stuck, you may give a very short Hebrew hint (a word or two), then return to English.
- Be warm, fun and encouraging.`;

// Builds the locked session setup for one stage + accent.
function liveSetup(stage, accent) {
  const prompt = `${LIVE_BASE_PROMPT}

Accent:
- ${accent.instruction}

Today's role-play (stage: ${stage.title}):
- ${stage.scenario} Stay in this role for the whole conversation.
- Practice focus: ${stage.focus}
- Pay special attention to mistakes related to this focus.
- Start by greeting the learner in character and setting the scene in one or two short sentences, then invite them to speak.`;
  return {
    model: LIVE_MODEL,
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: accent.voice } } },
    },
    systemInstruction: { parts: [{ text: prompt }] },
    // Room noise must not count as speech: start less eagerly, and keep end
    // sensitivity HIGH (LOW lets background noise hold the turn open forever,
    // so the partner never replies). Learners pause mid-sentence to find
    // words, but a longer wait (1-1.6 s) also kept the turn open in noisy rooms,
    // so end it after 0.7 s; the prompt tells the partner to wait if unfinished.
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
}

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

  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  let choice = {};
  try { choice = JSON.parse(Buffer.concat(chunks).toString() || "{}"); } catch (e) {}
  const topics = JSON.parse(fs.readFileSync(TOPICS_FILE, "utf8"));
  const stage = (Number.isInteger(choice.stage) && topics.stages[choice.stage]) || topics.stages[0];
  const accent = topics.accents.find(a => a.id === choice.accent) || topics.accents[0];
  const setup = liveSetup(stage, accent);

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
      bidiGenerateContentSetup: setup,
      fieldMask: fieldMask(setup),
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
    setup, // the token enforces these fields anyway
  });
}

// --- Accent samples ------------------------------------------------------
// A short clip per accent, so the learner can hear it before starting.
// Generated once with the same Live model, voice and accent instruction as
// a real conversation, then cached on disk (keyed by voice + instruction,
// so editing an accent regenerates it).
const SAMPLES_DIR = path.join(__dirname, "accent-samples");
const SAMPLE_TEXT = "Hi there! This is how I sound. Let's practice English together.";
const samplesInProgress = new Map();

function wavFile(pcm, rate) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0); header.writeUInt32LE(36 + pcm.length, 4); header.write("WAVE", 8);
  header.write("fmt ", 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write("data", 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

function generateSample(accent, key) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket("wss://generativelanguage.googleapis.com/ws/" +
      `google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${encodeURIComponent(key)}`);
    const chunks = [];
    const timer = setTimeout(() => { ws.close(); reject(new Error("Sample generation timed out")); }, 30000);
    ws.onopen = () => ws.send(JSON.stringify({ setup: {
      model: LIVE_MODEL,
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: accent.voice } } },
      },
      systemInstruction: { parts: [{ text: `${LIVE_BASE_PROMPT}

Accent:
- ${accent.instruction}

This is a short voice sample. When you receive a sentence, say exactly that sentence, word for word, and nothing else.` }] },
    } }));
    ws.onmessage = async ev => {
      const msg = JSON.parse(typeof ev.data === "string" ? ev.data : await ev.data.text());
      if (msg.setupComplete) ws.send(JSON.stringify({ realtimeInput: { text: SAMPLE_TEXT } }));
      const c = msg.serverContent;
      for (const part of (c && c.modelTurn && c.modelTurn.parts) || []) {
        if (part.inlineData && part.inlineData.data) chunks.push(Buffer.from(part.inlineData.data, "base64"));
      }
      if (c && c.turnComplete) {
        clearTimeout(timer);
        ws.close(1000);
        chunks.length ? resolve(wavFile(Buffer.concat(chunks), 24000)) : reject(new Error("No audio in sample"));
      }
    };
    ws.onclose = ev => {
      clearTimeout(timer);
      reject(new Error(ev.reason || `Connection closed (${ev.code})`));
    };
  });
}

async function handleAccentSample(req, res) {
  const fail = (status, error) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error }));
  };
  if (!ALLOWED_ORIGINS.includes(req.headers.origin) && !ALLOWED_ORIGINS.some(o => (req.headers.referer || "").startsWith(o + "/"))) {
    return fail(403, "Forbidden origin");
  }
  const id = new URL(req.url, "http://localhost").searchParams.get("accent");
  const topics = JSON.parse(fs.readFileSync(TOPICS_FILE, "utf8"));
  const accent = topics.accents.find(a => a.id === id);
  if (!accent) return fail(404, "Unknown accent");

  const hash = require("crypto").createHash("sha1").update(accent.voice + "|" + accent.instruction + "|" + SAMPLE_TEXT).digest("hex").slice(0, 10);
  const file = path.join(SAMPLES_DIR, `${accent.id}-${hash}.wav`);
  if (!fs.existsSync(file)) {
    const key = geminiKey();
    if (!key) return fail(503, "Missing GEMINI_API_KEY: fill it in the .env file");
    if (!samplesInProgress.has(file)) {
      samplesInProgress.set(file, generateSample(accent, key).then(wav => {
        fs.mkdirSync(SAMPLES_DIR, { recursive: true });
        for (const old of fs.readdirSync(SAMPLES_DIR)) {
          if (old.startsWith(accent.id + "-")) fs.unlinkSync(path.join(SAMPLES_DIR, old));
        }
        fs.writeFileSync(file, wav);
      }).finally(() => samplesInProgress.delete(file)));
    }
    await samplesInProgress.get(file);
  }
  res.writeHead(200, { "Content-Type": "audio/wav", "Cache-Control": "no-cache" });
  res.end(fs.readFileSync(file));
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
  if (req.url.split("?")[0] === "/api/accent-sample") {
    handleAccentSample(req, res).catch(err => {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(err.message || err) }));
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
