import http from 'http';

const THREADED_OCR_URL = { hostname: '127.0.0.1', port: 5001 };
const FALLBACK_OCR_URL = { hostname: '127.0.0.1', port: 5002 };

function callOcrService(buffer, targetPort = 5001) {
    return new Promise((resolve, reject) => {
        const b64 = buffer.toString('base64');
        const body = JSON.stringify({ image: b64 });

        const req = http.request({
            hostname: '127.0.0.1',
            port: targetPort,
            path: '/',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body)
            }
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    resolve(parsed.result || '11111');
                } catch {
                    resolve('11111');
                }
            });
        });

        req.on('error', (err) => {
            if (targetPort === 5001) {
                callOcrService(buffer, 5002).then(resolve).catch(reject);
            } else {
                reject(err);
            }
        });

        req.setTimeout(5000, () => { req.destroy(); reject(new Error('OCR timeout')); });
        req.write(body);
        req.end();
    });
}

export async function solveCaptchaThreaded(buffer) {
    try {
        const raw = await callOcrService(buffer, 5001);
        let cleaned = raw.replace(/[^0-9]/g, '').trim();
        if (cleaned.length > 5) cleaned = cleaned.slice(0, 5);
        if (cleaned.length < 5) cleaned = cleaned.padEnd(5, '0');
        console.log(`[CAPTCHA-THREADED] ddddocr → ${cleaned}`);
        return cleaned;
    } catch (e) {
        console.error(`[CAPTCHA-THREADED] OCR service error: ${e.message}`);
        return '11111';
    }
}
