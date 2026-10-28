// Real-time voice conversation (Gemini Live API, native audio) as a practice
// section of a stage. Usage:
//   VoiceChat.mount(containerEl, { stage, onFinish(talkedSeconds) })
//   VoiceChat.stop()   // ends any running conversation (e.g. on navigation)
// The page asks the local server (/api/live-token) for a single-use ephemeral
// token; the Gemini API key never reaches the browser.
(function () {
  const IN_RATE = 16000;   // Live API input: 16-bit PCM, 16 kHz
  const OUT_RATE = 24000;  // Live API output: 16-bit PCM, 24 kHz
  const CHUNK_SAMPLES = 1600; // 100 ms of mic audio per message
  // The model barely slows down when asked to, so the partner's voice is
  // time-stretched in the browser (same pitch, 12% slower).
  const PLAYBACK_SPEED = 0.88;

  // Noise gate: steady room noise (fans, hum) would keep the server's voice
  // detection "hearing speech" forever, so it would never reply. Below the
  // gate we send digital silence instead. The threshold follows the room's
  // noise floor, and the gate stays open briefly so word endings aren't cut.
  const GATE_MIN = 0.012, GATE_MAX = 0.08, GATE_RATIO = 2.5, GATE_HOLD_MS = 600;

  // AudioWorklet: converts mic audio (already at 16 kHz) to Int16 chunks.
  const CAPTURE_WORKLET = `
class PcmCapture extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Int16Array(${CHUNK_SAMPLES}); this.n = 0; }
  process(inputs) {
    const ch = inputs[0][0];
    if (ch) for (let i = 0; i < ch.length; i++) {
      const s = Math.max(-1, Math.min(1, ch[i]));
      this.buf[this.n++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      if (this.n === this.buf.length) {
        this.port.postMessage(this.buf.buffer, [this.buf.buffer]);
        this.buf = new Int16Array(${CHUNK_SAMPLES});
        this.n = 0;
      }
    }
    return true;
  }
}
registerProcessor("pcm-capture", PcmCapture);`;

  const CSS = `
  .vc-label { font-size: .8rem; font-weight: 600; color: var(--ink-soft); margin: 0 0 .4rem; }
  .vc-chips { display: flex; flex-wrap: wrap; gap: .4rem; margin-bottom: 1rem; }
  .vc-chip {
    font: inherit; font-weight: 500; font-size: .85rem;
    padding: .4rem .75rem; border-radius: 6px; cursor: pointer;
    background: var(--card); color: var(--ink); border: 1px solid var(--rule);
  }
  .vc-chip:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); }
  .vc-chip.active { background: var(--accent); border-color: var(--accent); color: var(--paper); }
  .vc-chip:disabled { cursor: default; }
  .vc-chip:disabled:not(.active) { opacity: .45; }
  .vc-mic {
    font: inherit; font-size: .85rem; max-width: 100%; margin-bottom: 1rem;
    padding: .4rem .6rem; border-radius: 6px;
    background: var(--card); color: var(--ink); border: 1px solid var(--rule);
  }
  .vc-log {
    border: 1px solid var(--rule); border-radius: 6px; padding: 1rem;
    min-height: 10rem; display: flex; flex-direction: column; gap: .6rem;
  }
  .vc-log:empty::before {
    content: "התמלול של השיחה יופיע כאן";
    color: var(--ink-soft); font-size: .9rem; direction: rtl; text-align: right;
  }
  .vc-msg {
    max-width: 85%; padding: .55rem .8rem; border-radius: 6px; line-height: 1.45;
    overflow-wrap: anywhere; text-align: left;
    scroll-margin-bottom: 8rem; /* keep new lines visible above the bottom bar */
  }
  .vc-msg.ai { background: var(--accent-soft); align-self: flex-start; }
  .vc-msg.user { border: 1px solid var(--rule); align-self: flex-end; }
  .vc-who {
    display: block; font-size: .72rem; text-transform: uppercase; letter-spacing: .05em;
    color: var(--ink-soft); margin-bottom: .15rem;
  }
  .vc-msg.interrupted .vc-text::after { content: " …"; color: var(--ink-soft); }
  .vc-bar {
    position: sticky; bottom: 0; z-index: 2;
    background: var(--card); border-top: 1px solid var(--rule);
    margin-top: 1rem; padding: .75rem 0 .9rem;
  }
  .vc-controls { display: flex; align-items: center; gap: .9rem; flex-wrap: wrap; margin-bottom: .6rem; }
  .vc-toggle {
    font: inherit; font-weight: 600; border: none; border-radius: 6px;
    padding: .7rem 1.3rem; cursor: pointer; background: var(--accent); color: var(--paper);
  }
  .vc-toggle:disabled { opacity: .5; cursor: default; }
  .vc-toggle.stop { background: var(--wrong); }
  .vc-timer { font-family: Georgia, serif; font-size: 1.25rem; font-variant-numeric: tabular-nums; direction: ltr; }
  .vc-timer.low { color: var(--wrong); }
  .vc-status { display: flex; align-items: center; gap: .5rem; font-size: .9rem; color: var(--ink-soft); flex: 1; min-width: 8rem; }
  .vc-status.error { color: var(--wrong); }
  .vc-dot { width: .7rem; height: .7rem; border-radius: 50%; background: var(--rule); flex: none; }
  .vc-dot.live { background: var(--accent); animation: vc-pulse 1.2s ease-in-out infinite; }
  .vc-dot.speaking { background: var(--accent); }
  @keyframes vc-pulse { 50% { opacity: .35; } }
  .vc-meter { height: .35rem; background: var(--rule); border-radius: 3px; overflow: hidden; }
  .vc-meter span { display: block; height: 100%; width: 0; background: var(--ink-soft); transition: width .08s linear; }
  .vc-meter.open span { background: var(--accent); }
  .vc-finish { margin-inline-start: auto; }
  .vc-rec { margin-top: 1rem; display: flex; align-items: center; gap: .75rem; flex-wrap: wrap; }
  .vc-rec:empty { display: none; }
  .vc-rec audio { flex: 1; min-width: 14rem; }
  .vc-rec a { font-size: .85rem; color: var(--accent); }`;

  const PREFS_KEY = "voiceChatPrefs";
  let prefs = { accent: "american" };
  try { Object.assign(prefs, JSON.parse(localStorage.getItem(PREFS_KEY)) || {}); } catch (e) {}
  let topicsReady = null;
  let ui = null; // elements of the mounted section
  let preview = null; // accent sample currently playing
  let s = null;  // current session state, null when idle

  // Only one conversation at a time: starting in another tab stops this one.
  const tabs = "BroadcastChannel" in window ? new BroadcastChannel("voice-chat") : null;
  if (tabs) tabs.onmessage = ev => {
    if (ev.data === "started" && s) end("השיחה נעצרה כי התחילה שיחה בלשונית אחרת");
  };
  window.addEventListener("pagehide", () => end());

  function loadTopics() {
    if (!topicsReady) topicsReady = fetch("voice-topics.json").then(r => r.json());
    return topicsReady;
  }

  function savePrefs() {
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch (e) {}
  }

  // ---- UI ----------------------------------------------------------------
  function mount(container, opts) {
    end();
    stopSample();
    clearRecording();
    if (!document.getElementById("vc-style")) {
      const style = document.createElement("style");
      style.id = "vc-style";
      style.textContent = CSS;
      document.head.appendChild(style);
    }
    container.innerHTML = `
      <p class="vc-label">מבטא</p>
      <div class="vc-chips" data-vc="accents"></div>
      <p class="vc-label">מיקרופון</p>
      <select class="vc-mic" data-vc="mic"><option value="">ברירת המחדל של המחשב</option></select>
      <div class="vc-log" data-vc="log" dir="ltr"></div>
      <div class="vc-rec" data-vc="rec"></div>
      <div class="vc-bar">
        <div class="vc-controls">
          <button class="vc-toggle" data-vc="toggle" disabled>התחלת שיחה</button>
          <span class="vc-timer" data-vc="timer">10:00</span>
          <div class="vc-status" data-vc="status"><span class="vc-dot" data-vc="dot"></span><span data-vc="statusText">טוען…</span></div>
          <button class="next show vc-finish" data-vc="finish">Finish →</button>
        </div>
        <div class="vc-meter" data-vc="meter" title="עוצמת המיקרופון"><span data-vc="meterBar"></span></div>
      </div>`;
    const q = name => container.querySelector(`[data-vc="${name}"]`);
    ui = {
      container, opts,
      accents: q("accents"), mic: q("mic"), log: q("log"), rec: q("rec"), toggle: q("toggle"), timer: q("timer"),
      status: q("status"), dot: q("dot"), statusText: q("statusText"),
      meter: q("meter"), meterBar: q("meterBar"), finish: q("finish"),
    };
    const mine = ui;
    ui.toggle.onclick = () => (s ? end() : start());
    ui.finish.onclick = () => {
      const talked = s && s.startedAt ? (Date.now() - s.startedAt) / 1000 : mine.lastTalked || 0;
      end();
      opts.onFinish && opts.onFinish(talked);
    };
    ui.accents.onclick = e => {
      const btn = e.target.closest("[data-accent]");
      if (!btn || s) return;
      prefs.accent = btn.dataset.accent;
      savePrefs();
      renderAccents();
      playSample(btn.dataset.accent);
    };
    ui.mic.onchange = () => {
      prefs.micId = ui.mic.value;
      savePrefs();
    };
    renderMics();
    loadTopics().then(topics => {
      if (ui !== mine) return;
      ui.topics = topics;
      if (!topics.accents.some(a => a.id === prefs.accent)) prefs.accent = topics.accents[0].id;
      renderAccents();
      ui.toggle.disabled = false;
      setStatus("מוכן");
    }).catch(() => setStatus("לא הצלחתי לטעון את הגדרות השיחה", "error"));
  }

  // Plays a short clip in the chosen accent (generated once by the server).
  async function playSample(id) {
    stopSample();
    const mine = preview = { audio: null };
    const label = ui.topics.accents.find(a => a.id === id).label;
    setStatus(`טוען דוגמה של מבטא ${label}…`);
    try {
      const res = await fetch("api/accent-sample?accent=" + encodeURIComponent(id));
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `שגיאה ${res.status}`);
      const url = URL.createObjectURL(await res.blob());
      if (preview !== mine || s) { URL.revokeObjectURL(url); return; }
      mine.audio = new Audio(url);
      mine.audio.playbackRate = PLAYBACK_SPEED; // same pace as the conversation (pitch is kept)
      mine.audio.onended = () => {
        URL.revokeObjectURL(url);
        if (preview === mine) { preview = null; setStatus("מוכן"); }
      };
      setStatus(`מבטא ${label} — דוגמה`, "speaking");
      await mine.audio.play();
    } catch (err) {
      if (preview === mine) {
        preview = null;
        setStatus(err.message === "Failed to fetch" ? "דוגמאות עובדות רק דרך השרת המקומי" : "לא הצלחתי להשמיע דוגמה: " + err.message, "error");
      }
    }
  }

  function stopSample() {
    if (preview && preview.audio) preview.audio.pause();
    preview = null;
  }

  function renderAccents() {
    if (!ui || !ui.topics) return;
    ui.accents.innerHTML = ui.topics.accents.map(a =>
      `<button class="vc-chip${a.id === prefs.accent ? " active" : ""}" data-accent="${a.id}"${s ? " disabled" : ""}>${a.label}</button>`
    ).join("");
  }

  // Device names are only listed once the site has mic permission, so this
  // runs again after each start.
  async function renderMics() {
    if (!ui || !navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
    const mine = ui;
    const mics = (await navigator.mediaDevices.enumerateDevices().catch(() => []))
      .filter(d => d.kind === "audioinput" && d.deviceId && d.deviceId !== "default" && d.deviceId !== "communications");
    if (ui !== mine) return;
    const esc = t => t.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
    ui.mic.innerHTML = `<option value="">ברירת המחדל של המחשב</option>` + mics.map((d, i) =>
      `<option value="${esc(d.deviceId)}">${esc(d.label || "מיקרופון " + (i + 1))}</option>`).join("");
    ui.mic.value = mics.some(d => d.deviceId === prefs.micId) ? prefs.micId : "";
    ui.mic.disabled = !!s;
  }

  function setStatus(text, mode = "") {
    if (!ui) return;
    if (s && s.micWarned && mode !== "error") return; // keep the mic warning visible
    ui.statusText.textContent = text;
    ui.status.className = "vc-status" + (mode === "error" ? " error" : "");
    ui.dot.className = "vc-dot" + (mode === "live" ? " live" : mode === "speaking" ? " speaking" : "");
  }

  function fmt(sec) {
    sec = Math.max(0, Math.ceil(sec));
    return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
  }

  function toBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(bin);
  }

  function gate(chunk) {
    let sum = 0;
    for (let i = 0; i < chunk.length; i++) sum += chunk[i] * chunk[i];
    const rms = Math.sqrt(sum / chunk.length) / 0x8000;
    // Floor drops fast toward quiet levels and creeps up slowly (~1%/chunk).
    s.noiseFloor = rms < s.noiseFloor ? s.noiseFloor * 0.8 + rms * 0.2 : s.noiseFloor * 1.01;
    const threshold = Math.min(GATE_MAX, Math.max(GATE_MIN, s.noiseFloor * GATE_RATIO));
    const now = performance.now();
    if (rms > threshold) s.gateUntil = now + GATE_HOLD_MS;
    const open = now < s.gateUntil;
    // A mic that stays at digital silence is the wrong device (e.g. a virtual
    // VoiceMeeter input), not a quiet room: tell the learner to pick another.
    s.micPeak = Math.max(s.micPeak, rms);
    if (!s.micWarned && now - s.micSince > 4000 && s.micPeak < 0.001) {
      s.micWarned = true;
      const label = s.stream.getAudioTracks()[0].label;
      setStatus(`לא מגיע קול מהמיקרופון${label ? ` "${label}"` : ""}: סיימו את השיחה ובחרו מיקרופון אחר`, "error");
    }
    ui.meterBar.style.width = Math.min(100, rms * 400) + "%";
    ui.meter.classList.toggle("open", open);
    return open ? chunk : new Int16Array(chunk.length);
  }

  // ---- Transcript --------------------------------------------------------
  function bubble(role) {
    const el = document.createElement("div");
    el.className = "vc-msg " + role;
    el.innerHTML = `<span class="vc-who">${role === "ai" ? "Partner" : "You"}</span><span class="vc-text"></span>`;
    ui.log.appendChild(el);
    return el;
  }
  function appendText(role, text) {
    if (!text) return;
    const key = role === "ai" ? "aiBubble" : "userBubble";
    if (!s[key]) s[key] = bubble(role);
    s[key].querySelector(".vc-text").textContent += text;
    s[key].scrollIntoView({ block: "nearest" });
  }

  // ---- Playback ----------------------------------------------------------
  // Streaming WSOLA time-stretch: overlap-adds 20 ms Hann frames taken from
  // the input at a smaller hop than they are written, picking each frame
  // within ±5 ms where it best matches the previous frame's continuation, so
  // speech gets slower without changing pitch.
  class Stretcher {
    constructor(speed) {
      this.N = 480; this.Hs = this.N / 2; this.Ha = Math.round(this.Hs * speed); this.tol = 120;
      this.win = Float32Array.from({ length: this.N }, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / this.N));
      this.buf = new Float32Array(0); this.base = 0; // buf[0] is absolute sample `base`
      this.next = 0; this.prev = -1; this.tail = new Float32Array(this.Hs);
    }
    push(input) {
      const merged = new Float32Array(this.buf.length + input.length);
      merged.set(this.buf); merged.set(input, this.buf.length);
      this.buf = merged;
      const { N, Hs, tol, win } = this, end = this.base + this.buf.length, out = [];
      const at = i => this.buf[i - this.base];
      while (this.next + tol + N <= end && (this.prev < 0 || this.prev + Hs + N <= end)) {
        let start = this.next;
        if (this.prev >= 0) {
          const target = this.prev + Hs;
          let best = -Infinity;
          for (let d = -tol; d <= tol; d++) {
            const c = this.next + d;
            if (c < this.base) continue;
            let sum = 0;
            for (let i = 0; i < N; i += 2) sum += at(c + i) * at(target + i);
            if (sum > best) { best = sum; start = c; }
          }
        }
        const frame = new Float32Array(Hs);
        for (let i = 0; i < Hs; i++) frame[i] = this.tail[i] + at(start + i) * win[i];
        for (let i = 0; i < Hs; i++) this.tail[i] = at(start + Hs + i) * win[Hs + i];
        out.push(frame);
        this.prev = start;
        this.next += this.Ha;
      }
      const keep = Math.max(this.base, Math.min(this.next - tol, this.prev < 0 ? this.next : this.prev + Hs));
      this.buf = this.buf.slice(keep - this.base);
      this.base = keep;
      return concat(out);
    }
    // End of a turn: release the last half-frame (it already fades out).
    flush() {
      const rest = this.tail;
      this.tail = new Float32Array(this.Hs);
      this.buf = new Float32Array(0); this.base = this.next = 0; this.prev = -1;
      return rest;
    }
  }

  function concat(parts) {
    const all = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) { all.set(p, o); o += p.length; }
    return all;
  }

  function playChunk(b64) {
    const bin = atob(b64);
    const pcm = new Float32Array(bin.length >> 1);
    for (let i = 0; i < pcm.length; i++) {
      pcm[i] = ((bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8)) << 16 >> 16) / 0x8000;
    }
    schedule(s.stretch.push(pcm));
  }

  function schedule(data) {
    if (!data.length) return;
    const buf = s.playCtx.createBuffer(1, data.length, OUT_RATE);
    buf.copyToChannel(data, 0);
    const src = s.playCtx.createBufferSource();
    src.buffer = buf;
    src.connect(s.playCtx.destination);
    if (s.recDest) src.connect(s.recDest);
    const now = s.playCtx.currentTime;
    s.nextPlayTime = Math.max(s.nextPlayTime, now + 0.05);
    src.start(s.nextPlayTime);
    s.nextPlayTime += buf.duration;
    s.sources.add(src);
    const session = s;
    src.onended = () => {
      if (s !== session) return;
      s.sources.delete(src);
      if (!s.sources.size) setStatus("מקשיב — אפשר לדבר", "live");
    };
    setStatus("השותף מדבר — אפשר לקטוע", "speaking");
  }

  // Barge-in: drop everything queued so the AI goes quiet immediately.
  function stopPlayback() {
    for (const src of s.sources) { try { src.stop(); } catch (e) {} }
    s.sources.clear();
    s.nextPlayTime = 0;
    s.stretch = new Stretcher(PLAYBACK_SPEED);
  }

  // ---- Server messages ---------------------------------------------------
  function onServerMessage(msg) {
    if (msg.setupComplete) {
      s.ready = true;
      // The learner opens the conversation: the partner waits for their hello.
      const first = !s.startedAt;
      if (first) {
        s.startedAt = Date.now();
        s.timerId = setInterval(tick, 250);
      }
      setStatus(first ? "מקשיב — תפתחו אתם את השיחה" : "מקשיב — אפשר לדבר", "live");
      return;
    }
    if (msg.sessionResumptionUpdate) {
      const u = msg.sessionResumptionUpdate;
      if (u.resumable && u.newHandle) s.resumeHandle = u.newHandle;
      return;
    }
    if (msg.goAway) {
      // The connection (not the session) is about to end: resume on a new one.
      reconnect();
      return;
    }
    if (msg.voiceActivity && msg.voiceActivity.type === "ACTIVITY_START") {
      s.userBubble = null; // each utterance gets its own bubble
      return;
    }
    const c = msg.serverContent;
    if (!c) return;
    if (c.interrupted) {
      stopPlayback();
      if (s.aiBubble) s.aiBubble.classList.add("interrupted");
      s.aiBubble = null;
      setStatus("מקשיב — אפשר לדבר", "live");
    }
    if (c.inputTranscription) appendText("user", c.inputTranscription.text);
    if (c.modelTurn || c.outputTranscription) s.userBubble = null; // user's turn is over
    for (const part of (c.modelTurn && c.modelTurn.parts) || []) {
      if (part.inlineData && part.inlineData.data) playChunk(part.inlineData.data);
    }
    if (c.outputTranscription) appendText("ai", c.outputTranscription.text);
    if (c.turnComplete) {
      if (!c.interrupted) schedule(s.stretch.flush());
      s.aiBubble = null;
    }
  }

  function send(obj) {
    if (s && s.ws && s.ws.readyState === WebSocket.OPEN) s.ws.send(JSON.stringify(obj));
  }

  // ---- Connection --------------------------------------------------------
  function connect() {
    const { token, apiVersion, setup } = s.auth;
    const url = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage." +
      `${apiVersion}.GenerativeService.BidiGenerateContentConstrained?access_token=${encodeURIComponent(token)}`;
    const ws = new WebSocket(url);
    s.ws = ws;
    s.ready = false;
    ws.onopen = () => {
      ws.send(JSON.stringify({
        setup: { ...setup, sessionResumption: s.resumeHandle ? { handle: s.resumeHandle } : {} },
      }));
    };
    ws.onmessage = async ev => {
      if (!s || s.ws !== ws) return;
      const text = typeof ev.data === "string" ? ev.data : await ev.data.text();
      if (!s || s.ws !== ws) return;
      try { onServerMessage(JSON.parse(text)); } catch (e) { console.error(e, text); }
    };
    ws.onclose = ev => {
      if (!s || s.ws !== ws) return; // an old connection we replaced on purpose
      if (s.resumeHandle && ev.code !== 1000 && s.reconnects < 3 && remaining() > 5) {
        reconnect();
      } else {
        const why = ev.reason ? ` (${ev.reason})` : ev.code !== 1000 ? ` (code ${ev.code})` : "";
        end(s.startedAt ? "השיחה נותקה" + why : "החיבור נכשל" + why, "error");
      }
    };
  }

  function reconnect() {
    if (!s || !s.resumeHandle) { end("החיבור הסתיים", "error"); return; }
    s.reconnects++;
    const old = s.ws;
    s.ws = null;
    try { old.close(); } catch (e) {}
    stopPlayback();
    setStatus("מתחבר מחדש…");
    connect();
  }

  function remaining() {
    return s.startedAt ? s.auth.maxSeconds - (Date.now() - s.startedAt) / 1000 : s.auth.maxSeconds;
  }

  function tick() {
    if (!s) return;
    const left = remaining();
    ui.timer.textContent = fmt(left);
    ui.timer.classList.toggle("low", left <= 60);
    if (left <= 0) end("נגמרו 10 הדקות — כל הכבוד!");
  }

  // ---- Recording ---------------------------------------------------------
  // The learner's mic and the partner's voice are mixed into one track in
  // playCtx (the mic is not routed to the speakers). The clip lives only in
  // memory and is replaced when the next conversation starts.
  function startRecording(session) {
    if (!("MediaRecorder" in window)) return;
    session.recDest = session.playCtx.createMediaStreamDestination();
    session.playCtx.createMediaStreamSource(session.stream).connect(session.recDest);
    const type = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find(t => MediaRecorder.isTypeSupported(t)) || "";
    const recorder = new MediaRecorder(session.recDest.stream, type ? { mimeType: type } : {});
    const chunks = [];
    recorder.ondataavailable = ev => { if (ev.data.size) chunks.push(ev.data); };
    recorder.onstop = () => {
      if (!chunks.length || !ui || ui !== session.ui || !ui.container.isConnected) return;
      const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
      showRecording(URL.createObjectURL(blob), blob.type.includes("mp4") ? "m4a" : "webm");
    };
    recorder.start(1000);
    session.recorder = recorder;
  }

  function showRecording(url, ext) {
    clearRecording();
    ui.recUrl = url;
    ui.rec.innerHTML = `<span class="vc-label">הקלטת השיחה</span>
      <audio controls src="${url}"></audio>
      <a href="${url}" download="conversation.${ext}">הורדה</a>`;
  }

  function clearRecording() {
    if (!ui) return;
    if (ui.recUrl) URL.revokeObjectURL(ui.recUrl);
    ui.recUrl = null;
    ui.rec.textContent = "";
  }

  // ---- Start / stop ------------------------------------------------------
  async function start() {
    if (!ui) return;
    stopSample();
    clearRecording();
    ui.toggle.disabled = true;
    ui.log.textContent = "";
    ui.timer.classList.remove("low");
    setStatus("מתחבר…");
    if (tabs) tabs.postMessage("started");
    // Create the audio contexts inside the click so Chrome lets them play.
    s = {
      micCtx: new AudioContext({ sampleRate: IN_RATE }),
      playCtx: new AudioContext({ sampleRate: OUT_RATE }),
      ui, sources: new Set(), nextPlayTime: 0, stretch: new Stretcher(PLAYBACK_SPEED), reconnects: 0,
      resumeHandle: null, startedAt: 0, micSince: 0, micPeak: 0, micWarned: false, noiseFloor: GATE_MIN, gateUntil: 0, aiBubble: null, userBubble: null,
    };
    const session = s;
    renderAccents();
    ui.mic.disabled = true;
    try {
      let res;
      try {
        res = await fetch("api/live-token", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ stage: ui.opts.stage, accent: prefs.accent }),
        });
      } catch (e) {
        throw new Error("שיחה קולית עובדת רק דרך השרת המקומי (open.vbs)");
      }
      const auth = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(auth.error || `שגיאה ${res.status}`);
      if (s !== session) return;
      s.auth = auth;
      ui.timer.textContent = fmt(auth.maxSeconds);

      // Chrome ignores an "ideal" deviceId, so ask for the chosen mic exactly
      // and fall back to the default if it was unplugged.
      const audio = { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true };
      const stream = await (prefs.micId
        ? navigator.mediaDevices.getUserMedia({ audio: { ...audio, deviceId: { exact: prefs.micId } } })
          .catch(e => e.name === "OverconstrainedError" || e.name === "NotFoundError"
            ? navigator.mediaDevices.getUserMedia({ audio }) : Promise.reject(e))
        : navigator.mediaDevices.getUserMedia({ audio }));
      if (s !== session) { stream.getTracks().forEach(t => t.stop()); return; }
      s.stream = stream;
      s.micSince = performance.now();
      renderMics();
      const workletUrl = URL.createObjectURL(new Blob([CAPTURE_WORKLET], { type: "text/javascript" }));
      await s.micCtx.audioWorklet.addModule(workletUrl);
      URL.revokeObjectURL(workletUrl);
      if (s !== session) return;
      const node = new AudioWorkletNode(s.micCtx, "pcm-capture");
      node.port.onmessage = ev => {
        if (s !== session) return;
        const pcm = gate(new Int16Array(ev.data));
        if (s.ready) {
          send({ realtimeInput: { audio: { data: toBase64(pcm.buffer), mimeType: `audio/pcm;rate=${IN_RATE}` } } });
        }
      };
      s.micCtx.createMediaStreamSource(s.stream).connect(node);
      try { startRecording(s); } catch (e) { console.warn("Recording unavailable", e); }

      connect();
      ui.toggle.textContent = "סיום שיחה";
      ui.toggle.classList.add("stop");
      ui.toggle.disabled = false;
    } catch (err) {
      const msg = err.name === "NotAllowedError" ? "אין הרשאה למיקרופון" : err.message;
      if (s === session) end(msg, "error");
    }
  }

  function end(message = "השיחה הסתיימה", mode = "") {
    if (!s) return;
    const old = s;
    s = null;
    clearInterval(old.timerId);
    if (old.ws) { old.ws.onclose = null; try { old.ws.close(1000); } catch (e) {} }
    for (const src of old.sources) { try { src.stop(); } catch (e) {} }
    if (old.recorder && old.recorder.state !== "inactive") old.recorder.stop();
    if (old.stream) old.stream.getTracks().forEach(t => t.stop());
    old.micCtx.close().catch(() => {});
    old.playCtx.close().catch(() => {});
    if (!ui || !ui.container.isConnected) return;
    if (old.startedAt) ui.lastTalked = (Date.now() - old.startedAt) / 1000;
    ui.meterBar.style.width = "0";
    ui.meter.classList.remove("open");
    ui.toggle.textContent = "התחלת שיחה";
    ui.toggle.classList.remove("stop");
    ui.toggle.disabled = false;
    ui.mic.disabled = false;
    renderAccents();
    setStatus(message, mode);
  }

  window.VoiceChat = { mount, stop: () => { stopSample(); end(); } };
})();
