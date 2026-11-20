#!/bin/bash
set -euo pipefail
BUILD_DIR="${BUILD_DIR:?BUILD_DIR is required}"
RUNTIME_DIR="$BUILD_DIR/tesseract-runtime"
BIN_DIR="$RUNTIME_DIR/bin"
LIB_DIR="$RUNTIME_DIR/lib"
TESSDATA_DIR="$RUNTIME_DIR/share/tessdata"

install_tesseract_if_needed() {
    local have_tesseract=0
    if command -v tesseract >/dev/null 2>&1; then
        local langs
        langs="$(tesseract --list-langs 2>/dev/null || true)"
        if printf '%s\n' "$langs" | grep -qx 'eng' && printf '%s\n' "$langs" | grep -qx 'ara'; then
            have_tesseract=1
        fi
    fi
    [ "$have_tesseract" -eq 1 ] && return 0

    if [ "$(id -u)" -eq 0 ]; then
        SUDO=""
    elif command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
        SUDO="sudo"
    else
        echo "❌ Tesseract with eng+ara trained data is required to build OCR runtime; install tesseract-ocr, tesseract-ocr-eng, and tesseract-ocr-ara first." >&2
        return 1
    fi
    if ! command -v apt-get >/dev/null 2>&1; then
        echo "❌ Cannot install Tesseract automatically: apt-get is unavailable." >&2
        return 1
    fi
    echo "📦 Installing missing Tesseract OCR runtime and language data..."
    $SUDO apt-get update -qq
    $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq tesseract-ocr tesseract-ocr-eng tesseract-ocr-ara
}

install_tesseract_if_needed
TESSERACT_BIN="$(command -v tesseract)"
SYSTEM_TESSDATA="$(tesseract --list-langs 2>&1 | sed -n 's/^List of available languages in "\(.*\)" .*/\1/p' | head -n 1 | sed 's:/*$::')"
if [ ! -x "$TESSERACT_BIN" ] || [ ! -d "$SYSTEM_TESSDATA" ]; then
    echo "❌ Could not locate Tesseract executable or trained-data directory." >&2
    exit 1
fi

mkdir -p "$BIN_DIR" "$LIB_DIR" "$TESSDATA_DIR"
cp -L "$TESSERACT_BIN" "$BIN_DIR/tesseract"
chmod 755 "$BIN_DIR/tesseract"
for lang in eng ara; do
    if [ ! -f "$SYSTEM_TESSDATA/$lang.traineddata" ]; then
        echo "❌ Missing Tesseract language data: $SYSTEM_TESSDATA/$lang.traineddata" >&2
        exit 1
    fi
    cp -L "$SYSTEM_TESSDATA/$lang.traineddata" "$TESSDATA_DIR/$lang.traineddata"
done

# Bundle every dynamically-linked library reported by ldd; keep the binary
# portable across the runtime image without requiring system Tesseract packages.
while IFS= read -r library; do
    [ -f "$library" ] || continue
    cp -L "$library" "$LIB_DIR/$(basename "$library")"
done < <(ldd "$TESSERACT_BIN" | awk '{ for (i = 1; i <= NF; i++) if ($i ~ /^\//) { print $i; break } }' | sort -u)

if ! LD_LIBRARY_PATH="$LIB_DIR${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" \
    "$BIN_DIR/tesseract" --tessdata-dir "$TESSDATA_DIR" --list-langs 2>&1 \
    | grep -qx 'eng' || ! LD_LIBRARY_PATH="$LIB_DIR${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" \
    "$BIN_DIR/tesseract" --tessdata-dir "$TESSDATA_DIR" --list-langs 2>&1 | grep -qx 'ara'; then
    echo "❌ Bundled Tesseract failed its language-data self-check." >&2
    exit 1
fi

echo "✅ Tesseract runtime packaged at $RUNTIME_DIR"
 du -sh "$RUNTIME_DIR"
