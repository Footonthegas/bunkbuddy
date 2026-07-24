import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import { spawn } from 'child_process';
import rateLimit from 'express-rate-limit';
import { loginToIms } from './ims/login.js';
import { scrapeStudentData, fetchResultHubBatch, fetchStudentDetailedProfile } from './ims/scraper.js';
import { sessionCache } from '../experimental/session_cache.js';
import { pooledLoginAndScrape, fastRefreshWithCookies, browserPool } from '../experimental/browser_pool.js';

let enableExperimentalScraper = true;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = process.env.PORT || 3001;

// ── Start ddddocr OCR microservice ──────────────────────────────────────────
let ocrReady = false;
const ocrServicePath = path.join(__dirname, 'ims', 'ocr_service.py');
const pythonCmd = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const ocrProc = spawn(pythonCmd, [ocrServicePath], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
ocrProc.stdout.on('data', d => {
  const msg = d.toString();
  process.stdout.write('[OCR] ' + msg);
  if (msg.includes('Listening')) ocrReady = true;
});
ocrProc.stderr.on('data', d => {
  const msg = d.toString();
  if (msg.includes('GetGpuDevices') || msg.includes('device_discovery.cc')) return;
  process.stderr.write('[OCR] ' + msg);
});
ocrProc.on('exit', code => { console.log(`[OCR] Service exited with code ${code}`); ocrReady = false; });
ocrProc.on('error', err => { console.error('[OCR] Failed to start:', err.message); ocrReady = false; });
// Cleanup OCR on exit
process.on('exit', () => ocrProc.kill());
process.on('SIGINT', () => { ocrProc.kill(); process.exit(); });
// ────────────────────────────────────────────────────────────────────────────

const app = express();
app.set('trust proxy', 1);
app.use(cors());
app.use(express.json({ limit: '2mb' }));

// Apply security rate limits for strict server protection
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, 
  max: 1000, // relaxed for development
  message: { success: false, message: 'Too many login attempts.' }
});

const sessions = new Map();

// ── Holidays Persistence ────────────────────────────────────────────────────
const holidaysFilePath = path.join(__dirname, 'holidays.json');
let holidays = [];
try {
  if (fs.existsSync(holidaysFilePath)) {
    holidays = JSON.parse(fs.readFileSync(holidaysFilePath, 'utf8'));
  }
} catch (e) {
  console.error("Failed to load holidays", e);
}

function saveHolidays() {
  fs.writeFileSync(holidaysFilePath, JSON.stringify(holidays, null, 2), 'utf8');
}
// ────────────────────────────────────────────────────────────────────────────

app.use(express.static(ROOT));

