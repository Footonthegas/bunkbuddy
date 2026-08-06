"""
solve_captcha_cli.py - CAPTCHA solver using ddddocr with old model for numeric CAPTCHAs.

Reads raw image bytes from stdin, solves using ddddocr old model with
multiple preprocessing variants, writes best candidate to stdout.

Usage:
    python solve_captcha_cli.py < image_bytes
    cat captcha.jpg | python solve_captcha_cli.py
"""
import io
import re
import sys
from collections import Counter

import ddddocr
from PIL import Image, ImageOps, ImageFilter, ImageEnhance

EXPECTED_CAPTCHA_LEN = 5

try:
    _ocr = ddddocr.DdddOcr(show_ad=False, old_model=True)
    print(f"[CAPTCHA-PY-DEBUG] ddddocr old_model loaded", file=sys.stderr, flush=True)
except TypeError:
    print(f"[CAPTCHA-PY-DEBUG] old_model not supported, using default model", file=sys.stderr, flush=True)
    try:
        _ocr = ddddocr.DdddOcr(show_ad=False)
        print(f"[CAPTCHA-PY-DEBUG] ddddocr default model loaded", file=sys.stderr, flush=True)
    except Exception as e2:
        print(f"[CAPTCHA-PY-DEBUG] ddddocr init failed: {e2}", file=sys.stderr, flush=True)
        _ocr = None
except Exception as e:
    print(f"[CAPTCHA-PY-DEBUG] ddddocr init failed: {e}", file=sys.stderr, flush=True)
    _ocr = None


def _build_variants(raw_bytes):
    try:
        base = Image.open(io.BytesIO(raw_bytes))
        print(f"[CAPTCHA-PY-DEBUG] image format={base.format} size={base.size} mode={base.mode}", file=sys.stderr, flush=True)
        base = base.convert("L")
        base = ImageOps.autocontrast(base)
    except Exception as e:
        print(f"[CAPTCHA-PY-DEBUG] image load failed: {e}", file=sys.stderr, flush=True)
        return []

    variants = [base]
    denoised = base.filter(ImageFilter.MedianFilter(size=3))
    variants.append(denoised)

    bw = denoised.point(lambda p: 255 if p > 128 else 0).convert("L")
    variants.append(bw)

    out = []
    seen = set()
    for img in variants:
        scaled = img.resize((img.width * 3, img.height * 3), Image.Resampling.NEAREST)
        buf = io.BytesIO()
        scaled.save(buf, format="PNG")
        b = buf.getvalue()
        if b not in seen and len(b) > 10:
            out.append(b)
            seen.add(b)

    print(f"[CAPTCHA-PY-DEBUG] built {len(out)} variants", file=sys.stderr, flush=True)
    return out


def solve(raw_bytes):
    if not raw_bytes:
        return ""

    variants = _build_variants(raw_bytes)
    if not variants:
        return ""

    predictions = []
    for i, vb in enumerate(variants):
        if _ocr is None:
            break
        try:
            raw = _ocr.classification(vb)
            digits = re.sub(r"\D", "", raw or "")
            print(f"[CAPTCHA-PY-DEBUG] variant {i}: raw={raw!r} digits={digits!r}", file=sys.stderr, flush=True)
            if digits:
                predictions.append(digits)
                if len(digits) == EXPECTED_CAPTCHA_LEN:
                    print(f"[CAPTCHA-PY-DEBUG] early exit on variant {i}", file=sys.stderr, flush=True)
                    return digits
        except Exception as e:
            print(f"[CAPTCHA-PY-DEBUG] variant {i} failed: {e}", file=sys.stderr, flush=True)
            continue

    if not predictions:
        return ""

    exact_len = [p for p in predictions if len(p) == EXPECTED_CAPTCHA_LEN]
    if exact_len:
        result = Counter(exact_len).most_common(1)[0][0]
        print(f"[CAPTCHA-PY-DEBUG] selected (exact): {result}", file=sys.stderr, flush=True)
        return result

    near_len = [p for p in predictions if len(p) >= 4]
    if near_len:
        result = Counter(near_len).most_common(1)[0][0]
        print(f"[CAPTCHA-PY-DEBUG] selected (near): {result}", file=sys.stderr, flush=True)
        return result

    return ""


if __name__ == "__main__":
    raw = sys.stdin.buffer.read()
    if not raw:
        print("", end="")
        sys.exit(1)
    result = solve(raw)
    print(result, end="")
