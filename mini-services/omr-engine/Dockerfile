# ALNOKHBA QB — OMR/OCR engine container (Fly.io / Render / Railway / any Docker host).
#
# WHY THIS EXISTS: the Vercel FastAPI service (omr-service/) runs the OMR
# pipeline fine, but the Vercel Python runtime has no tesseract binary, so
# OCR there degrades to the z-ai VLM fallback (whose gateway is only
# reachable from Z.ai-hosted runs). This container ships the FULL engine:
# OMR + tesseract OCR with the bundled Arabic/English tessdata.
#
# RUN (Fly.io / Render / Railway all accept a Dockerfile):
#   docker build -t alnokhba-omr-engine .
#   docker run -p 3032:3032 -e OMR_SHARED_SECRET=<same-as-web> alnokhba-omr-engine
#
# WIRE UP: set OMR_ENGINE_URL=https://<engine-host> (and the same
# OMR_SHARED_SECRET) on the Next.js app — src/lib/omr/client.ts prefers the
# explicit OMR_ENGINE_URL over every other resolution strategy.
# Security: binding 0.0.0.0 REQUIRES OMR_SHARED_SECRET (server.py refuses to
# start without it), so the engine can never be an unauthenticated endpoint.

FROM python:3.12-slim

# tesseract binary for OCR (ara + eng language packs), plus the runtime
# libraries the opencv-headless wheels may dlopen on slim images.
RUN apt-get update && apt-get install -y --no-install-recommends \
      tesseract-ocr \
      tesseract-ocr-ara \
      libgl1 \
      libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY server.py ./
COPY engine/ ./engine/
COPY tessdata/ ./tessdata/

ENV OMR_ENGINE_HOST=0.0.0.0 \
    OMR_ENGINE_PORT=3032 \
    PYTHONUNBUFFERED=1

EXPOSE 3032

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:3032/health', timeout=4).status == 200 else 1)"

CMD ["python", "server.py"]
