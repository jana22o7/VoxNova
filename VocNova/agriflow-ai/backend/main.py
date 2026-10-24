"""
AgriFlow AI - backend
=====================
One FastAPI app that serves:
  * the dashboard frontend           (GET /)
  * 6 AI farming features            (POST /api/features/...)
  * Vox Nova, the voice AI chatbot   (POST /api/vox/...)

Voice pipeline (Vox Nova):
  mic audio -> Whisper STT (faster-whisper) -> Gemini (agri expert, JSON output)
            -> neural TTS (edge-tts, gTTS fallback) -> audio back to the browser

Run:  uvicorn main:app --reload --port 8000     (from the backend/ folder)
"""
from __future__ import annotations

import asyncio
import base64
import io
import logging
import os
import tempfile
from pathlib import Path
from typing import Dict, List, Literal, Optional

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from google import genai
from google.genai import types
from pydantic import BaseModel, Field

load_dotenv()
log = logging.getLogger("agriflow")
logging.basicConfig(level=logging.INFO)

# --------------------------------------------------------------------------
# Config
# --------------------------------------------------------------------------
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-3.8-flash")
STT_ENGINE = os.getenv("STT_ENGINE", "whisper").lower()
WHISPER_MODEL = os.getenv("WHISPER_MODEL", "small")

MAX_AUDIO_BYTES = 15 * 1024 * 1024
MAX_IMAGE_BYTES = 8 * 1024 * 1024
FRONTEND_DIR = Path(__file__).resolve().parent.parent / "frontend"

client = genai.Client(api_key=GEMINI_API_KEY) if GEMINI_API_KEY else None

app = FastAPI(title="AgriFlow AI + Vox Nova")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


def require_ai() -> genai.Client:
    if client is None:
        raise HTTPException(503, "GEMINI_API_KEY is not set. Add it to your .env file and restart the server.")
    return client


# --------------------------------------------------------------------------
# Schemas (Gemini returns these as structured JSON)
# --------------------------------------------------------------------------
class VoxReply(BaseModel):
    reply: str = Field(description="Text shown on screen, in the user's own style (English, Tamil script, or Tanglish).")
    speech: str = Field(description="Same meaning as reply, written so a text-to-speech voice reads it well. "
                                    "English -> English. Tamil or Tanglish -> Tamil script.")
    speech_lang: Literal["en", "ta"]
    style: Literal["english", "tamil", "tanglish"]


class Section(BaseModel):
    heading: str
    points: List[str]


class FeatureResult(BaseModel):
    headline: str = Field(description="One-line verdict, e.g. the disease name or the top recommendation.")
    summary: str = Field(description="2-3 plain sentences a farmer can act on today.")
    severity: Literal["good", "info", "warning", "critical"]
    confidence: int = Field(description="0-100 confidence in this answer.")
    sections: List[Section]
    voice_summary: str = Field(description="One or two short spoken sentences, no markdown.")


class ChatIn(BaseModel):
    session_id: str
    message: str
    context: Optional[str] = None
    speak: bool = True


class TTSIn(BaseModel):
    text: str
    lang: Literal["en", "ta"] = "en"


class FeatureIn(BaseModel):
    inputs: Dict[str, str] = {}
    lang: Literal["en", "ta"] = "en"


# --------------------------------------------------------------------------
# Prompts
# --------------------------------------------------------------------------
VOX_SYSTEM = """
You are Vox Nova, the voice assistant inside AgriFlow AI. You help farmers, agri-students and
home gardeners in India. Users speak or type English, Tamil (தமிழ்) or Tanglish (Tamil in English letters).

Expertise: plant disease diagnosis and remedies, crop planning by season/soil/water, pest control
(prefer organic: neem oil, panchakavya, kashayam, then safe chemical options), fertilizer and
irrigation, weather-aware farm decisions, and rough market/yield guidance.

Reply rules:
- Practical, warm, India-specific. Maximum 3 short sentences (4 only when diagnosing).
- Never use bullet points, asterisks, markdown, emojis or headings. Fluid spoken sentences only.
- "reply" matches the user's style: English -> English, Tamil script -> Tamil, Tanglish -> Tanglish.
- "speech" carries the same meaning for the voice: English stays English; Tamil and Tanglish are
  written fully in Tamil script (use common Tamil words, transliterate product names) and speech_lang is "ta".
- If a [Dashboard context] block is present, it is a result the user just saw in the dashboard. Use it.
- For any chemical, mention label dose and protective gear. If unsure, say so and suggest the
  nearest Krishi Vigyan Kendra or agriculture officer.
- If the question is not about farming, answer in one line and steer back to farming.
- When useful, point to a dashboard tool, e.g. "upload a leaf photo in Disease Detection".
"""

