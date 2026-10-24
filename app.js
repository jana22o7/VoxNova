"use strict";
/* =====================================================================
   AgriFlow AI dashboard + Vox Nova voice chatbot (browser side)
   Sections:  1 helpers  2 i18n  3 feature config  4 dashboard views
              5 Vox Nova (mic, silence detection, playback, chat)  6 boot
   ===================================================================== */

/* ---------- 1. helpers ---------- */
const $ = (s, r = document) => r.querySelector(s);
function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") n.className = v;
    else if (k === "text") n.textContent = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) if (kid != null) n.append(kid.nodeType ? kid : document.createTextNode(kid));
  return n;
}
const store = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : "s" + Math.random().toString(36).slice(2) + Date.now());

async function api(path, { method = "GET", json, form } = {}) {
  const opt = { method, headers: {} };
  if (json) { opt.body = JSON.stringify(json); opt.headers["Content-Type"] = "application/json"; }
  if (form) opt.body = form;
  const r = await fetch(path, opt);
  let data = null;
  try { data = await r.json(); } catch { /* not json */ }
  if (!r.ok) {
    const d = data && data.detail;
    throw new Error(typeof d === "string" ? d : d ? JSON.stringify(d) : `Request failed (${r.status})`);
  }
  return data;
}

const S = { lang: store.get("lang", "en"), view: "home", sid: store.get("sid", "") || uuid(), last: null };
store.set("sid", S.sid);
const L = (o) => (o && (o[S.lang] || o.en)) || "";

/* ---------- 2. i18n (UI text; AI output language follows the same toggle) ---------- */
const TXT = {
  en: {
    dash: "Dashboard", analyse: "Analyse", listen: "Listen", askVox: "Ask Vox Nova about this",
    hello: "What is your field telling you today?",
    helloSub: "Six AI tools and one voice assistant, working from the same farm context. Pick a tool, or just ask Vox Nova out loud.",
    promo: "Not sure where to start? Say it in English, தமிழ் or Tanglish. Vox Nova listens, answers and speaks back.",
    talk: "Talk to Vox Nova", placeholder: "Type or tap the mic. English, தமிழ் or Tanglish", send: "Send", newChat: "New chat",
    empty: "Fill the form and press Analyse. Your result will appear here.",
    idle: "Tap the orb and ask about your crop", listening: "Listening… pause when you are done", thinking: "Thinking…",
    speaking: "Speaking… tap the orb to stop", transcribing: "Understanding your voice…",
    welcome: "Vanakkam! Ask me about a sick plant, what to sow, pests, fertilizer or the weather.",
    conf: "Confidence", replay: "Play again", ex: "Explain this result in simple words and tell me what to do first.",
    micDenied: "Microphone access is blocked. Allow it in your browser's site settings, or type your question.",
    noSpeech: "I did not hear anything. Tap the mic and speak closer to it.",
  },
  ta: {
    dash: "டாஷ்போர்டு", analyse: "பகுப்பாய்வு செய்", listen: "கேளுங்கள்", askVox: "இதைப் பற்றி Vox Nova-விடம் கேள்",
    hello: "இன்று உங்கள் வயல் என்ன சொல்கிறது?",
    helloSub: "ஆறு AI கருவிகளும் ஒரு குரல் உதவியாளரும் ஒரே பண்ணைத் தகவலில் இயங்குகின்றன. ஒரு கருவியைத் தேர்ந்தெடுங்கள், அல்லது Vox Nova-விடம் பேசுங்கள்.",
    promo: "எங்கே தொடங்குவது என்று தெரியவில்லையா? தமிழ், English அல்லது Tanglish-ல் பேசுங்கள். Vox Nova கேட்டு, பதில் சொல்லும்.",
    talk: "Vox Nova-வுடன் பேசு", placeholder: "தட்டச்சு செய்யுங்கள் அல்லது மைக்கை அழுத்துங்கள்", send: "அனுப்பு", newChat: "புதிய உரையாடல்",
    empty: "படிவத்தை நிரப்பி பகுப்பாய்வு செய் என்பதை அழுத்துங்கள். முடிவு இங்கே தெரியும்.",
    idle: "ஆர்பை அழுத்தி உங்கள் பயிர் பற்றி கேளுங்கள்", listening: "கேட்கிறேன்… முடிந்ததும் நிறுத்துங்கள்", thinking: "யோசிக்கிறேன்…",
    speaking: "பேசுகிறேன்… நிறுத்த ஆர்பை அழுத்துங்கள்", transcribing: "உங்கள் குரலைப் புரிந்துகொள்கிறேன்…",
    welcome: "வணக்கம்! நோய்வாய்ப்பட்ட செடி, விதைப்பு, பூச்சி, உரம், வானிலை பற்றி கேளுங்கள்.",
    conf: "நம்பகத்தன்மை", replay: "மீண்டும் கேள்", ex: "இந்த முடிவை எளிமையாக விளக்கி, முதலில் என்ன செய்ய வேண்டும் என்று சொல்லுங்கள்.",
    micDenied: "மைக்ரோஃபோன் அனுமதி மறுக்கப்பட்டுள்ளது. உலாவி அமைப்பில் அனுமதியுங்கள் அல்லது தட்டச்சு செய்யுங்கள்.",
    noSpeech: "எதுவும் கேட்கவில்லை. மைக்கை அழுத்தி அருகில் பேசுங்கள்.",
  },
};
const tr = (k) => TXT[S.lang][k] || TXT.en[k];

