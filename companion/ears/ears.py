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


class HealingWhisper:
    """Whisper that survives a GPU reset (2026-11-25: the NVIDIA driver reset itself, and every transcription after
    it failed with "CUDA failed with error unknown error" until Lyra was restarted). On a CUDA error it moves to the
    CPU and does the same audio again; after a while it tries the graphics card again."""
    GPU_REST_S = 600

    def __init__(self):
        self.model, self.device, self.gpu_rest_until = None, None, 0
        self.load()

    def load(self, cpu=False):
        from faster_whisper import WhisperModel
        old, self.model = self.model, None
        del old
        if not cpu:
            try:
                self.model, self.device = WhisperModel(MODEL, device="cuda", compute_type="float16"), "cuda"
                print(f"Whisper {MODEL} on the GPU.")
                return
            except Exception as e:
                print(f"GPU not available ({e.__class__.__name__}), using the CPU.")
        self.model, self.device = WhisperModel(MODEL, device="cpu", compute_type="int8"), "cpu"
        if cpu:
            print(f"Whisper {MODEL} on the CPU for now (the graphics card stopped answering).")

    def text(self, audio, **kw):
        if self.device == "cpu" and self.gpu_rest_until and time.time() > self.gpu_rest_until:
            self.gpu_rest_until = 0
            self.load()  # the card may be back: try it again
        try:
            segs, _ = self.model.transcribe(audio, **kw)
            return " ".join(s.text.strip() for s in segs).strip()  # (errors surface here, while the segments are made)
        except RuntimeError as e:
            if self.device != "cuda" or "cuda" not in str(e).lower():
                raise
            print(f"The graphics card stopped answering ({e}); moving to the CPU and trying again.", flush=True)
            self.load(cpu=True)
            self.gpu_rest_until = time.time() + self.GPU_REST_S
            segs, _ = self.model.transcribe(audio, **kw)
            return " ".join(s.text.strip() for s in segs).strip()


def load_whisper():
    return HealingWhisper()


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
                    text = whisper.text(audio, language="en", beam_size=3, condition_on_previous_text=False)
            if text.lower() in JUNK:
                text = ""
            body = json.dumps({"text": text}).encode()
            self.send_response(200); self.send_header("Content-Type", "application/json"); self.end_headers()
            self.wfile.write(body)

    port = int(ENV.get("EARS_PORT", "8772"))
    srv = ThreadingHTTPServer(("127.0.0.1", port), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    print(f"Discord voice transcription on http://127.0.0.1:{port}/transcribe")


# A pause isn't the end of a sentence (Chris: "I'd like to finish my sentences even if I pause").
# Each pause ends a piece of speech, but the words are held: a short beat if it sounds finished, longer if it
# sounds cut off ("and...", "so...", "the..."). Speaking again in that time joins the same turn.
# Same rules as lyra-runtime/src/voice/endpoint.js (Discord voice).
import re
GRACE_S = float(ENV.get("EARS_GRACE_MS", "700")) / 1000  # from companion/.env
THINK_S = float(ENV.get("EARS_THINK_MS", "2600")) / 1000
TRAILING = re.compile(r"\b(and|but|so|or|because|cause|cuz|um+|uh+|er+|like|the|a|an|to|of|with|for|from|in|on|at|if|when|while|that|which|who|what|my|your|our|their|his|her|i|i'm|im|it's|is|was|are|were|then|also|just|maybe|actually|well|about|into|than|as|not|really|very|kind of|sort of|you know|i mean|let me|i think|i want|i need)[,.…-]*$", re.I)


def sounds_unfinished(text):
    t = text.strip()
    if not t:
        return False
    if re.search(r"(\.\.\.|…|,|-|–)$", t) or TRAILING.search(t):
        return True
    return not re.search(r"[.!?][\"')]*$", t)


def wait_for(text):
    return THINK_S if sounds_unfinished(text) else GRACE_S


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

    held = None       # words said so far in this turn, waiting in case there's more: {"text", "until"}
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

        # the turn is over: nothing more said in time (and not mid-word right now)
        if held and speech is None and now >= held["until"]:
            text, held = held["text"], None
            print(f"Heard: {text}")
            try:
                r = post("/api/heard", {"ownerKey": OWNER_KEY, "text": text}, timeout=5)
                if r.get("error"):
                    print("  ->", r["error"])
            except Exception as e:
                print("  -> couldn't reach Lyra:", e)

        if not state.get("listen"):
            # she's speaking / thinking / mic off: drop everything and reset
            held = None
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
                text = whisper.text(audio, language="en", beam_size=3, vad_filter=False, condition_on_previous_text=False)
            if text.lower() in JUNK or len(text) < 2:
                try: post("/api/ears/activity", {"ownerKey": OWNER_KEY, "state": "idle"})
                except Exception: pass
                continue
            # hold it: maybe there's more to this sentence
            held = {"text": f'{held["text"]} {text}'.strip() if held else text}
            held["until"] = time.time() + wait_for(held["text"])
            print(f"  ...({seconds:.1f}s) {text}  [waiting {wait_for(held['text']):.1f}s for more]")
            try: post("/api/ears/activity", {"ownerKey": OWNER_KEY, "state": "hearing"})
            except Exception: pass


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(0)