FEATURE_SYSTEM = """
You are AgriFlow AI, an expert agronomist and plant pathologist for Indian farmers.
Be specific, practical and safe. Prefer integrated pest management: cultural and organic first,
chemicals only with label dose, waiting period and protective gear. Never invent live market prices:
give typical ranges and tell the user to verify at the local mandi or eNAM. State assumptions when
inputs are missing. Fill every field of the schema. Use 3 to 5 sections with short, actionable points.
Write ALL text in {language}.
"""

FEATURE_TASKS: Dict[str, str] = {
    "crop": "Recommend the 3 best crops for these conditions. For each: why it fits, duration, water need, "
            "relative input cost, and a suitable variety. End with a section on risks and soil preparation.",
    "pest": "Diagnose the likely pest or insect problem and give a control plan. Sections: likely pest and "
            "how to confirm, organic control, chemical control if needed (dose, safety, waiting period), "
            "prevention. Respect the farmer's preferred method.",
    "fertilizer": "Create a fertilizer and irrigation plan for this crop and stage. Sections: nutrient plan "
                  "(with kg per acre), organic options, irrigation schedule, signs of deficiency to watch for. "
                  "If soil test values are given, interpret them.",
    "market": "Estimate the yield and economics for this crop. Sections: expected yield range per acre, typical "
              "cost of cultivation, typical price range and best selling window, ways to raise profit. "
              "Clearly mark all numbers as estimates.",
    "weather": "Using the REAL forecast data supplied, give a 7-day farm advisory. Sections: what to do "
               "in the next 48 hours (irrigation, spraying, harvesting), rain and heat risks, disease pressure "
               "from humidity, and a day-wise plan.",
}

DISEASE_TASK = ("Look at the plant photo and the notes. Identify the most likely disease, pest damage or "
                "nutrient problem. Sections: what I see, likely cause and alternatives, organic treatment, "
                "chemical treatment if needed (dose and safety), prevention. If the photo is unclear or not "
                "a plant, say so and lower the confidence.")


def language_name(lang: str) -> str:
    return "Tamil (தமிழ்)" if lang == "ta" else "English"


# --------------------------------------------------------------------------
# Speech-to-text
# --------------------------------------------------------------------------
_whisper = None
_whisper_lock = asyncio.Lock()


def _load_whisper():
    global _whisper
    if _whisper is None:
        from faster_whisper import WhisperModel
        log.info("Loading Whisper model '%s' (first run downloads it)...", WHISPER_MODEL)
        _whisper = WhisperModel(WHISPER_MODEL, device="auto", compute_type="int8")
    return _whisper


def _whisper_transcribe(path: str, language: Optional[str]) -> str:
    model = _load_whisper()
    segments, info = model.transcribe(
        path,
        language=language,                      # None = auto-detect
        beam_size=5,
        vad_filter=True,                        # drops silence, prevents "ghost" transcripts
        condition_on_previous_text=False,
        initial_prompt="Farming, crops, paddy, tomato, neem oil, panchakavya, leaf spot. "
                       "விவசாயம், பயிர், நோய், உரம், பூச்சி",
    )
    text = " ".join(s.text.strip() for s in segments).strip()
    log.info("Whisper heard (%s, p=%.2f): %s", info.language, info.language_probability, text)
    return text


async def transcribe(audio: bytes, mime: str, language: Optional[str]) -> str:
    if STT_ENGINE == "gemini":
        ai = require_ai()
        resp = await ai.aio.models.generate_content(
            model=GEMINI_MODEL,
            contents=[
                types.Part.from_bytes(data=audio, mime_type=mime.split(";")[0] or "audio/webm"),
                "Transcribe this speech exactly. Tamil must be in Tamil script, English in English. "
                "Return only the transcript. If there is no speech, return an empty string.",
            ],
        )
        return (resp.text or "").strip()

    suffix = ".mp4" if "mp4" in mime else ".ogg" if "ogg" in mime else ".wav" if "wav" in mime else ".webm"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as f:
        f.write(audio)
        path = f.name
    try:
        async with _whisper_lock:               # one transcription at a time keeps CPU/RAM predictable
            return await asyncio.to_thread(_whisper_transcribe, path, language)
    finally:
        try:
            os.remove(path)
        except OSError:
            pass


# --------------------------------------------------------------------------
# Text-to-speech
# --------------------------------------------------------------------------
VOICES = {"en": "en-IN-NeerjaNeural", "ta": "ta-IN-PallaviNeural"}


def _gtts(text: str, lang: str) -> bytes:
    from gtts import gTTS
    buf = io.BytesIO()
    gTTS(text=text, lang=lang, slow=False).write_to_fp(buf)
    return buf.getvalue()