const CHIPS = {
  en: ["My tomato leaves have yellow spots", "Which crop for red soil in Kharif?", "Organic spray for aphids", "Will it rain this week?"],
  ta: ["தக்காளி இலையில் மஞ்சள் புள்ளிகள் இருக்கு", "செம்மண்ணுக்கு எந்த பயிர் நல்லது?", "அசுவினிக்கு இயற்கை மருந்து", "இந்த வாரம் மழை வருமா?"],
};

/* ---------- 3. the six AI features ---------- */
const seasons = [
  { v: "Kharif (Jun-Oct)", ta: "காரிஃப் (ஜூன்-அக்)" }, { v: "Rabi (Nov-Mar)", ta: "ராபி (நவ-மார்)" },
  { v: "Summer (Mar-Jun)", ta: "கோடை (மார்-ஜூன்)" }, { v: "Samba (Aug-Jan)", ta: "சம்பா (ஆக-ஜன)" },
  { v: "Year-round", ta: "ஆண்டு முழுவதும்" },
];
const soils = [
  { v: "Red soil", ta: "செம்மண்" }, { v: "Black cotton soil", ta: "கரிசல் மண்" }, { v: "Alluvial soil", ta: "வண்டல் மண்" },
  { v: "Sandy soil", ta: "மணல் மண்" }, { v: "Clay loam", ta: "களிமண் கலப்பு" }, { v: "Laterite soil", ta: "செம்பாறை மண்" },
];
const CROP = { key: "Crop", type: "text", label: { en: "Crop", ta: "பயிர்" }, ph: { en: "Tomato, paddy, banana…", ta: "தக்காளி, நெல், வாழை…" } };
const LOC = (req) => ({ key: "Location", type: "text", req, label: { en: "Village / town / district", ta: "ஊர் / மாவட்டம்" }, ph: { en: "Krishnagiri", ta: "கிருஷ்ணகிரி" } });

