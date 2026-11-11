# ALNOKHBA QB — OMR Engine HTTP service (stdlib only, port 3032)
import hashlib
import hmac
import json
import os
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from engine.pipeline import ocr, process  # noqa: E402

PORT = 3032
HOST = os.environ.get("OMR_ENGINE_HOST", "127.0.0.1")  # 0.0.0.0 in Docker
MAX_BODY = 40 * 1024 * 1024
SHARED_SECRET = os.environ.get("OMR_SHARED_SECRET", "").strip()
# Localhost-only by default; when exposed (Docker/0.0.0.0) the shared secret
# becomes REQUIRED so the engine can never serve as an unauthenticated public
# endpoint.
if HOST != "127.0.0.1" and not SHARED_SECRET:
    print("[omr-engine] WARNING: bound to a non-loopback host without OMR_SHARED_SECRET — refusing to start", flush=True)
    sys.exit(1)

# naive per-IP sliding-window rate limit (process-wide, stdlib only)
_RATE: dict[str, list[float]] = {}
RATE_LIMIT = int(os.environ.get("OMR_RATE_LIMIT", "120"))  # requests/min/IP
RATE_WINDOW = 60.0


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _rate_ok(self) -> bool:
        if RATE_LIMIT <= 0:
            return True
        ip = self.client_address[0]
        now = time.time()
        bucket = [t for t in _RATE.get(ip, []) if now - t < RATE_WINDOW]
        bucket.append(now)
        _RATE[ip] = bucket
        return len(bucket) <= RATE_LIMIT

    def _authed(self) -> bool:
        if not SHARED_SECRET:
            return True  # loopback dev mode
        got = self.headers.get("x-anqb-omr-key", "")
        return hmac.compare_digest(got, SHARED_SECRET)

    def _send(self, code: int, obj: dict) -> None:
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):  # noqa: N802
        if not self._rate_ok():
            self._send(429, {"ok": False, "error": "rate limit exceeded"})
            return
        if self.path == "/health":
            self._send(200, {"ok": True, "engine": "python-opencv", "version": "1.1.0"})
        else:
            self._send(404, {"ok": False, "error": "not found"})

    def do_POST(self):  # noqa: N802
        if not self._rate_ok():
            self._send(429, {"ok": False, "error": "rate limit exceeded"})
            return
        if not self._authed():
            self._send(401, {"ok": False, "error": "unauthorized"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length > MAX_BODY:
                self._send(413, {"ok": False, "error": "payload too large"})
                return
            raw = self.rfile.read(length)
            payload = json.loads(raw.decode("utf-8"))
        except Exception as e:  # noqa: BLE001
            self._send(400, {"ok": False, "error": f"invalid JSON body: {e}"})
            return

        try:
            if self.path == "/process":
                result = process(payload)
                self._send(200, result)
            elif self.path == "/ocr":
                result = ocr(payload.get("imageBase64", ""), payload.get("lang", "eng"))
                self._send(200, result)
            elif self.path == "/pdf_pages":
                # Rasterize a batch of PDF pages → JPEG base64 (chunked cursor:
                # { pdfBase64, fromPage, maxPages, dpi, quality }).
                from engine.pipeline import pdf_pages

                result = pdf_pages(
                    payload.get("pdfBase64", ""),
                    dpi=int(payload.get("dpi") or 200),
                    from_page=int(payload.get("fromPage") or 0),
                    max_pages=int(payload.get("maxPages") or 30),
                    quality=int(payload.get("quality") or 85),
                )
                self._send(200, {"ok": True, **result})
            else:
                self._send(404, {"ok": False, "error": "not found"})
        except ValueError as e:
            self._send(200, {"ok": False, "stage": "pdf", "error": str(e)})
        except Exception as e:  # noqa: BLE001
            import traceback

            traceback.print_exc()
            self._send(200, {"ok": False, "stage": "unhandled", "error": f"internal error: {e}"})

    def log_message(self, fmt, *args):  # quiet-ish
        sys.stderr.write("[omr-engine] " + (fmt % args) + "\n")


if __name__ == "__main__":
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"[omr-engine] listening on http://{HOST}:{PORT}", flush=True)
    server.serve_forever()
