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

SPEAKING SPEED (most important):
- Speak SLOWLY, about 25% slower than a normal native speaker. Leave a short pause between phrases and after commas, and stretch the key word in each sentence a little.
- Keep this slow pace in every single turn, from the first word to the last. Never speed up.

How you speak:
- Sound like a real person chatting with a friend, not a robot, a teacher or a customer-service agent.
- Be calm and relaxed, like a person chatting on the couch. Speak slowly: clearly slower than normal conversation, the way you'd talk to a friend who is still learning English, with small gaps between phrases. Never rush, and don't speed up as the conversation goes on.
- Vary your pace a little like a real person, not one fixed speed: slow down on key words, new words and questions, and take short natural pauses to think ("hmm...", "um", "you know...").
- Your baseline is calm and low-key, never hyped, bubbly or "presenter" energy.
- Calm is not monotone: use real, varied intonation the way people do. Your voice goes up on questions and down at the end of statements, and you clearly stress the one or two words that matter in each sentence: say them a little louder, longer and higher, sometimes with a tiny pause just before them ("I went there... *last* summer.", "It was *really* hot."). Some sentences sound warmer, softer or more thoughtful than others. Never say every sentence in the same tone or melody.
- Excitement comes only in small doses: now and then, put a little extra energy on a single word or a short phrase ("Oh, that's *so* cool.", "Wait, *really*?"), then go straight back to calm. Most turns have no excitement at all, and don't call everything "amazing" or "awesome".
- Mirror the learner's voice: match their mood, energy, pace and tone, like mirror neurons. If they sound calm or tired, be calm and soft; if they sound happy or excited, you can lift your energy a bit; if they speak slowly, slow down with them; if they sound serious or sad, be gentle and serious.
- Never cut the learner off. They are learning and often pause in the middle of a sentence to find a word; wait until they have clearly finished. If what they said sounds unfinished, just give a tiny nudge ("Mm-hm?", "Go on...") and let them continue.
- Use simple, casual street-level English: the basic everyday words people really say ("cool", "really?", "no way", "yeah", "kind of", "gonna", "wanna"). No fancy or formal words, no long sentences.
- Keep every turn short: usually one or two short sentences, never a long answer or a list. If you have more to say, say one thing and keep the rest for later.
- Talk like a real friend, not an interviewer: don't ask a question every turn. Often just react ("Oh, nice.", "Yeah, me too.", "Ha, that's funny.") and share a little about yourself ("I love that place, I go there every summer."), then let the learner pick it up.
- Ask a question only now and then (roughly every second or third turn), one simple question at a time.
- When the learner asks you something, answer it simply and briefly, in a sentence or two.

Correcting mistakes:
- When the learner makes a grammar, word-choice or pronunciation mistake, fix it casually in a few words, the way a friend would, then keep chatting. For example: "Oh, you mean 'I went there yesterday'. So what did you do there?"
- Correct at most one or two important mistakes per turn. Don't correct every small slip, and never lecture.
- Watch for errors typical of Hebrew speakers: missing "do/does/did" in questions, missing articles (a/the), wrong prepositions, present tense instead of present perfect, word order in questions.

Language:
- Speak English only. If the learner speaks Hebrew or is stuck, you may give a very short Hebrew hint (a word or two), then return to English.
- Be warm, easygoing and encouraging.`;

// Builds the locked session setup for one stage + accent.
function liveSetup(stage, accent) {
  const prompt = `${LIVE_BASE_PROMPT}

Accent:
- ${accent.instruction}

Today's role-play (stage: ${stage.title}):
- ${stage.scenario} Stay in this role for the whole conversation.
- Practice focus: ${stage.focus}
- Pay special attention to mistakes related to this focus.

How to start:
- The learner opens the conversation. Wait for them to speak first, then reply to exactly what they said, like a real person, with short, friendly small talk (e.g. if they ask how you are, answer and ask back; if they just say hi, say hi and ask how they are). Do NOT jump straight into your story, your opinions or the practice topic.

