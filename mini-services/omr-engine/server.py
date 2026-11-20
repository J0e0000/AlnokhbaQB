# ALNOKHBA QB — OMR Engine HTTP service (stdlib only, port 3032)
#
# Auth: every route except GET /health requires
#   Authorization: Bearer <OMR_ENGINE_TOKEN>
# The service REFUSES to start on 0.0.0.0 when OMR_ENGINE_TOKEN is empty —
# an unauthenticated engine may only ever bind loopback.
import hmac
import json
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from engine.pipeline import ocr, process  # noqa: E402

PORT = int(os.environ.get("OMR_ENGINE_PORT", "3032"))
HOST = os.environ.get("OMR_ENGINE_HOST", "127.0.0.1")
TOKEN = (os.environ.get("OMR_ENGINE_TOKEN") or "").strip()
# Base64 expands a 20 MiB upload by roughly one third; leave room for JSON too.
MAX_BODY = 32 * 1024 * 1024


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _authorized(self) -> bool:
        """Bearer-token check (constant-time). GET /health is public by design;
        when no token is configured the service must be loopback-only (the
        startup guard below refuses 0.0.0.0 without a token)."""
        if not TOKEN:
            return True
        header = self.headers.get("Authorization", "")
        if header.startswith("Bearer "):
            provided = header[len("Bearer "):].strip()
            if provided and hmac.compare_digest(
                provided.encode("utf-8"), TOKEN.encode("utf-8")
            ):
                return True
        return False

    def _send(self, code: int, obj: dict) -> None:
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):  # noqa: N802
        if self.path == "/health":
            self._send(200, {"ok": True, "engine": "python-opencv", "version": "1.0.0"})
        else:
            self._send(404, {"ok": False, "error": "not found"})

    def do_POST(self):  # noqa: N802
        if not self._authorized():
            self._send(401, {"ok": False, "error": "unauthorized — missing or invalid bearer token"})
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
            else:
                self._send(404, {"ok": False, "error": "not found"})
        except Exception as e:  # noqa: BLE001
            import traceback

            traceback.print_exc()
            self._send(200, {"ok": False, "stage": "unhandled", "error": f"internal error: {e}"})

    def log_message(self, fmt, *args):  # quiet-ish
        sys.stderr.write("[omr-engine] " + (fmt % args) + "\n")


if __name__ == "__main__":
    if not TOKEN and HOST in ("0.0.0.0", "::", ""):
        print(
            "[omr-engine] refusing to start: OMR_ENGINE_TOKEN is empty but the "
            "host is public (0.0.0.0). Set OMR_ENGINE_TOKEN or bind 127.0.0.1.",
            flush=True,
        )
        sys.exit(1)
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"[omr-engine] listening on http://{HOST}:{PORT}", flush=True)
    server.serve_forever()