const FEATURES = [
  { id: "disease", icon: "🍃", title: { en: "Disease Detection", ta: "பயிர் நோய் கண்டறிதல்" },
    desc: { en: "Upload a leaf photo. Get the likely disease and a treatment plan.", ta: "இலை புகைப்படத்தை பதிவேற்றுங்கள். நோயும் சிகிச்சையும் தெரிந்துகொள்ளுங்கள்." },
    fields: [
      { key: "image", type: "file", label: { en: "Leaf or plant photo", ta: "இலை / செடி புகைப்படம்" } },
      { ...CROP, key: "crop" },
      { key: "symptoms", type: "textarea", label: { en: "What do you see? (optional)", ta: "என்ன தெரிகிறது? (விருப்பம்)" }, ph: { en: "Yellow spots, white powder, curling…", ta: "மஞ்சள் புள்ளி, வெள்ளைப் பொடி, சுருள்…" } },
    ] },
  { id: "crop", icon: "🌱", title: { en: "Crop Recommendation", ta: "பயிர் பரிந்துரை" },
    desc: { en: "Best crops for your soil, season and water.", ta: "உங்கள் மண், பருவம், நீருக்கு ஏற்ற பயிர்கள்." },
    fields: [
      LOC(false),
      { key: "Season", type: "select", options: seasons, label: { en: "Season", ta: "பருவம்" } },
      { key: "Soil type", type: "select", options: soils, label: { en: "Soil type", ta: "மண் வகை" } },
      { key: "Water availability", type: "select", label: { en: "Water availability", ta: "நீர் வசதி" },
        options: [{ v: "Borewell / well", ta: "ஆழ்துளை / கிணறு" }, { v: "Canal irrigation", ta: "கால்வாய்" }, { v: "Rain-fed only", ta: "மழை மட்டும்" }, { v: "Drip available", ta: "சொட்டு நீர்" }] },
      { key: "Land size (acres)", type: "text", label: { en: "Land size (acres)", ta: "நிலப்பரப்பு (ஏக்கர்)" }, ph: { en: "2", ta: "2" } },
    ] },
  { id: "pest", icon: "🐛", title: { en: "Pest Control", ta: "பூச்சி கட்டுப்பாடு" },
    desc: { en: "Organic first, chemical only when needed.", ta: "முதலில் இயற்கை முறை, தேவைப்பட்டால் மட்டும் ரசாயனம்." },
    fields: [
      CROP,
      { key: "Pest or damage seen", type: "textarea", label: { en: "What is attacking the crop?", ta: "பயிரை என்ன தாக்குகிறது?" }, ph: { en: "Small green insects under leaves, holes in fruit…", ta: "இலைக்கு அடியில் பச்சைப் பூச்சிகள், காயில் துளைகள்…" } },
      { key: "Growth stage", type: "select", label: { en: "Growth stage", ta: "வளர்ச்சி நிலை" },
        options: [{ v: "Seedling", ta: "நாற்று" }, { v: "Vegetative", ta: "வளர்ச்சி" }, { v: "Flowering", ta: "பூக்கும் நிலை" }, { v: "Fruiting / grain filling", ta: "காய் / மணி பிடிப்பு" }] },
      { key: "Preferred method", type: "select", label: { en: "Preferred method", ta: "விருப்ப முறை" },
        options: [{ v: "Organic only", ta: "இயற்கை மட்டும்" }, { v: "Organic first, chemical if needed", ta: "இயற்கை முதலில்" }, { v: "Chemical is fine", ta: "ரசாயனம் சரி" }] },
    ] },
  { id: "fertilizer", icon: "🧪", title: { en: "Fertilizer & Irrigation", ta: "உரம் & நீர்ப்பாசனம்" },
    desc: { en: "Nutrient and watering plan with quantities per acre.", ta: "ஏக்கருக்கான உர அளவும் நீர்ப்பாசன அட்டவணையும்." },
    fields: [
      CROP,
      { key: "Soil type", type: "select", options: soils, label: { en: "Soil type", ta: "மண் வகை" } },
      { key: "Growth stage", type: "select", label: { en: "Growth stage", ta: "வளர்ச்சி நிலை" },
        options: [{ v: "Before sowing", ta: "விதைப்புக்கு முன்" }, { v: "Seedling", ta: "நாற்று" }, { v: "Vegetative", ta: "வளர்ச்சி" }, { v: "Flowering", ta: "பூக்கும் நிலை" }, { v: "Fruiting / grain filling", ta: "காய் / மணி பிடிப்பு" }] },
      { key: "Area (acres)", type: "text", label: { en: "Area (acres)", ta: "பரப்பு (ஏக்கர்)" }, ph: { en: "1", ta: "1" } },
      { key: "Soil test values (optional)", type: "text", label: { en: "Soil test values (optional)", ta: "மண் பரிசோதனை (விருப்பம்)" }, ph: { en: "N 200, P 12, K 150 kg/ha, pH 6.8", ta: "N 200, P 12, K 150, pH 6.8" } },
    ] },
  { id: "weather", icon: "⛅", title: { en: "Weather Advisory", ta: "வானிலை ஆலோசனை" },
    desc: { en: "Live 7-day forecast turned into farm actions.", ta: "7 நாள் வானிலை முன்னறிவிப்பை வேளாண் செயல்களாக மாற்றுகிறது." },
    fields: [ LOC(true), { ...CROP, req: false } ] },
  { id: "market", icon: "📈", title: { en: "Market & Yield", ta: "சந்தை & மகசூல்" },
    desc: { en: "Expected yield, cost and a good selling window.", ta: "எதிர்பார்க்கும் மகசூல், செலவு, விற்க நல்ல காலம்." },
    fields: [
      CROP, LOC(false),
      { key: "Area (acres)", type: "text", label: { en: "Area (acres)", ta: "பரப்பு (ஏக்கர்)" }, ph: { en: "2", ta: "2" } },
      { key: "Sowing / planting month", type: "text", label: { en: "Sowing / planting month", ta: "விதைப்பு மாதம்" }, ph: { en: "October", ta: "அக்டோபர்" } },
    ] },
];

