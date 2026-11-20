# OMR/OCR engine — host on Fly.io / Render / Railway, then set OMR_ENGINE_URL in Vercel.
FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    tesseract-ocr tesseract-ocr-ara tesseract-ocr-eng libgl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
ENV OMR_ENGINE_PORT=3032 OMR_ENGINE_HOST=0.0.0.0
EXPOSE 3032
CMD ["python3", "server.py"]
