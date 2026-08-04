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
import { scrapeWithNode } from './ims/node_scraper.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RESULTHUB_SCRIPT = path.join(__dirname, 'ims', 'resulthub_scraper.py');

async function fetchResultHubPython(rollNumber) {
  return new Promise((resolve) => {
    const pyCmd = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
    const args = [RESULTHUB_SCRIPT, rollNumber];
    const proc = spawn(pyCmd, args, { windowsHide: true });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    proc.on('error', () => resolve({ success: false, history: {} }));

    proc.on('close', (code) => {
      if (code !== 0) {
        return resolve({ success: false, history: {} });
      }
      try {
        const json = JSON.parse(stdout.trim());
        resolve(json);
      } catch (e) {
        resolve({ success: false, history: {} });
      }
    });
  });
}

async function fetchResultHubGo(rollNumber) {
  if (!RESULTHUB_GO_BIN) return { success: false, history: {} };
  try {
    await fs.promises.chmod(RESULTHUB_GO_BIN, 0o755);
  } catch (e) {
    console.error('[RESULT-HUB] Could not set execute permission on Go binary:', e.message);
  }
  return new Promise((resolve) => {
    const args = ['--resulthub', rollNumber];
    const proc = spawn(RESULTHUB_GO_BIN, args, { windowsHide: true });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    proc.on('error', () => resolve({ success: false, history: {} }));

    proc.on('close', (code) => {
      if (code !== 0) {
        return resolve({ success: false, history: {} });
      }
      try {
        const json = JSON.parse(stdout.trim());
        if (json.status === 'success' && json.cgpa) {
          resolve({ success: true, history: json });
        } else {
          resolve({ success: false, history: {} });
        }
      } catch (e) {
        resolve({ success: false, history: {} });
      }
    });
  });
}

let enableExperimentalScraper = false;