/* ---------- 4. dashboard views ---------- */
function renderNav() {
  const nav = $("#nav");
  nav.replaceChildren(
    el("button", { class: S.view === "home" ? "on" : "", onclick: () => go("home") }, el("span", { class: "ic", text: "🌾" }), tr("dash")),
    ...FEATURES.map((f) => el("button", { class: S.view === f.id ? "on" : "", onclick: () => go(f.id) },
      el("span", { class: "ic", text: f.icon }), L(f.title))),
  );
}
function go(view) {
  S.view = view;
  renderNav();
  renderView();
  $("#view").scrollTop = 0;
}
function renderView() {
  const view = $("#view");
  const f = FEATURES.find((x) => x.id === S.view);
  $("#crumb").textContent = f ? `AgriFlow AI / ${L(f.title)}` : "AgriFlow AI";
  view.replaceChildren(f ? featureView(f) : homeView());
}

function homeView() {
  return el("div", {},
    el("div", { class: "hello" }, el("h1", { text: tr("hello") }), el("p", { text: tr("helloSub") })),
    el("div", { class: "bento" }, FEATURES.map((f) =>
      el("button", { class: "tile", onclick: () => go(f.id) },
        el("span", { class: "big", text: f.icon }), el("h3", { text: L(f.title) }), el("p", { text: L(f.desc) })))),
    el("div", { class: "vox-promo" },
      el("p", { text: tr("promo") }),
      el("button", { class: "btn primary", onclick: () => { openVox(); } }, tr("talk"))),
  );
}

function featureView(f) {
  const out = el("div", {}, el("div", { class: "empty", text: tr("empty") }));
  const form = el("form", { class: "panel" });
  const controls = {};
  for (const fd of f.fields) {
    let c;
    if (fd.type === "select") c = el("select", {}, fd.options.map((o) => el("option", { value: o.v, text: S.lang === "ta" ? o.ta : o.v })));
    else if (fd.type === "textarea") c = el("textarea", { placeholder: fd.ph ? L(fd.ph) : "" });
    else if (fd.type === "file") {
      c = el("input", { type: "file", accept: "image/*" });
      const prev = el("img", { class: "preview", alt: "", hidden: true });
      c.addEventListener("change", () => {
        const file = c.files[0];
        if (file) { prev.src = URL.createObjectURL(file); prev.hidden = false; } else prev.hidden = true;
      });
      controls[fd.key] = c;
      form.append(el("label", { class: "f" }, L(fd.label), c), prev);
      continue;
    } else c = el("input", { type: "text", placeholder: fd.ph ? L(fd.ph) : "", required: fd.req });
    controls[fd.key] = c;
    form.append(el("label", { class: "f" }, L(fd.label), c));
  }
  const btn = el("button", { class: "btn primary", type: "submit" }, tr("analyse"));
  form.append(btn);

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    btn.disabled = true;
    out.replaceChildren(el("div", { class: "panel" }, [1, 2, 3, 4, 5].map((i) => el("div", { class: "skel", style: `width:${100 - i * 9}%` }))));
    try {
      let data;
      if (f.id === "disease") {
        const fdata = new FormData();
        const file = controls.image.files[0];
        if (file) fdata.append("image", file);
        fdata.append("crop", controls.crop.value);
        fdata.append("symptoms", controls.symptoms.value);
        fdata.append("lang", S.lang);
        data = await api("/api/features/disease", { method: "POST", form: fdata });
      } else {
        const inputs = {};
        for (const fd of f.fields) inputs[fd.key] = controls[fd.key].value;
        data = await api(`/api/features/${f.id}`, { method: "POST", json: { inputs, lang: S.lang } });
      }
      out.replaceChildren(resultView(f, data));
    } catch (err) {
      out.replaceChildren(el("div", { class: "empty error", text: err.message }));
    } finally { btn.disabled = false; }
  });

  return el("div", {},
    el("div", { class: "fhead" }, el("h1", { text: L(f.title) }), el("p", { text: L(f.desc) })),
    el("div", { class: "split" }, form, out));
}

