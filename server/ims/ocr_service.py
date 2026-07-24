"""
ddddocr CAPTCHA microservice - runs locally on port 5001
Node.js calls this via HTTP instead of spawning a new Python process each time.
"""
import base64
import sys
try:
    from http.server import HTTPServer, BaseHTTPRequestHandler
    import ddddocr
    import json

    ocr = ddddocr.DdddOcr(show_ad=False)
    print("[ddddocr] Model loaded. Listening on http://127.0.0.1:5001", flush=True)

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, format, *args):
            pass

        def do_POST(self):
            length = int(self.headers.get('Content-Length', 0))
            body = self.rfile.read(length)
            data = json.loads(body)
            b64 = data.get('image', '')
            try:
                img_bytes = base64.b64decode(b64)
                result = ocr.classification(img_bytes)
                result = result.strip().replace(' ', '')
            except Exception as e:
                print(f"[ddddocr] OCR error: {e}", flush=True)
                result = ''

            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({'result': result}).encode())

    server = HTTPServer(('127.0.0.1', 5001), Handler)
    server.serve_forever()

except Exception as e:
    print(f"[ddddocr] FAILED TO START: {e}", flush=True)
    sys.exit(1)