const ROOT = path.join(__dirname, '..');
const RESULTHUB_GO_BIN = process.env.RESULTHUB_GO_BIN || (() => {
  const candidates = [
    path.join(ROOT, 'fast_scraper_go', 'fast_scraper_go.exe'),
    path.join(ROOT, 'fast_scraper_go', 'fast_scraper_go'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
})();
const PORT = process.env.PORT || 3001;

// ── Start ddddocr OCR microservice (optional, silent if unavailable) ─────────
let ocrReady = false;
const ocrServicePath = path.join(__dirname, 'ims', 'ocr_service.py');
const pythonCmd = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const ocrProc = spawn(pythonCmd, [ocrServicePath], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
ocrProc.stdout.on('data', d => {
  const msg = d.toString();
  if (msg.includes('Listening')) {
    ocrReady = true;
    console.log('[OCR] Service ready');
  }
});
ocrProc.stderr.on('data', () => {});
ocrProc.on('exit', () => { ocrReady = false; });
ocrProc.on('error', () => { ocrReady = false; });
process.on('exit', () => { if (ocrProc) ocrProc.kill(); });
process.on('SIGINT', () => { if (ocrProc) ocrProc.kill(); process.exit(); });
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

// Only serve the retro terminal frontend, hide backend source files
app.use(express.static(path.join(ROOT, 'frontend')));

// Explicit routes for SPA-like navigation
app.get('/', (req, res) => res.sendFile(path.join(ROOT, 'frontend', 'index.html')));
app.get('/app.html', (req, res) => res.sendFile(path.join(ROOT, 'frontend', 'app.html')));

app.post('/api/auth/login', loginLimiter, async (req, res) => {
  const { rollNumber, password, year, semester } = req.body;

  if (!rollNumber || !password) {
    return res.status(400).json({ success: false, message: 'Roll number and password are required.' });
  }

  // Demo login for Razorpay verification
  if (rollNumber === '12345' && password === '12345') {
    const demoSessionId = uuidv4();
    const demoData = {
      home: {
        profile: { name: 'Demo User', program: 'B.Tech', cgpa: '8.50', semester: '4' },
        summary: [
          { subject: 'Demo Subject A', attended: '32', absent: '8', total: '40', percentage: '80.00%', statusText: 'bunkable', statusNumber: 5 },
          { subject: 'Demo Subject B', attended: '35', absent: '5', total: '40', percentage: '87.50%', statusText: 'bunkable', statusNumber: 12 },
        ]
      },
      attendance: [
        { subject: 'Demo Subject A', attended: '32', absent: '8', total: '40', percentage: '80.00%', statusText: 'bunkable', statusNumber: 5 },
        { subject: 'Demo Subject B', attended: '35', absent: '5', total: '40', percentage: '87.50%', statusText: 'bunkable', statusNumber: 12 },
      ],
      detailedAttendance: {
        matrix: [],
        subjects: [],
        summary: { totalClasses: ['40', '40'], totalAbsent: ['8', '5'], totalPresent: ['32', '35'], percentages: ['80.00%', '87.50%'] },
        legend: {}
      },
      resources: [],
      connect: []
    };
    const demoHistory = {
      cgpa: '8.50',
      universityRank: '#150',
      deptRank: '#12',
      credits: '92',
      sgpa: [8.2, 7.8, 8.5, 8.5],
      major: 'COMPUTER SCIENCE & ENGINEERING',
      name: 'Demo User',
      url: 'https://www.resulthubdtu.com/NSUT/StudentProfile/2028/12345'
    };
    sessions.set(demoSessionId, {
      sessionId: demoSessionId,
      rollNumber: '12345',
      data: demoData,
      history: demoHistory,
      cookies: [],
      cookieJar: null,
      password: '12345',
      semester: semester || '4',
      year: year || '2025-26'
    });
    return res.json({
      success: true,
      sessionId: demoSessionId,
      rollNumber: '12345',
      data: demoData,
      history: demoHistory,
      mode: 'demo'
    });
  }

  // Always perform live scrape to return latest attendance data per user request

  let loginFailed = false;

  // Use Node.js scraper directly (no Go binary needed)
  try {
    console.log(`[LOGIN] Attempting Node.js Scraper for ${rollNumber}...`);
    
    const result = await scrapeWithNode(rollNumber, password, year, semester);
    
    if (result.status === 'error') {
      if (result.error && result.error.includes('Invalid roll number or password')) {
        loginFailed = true;
      }
      return res.status(loginFailed ? 401 : 500).json({
        success: false,
        message: loginFailed ? 'Invalid roll number or password.' : (result.error || 'Scraper failed. Please try again.'),
      });
    }

    const normalized = result.data;
    const sessionId = uuidv4();
    const sessionPayload = {
      sessionId,
      rollNumber,
      data: normalized,
      history: null,
      cookies: [],
      cookieJar: null,
      password: password,
      semester: semester || '1',
      year: year || '2026-27'
    };

    sessions.set(sessionId, sessionPayload);
    sessionCache.setSession(rollNumber, sessionPayload, semester, year);

    console.log(`[LOGIN] ✅ Node.js scraper completed for ${rollNumber} (${normalized.attendance.length} subjects)!`);
    return res.json({
      success: true,
      sessionId,
      rollNumber,
      data: normalized,
      history: null,
      mode: 'node-scraper'
    });
  } catch (err) {
    if (err.message && err.message.includes('Invalid roll number or password')) {
      loginFailed = true;
    }
    console.error(`[LOGIN] ❌ Node.js scraper failed for ${rollNumber}: ${err.message}`);
    return res.status(loginFailed ? 401 : 500).json({
      success: false,
      message: loginFailed ? 'Invalid roll number or password.' : (err.message || 'Scraper failed. Please try again.'),
    });
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

app.post('/api/academics/history', async (req, res) => {
  const { sessionId } = req.body;
  const session = sessions.get(sessionId);
  if (!session) {
    return res.status(401).json({ message: 'Session expired. Please log in again.' });
  }

  if (session.history && Object.keys(session.history).length > 0) {
    return res.json({ success: true, history: session.history, cached: true });
  }

  try {
    const rh = await fetchResultHubGo(session.rollNumber);
    if (rh && rh.success && rh.history) {
      session.history = rh.history;
      return res.json({ success: true, history: rh.history, cached: false });
    }
  } catch (e) {
    console.error("ResultHub on-demand fetch failed:", e.message);
  }

  res.json({ success: false, message: 'Failed to fetch academic history.' });
});

app.get('/api/data', async (req, res) => {
  const session = sessions.get(req.query.sessionId);
  if (!session) {
    return res.status(401).json({ message: 'Session expired. Please log in again.' });
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

    let refreshLoginFailed = false;

    try {
      const result = await scrapeWithNode(session.rollNumber, pwd, targetYear, targetSem);
      
      if (result.status === 'error') {
        if (result.error && result.error.includes('Invalid roll number or password')) {
          refreshLoginFailed = true;
        }
        const status = refreshLoginFailed ? 401 : 500;
        return res.status(status).json({
          success: false,
          message: refreshLoginFailed ? 'Invalid roll number or password.' : (result.error || 'Refresh failed. Please try again.'),
        });
      }

      const normalized = result.data;
      session.data = normalized;
      session.year = targetYear;
      session.semester = targetSem;
      res.json({ success: true, sessionId: req.body.sessionId, data: session.data, history: session.history, mode: 'node-refresh' });
      return;
    } catch (err) {
      if (err.message && err.message.includes('Invalid roll number or password')) {
        refreshLoginFailed = true;
      }
      console.error(`[REFRESH] Node.js scraper failed for ${session.rollNumber}: ${err.message}`);
      const status = refreshLoginFailed ? 401 : 500;
      return res.status(status).json({
        success: false,
        message: refreshLoginFailed ? 'Invalid roll number or password.' : (err.message || 'Refresh failed. Please try again.'),
      });
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
  console.log(`[SERVER] Scraper: Node.js + ddddocr (Python)`);
  if (enableExperimentalScraper) {
    console.log('[SERVER] Pre-warming browser pool...');
    browserPool.getBrowser().then((browser) => {
      if (browser) {
        console.log('[SERVER] Browser pool warm and ready.');
      } else {
        console.log('[SERVER] Browser pool not available, using Node.js scraper.');
      }
    }).catch(e => {
      console.log('[SERVER] Browser pool skipped:', e.message);
    });
  }
});