function resultView(f, data) {
  const r = data.result;
  const ctx = `${L(f.title)}: ${r.headline}. ${r.summary} ` +
    r.sections.map((s) => `${s.heading}: ${s.points.join("; ")}`).join(" | ");
  S.last = { text: ctx };

  const nodes = [
    el("div", { class: "rtop" }, el("h2", { text: r.headline }), el("span", { class: `badge ${r.severity}`, text: r.severity })),
    el("div", { class: "conf" }, `${tr("conf")} ${r.confidence}%`, el("i", {}, el("b", { style: `width:${Math.max(0, Math.min(100, r.confidence))}%` }))),
    el("p", { class: "lead", text: r.summary }),
  ];
  if (data.extra) nodes.push(weatherStrip(data.extra));
  nodes.push(
    el("div", { class: "secs" }, r.sections.map((s) => el("div", { class: "sec" }, el("h3", { text: s.heading }), el("ul", {}, s.points.map((p) => el("li", { text: p })))))),
    el("div", { class: "ractions" },
      el("button", { class: "btn", onclick: async (e) => {
        e.target.disabled = true;
        try { const d = await api("/api/vox/tts", { method: "POST", json: { text: r.voice_summary, lang: S.lang } }); playB64(d.audio_b64, d.audio_mime); }
        catch (err) { addMsg("err", err.message); }
        e.target.disabled = false;
      } }, "🔊 " + tr("listen")),
      el("button", { class: "btn primary", onclick: () => { openVox(); voxSend(tr("ex"), S.last.text); } }, tr("askVox"))));
  return el("div", { class: "panel result" }, nodes);
}

function weatherStrip(x) {
  const loc = S.lang === "ta" ? "ta-IN" : "en-IN";
  const c = x.current;
  return el("div", {},
    el("p", { class: "conf", text: `${x.place}: ${c.temperature_2m}°C, ${c.relative_humidity_2m}% humidity, ${c.wind_speed_10m} km/h wind` }),
    el("div", { class: "wx", style: "margin-top:10px" }, x.days.map((d) => el("div", {},
      new Date(d.date).toLocaleDateString(loc, { weekday: "short" }),
      el("b", { text: `${Math.round(d.max_c)}° / ${Math.round(d.min_c)}°` }),
      el("span", { class: "rain", text: `${d.rain_mm} mm · ${d.rain_chance_pct ?? 0}%` })))));
}

/* ---------- 5. Vox Nova ---------- */
const V = { rec: null, stream: null, chunks: [], ac: null, raf: 0, audio: null, busy: false, discard: false };
const voxEl = () => $("#vox");
const speakOn = () => $("#voxSpeak").checked;

function setState(s, text) {
  voxEl().dataset.state = s;
  $("#voxState").textContent = text || tr(s === "idle" ? "idle" : s);
  if (s !== "listening") voxEl().style.setProperty("--level", 0);
}
function openVox() { voxEl().classList.add("open"); }
function closeVox() { voxEl().classList.remove("open"); }

function addMsg(kind, text, opts = {}) {
  const m = el("div", { class: `msg ${kind}` });
  if (opts.via) m.append(el("span", { class: "via", text: opts.via }));
  m.append(document.createTextNode(text));
  if (opts.audio) {
    m.append(el("button", { class: "replay", onclick: () => { setState("speaking"); playB64(opts.audio, "audio/mpeg", () => setState("idle")); } }, "🔊 " + tr("replay")));
  }
  const chat = $("#chat");
  chat.append(m);
  chat.scrollTop = chat.scrollHeight;
  return m;
}
function typing() {
  const m = el("div", { class: "msg bot" }, el("span", { class: "typing" }, el("i"), el("i"), el("i")));
  $("#chat").append(m); $("#chat").scrollTop = 1e9;
  return m;
}

