import { login, saveSession, getSession } from './api.js';

const overlay = document.getElementById('loadingOverlay');
const loadingText = document.getElementById('loadingText');
const loginBtn = document.getElementById('loginBtn');
const enterKey = document.getElementById('enterKey');
const rollInput = document.getElementById('rollInput');
const passInput = document.getElementById('passInput');
const loginStatus = document.getElementById('loginStatus');
const loginCursor = document.getElementById('loginCursor');
const loginProgress = document.getElementById('loginProgress');
const loginProgressBar = document.getElementById('loginProgressBar');

function setStatus(text, type = '') {
  loginStatus.textContent = text;
  loginStatus.className = type;
  if (!type) loginStatus.className = 'dim';
}

function showLoading(show) {
  if (show) {
    overlay.classList.add('active');
  } else {
    overlay.classList.remove('active');
  }
}

async function handleLogin() {
  const rollNumber = rollInput.value.trim().toUpperCase();
  const password = passInput.value;
  const semester = document.getElementById('semInput').value;
  const year = document.getElementById('yearInput').value;
  const termsCheck = document.getElementById('termsCheck');

  if (!termsCheck || !termsCheck.checked) {
    setStatus('ERROR: Terms not accepted', 'error');
    loginCursor.style.display = 'none';
    setTimeout(() => { loginCursor.style.display = 'inline-block'; }, 2000);
    return;
  }

  if (!rollNumber || !password) {
    setStatus('ERROR: Missing credentials', 'error');
    loginCursor.style.display = 'none';
    setTimeout(() => { loginCursor.style.display = 'inline-block'; }, 2000);
    return;
  }

  loginBtn.disabled = true;
  enterKey.disabled = true;
  showLoading(true);

  const steps = [
    [300,  'CONNECTING TO IMS GATEWAY...'],
    [600,  'SOLVING CAPTCHA CHALLENGE...'],
    [900,  'AUTHENTICATING CREDENTIALS...'],
    [1200, 'NAVIGATING ATTENDANCE PORTAL...'],
    [1500, 'SCRAPING ATTENDANCE RECORDS...'],
    [1800, 'PARSING SUBJECT DATA...'],
  ];

  const timers = steps.map(([delay, text]) => {
    return setTimeout(() => { loadingText.textContent = text; }, delay);
  });

  try {
    const result = await login(rollNumber, password, year, semester);
    timers.forEach(clearTimeout);

    if (result.success) {
      loadingText.textContent = 'ACCESS GRANTED';
      loadingText.className = 'loading-text success';
      
      // Clear any stale roll values before saving
      localStorage.removeItem('bb_roll');
      localStorage.removeItem('bb_roll_id');
      
      saveSession(result.sessionId, result.rollNumber, result.data, result.history);
      localStorage.setItem('bb_password', password);
      localStorage.setItem('bb_semester', semester);
      localStorage.setItem('bb_year', year);
      sessionStorage.setItem('bb_just_logged_in', 'true');

      setTimeout(() => {
        window.location.href = '/app.html';
      }, 800);
      return;
    }

    throw new Error(result.message || 'Login failed');
  } catch (err) {
    timers.forEach(clearTimeout);
    loadingText.textContent = 'ACCESS DENIED';
    loadingText.className = 'loading-text error';
    
    setTimeout(() => {
      showLoading(false);
      loginBtn.disabled = false;
      enterKey.disabled = false;
      setStatus(err.message || 'Connection terminated', 'error');
      loginCursor.style.display = 'none';
      setTimeout(() => { loginCursor.style.display = 'inline-block'; }, 3000);
    }, 1500);
  }
}

loginBtn?.addEventListener('click', handleLogin);
enterKey?.addEventListener('click', handleLogin);

passInput?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') handleLogin();
});

rollInput?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') passInput.focus();
});

function clearForm() {
  rollInput.value = '';
  passInput.value = '';
  setStatus('Form cleared', 'dim');
}

function quickFillDemo() {
  rollInput.value = '12345';
  passInput.value = '12345';
  setStatus('Demo credentials loaded', 'success');
}

function togglePass() {
  const type = passInput.type === 'password' ? 'text' : 'password';
  passInput.type = type;
}

const session = getSession();
if (session) {
  window.location.href = 'app.html';
} else {
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