app.post('/api/auth/login', loginLimiter, async (req, res) => {
  const { rollNumber, password, year, semester } = req.body;

  if (!rollNumber || !password) {
    return res.status(400).json({ success: false, message: 'Roll number and password are required.' });
  }

  // Always perform live scrape to return latest attendance data per user request

  // 2. Attempt Experimental Fast Scraper if enabled
  if (enableExperimentalScraper) {
    try {
      console.log(`[LOGIN] Attempting Experimental Pooled Login+Scrape for ${rollNumber}...`);
      
      const result = await pooledLoginAndScrape(rollNumber, password, year, semester);

      const sessionId = uuidv4();
      const sessionPayload = {
        sessionId,
        rollNumber: result.rollNumber,
        data: result.data,
        history: result.history,
        cookies: result.cookies || [],
        cookieJar: result.cookieJar || null,
        password: password,
        semester,
        year
      };

      sessions.set(sessionId, sessionPayload);
      sessionCache.setSession(rollNumber, sessionPayload, semester, year);

      console.log(`[LOGIN] ✅ Experimental scraper completed for ${rollNumber} (${result.data.attendance.length} subjects)!`);
      return res.json({
        success: true,
        sessionId,
        rollNumber: sessionPayload.rollNumber,
        data: sessionPayload.data,
        history: sessionPayload.history,
        mode: 'experimental-fast'
      });
    } catch (expErr) {
      if (expErr.message.includes('Invalid roll number or password')) {
        return res.status(401).json({ success: false, message: 'Invalid roll number or password.' });
      }
      console.warn(`[FALLBACK] Experimental scraper: ${expErr.message}. Falling back to legacy Puppeteer...`);
    }
  }

  // 3. Legacy Puppeteer Scraper (Fallback or Default)
  if (!ocrReady) {
    for (let i = 0; i < 20 && !ocrReady; i++) await new Promise(r => setTimeout(r, 500));
    if (!ocrReady) return res.status(503).json({ success: false, message: 'OCR service is starting up. Try again in a few seconds.' });
  }

  let browserToClose = null;
  try {
    const result = await loginToIms(rollNumber, password);
    browserToClose = result.browser;

    if (!result.success) {
      return res.status(401).json({ success: false, message: result.message || 'Login failed.' });
    }

    const data = await scrapeStudentData(result.page, result.browser, year, semester, rollNumber);
    
    let history = null;
    try {
        const studentProfile = await fetchStudentDetailedProfile(rollNumber, null, result.browser);
        if (studentProfile && studentProfile.success) {
            history = studentProfile.history;
        }
    } catch(e) {
        console.error("ResultHub pre-fetch failed silently:", e.message);
    }

    const sessionId = uuidv4();
    sessions.set(sessionId, { data, rollNumber, history, semester, year, password });

    res.json({
      success: true,
      sessionId,
      rollNumber,
      data,
      history,
      mode: 'legacy-puppeteer'
    });
  } catch (err) {
    console.error('Login error:', err.message);
    const status = err.message.includes('Invalid') ? 401 : 500;
    res.status(status).json({
      success: false,
      message: err.message || 'Could not connect to IMS NSUT.',
    });
  } finally {
    if (browserToClose) {
      await browserToClose.close().catch(() => {});
    }
  }
});

app.post('/api/config/toggle-experimental', (req, res) => {
  if (typeof req.body.enabled === 'boolean') {
    enableExperimentalScraper = req.body.enabled;
  } else {
    enableExperimentalScraper = !enableExperimentalScraper;
  }
  console.log(`[CONFIG] Experimental fast scraper mode: ${enableExperimentalScraper ? 'ENABLED ⚡' : 'DISABLED 🐢 (Legacy mode)'}`);
  res.json({ success: true, experimentalEnabled: enableExperimentalScraper });
});

app.get('/api/data', async (req, res) => {
  const session = sessions.get(req.query.sessionId);
  if (!session) {
    return res.status(401).json({ message: 'Session expired. Please log in again.' });
  }
  
  if (!session.history || Object.keys(session.history).length === 0) {
      try {
          const profile = await fetchStudentDetailedProfile(session.rollNumber);
          if (profile && profile.success) {
              session.history = profile.history;
          }
      } catch(e) { }
  }
  
  res.json({ rollNumber: session.rollNumber, data: session.data, history: session.history });
});