/* --- playback --- */
function stopAudio() {
  if (V.audio) { V.audio.pause(); V.audio = null; }
  if (voxEl().dataset.state === "speaking") setState("idle");
}
function playB64(b64, mime, onEnd) {
  if (V.audio) { V.audio.pause(); V.audio = null; }
  const a = new Audio(`data:${mime || "audio/mpeg"};base64,${b64}`);
  V.audio = a;
  const done = () => { if (V.audio === a) { V.audio = null; } onEnd && onEnd(); };
  a.onended = done; a.onerror = done;
  return a.play().catch(() => done());
}

/* --- shared reply handler --- */
function showReply(d) {
  addMsg("bot", d.reply, { audio: d.audio_b64 });
  if (d.audio_b64 && speakOn()) {
    setState("speaking");
    playB64(d.audio_b64, d.audio_mime, () => setState("idle"));
  } else setState("idle");
}

/* --- text chat --- */
async function voxSend(text, context) {
  text = (text || "").trim();
  if (!text || V.busy) return;
  stopAudio();
  V.busy = true;
  addMsg("user", text);
  const t = typing();
  setState("thinking");
  try {
    const d = await api("/api/vox/chat", { method: "POST", json: { session_id: S.sid, message: text, context: context || null, speak: speakOn() } });
    t.remove(); showReply(d);
  } catch (e) { t.remove(); addMsg("err", e.message); setState("idle"); }
  finally { V.busy = false; }
}

/* --- voice: record with live level meter and auto-stop on silence --- */
function pickMime() {
  for (const m of ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"])
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) return m;
  return "";
}

async function toggleMic() {
  if (V.rec && V.rec.state === "recording") { V.rec.stop(); return; }
  if (V.busy) return;
  stopAudio();
  try {
    V.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
  } catch { addMsg("err", tr("micDenied")); return; }

  V.chunks = []; V.discard = false;
  const mime = pickMime();
  V.rec = new MediaRecorder(V.stream, mime ? { mimeType: mime } : undefined);
  V.rec.ondataavailable = (e) => e.data.size && V.chunks.push(e.data);
  V.rec.onstop = onRecStop;
  V.rec.start(250);
  setState("listening");
  startMeter();
}

function startMeter() {
  const AC = window.AudioContext || window.webkitAudioContext;
  V.ac = new AC();
  const src = V.ac.createMediaStreamSource(V.stream);
  const an = V.ac.createAnalyser();
  an.fftSize = 1024;
  src.connect(an);
  const time = new Uint8Array(an.fftSize), freq = new Uint8Array(an.frequencyBinCount);
  const canvas = $("#wave"), g = canvas.getContext("2d");
  const t0 = performance.now();
  let heard = false, lastVoice = t0;

  const tick = () => {
    if (!V.rec || V.rec.state !== "recording") return;
    an.getByteTimeDomainData(time);
    let sum = 0;
    for (const v of time) { const x = (v - 128) / 128; sum += x * x; }
    const rms = Math.sqrt(sum / time.length);
    voxEl().style.setProperty("--level", Math.min(1, rms * 5).toFixed(3));

    // waveform bars
    an.getByteFrequencyData(freq);
    const w = (canvas.width = canvas.clientWidth * devicePixelRatio), h = (canvas.height = 44 * devicePixelRatio);
    g.clearRect(0, 0, w, h);
    g.fillStyle = "#e2624b";
    const bars = 40, bw = w / bars;
    for (let i = 0; i < bars; i++) {
      const v = freq[Math.floor(i * 0.6)] / 255;
      const bh = Math.max(3 * devicePixelRatio, v * h);
      g.fillRect(i * bw + bw * 0.2, (h - bh) / 2, bw * 0.6, bh);
    }

    // silence handling
    const now = performance.now();
    if (rms > 0.025) { heard = true; lastVoice = now; }
    if (heard && now - lastVoice > 1500) return V.rec.stop();          // finished speaking
    if (!heard && now - t0 > 7000) { V.discard = true; return V.rec.stop(); } // nobody spoke
    if (now - t0 > 25000) return V.rec.stop();                         // hard cap
    V.raf = requestAnimationFrame(tick);
  };
  V.raf = requestAnimationFrame(tick);
}

