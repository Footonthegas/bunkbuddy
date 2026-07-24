import { login, saveSession, getSession } from './api.js';

const overlay = document.getElementById('loadingOverlay');
const terminalBody = document.getElementById('terminalBody');
const loginBtn = document.getElementById('loginBtn');
const rollInput = document.getElementById('rollInput');
const passInput = document.getElementById('passInput');

const terminalScroll = document.getElementById('terminalScroll');

async function typeLine(text, isError = false, startDelay = 0) {
    if (startDelay) await new Promise(r => setTimeout(r, startDelay));
    
    const line = document.createElement('div');
    line.className = 'terminal-line' + (isError ? ' error' : '');
    
    let cursor = terminalBody.querySelector('.terminal-cursor');
    if (!cursor) {
        cursor = document.createElement('div');
        cursor.className = 'terminal-cursor';
        terminalBody.appendChild(cursor);
    }
    
    terminalBody.insertBefore(line, cursor);
    
    // Instead of typing char by char, print the whole block to save time
    line.textContent = text;
    terminalScroll.scrollTop = terminalScroll.scrollHeight;
    
    // Fast printing delay
    await new Promise(r => setTimeout(r, 5));
    return line;
}

function clearTerminal() {
    terminalBody.innerHTML = '<div class="terminal-cursor"></div>';
}

async function handleLogin() {
  const rollNumber = rollInput.value.trim().toUpperCase();
  const password = passInput.value;
  const semester = document.getElementById('semInput').value;
  const year = document.getElementById('yearInput').value;
  const termsCheck = document.getElementById('termsCheck');

  if (!termsCheck || !termsCheck.checked) {
    alert('You must accept the Terms and Conditions to proceed.');
    return;
  }

  if (!rollNumber || !password) {
    alert('Please enter your roll number and password.');
    return;
  }

  loginBtn.disabled = true;
  overlay.classList.add('active');
  clearTerminal();
  
  try {
    typeLine(`[SYS] AUTHENTICATING ${rollNumber}...`);
    
    // Show timed progress lines while API runs
    const progressLines = [
      [100,  `[NET] Connecting to IMS NSUT gateway...`],
      [200,  `[SEC] Solving CAPTCHA challenge...`],
      [350,  `[AUTH] Submitting credentials...`],
      [500,  `[SYNC] Navigating to attendance portal...`],
      [700,  `[DATA] Scraping attendance records...`],
      [900,  `[DATA] Parsing subject-wise data...`],
      [1100, `[SYNC] Fetching academic history...`],
    ];
    
    let cancelled = false;
    const timers = progressLines.map(([delay, text]) => 
      setTimeout(() => { if (!cancelled) typeLine(text); }, delay)
    );

    const result = await login(rollNumber, password, year, semester);
    cancelled = true;
    timers.forEach(clearTimeout);

    if (result.success) {
      await typeLine(`[SYS] ✓ DATA RECEIVED — ${result.data?.attendance?.length || 0} subjects`);
      await typeLine(`[SYS] ✓ SESSION ESTABLISHED`);
      
      saveSession(result.sessionId, result.rollNumber, result.data, result.history);
      if (result.history) {
          localStorage.setItem('bb_academic_history_v2', JSON.stringify(result.history));
      }
      localStorage.setItem('bb_password', password);
      localStorage.setItem('bb_roll_id', result.rollNumber || rollNumber);
      localStorage.setItem('bb_semester', semester);
      localStorage.setItem('bb_year', year);
      
      await new Promise(r => setTimeout(r, 400));
      window.location.href = 'app.html';
      return;
    }

    throw new Error(result.message || 'Login failed');
  } catch (err) {
    let errMsg = err.message || 'Connection terminated.';
    const lowerErr = errMsg.toLowerCase();
    
    if (lowerErr.includes('invalid') || lowerErr.includes('incorrect') || lowerErr.includes('wrong') || lowerErr.includes('failed')) {
        errMsg = 'Please check your Roll Number and Password.';
    }
    
    await typeLine(`[ERR] ${errMsg}`, true, 0);
    setTimeout(() => {
      overlay.classList.remove('active');
      loginBtn.disabled = false;
    }, 1200);
  }
}

loginBtn?.addEventListener('click', () => handleLogin());

passInput?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') handleLogin();
});

// Setup auto-login functionality if credentials exist
const session = getSession();
if (session && (window.location.pathname.endsWith('index.html') || window.location.pathname === '/' || window.location.pathname === '')) {
    window.location.href = 'app.html';
} else {
    // If no session but credentials cached, just pre-fill the form fields.
    const storedPwd = localStorage.getItem('bb_password');
    const storedRoll = localStorage.getItem('bb_roll_id');
    const storedSem = localStorage.getItem('bb_semester');
    const storedYear = localStorage.getItem('bb_year');

    if (storedPwd && storedRoll && rollInput && passInput) {
        rollInput.value = storedRoll;
        passInput.value = storedPwd;
        const semInput = document.getElementById('semInput');
        const yearInput = document.getElementById('yearInput');
        if (semInput && storedSem) semInput.value = storedSem;
        if (yearInput && storedYear) yearInput.value = storedYear;
    }
}