app.post('/api/data/refresh', async (req, res) => {
  const { sessionId, year, semester } = req.body;
  const session = sessions.get(sessionId);
  if (!session) {
    return res.status(401).json({ message: 'Session expired. Please log in again.' });
  }

  try {
    const targetYear = year || session.year || '2026-27';
    const targetSem = semester || session.semester || '1';
    console.log(`[REFRESH] Full re-login refresh for ${session.rollNumber} [${targetYear} / Sem ${targetSem}]...`);
    
    const pwd = session.password || '';
    if (!pwd) {
      return res.status(401).json({ message: 'Password not stored. Please log in again.' });
    }

    let result;
    try {
      result = await pooledLoginAndScrape(session.rollNumber, pwd, targetYear, targetSem);
    } catch (expErr) {
      if (expErr.message.includes('Invalid roll number or password')) {
        return res.status(401).json({ success: false, message: 'Invalid roll number or password.' });
      }
      console.warn(`[FALLBACK] Experimental refresh: ${expErr.message}. Falling back to legacy Puppeteer...`);
    }

    if (result) {
      session.data = result.data;
      session.history = result.history;
      session.cookies = result.cookies || [];
      session.year = targetYear;
      session.semester = targetSem;
      res.json({ success: true, sessionId: req.body.sessionId, data: session.data, history: session.history, mode: 'experimental-full-refresh' });
      return;
    }

    let browserToClose = null;
    if (!ocrReady) {
      for (let i = 0; i < 20 && !ocrReady; i++) await new Promise(r => setTimeout(r, 500));
      if (!ocrReady) return res.status(503).json({ success: false, message: 'OCR service is starting up. Try again in a few seconds.' });
    }

    try {
      const legacyResult = await loginToIms(session.rollNumber, pwd);
      browserToClose = legacyResult.browser;

      if (!legacyResult.success) {
        return res.status(401).json({ success: false, message: legacyResult.message || 'Login failed.' });
      }

      const data = await scrapeStudentData(legacyResult.page, legacyResult.browser, targetYear, targetSem, session.rollNumber);
      
      let history = null;
      try {
          const studentProfile = await fetchStudentDetailedProfile(session.rollNumber, null, legacyResult.browser);
          if (studentProfile && studentProfile.success) {
            history = studentProfile.history;
          }
      } catch(e) { }
      
      session.data = data;
      session.history = history;
      session.cookies = [];
      session.year = targetYear;
      session.semester = targetSem;
      res.json({ success: true, sessionId: req.body.sessionId, data: session.data, history: session.history, mode: 'legacy-puppeteer' });
    } catch (err) {
      console.error('Refresh error:', err.message);
      const status = err.message.includes('Invalid') ? 401 : 500;
      res.status(status).json({
        success: false,
        message: err.message || 'Could not connect to IMS NSUT.',
      });
    } finally {
      if (browserToClose) {
        await browserToClose.close().catch(() => {});
      }
    }
  } catch (err) {
    console.error('Refresh error:', err.message);
    res.status(500).json({
      success: false,
      message: err.message || 'Could not connect to IMS NSUT.',
    });
  }
});

app.get('/api/holidays', (req, res) => {
  res.json({ success: true, holidays });
});

app.post('/api/holidays/toggle', (req, res) => {
  const sessionId = req.headers['authorization'] || req.body.sessionId;
  if (!sessionId || !sessions.has(sessionId)) {
    return res.status(401).json({ success: false, message: 'Unauthorized. Please login.' });
  }
  const session = sessions.get(sessionId);
  if (session.rollNumber !== '2024UME4113') {
    return res.status(403).json({ success: false, message: 'Forbidden. Admin access required.' });
  }

  const { date } = req.body; // e.g., "YYYY-MM-DD"
  if (!date) return res.status(400).json({ success: false, message: 'Date is required.' });

  const index = holidays.indexOf(date);
  if (index === -1) {
    holidays.push(date);
  } else {
    holidays.splice(index, 1);
  }
  saveHolidays();
  res.json({ success: true, holidays });
});

app.get('/api/results/:year', async (req, res) => {
  const { year } = req.params;
  const branch = req.query.branch || 'all';

  if (!year) {
    return res.status(400).json({ success: false, message: 'Year is required.' });
  }

  try {
    const students = await fetchResultHubBatch(year, branch);
    res.json({ success: true, count: students.length, candidates: students });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Batch fetching failed', error: error.message });
  }
});

app.get('/api/history/:roll', async (req, res) => {
  const { roll } = req.params;
  if (!roll) {
    return res.status(400).json({ success: false, message: 'Roll is required.' });
  }

  try {
    const profile = await fetchStudentDetailedProfile(roll);
    if (!profile.success) return res.status(500).json(profile);
    res.json(profile);
  } catch (error) {
    res.status(500).json({ success: false, message: 'History fetching failed', error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`BunkBuddy server running at http://localhost:${PORT}`);
  if (enableExperimentalScraper) {
    console.log('[SERVER] Pre-warming browser pool...');
    browserPool.getBrowser().then(() => {
      console.log('[SERVER] Browser pool warm and ready.');
    }).catch(e => {
      console.warn('[SERVER] Browser pool warm-up failed:', e.message);
    });
  }
});