Let the learner lead:
- Follow the learner's lead: talk about what THEY bring up and react to what they actually said. Don't change the subject or push your own topics.
- Keep a natural give-and-take: react to their answers and share a short bit of your own life, and only sometimes follow up with a simple question ("Oh really? Why?"). The learner should still do most of the talking.
- Bring in your role-play story and the practice focus only in small bits, naturally, when it fits what they are saying, and answer fully when they ask you something.
- If the learner goes quiet or seems stuck, give a tiny nudge with one easy question, nothing more.

This is a voice call only:
- The learner can only hear you. You cannot see each other, and there is no camera, screen or chat.
- Never ask the learner to look at, show or react to a photo, picture, video, link, map or anything visual. If something visual is part of your story, describe it in words instead.`;
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
// a real conversation, then cached on disk (keyed by voice + instructions,
// so editing an accent or the base prompt regenerates it).
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

  const hash = require("crypto").createHash("sha1").update(accent.voice + "|" + accent.instruction + "|" + SAMPLE_TEXT + "|" + LIVE_BASE_PROMPT).digest("hex").slice(0, 10);
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

// --- Unseen: reading text + comprehension questions ----------------------
// The learner picks a field and a subject (or types their own); Gemini writes
// a short article about it plus multiple-choice questions, as structured JSON.
// gemini-3.8-flash (and flash-latest) took 3-5 minutes per request on
// 2026-11-07; 3.5-flash with low thinking writes an exercise in seconds.
// When a model is busy ("high demand"), the next one in the list is tried.
const UNSEEN_MODELS = ["models/gemini-3.5-flash", "models/gemini-3.5-flash-lite"];
const UNSEEN_LEVELS = {
  easy: "CEFR A2: short simple sentences, very common everyday words, about 150-180 words",
  medium: "CEFR B1: clear sentences, common vocabulary with a few new words, about 220-260 words",
  hard: "CEFR B2: richer vocabulary and some complex sentences, about 300-350 words",
};
const UNSEEN_SCHEMA = {
  type: "OBJECT",
  properties: {
    title: { type: "STRING" },
    paragraphs: { type: "ARRAY", items: { type: "STRING" } },
    glossary: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: { word: { type: "STRING" }, hebrew: { type: "STRING" } },
        required: ["word", "hebrew"],
      },
    },
    questions: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          question: { type: "STRING" },
          options: { type: "ARRAY", items: { type: "STRING" } },
          answer: { type: "INTEGER" },
          quote: { type: "STRING" },
          explanation: { type: "STRING" },
        },
        required: ["question", "options", "answer", "quote", "explanation"],
      },
    },
  },
  required: ["title", "paragraphs", "glossary", "questions"],
};

function unseenPrompt(field, subject, level, avoid) {
  return `Write an "Unseen" reading-comprehension exercise in English for a native Hebrew speaker (Israeli high-school / adult learner).

Field: ${field}
Specific subject: ${subject || "(none given: choose an interesting, specific subject within the field)"}
Level: ${UNSEEN_LEVELS[level]}
${avoid ? `The learner already read an article titled "${avoid}" on this subject: write a new one about a different side of it, with a different title.
` : ""}
The text:
- An interesting, informative article about the subject, written for this level, in 3-5 paragraphs, with a short title.
- If the subject is a real person, company, team or event, use only well-known, widely reported facts. Do not invent quotes, numbers or dates; if you are not sure of an exact detail, leave it out or keep it general.
- The field and subject may be written in Hebrew (the learner typed them). Understand them and write about exactly that subject (for example a specific team, person or place), not a general article about the field.
- If the subject is inappropriate or makes no sense, write about the closest sensible, appropriate subject in the field.

The questions (exactly 6, in the order the answers appear in the text):
- Mix the types: main idea, specific details, vocabulary in context ("The word X in paragraph 2 means..."), reference ("'it' in line ... refers to..."), cause/effect and one inference question.
- Each question has exactly 4 options in English; only one is correct, and the wrong ones are plausible.
- "answer" is the 0-based index of the correct option. Spread the correct answers across positions.
- "quote" is the exact sentence from the text (copied word for word) that proves the answer.
- "explanation" is 1-2 short sentences IN HEBREW explaining why that answer is correct.

