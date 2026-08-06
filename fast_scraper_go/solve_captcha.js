/**
 * solve_captcha_cli.js - CAPTCHA solver using tesseract.js with aggressive preprocessing.
 *
 * Reads raw image bytes from stdin, solves using tesseract.js with multiple
 * preprocessing variants, and writes the best candidate text to stdout.
 *
 * Usage:
 *     node solve_captcha_cli.js < image_bytes
 *     cat captcha.png | node solve_captcha_cli.js
 */

import { createWorker } from 'tesseract.js';
import { Readable } from 'stream';
import { promisify } from 'util';
import { exec } from 'child_process';

const sleep = promisify(setTimeout);

async function preprocessImage(rawBytes) {
  const { execSync } = await import('child_process');
  const fs = await import('fs');

  const tmpInput = '/tmp/captcha_input.png';
  const tmpOutput = '/tmp/captcha_out_%d.png';

  fs.writeFileSync(tmpInput, rawBytes);

  const variants = [];

  const baseCmd = `convert ${tmpInput} -colorspace Gray -auto-level`;
  const cmds = [
    `${baseCmd} ${tmpOutput.replace('%d', '0')}`,
    `${baseCmd} -median 3 ${tmpOutput.replace('%d', '1')}`,
    `${baseCmd} -median 3 -threshold 80% ${tmpOutput.replace('%d', '2')}`,
    `${baseCmd} -median 3 -threshold 90% ${tmpOutput.replace('%d', '3')}`,
    `${baseCmd} -median 3 -threshold 110% ${tmpOutput.replace('%d', '4')}`,
    `${baseCmd} -median 3 -threshold 130% ${tmpOutput.replace('%d', '5')}`,
    `${baseCmd} -median 3 -negate -threshold 80% ${tmpOutput.replace('%d', '6')}`,
    `${baseCmd} -median 3 -negate -threshold 90% ${tmpOutput.replace('%d', '7')}`,
    `${baseCmd} -resize 300% ${tmpOutput.replace('%d', '8')}`,
    `${baseCmd} -resize 300% -median 3 -threshold 100% ${tmpOutput.replace('%d', '9')}`,
  ];

  for (const cmd of cmds) {
    try {
      execSync(cmd, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      continue;
    }
  }

  for (let i = 0; i < 10; i++) {
    const path = tmpOutput.replace('%d', String(i));
    if (fs.existsSync(path)) {
      const data = fs.readFileSync(path);
      if (data.length > 0) variants.push(data);
    }
  }

  try { fs.unlinkSync(tmpInput); } catch (e) {}
  for (let i = 0; i < 10; i++) {
    try { fs.unlinkSync(tmpOutput.replace('%d', String(i))); } catch (e) {}
  }

  return variants;
}

async function solveWithTesseract(imageBuffer) {
  const worker = createWorker({
    logger: m => {}
  });

  await worker.load();
  await worker.loadLanguage('eng');
  await worker.initialize('eng');
  await worker.setParameters({
    tessedit_pageseg_mode: '8',
    tessedit_char_whitelist: '0123456789'
  });

  try {
    const { data } = await worker.recognize(imageBuffer);
    const text = data.text.replace(/\s/g, '').replace(/[^0-9]/g, '');
    return text;
  } catch (e) {
    return '';
  } finally {
    await worker.terminate();
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

  try {
    const variants = await preprocessImage(rawBytes);

    if (variants.length === 0) {
      process.exit(1);
    }

    const predictions = [];

    for (const variant of variants) {
      const text = await solveWithTesseract(variant);
      if (text && text.length >= 4) {
        predictions.push(text);
      }
    }

    if (predictions.length === 0) {
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
    process.exit(1);
  }
}

main();