async def synthesize(text: str, lang: str) -> bytes:
    text = text.strip()
    if not text:
        return b""
    try:
        import edge_tts
        chunks = bytearray()
        async for ch in edge_tts.Communicate(text, VOICES[lang], rate="-4%").stream():
            if ch["type"] == "audio":
                chunks += ch["data"]
        if chunks:
            return bytes(chunks)
    except Exception as e:                      # offline / blocked -> fall back
        log.warning("edge-tts failed (%s); falling back to gTTS", e)
    return await asyncio.to_thread(_gtts, text, lang)


def b64(data: bytes) -> str:
    return base64.b64encode(data).decode()


# --------------------------------------------------------------------------
# Vox Nova chat brain
# --------------------------------------------------------------------------
SESSIONS: Dict[str, List[types.Content]] = {}
MAX_TURNS = 12                                   # messages kept per session (user + model)


async def vox_think(session_id: str, user_text: str, context: Optional[str]) -> VoxReply:
    ai = require_ai()
    history = SESSIONS.setdefault(session_id, [])
    prompt = user_text if not context else f"[Dashboard context]\n{context[:2000]}\n[/Dashboard context]\n\n{user_text}"
    contents = history + [types.Content(role="user", parts=[types.Part(text=prompt)])]
    try:
        resp = await ai.aio.models.generate_content(
            model=GEMINI_MODEL,
            contents=contents,
            config=types.GenerateContentConfig(
                system_instruction=VOX_SYSTEM,
                temperature=0.5,
                response_mime_type="application/json",
                response_schema=VoxReply,
            ),
        )
        out: VoxReply = resp.parsed or VoxReply.model_validate_json(resp.text)
    except HTTPException:
        raise
    except Exception as e:
        log.exception("Gemini chat failed")
        raise HTTPException(502, f"AI service error: {e}")

    history.append(types.Content(role="user", parts=[types.Part(text=user_text)]))
    history.append(types.Content(role="model", parts=[types.Part(text=out.reply)]))
    del history[:-MAX_TURNS]
    return out


async def vox_payload(out: VoxReply, speak: bool) -> dict:
    audio = await synthesize(out.speech, out.speech_lang) if speak else b""
    return {
        "reply": out.reply,
        "speech": out.speech,
        "speech_lang": out.speech_lang,
        "style": out.style,
        "audio_b64": b64(audio) if audio else None,
        "audio_mime": "audio/mpeg",
    }


# --------------------------------------------------------------------------
# API: health
# --------------------------------------------------------------------------
@app.get("/api/health")
async def health():
    return {"ok": True, "ai_ready": client is not None, "model": GEMINI_MODEL,
            "stt": STT_ENGINE + (f":{WHISPER_MODEL}" if STT_ENGINE == "whisper" else ""),
            "tts": "edge-tts (gTTS fallback)"}


# --------------------------------------------------------------------------
# API: Vox Nova
# --------------------------------------------------------------------------
@app.post("/api/vox/chat")
async def vox_chat(body: ChatIn):
    text = body.message.strip()
    if not text:
        raise HTTPException(422, "Message is empty.")
    out = await vox_think(body.session_id, text, body.context)
    return await vox_payload(out, body.speak)


@app.post("/api/vox/voice")
async def vox_voice(
    audio: UploadFile = File(...),
    session_id: str = Form(...),
    lang_hint: str = Form("auto"),               # auto | en | ta
    context: Optional[str] = Form(None),
    speak: bool = Form(True),
):
    data = await audio.read()
    if len(data) > MAX_AUDIO_BYTES:
        raise HTTPException(413, "Audio is too long. Keep it under 30 seconds.")
    if len(data) < 1500:
        raise HTTPException(422, "Recording was too short. Hold on a bit longer and speak clearly.")

    hint = lang_hint if lang_hint in ("en", "ta") else None
    try:
        transcript = await transcribe(data, audio.content_type or "audio/webm", hint)
    except HTTPException:
        raise
    except Exception as e:
        log.exception("STT failed")
        raise HTTPException(502, f"Speech recognition failed: {e}")
    if not transcript:
        raise HTTPException(422, "I could not hear any speech. Try again closer to the microphone.")

    out = await vox_think(session_id, transcript, context)
    payload = await vox_payload(out, speak)
    payload["transcript"] = transcript
    return payload


@app.post("/api/vox/tts")
async def vox_tts(body: TTSIn):
    audio = await synthesize(body.text, body.lang)
    return {"audio_b64": b64(audio), "audio_mime": "audio/mpeg"}


@app.post("/api/vox/reset")
async def vox_reset(session_id: str = Form(...)):
    SESSIONS.pop(session_id, None)
    return {"ok": True}