The glossary (the learner taps these words in the text to see the translation):
- Every word or phrase in the text that is harder than CEFR B1 (B2, C1 or C2), up to 12. If there are fewer than 5 such words, add the hardest B1 words until there are 5.
- "word" is copied exactly as it appears in the text (same form, e.g. "strides", not "stride").
- "hebrew" is a short Hebrew translation that fits its meaning in this text.`;
}

// Podcast: the same exercise, but a longer spoken episode that is turned
// into audio. Lengths are for listening (about 130-150 spoken words a minute).
const PODCAST_LEVELS = {
  easy: "CEFR A2: short simple sentences, very common everyday words, about 380-420 words (about 3 minutes)",
  medium: "CEFR B1: clear sentences, common vocabulary with a few new words, about 600-650 words (about 4-5 minutes)",
  hard: "CEFR B2: richer vocabulary and some longer sentences, about 800-850 words (about 6 minutes)",
};

function podcastPrompt(field, subject, level, avoid, voice) {
  return `Write a "listening comprehension" podcast episode in English for a native Hebrew speaker (Israeli high-school / adult learner).

Field: ${field}
Specific subject: ${subject || "(none given: choose an interesting, specific subject within the field)"}
Level: ${PODCAST_LEVELS[level]}
${avoid ? `The learner already heard an episode titled "${avoid}" on this subject: write a new one about a different side of it, with a different title.
` : ""}
The episode:
- One host, a ${voice === "male" ? "man" : "woman"} with a first name, talking alone to the listener, like a real, friendly educational podcast.
- It is spoken, not written: natural spoken English with contractions, short sentences, signposting ("So, here's the thing...", "Now, you might be wondering..."), a rhetorical question now and then, and a short personal comment or two. No sound effects, stage directions, music cues, brackets or speaker labels — only the words the host says.
- Start with a short welcome and the topic of the episode, then 3-4 main parts, then a short recap and goodbye.
- 8-12 paragraphs (each paragraph is read as one block of audio). "title" is the episode name.
- If the subject is a real person, company, team or event, use only well-known, widely reported facts. Do not invent quotes, numbers or dates; if you are not sure of an exact detail, leave it out or keep it general.
- The field and subject may be written in Hebrew (the learner typed them). Understand them and talk about exactly that subject, not a general episode about the field.
- If the subject is inappropriate or makes no sense, talk about the closest sensible, appropriate subject in the field.

The questions (exactly 8, in the order the answers come up in the episode):
- These are listening questions: refer to what "the host says", never to paragraph or line numbers.
- Mix the types: main idea, specific details, vocabulary in context ("When the host says X, she/he means..."), the host's opinion or attitude, cause/effect and one inference question.
- Each question has exactly 4 options in English; only one is correct, and the wrong ones are plausible.
- "answer" is the 0-based index of the correct option. Spread the correct answers across positions.
- "quote" is the exact sentence from the episode (copied word for word) that proves the answer.
- "explanation" is 1-2 short sentences IN HEBREW explaining why that answer is correct.

