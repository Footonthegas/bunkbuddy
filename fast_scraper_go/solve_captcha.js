/**
 * solve_captcha.js - CAPTCHA solver using tesseract.js.
 *
 * Reads raw image bytes from stdin (JPEG/PNG), solves using tesseract.js
 * with multiple PSM modes and a numeric whitelist, writes best candidate
 * to stdout.
 *
 * No native modules beyond tesseract.js itself. No ImageMagick or canvas.
 *
 * Usage:
 *     node solve_captcha.js < image_bytes
 */

import { createWorker } from 'tesseract.js';

async function ocrBuffer(worker, imageBuffer, psm) {
  try {
    const { data } = await worker.recognize(imageBuffer, {
      tessedit_pageseg_mode: psm,
      tessedit_char_whitelist: '0123456789',
      tessedit_char_blacklist: '',
      load_system_dictionary: 'F',
      load_freq_dawg: 'F',
      load_punc_dawg: 'F',
    });
    const text = (data.text || '').replace(/\s/g, '').replace(/[^0-9]/g, '');
    return text;
  } catch (e) {
    return '';
  }
}

async function main() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  const rawBytes = Buffer.concat(chunks);

  if (!rawBytes || rawBytes.length === 0) {
    process.exit(1);
  }

  const worker = createWorker({ logger: m => {} });

  try {
    await worker.load();
    await worker.loadLanguage('eng');
    await worker.initialize('eng');

    const psmModes = ['8', '13', '7', '6', '10'];
    const predictions = [];

    for (const psm of psmModes) {
      const text = await ocrBuffer(worker, rawBytes, psm);
      if (text && text.length >= 4) {
        predictions.push(text);
      }
    }

    await worker.terminate();

    if (predictions.length === 0) {
      process.stderr.write('[CAPTCHA-DEBUG] tesseract.js returned no valid predictions\n');
      process.exit(1);
    }

    const exact = predictions.filter(p => p.length === 5);
    if (exact.length > 0) {
      const counts = {};
      exact.forEach(p => counts[p] = (counts[p] || 0) + 1);
      const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
      console.log(best);
      process.exit(0);
    }

    const near = predictions.filter(p => p.length >= 4);
    if (near.length > 0) {
      const counts = {};
      near.forEach(p => counts[p] = (counts[p] || 0) + 1);
      const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
      console.log(best);
      process.exit(0);
    }

    process.exit(1);
  } catch (e) {
    process.stderr.write('[CAPTCHA-DEBUG] tesseract.js error: ' + e.message + '\n');
    try { await worker.terminate(); } catch (e2) {}
    process.exit(1);
  }
}

main();
