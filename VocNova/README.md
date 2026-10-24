# AgriFlow AI + Vox Nova

One dashboard, six AI farming tools, and Vox Nova, a real voice assistant (English, Tamil, Tanglish).

## Run it

```bash
cd agriflow-ai/backend
python -m venv .venv && source .venv/bin/activate        # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp ../.env.example .env                                   # then put your GEMINI_API_KEY in .env
uvicorn main:app --reload --port 8000
```

Open http://localhost:8000 (use localhost or HTTPS, browsers block the microphone on plain http elsewhere).
The first voice question downloads the Whisper model once (about 460 MB for `small`).

## What is inside

| Part | Tech |
|---|---|
| 1 Disease Detection (photo + notes) | Gemini vision |
| 2 Crop Recommendation | Gemini, structured JSON |
| 3 Pest Control (organic first) | Gemini, structured JSON |
| 4 Fertilizer & Irrigation | Gemini, structured JSON |
| 5 Weather Advisory | Open-Meteo live forecast (no key) + Gemini |
| 6 Market & Yield | Gemini estimates (verify prices at your mandi / eNAM) |
| Vox Nova speech-to-text | faster-whisper (Whisper) locally, or Gemini audio (`STT_ENGINE=gemini`) |
| Vox Nova voice out | edge-tts neural voices (ta-IN Pallavi, en-IN Neerja), gTTS fallback |

## Vox Nova pipeline

mic (MediaRecorder, auto-stops after 1.5 s of silence) -> `/api/vox/voice` -> Whisper -> Gemini (session memory,
JSON: on-screen reply + Tamil-script speech text) -> neural TTS -> browser plays it.
Every dashboard result has "Ask Vox Nova about this", which hands the result to the chatbot as context.

## Merging into your existing AgriFlow code

Vox Nova is self-contained:
* Backend: everything under "Vox Nova" in `backend/main.py` (`/api/vox/*`, `transcribe`, `synthesize`, `vox_think`).
* Frontend: the `<aside class="vox">` block in `index.html`, the "Vox Nova" section of `style.css`, and section 5 of `app.js`.
Copy those into your project and keep the same element ids.
