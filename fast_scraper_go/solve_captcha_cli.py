"""
solve_captcha_cli.py - CAPTCHA solver using pytesseract with aggressive preprocessing.

Reads raw image bytes from stdin, solves using tesseract OCR with multiple
preprocessing variants, and writes the best candidate text to stdout.

Falls back to ddddocr if pytesseract fails.

Usage:
    python solve_captcha_cli.py < image_bytes
    cat captcha.png | python solve_captcha_cli.py
"""
import io
import re
import sys
import os
import subprocess
from collections import Counter

import numpy as np
from PIL import Image, ImageOps, ImageFilter
import pytesseract

EXPECTED_CAPTCHA_LEN = 5

_custom_config = r'--oem 3 --psm 8 -c tessedit_char_whitelist=0123456789'


def _try_tesseract(img: Image.Image) -> str:
    try:
        text = pytesseract.image_to_string(img, config=_custom_config)
        digits = re.sub(r"\D", "", text or "")
        return digits
    except Exception:
        return ""


def _try_ddddocr(img: Image.Image) -> str:
    try:
        import ddddocr
        if not hasattr(_try_ddddocr, '_ocr'):
            _try_ddddocr._ocr = ddddocr.DdddOcr(show_ad=False)
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        raw = _try_ddddocr._ocr.classification(buf.getvalue())
        digits = re.sub(r"\D", "", raw or "")
        return digits
    except Exception:
        return ""


def _preprocess_variants(raw_bytes: bytes) -> list:
    try:
        base = Image.open(io.BytesIO(raw_bytes)).convert("L")
    except Exception:
        return []

    variants = []

    base = ImageOps.autocontrast(base)
    variants.append(base)

    denoised = base.filter(ImageFilter.MedianFilter(size=3))
    variants.append(denoised)

    for threshold in (80, 100, 120, 140, 160, 180):
        bw = denoised.point(lambda p, t=threshold: 255 if p > t else 0).convert("L")
        variants.append(bw)
        variants.append(ImageOps.invert(bw))

    out = []
    seen = set()
    for img in variants:
        scaled = img.resize((img.width * 3, img.height * 3), Image.Resampling.NEAREST)
        if scaled.mode != 'L':
            scaled = scaled.convert('L')
        out.append(scaled)

    return out


def solve(raw_bytes: bytes) -> str:
    if not raw_bytes:
        return ""

    variants = _preprocess_variants(raw_bytes)
    if not variants:
        return ""

    predictions = []

    for i, img in enumerate(variants):
        text = ""
        try:
            text = _try_tesseract(img)
        except Exception:
            pass

        if not text:
            try:
                text = _try_ddddocr(img)
            except Exception:
                pass

        if text:
            predictions.append(text)

    if not predictions:
        return ""

    exact_len = [p for p in predictions if len(p) == EXPECTED_CAPTCHA_LEN]
    if exact_len:
        return Counter(exact_len).most_common(1)[0][0]

    near_len = [p for p in predictions if len(p) >= 4]
    if near_len:
        return Counter(near_len).most_common(1)[0][0]

    best = max(predictions, key=len)
    return best


if __name__ == "__main__":
    raw = sys.stdin.buffer.read()
    if not raw:
        print("", end="")
        sys.exit(1)
    result = solve(raw)
    print(result, end="")