# --------------------------------------------------------------------------
# API: the 6 dashboard features
# --------------------------------------------------------------------------
async def run_feature(task: str, user_block: str, lang: str, image: Optional[tuple] = None) -> FeatureResult:
    ai = require_ai()
    parts: list = []
    if image:
        parts.append(types.Part.from_bytes(data=image[0], mime_type=image[1]))
    parts.append(f"{task}\n\n{user_block}")
    try:
        resp = await ai.aio.models.generate_content(
            model=GEMINI_MODEL,
            contents=parts,
            config=types.GenerateContentConfig(
                system_instruction=FEATURE_SYSTEM.format(language=language_name(lang)),
                temperature=0.4,
                response_mime_type="application/json",
                response_schema=FeatureResult,
            ),
        )
        return resp.parsed or FeatureResult.model_validate_json(resp.text)
    except Exception as e:
        log.exception("Feature call failed")
        raise HTTPException(502, f"AI service error: {e}")


def format_inputs(inputs: Dict[str, str]) -> str:
    lines = [f"- {k}: {v}" for k, v in inputs.items() if v and v.strip()]
    return "Farmer's inputs:\n" + ("\n".join(lines) if lines else "- (none given, state your assumptions)")


# 1) Disease detection (photo + notes)
@app.post("/api/features/disease")
async def feature_disease(
    image: Optional[UploadFile] = File(None),
    crop: str = Form(""),
    symptoms: str = Form(""),
    lang: str = Form("en"),
):
    img = None
    if image is not None and image.filename:
        raw = await image.read()
        if len(raw) > MAX_IMAGE_BYTES:
            raise HTTPException(413, "Photo is larger than 8 MB. Use a smaller photo.")
        if not (image.content_type or "").startswith("image/"):
            raise HTTPException(415, "Please upload an image file (JPG, PNG or WebP).")
        img = (raw, image.content_type)
    if img is None and not symptoms.strip():
        raise HTTPException(422, "Upload a leaf photo or describe the symptoms.")
    block = format_inputs({"Crop": crop, "Symptoms described": symptoms})
    result = await run_feature(DISEASE_TASK, block, lang if lang in ("en", "ta") else "en", img)
    return {"result": result}


# 2, 3, 4, 6) crop / pest / fertilizer / market
@app.post("/api/features/{name}")
async def feature_generic(name: str, body: FeatureIn):
    if name == "weather":
        return await feature_weather(body)
    task = FEATURE_TASKS.get(name)
    if not task:
        raise HTTPException(404, f"Unknown feature '{name}'.")
    result = await run_feature(task, format_inputs(body.inputs), body.lang)
    return {"result": result}


# 5) Weather advisory, uses real forecast data (Open-Meteo, no API key needed)
async def feature_weather(body: FeatureIn):
    place = (body.inputs.get("Location") or "").strip()
    if not place:
        raise HTTPException(422, "Enter your village, town or district.")
    async with httpx.AsyncClient(timeout=15) as http:
        geo = await http.get("https://geocoding-api.open-meteo.com/v1/search",
                             params={"name": place, "count": 1, "language": "en"})
        found = (geo.json().get("results") or [])
        if not found:
            raise HTTPException(404, f"Could not find '{place}'. Try the nearest town name.")
        g = found[0]
        wx = await http.get("https://api.open-meteo.com/v1/forecast", params={
            "latitude": g["latitude"], "longitude": g["longitude"], "timezone": "auto", "forecast_days": 7,
            "current": "temperature_2m,relative_humidity_2m,wind_speed_10m,precipitation",
            "daily": "temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,"
                     "et0_fao_evapotranspiration",
        })
        wx.raise_for_status()
        data = wx.json()

    d = data["daily"]
    days = [{
        "date": d["time"][i], "max_c": d["temperature_2m_max"][i], "min_c": d["temperature_2m_min"][i],
        "rain_mm": d["precipitation_sum"][i], "rain_chance_pct": d["precipitation_probability_max"][i],
        "et0_mm": d["et0_fao_evapotranspiration"][i],
    } for i in range(len(d["time"]))]
    place_label = ", ".join(x for x in [g.get("name"), g.get("admin1"), g.get("country")] if x)
    block = (format_inputs({k: v for k, v in body.inputs.items() if k != "Location"})
             + f"\n\nLocation: {place_label}\nCurrent: {data['current']}\n7-day forecast: {days}")
    result = await run_feature(FEATURE_TASKS["weather"], block, body.lang)
    return {"result": result, "extra": {"place": place_label, "current": data["current"], "days": days}}


# --------------------------------------------------------------------------
# Frontend (must be mounted last so /api routes win)
# --------------------------------------------------------------------------
if FRONTEND_DIR.exists():
    app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")
