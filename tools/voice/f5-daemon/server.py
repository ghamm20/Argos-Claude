"""
ARGOS F5-TTS daemon (Phase 7-C). Loads the F5 model ONCE and serves
synthesis over local HTTP, eliminating the ~20s per-call cold-load that the
CLI-spawn path pays. Pure stdlib HTTP server (no Flask) so it adds no deps
beyond F5-TTS itself.

Run with the F5 venv python (or `npm run voice:f5-daemon`), e.g.:
  <ARGOS_F5_HOME>/venv/Scripts/python.exe server.py

Env:
  ARGOS_F5_PORT    listen port (default 7880)
  ARGOS_F5_DEVICE  cuda | cpu (default cuda)
  ARGOS_F5_MODEL   F5 model name (default F5TTS_v1_Base)
  ARGOS_ROOT       used to resolve the default Bartimaeus reference clip

Endpoints:
  GET  /health  -> 200 {"ok":true,"model":...,"device":...,"ready":true}
  POST /synth   -> body {text, ref_wav?, ref_text?, nfe_step?} -> audio/wav
"""
import os
import sys
import json
import time
import threading
import tempfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import torch  # noqa: F401  (ensures CUDA is initialized early)
from f5_tts.api import F5TTS

PORT = int(os.environ.get("ARGOS_F5_PORT", "7880"))
DEVICE = os.environ.get("ARGOS_F5_DEVICE", "cuda")
MODEL = os.environ.get("ARGOS_F5_MODEL", "F5TTS_v1_Base")
ARGOS_ROOT = os.environ.get("ARGOS_ROOT", "")
REFDIR = os.path.join(ARGOS_ROOT, "tools", "voice", "bart-reference") if ARGOS_ROOT else ""
DEFAULT_REF = os.path.join(REFDIR, "bart-ref.wav") if REFDIR else ""
DEFAULT_REFTXT = os.path.join(REFDIR, "bart-ref.txt") if REFDIR else ""

print(f"[f5-daemon] loading {MODEL} on {DEVICE} (port {PORT}) ...", flush=True)
_f5 = F5TTS(model=MODEL, device=DEVICE)
_lock = threading.Lock()  # F5 inference is not re-entrant; serialize.
print(f"[f5-daemon] ready — listening on 127.0.0.1:{PORT}", flush=True)


def _default_reftext():
    try:
        with open(DEFAULT_REFTXT, encoding="utf-8") as f:
            return f.read().strip()
    except Exception:
        return ""


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):  # silence default stderr logging
        pass

    def _json(self, code, obj):
        b = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def do_GET(self):
        if self.path == "/health":
            self._json(200, {"ok": True, "ready": True, "model": MODEL, "device": DEVICE})
        else:
            self._json(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/synth":
            self._json(404, {"error": "not found"})
            return
        try:
            n = int(self.headers.get("content-length", 0))
            body = json.loads(self.rfile.read(n) or b"{}")
        except Exception as e:
            self._json(400, {"error": f"bad body: {e}"})
            return
        text = (body.get("text") or "").strip()
        if not text:
            self._json(400, {"error": "text required"})
            return
        ref_wav = body.get("ref_wav") or DEFAULT_REF
        ref_text = body.get("ref_text")
        if ref_text is None:
            ref_text = _default_reftext()
        try:
            nfe = int(body.get("nfe_step", 64))
        except Exception:
            nfe = 64
        if not ref_wav or not os.path.exists(ref_wav):
            self._json(400, {"error": f"reference wav not found: {ref_wav}"})
            return

        out = os.path.join(tempfile.gettempdir(), f"f5d_{int(time.time() * 1000)}.wav")
        try:
            t0 = time.time()
            with _lock:
                _f5.infer(
                    ref_file=ref_wav,
                    ref_text=ref_text,
                    gen_text=text,
                    file_wave=out,
                    nfe_step=nfe,
                    remove_silence=True,
                )
            with open(out, "rb") as f:
                data = f.read()
            self.send_response(200)
            self.send_header("content-type", "audio/wav")
            self.send_header("content-length", str(len(data)))
            self.send_header("x-f5-gen-ms", str(int((time.time() - t0) * 1000)))
            self.end_headers()
            self.wfile.write(data)
        except Exception as e:
            self._json(500, {"error": str(e)})
        finally:
            try:
                os.unlink(out)
            except Exception:
                pass


def main():
    try:
        ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
    except KeyboardInterrupt:
        sys.exit(0)


if __name__ == "__main__":
    main()