function cleanupMic() {
  cancelAnimationFrame(V.raf);
  if (V.stream) V.stream.getTracks().forEach((t) => t.stop());
  if (V.ac) V.ac.close().catch(() => {});
  V.stream = null; V.ac = null;
}

async function onRecStop() {
  cleanupMic();
  const type = V.rec.mimeType || "audio/webm";
  const blob = new Blob(V.chunks, { type });
  if (V.discard) { setState("idle"); addMsg("sys", tr("noSpeech")); return; }

  V.busy = true;
  setState("thinking", tr("transcribing"));
  const ext = type.includes("mp4") ? "mp4" : type.includes("ogg") ? "ogg" : "webm";
  const fd = new FormData();
  fd.append("audio", blob, `speech.${ext}`);
  fd.append("session_id", S.sid);
  fd.append("lang_hint", $("#voxLang").value);
  fd.append("speak", speakOn() ? "true" : "false");
  const um = addMsg("user", "…", { via: "🎙️" });
  const t = typing();
  try {
    const d = await api("/api/vox/voice", { method: "POST", form: fd });
    um.lastChild.textContent = d.transcript;
    t.remove(); showReply(d);
  } catch (e) { um.remove(); t.remove(); addMsg("err", e.message); setState("idle"); }
  finally { V.busy = false; }
}

function resetChat() {
  stopAudio();
  const fd = new FormData(); fd.append("session_id", S.sid);
  api("/api/vox/reset", { method: "POST", form: fd }).catch(() => {});
  $("#chat").replaceChildren();
  addMsg("bot", tr("welcome"));
  setState("idle");
}

function renderChips() {
  $("#chips").replaceChildren(...CHIPS[S.lang].map((c) => el("button", { onclick: () => voxSend(c) }, c)));
}

function wireVox() {
  $("#orb").addEventListener("click", () => (voxEl().dataset.state === "speaking" ? stopAudio() : toggleMic()));
  $("#micBtn").addEventListener("click", toggleMic);
  $("#sendBtn").addEventListener("click", () => { const i = $("#voxInput"); const v = i.value; i.value = ""; voxSend(v); });
  $("#voxInput").addEventListener("keydown", (e) => { if (e.key === "Enter") $("#sendBtn").click(); });
  $("#voxReset").addEventListener("click", resetChat);
  $("#voxFab").addEventListener("click", openVox);
  $("#voxOpen").addEventListener("click", openVox);
  $("#voxClose").addEventListener("click", closeVox);
  $("#voxSpeak").addEventListener("change", (e) => { if (!e.target.checked) stopAudio(); });
}

/* ---------- 6. boot ---------- */
function applyLang() {
  document.documentElement.lang = S.lang;
  document.body.classList.toggle("ta", S.lang === "ta");
  document.querySelectorAll(".seg button").forEach((b) => b.classList.toggle("on", b.dataset.lang === S.lang));
  $("#voxInput").placeholder = tr("placeholder");
  $("#sendBtn").textContent = tr("send");
  $("#voxReset").textContent = tr("newChat");
  if (voxEl().dataset.state === "idle") $("#voxState").textContent = tr("idle");
  renderNav(); renderView(); renderChips();
}

async function checkHealth() {
  const box = $("#sys");
  try {
    const h = await api("/api/health");
    box.replaceChildren(el("span", { class: `dot ${h.ai_ready ? "ok" : "bad"}` }),
      h.ai_ready ? "AI ready" : "GEMINI_API_KEY missing", el("br"), `Model: ${h.model}`, el("br"), `Voice: ${h.stt}`);
  } catch { box.replaceChildren(el("span", { class: "dot bad" }), "Server not reachable"); }
}

document.querySelectorAll(".seg button").forEach((b) =>
  b.addEventListener("click", () => { S.lang = b.dataset.lang; store.set("lang", S.lang); applyLang(); }));

wireVox();
applyLang();
addMsg("bot", tr("welcome"));
checkHealth();