The glossary (the learner taps these words in the transcript to see the translation):
- Every word or phrase in the episode that is harder than CEFR B1 (B2, C1 or C2), up to 14. If there are fewer than 5 such words, add the hardest B1 words until there are 5.
- "word" is copied exactly as it appears in the episode (same form).
- "hebrew" is a short Hebrew translation that fits its meaning in this episode.`;
}

// Text-to-speech. gemini-3.8-flash-tts answered in ~7 s on 2026-11-07 (unlike
// the 3.8 text model); the older TTS models are the fallback when it's busy.
const PODCAST_TTS_MODELS = ["models/gemini-3.8-flash-tts", "models/gemini-3.1-flash-tts-preview", "models/gemini-2.5-flash-preview-tts"];
const PODCAST_VOICES = { female: "Aoede", male: "Charon" };
const PODCAST_DIR = path.join(__dirname, "podcast-audio");
const PODCAST_KEEP = 30; // newest episodes kept on disk

// Returns { rate, pcm } (16-bit mono) from a TTS inlineData part: either a
// WAV file or raw little-endian PCM labelled audio/L16 with a rate parameter.
function ttsPcm(inline) {
  const buf = Buffer.from(inline.data, "base64");
  if (buf.slice(0, 4).toString() === "RIFF") {
    let rate = 24000, pos = 12;
    while (pos + 8 <= buf.length) {
      const id = buf.slice(pos, pos + 4).toString(), size = buf.readUInt32LE(pos + 4);
      if (id === "fmt ") rate = buf.readUInt32LE(pos + 12);
      if (id === "data") return { rate, pcm: buf.slice(pos + 8, pos + 8 + size) };
      pos += 8 + size + (size % 2);
    }
    throw new Error("WAV without data");
  }
  const m = /rate=(\d+)/i.exec(inline.mimeType || "");
  return { rate: m ? Number(m[1]) : 24000, pcm: buf };
}

async function speakPart(text, voiceName, key) {
  const body = JSON.stringify({
    contents: [{ parts: [{ text: `Read this aloud as a friendly podcast host: warm, relaxed and natural, clearly and a little slower than normal, for English learners. Say only the text after the colon:

