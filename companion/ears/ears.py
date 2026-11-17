"""Lyra's ears: listens on the PC microphone, hears when Chris speaks, and transcribes it locally.

- Mic capture: sounddevice (16 kHz mono). Pick the mic with MIC_NAME in .env (part of its name),
  otherwise the Windows default input is used.
- Speech detection: Silero VAD (starts on voice, ends after ~0.8 s of silence).
- Transcription: faster-whisper on the GPU (WHISPER_MODEL, default small.en), CPU fallback.
- Sends each sentence to her server (/api/heard). She never hears herself: while she's thinking or
  speaking, or the mic is switched off on her page, whatever it hears is thrown away.

Free and fully local. Run it with Start Lyra.bat (it starts this in its own window).
"""
import json, os, queue, sys, time, urllib.request
from pathlib import Path

import numpy as np
import sounddevice as sd

ROOT = Path(__file__).resolve().parent.parent


def load_env():
    env = {}
    for line in (ROOT / ".env").read_text(encoding="utf8").splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip()
    return env


ENV = load_env()
PORT = ENV.get("PORT", "8770")
SERVER = f"http://localhost:{PORT}"
OWNER_KEY = ENV.get("OWNER_KEY", "")
MIC_NAME = ENV.get("MIC_NAME", "")
MODEL = ENV.get("WHISPER_MODEL", "small.en")
RATE = 16000
CHUNK = 512  # Silero VAD wants 512 samples at 16 kHz


def post(path, body, timeout=5):
    req = urllib.request.Request(SERVER + path, data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read() or b"{}")


def ears_state():
    try:
        return post("/api/ears", {"ownerKey": OWNER_KEY})
    except Exception:
        return {"listen": False, "offline": True}


def pick_mic():
    devices = sd.query_devices()
    if MIC_NAME:
        for i, d in enumerate(devices):
            if d["max_input_channels"] > 0 and MIC_NAME.lower() in d["name"].lower() and d["hostapi"] == 0:
                return i, d["name"]
        for i, d in enumerate(devices):
            if d["max_input_channels"] > 0 and MIC_NAME.lower() in d["name"].lower():
                return i, d["name"]
        print(f"Mic '{MIC_NAME}' not found, using the Windows default.")
    i = sd.default.device[0]
    return i, devices[i]["name"]


def load_whisper():
    from faster_whisper import WhisperModel
    try:
        m = WhisperModel(MODEL, device="cuda", compute_type="float16")
        print(f"Whisper {MODEL} on the GPU.")
    except Exception as e:
        print(f"GPU not available ({e.__class__.__name__}), using the CPU.")
        m = WhisperModel(MODEL, device="cpu", compute_type="int8")
    return m


def serve_transcription(whisper, lock):
    """Discord voice sends people's speech here (48 kHz mono 16-bit PCM) and gets text back.
    Same GPU Whisper as the PC mic, so it's free and stays on this computer."""
    import threading
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

    class H(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def do_POST(self):
            if self.path != "/transcribe":
                self.send_response(404); self.end_headers(); return
            n = int(self.headers.get("Content-Length", 0))
            pcm = np.frombuffer(self.rfile.read(n), dtype=np.int16).astype(np.float32) / 32768.0
            audio = pcm[: len(pcm) // 3 * 3].reshape(-1, 3).mean(axis=1)  # 48 kHz -> 16 kHz
            text = ""
            if len(audio) > RATE * 0.4:
                with lock:
                    segs, _ = whisper.transcribe(audio, language="en", beam_size=3, condition_on_previous_text=False)
                    text = " ".join(s.text.strip() for s in segs).strip()
            if text.lower() in JUNK:
                text = ""
            body = json.dumps({"text": text}).encode()
            self.send_response(200); self.send_header("Content-Type", "application/json"); self.end_headers()
            self.wfile.write(body)

    port = int(ENV.get("EARS_PORT", "8772"))
    srv = ThreadingHTTPServer(("127.0.0.1", port), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    print(f"Discord voice transcription on http://127.0.0.1:{port}/transcribe")


# Whisper sometimes "hears" these in silence or noise
JUNK = {"", "you", "thank you.", "thanks for watching!", "thank you for watching.", "bye.", ".", "uh", "um", "hmm"}


def main():
    from silero_vad import load_silero_vad, VADIterator
    import torch

    mic, mic_name = pick_mic()
    print(f"Listening on: {mic_name}")
    whisper = load_whisper()
    import threading
    lock = threading.Lock()
    serve_transcription(whisper, lock)
    vad_model = load_silero_vad()
    vad = VADIterator(vad_model, threshold=0.5, sampling_rate=RATE, min_silence_duration_ms=800, speech_pad_ms=200)

    q = queue.Queue()
    stream = sd.InputStream(device=mic, channels=1, samplerate=RATE, blocksize=CHUNK, dtype="float32",
                            callback=lambda data, frames, t, status: q.put(data[:, 0].copy()))
    stream.start()

    pre = []          # a little audio from before speech starts
    speech = None     # audio of the current sentence
    state = {"listen": False}
    last_check = 0.0
    print("Ready. Speak to Lyra. (Ctrl+C to stop)")

    while True:
        chunk = q.get()
        now = time.time()
        if now - last_check > 0.4:
            state = ears_state()
            last_check = now
            if state.get("offline"):
                print("Waiting for Lyra's server...", end="\r")

        if not state.get("listen"):
            # she's speaking / thinking / mic off: drop everything and reset
            if speech is not None:
                speech = None
            vad.reset_states()
            pre.clear()
            continue

        event = vad(torch.from_numpy(chunk), return_seconds=False)
        if speech is None:
            pre.append(chunk)
            if len(pre) > 10:
                pre.pop(0)
        else:
            speech.append(chunk)

        if event and "start" in event and speech is None:
            speech = list(pre) + [chunk]
            try: post("/api/ears/activity", {"ownerKey": OWNER_KEY, "state": "hearing"})
            except Exception: pass
        elif event and "end" in event and speech is not None:
            audio = np.concatenate(speech)
            speech = None
            seconds = len(audio) / RATE
            if seconds < 0.45:
                continue
            try: post("/api/ears/activity", {"ownerKey": OWNER_KEY, "state": "transcribing"})
            except Exception: pass
            with lock:
                segs, _ = whisper.transcribe(audio, language="en", beam_size=3, vad_filter=False, condition_on_previous_text=False)
                text = " ".join(s.text.strip() for s in segs).strip()
            if text.lower() in JUNK or len(text) < 2:
                try: post("/api/ears/activity", {"ownerKey": OWNER_KEY, "state": "idle"})
                except Exception: pass
                continue
            print(f"Heard ({seconds:.1f}s): {text}")
            try:
                r = post("/api/heard", {"ownerKey": OWNER_KEY, "text": text}, timeout=5)
                if r.get("error"):
                    print("  ->", r["error"])
            except Exception as e:
                print("  -> couldn't reach Lyra:", e)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(0)
