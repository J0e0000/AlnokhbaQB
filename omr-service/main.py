# ============================================================
# ALNOKHBA QB — OMR engine, Vercel Service (FastAPI/ASGI).
# Same engine code as mini-services/omr-engine (local dev :3032) —
# engine/ is a committed mirror; keep the two in sync.
# Publicly routed at /api/omr/* via the top-level rewrite in vercel.json.
# Optional shared secret: when OMR_SHARED_SECRET is set, callers must send
# the x-anqb-omr-key header (the Next.js scan route does automatically).
import asyncio
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from engine.pipeline import ocr as engine_ocr
from engine.pipeline import process as engine_process

MAX_BODY = 25 * 1024 * 1024
SHARED_SECRET = (os.environ.get("OMR_SHARED_SECRET") or "").strip()

app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)


def _authorized(request: Request) -> bool:
    if not SHARED_SECRET:
        return True  # no secret configured → open (local/dev posture)
    return (request.headers.get("x-anqb-omr-key") or "") == SHARED_SECRET


@app.get("/api/omr/health")
async def health():
    info = {"ok": True, "engine": "python-opencv", "version": "1.0.0"}
    try:
        import cv2  # noqa: F401 — proves the opencv stack really loads

        info["opencv"] = cv2.__version__
    except Exception as e:  # noqa: BLE001
        info = {"ok": False, "engine": "python-opencv", "error": f"opencv unavailable: {e}"}
    return JSONResponse(info, status_code=200 if info["ok"] else 503)


@app.post("/api/omr/process")
async def process_route(request: Request):
    if not _authorized(request):
        return JSONResponse({"ok": False, "stage": "unauthorized", "error": "unauthorized"}, status_code=401)
    body = await request.body()
    if len(body) > MAX_BODY:
        return JSONResponse({"ok": False, "error": "payload too large"}, status_code=413)
    try:
        payload = json.loads(body.decode("utf-8"))
    except Exception as e:  # noqa: BLE001
        return JSONResponse({"ok": False, "error": f"invalid JSON body: {e}"}, status_code=400)
    # engine is CPU-bound (cv2) — keep the event loop free via a worker thread
    loop = asyncio.get_running_loop()
    result = await loop.run_in_executor(None, lambda: engine_process(payload))
    return JSONResponse(result)


@app.post("/api/omr/ocr")
async def ocr_route(request: Request):
    if not _authorized(request):
        return JSONResponse({"ok": False, "stage": "unauthorized", "error": "unauthorized"}, status_code=401)
    body = await request.body()
    if len(body) > MAX_BODY:
        return JSONResponse({"ok": False, "error": "payload too large"}, status_code=413)
    try:
        payload = json.loads(body.decode("utf-8"))
    except Exception as e:  # noqa: BLE001
        return JSONResponse({"ok": False, "error": f"invalid JSON body: {e}"}, status_code=400)
    loop = asyncio.get_running_loop()
    result = await loop.run_in_executor(
        None, lambda: engine_ocr(payload.get("imageBase64", ""), payload.get("lang", "eng"))
    )
    return JSONResponse(result)
