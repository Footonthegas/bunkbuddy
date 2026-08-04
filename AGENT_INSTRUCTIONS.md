# BunkBuddy Backend — Agent Instructions

## Scraper Architecture (3-Tier Fallback)

The backend uses a cascading scraper strategy. If a higher-tier scraper fails, it automatically falls back to the next one.

### Tier 1: Go Scraper (Primary — Fastest)
- **Files**: `fast_scraper_go/main.go`, `fast_scraper_go/courses_timetable.go`, `fast_scraper_go/captcha_solver.go`, `fast_scraper_go/solve_captcha_cli.py`
- **Wrapper**: `server/ims/go_scraper.js`
- **Binary**: `fast_scraper_go/fast_scraper_go.exe` (pre-built)
- **Speed**: ~2-4s total
- **How it works**: Pure HTTP scraper written in Go. CAPTCHA solving uses a Python subprocess with `ddddocr`. No browser needed. Outputs JSON directly.
- **Toggle**: `POST /api/config/toggle-go-scraper` with body `{ "enabled": true/false }`
- **Config var**: `GO_SCRAPER_BIN` (path to binary)

### Tier 2: Experimental Browser Pool (Secondary)
- **Files**: `experimental/browser_pool.js`, `experimental/session_cache.js`
- **Speed**: ~3-5s total
- **How it works**: Reuses a warm Puppeteer browser pool. Faster than legacy because it avoids cold-start overhead.
- **Toggle**: `POST /api/config/toggle-experimental` with body `{ "enabled": true/false }`

### Tier 3: Legacy Puppeteer (Fallback)
- **Files**: `server/ims/login.js`, `server/ims/scraper.js`, `server/ims/client.js`
- **Speed**: ~5-8s total
- **How it works**: Launches a fresh Puppeteer instance for every login. Most reliable but slowest.

### Login Flow
```
Client → POST /api/auth/login
  ↓
[1] Go Scraper (if enabled & binary found)
  ↓ fail
[2] Experimental Pooled Scraper (if enabled)
  ↓ fail
[3] Legacy Puppeteer Scraper
```

### Refresh Flow
```
Client → POST /api/data/refresh
  ↓
[1] Go Scraper (if enabled & binary found)
  ↓ fail
[2] Experimental Pooled Scraper (if enabled)
  ↓ fail
[3] Legacy Puppeteer Scraper
```

## Running the Server

```bash
cd server
npm install
node server.js
```

Server runs on `http://localhost:3001`.

## Go Scraper Build

```bash
cd fast_scraper_go
go build -o fast_scraper_go.exe .
```

## API Endpoints

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/auth/login` | POST | Login with rollNumber, password, year, semester |
| `/api/data/refresh` | POST | Refresh data with sessionId, year, semester |
| `/api/data` | GET | Get current session data |
| `/api/config/toggle-go-scraper` | POST | Enable/disable Go scraper |
| `/api/config/toggle-experimental` | POST | Enable/disable experimental scraper |
| `/api/holidays` | GET | Get holidays list |
| `/api/holidays/toggle` | POST | Toggle holiday (admin only) |
| `/api/results/:year` | GET | Get batch results |
| `/api/history/:roll` | GET | Get student academic history |

## Frontend Integration

The frontend (`frontend/` or root `js/`) calls the same API endpoints regardless of which scraper is used. The backend normalizes all scraper outputs to the same JSON schema:

```json
{
  "success": true,
  "sessionId": "uuid",
  "rollNumber": "2024UME4113",
  "mode": "go-scraper | experimental-fast | legacy-puppeteer",
  "data": {
    "home": {
      "profile": { "name": "Student", "program": "B.Tech", "cgpa": "--", "semester": "4" },
      "summary": [...]
    },
    "attendance": [...],
    "detailedAttendance": { "matrix": [], "subjects": [], "summary": {}, "legend": {} },
    "resources": [],
    "connect": []
  },
  "history": { "cgpa": "8.50", "sgpa": [...], ... }
}
```

## Fallback Behavior

If the Go scraper fails (binary missing, invalid credentials, network error, portal structure change), the server automatically:
1. Logs the error with `[FALLBACK]` prefix
2. Tries the experimental scraper
3. Falls back to legacy Puppeteer if experimental also fails

The `mode` field in the response indicates which scraper succeeded. The frontend does not need to change.

## Troubleshooting

| Issue | Solution |
|---|---|
| Go scraper not found | Ensure `fast_scraper_go.exe` exists in `fast_scraper_go/` |
| `login_failed` from Go scraper | Check credentials. CAPTCHA might be wrong — Go scraper auto-retries 5 times |
| Go scraper returns `navigation_failed` | IMS portal HTML structure changed. Check regex patterns in Go code |
| Experimental scraper timeout | OCR service might be slow. Check Python `ddddocr` process |
| Legacy Puppeteer slow | Normal — cold starts take 5-8s. Consider keeping experimental enabled |