${text}` }] }],
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } },
    },
  });
  let lastError = "";
  for (const model of PODCAST_TTS_MODELS) {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/${model}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body,
      signal: AbortSignal.timeout(90000),
    });
    const data = await response.json().catch(() => ({}));
    const parts = (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
    const inline = parts.map(p => p.inlineData).find(Boolean);
    if (response.ok && inline) return ttsPcm(inline);
    lastError = (data.error && data.error.message) || `Speech failed (${response.status})`;
    if (response.ok || ![429, 500, 503].includes(response.status)) break;
  }
  throw new Error(lastError);
}

// The free tier allows only a few TTS requests a minute, so the episode is
// recorded in as few requests as possible: one per ~450 words (a 600-word
// episode took one 33 s request on 2026-11-07), sent one after another.
const PODCAST_WORDS_PER_REQUEST = 450;

async function recordPodcast(paragraphs, voice, key) {
  const voiceName = PODCAST_VOICES[voice];
  const id = require("crypto").createHash("sha1").update(voiceName + "|" + paragraphs.join("\n")).digest("hex").slice(0, 16);
  const file = path.join(PODCAST_DIR, id + ".wav");
  if (fs.existsSync(file)) return id;
  const groups = [];
  let words = Infinity;
  for (const p of paragraphs) {
    const n = p.split(/\s+/).length;
    if (words + n > PODCAST_WORDS_PER_REQUEST) { groups.push([]); words = 0; }
    groups[groups.length - 1].push(p);
    words += n;
  }
  const pieces = [];
  for (const g of groups) pieces.push(await speakPart(g.join("\n\n"), voiceName, key));
  const rate = pieces[0].rate;
  if (pieces.some(p => p.rate !== rate)) throw new Error("Audio parts came back at different sample rates");
  const pause = Buffer.alloc(Math.round(rate * 0.5) * 2);
  const pcm = Buffer.concat(pieces.flatMap((p, i) => (i ? [pause, p.pcm] : [p.pcm])));
  fs.mkdirSync(PODCAST_DIR, { recursive: true });
  fs.writeFileSync(file, wavFile(pcm, rate));
  const old = fs.readdirSync(PODCAST_DIR).filter(n => n.endsWith(".wav"))
    .map(n => ({ n, t: fs.statSync(path.join(PODCAST_DIR, n)).mtimeMs }))
    .sort((a, b) => b.t - a.t).slice(PODCAST_KEEP);
  for (const o of old) fs.unlinkSync(path.join(PODCAST_DIR, o.n));
  return id;
}

// Serves a recorded episode, with Range support so the player can seek.
function handlePodcastAudio(req, res) {
  const id = new URL(req.url, "http://localhost").searchParams.get("id") || "";
  const file = path.join(PODCAST_DIR, id + ".wav");
  if (!/^[0-9a-f]{16}$/.test(id) || !fs.existsSync(file)) { res.writeHead(404); res.end("Not found"); return; }
  const size = fs.statSync(file).size;
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
  if (m) {
    const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
    const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    if (start > end || start >= size) { res.writeHead(416, { "Content-Range": `bytes */${size}` }); res.end(); return; }
    res.writeHead(206, { "Content-Type": "audio/wav", "Accept-Ranges": "bytes", "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": end - start + 1 });
    fs.createReadStream(file, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, { "Content-Type": "audio/wav", "Accept-Ranges": "bytes", "Content-Length": size });
  fs.createReadStream(file).pipe(res);
}

async function handleUnseen(req, res) {
  const send = (status, body) => {
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(body));
  };
  if (req.method !== "POST") return send(405, { error: "Use POST" });
  if (!ALLOWED_ORIGINS.includes(req.headers.origin)) return send(403, { error: "Forbidden origin" });
  const key = geminiKey();
  if (!key) return send(503, { error: "Missing GEMINI_API_KEY: fill it in the .env file" });

  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  let choice = {};
  try { choice = JSON.parse(Buffer.concat(chunks).toString() || "{}"); } catch (e) {}
  const clean = v => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, 100) : "");
  const field = clean(choice.field);
  const subject = clean(choice.subject);
  const level = UNSEEN_LEVELS[choice.level] ? choice.level : "medium";
  const podcast = choice.kind === "podcast";
  const voice = choice.voice === "male" ? "male" : "female";
  if (!field && !subject) return send(400, { error: "Pick a field or a subject" });
  const prompt = podcast
    ? podcastPrompt(field || "General", subject, level, clean(choice.avoid), voice)
    : unseenPrompt(field || "General", subject, level, clean(choice.avoid));

  const body = JSON.stringify({
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: UNSEEN_SCHEMA,
      thinkingConfig: { thinkingLevel: "low" },
    },
  });
  let response, data;
  for (const model of UNSEEN_MODELS) {
    response = await fetch(`https://generativelanguage.googleapis.com/v1beta/${model}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body,
      signal: AbortSignal.timeout(60000),
    });
    data = await response.json().catch(() => ({}));
    if (![429, 500, 503].includes(response.status)) break;
  }
  if (!response.ok) {
    return send(502, { error: (data.error && data.error.message) || `Generation failed (${response.status})` });
  }
  const parts = (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
  let unseen;
  try { unseen = JSON.parse(parts.map(p => p.text || "").join("")); } catch (e) {}
  const questions = ((unseen && unseen.questions) || []).filter(q =>
    Array.isArray(q.options) && q.options.length === 4 && Number.isInteger(q.answer) && q.answer >= 0 && q.answer < 4);
  if (!unseen || !Array.isArray(unseen.paragraphs) || !unseen.paragraphs.length || !questions.length) {
    return send(502, { error: "The model returned an incomplete exercise, try again" });
  }
  const paragraphs = unseen.paragraphs.map(p => String(p).trim()).filter(Boolean);
  let audioId;
  if (podcast) {
    try {
      audioId = await recordPodcast(paragraphs, voice, key);
    } catch (err) {
      return send(502, { error: "Recording failed: " + (err.message || err) });
    }
  }
  send(200, { ...unseen, paragraphs, questions, glossary: unseen.glossary || [], audioId, voice: podcast ? voice : undefined });
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
  if (req.url.split("?")[0] === "/api/podcast-audio") {
    try { handlePodcastAudio(req, res); } catch (err) { res.writeHead(500); res.end(String(err)); }
    return;
  }
  if (req.url.split("?")[0] === "/api/unseen") {
    handleUnseen(req, res).catch(err => {
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
