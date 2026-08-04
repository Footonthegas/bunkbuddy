const API_BASE = '';

export async function login(rollNumber, password, year, semester) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120000);

  try {
    const res = await fetch(`${API_BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rollNumber, password, year, semester }),
      signal: controller.signal,
    });

    const data = await res.json();
    if (!res.ok && !data.needsCaptcha) {
      throw new Error(data.message || 'Login failed');
    }
    return data;
  } finally {
    clearTimeout(timeout);
  }
}

export async function refreshData(sessionId, year, semester) {
  const res = await fetch(`${API_BASE}/api/data/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, year, semester }),
  });

  const data = await res.json();
  return { ...data, ok: res.ok, status: res.status };
}

export async function getHolidays() {
  const res = await fetch(`${API_BASE}/api/holidays`);
  const data = await res.json();
  return data.holidays || [];
}

export async function fetchAcademicHistory(sessionId) {
  const res = await fetch(`${API_BASE}/api/academics/history`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId }),
  });
  const data = await res.json();
  return { ...data, ok: res.ok };
}

export function saveSession(sessionId, rollNumber, data, history = null) {
  try {
    localStorage.setItem('bb_session', sessionId);
    localStorage.setItem('bb_roll', rollNumber);
    localStorage.setItem('bb_roll_id', rollNumber);
    const serialized = JSON.stringify(data);
    localStorage.setItem('bb_data', serialized);
    if (history) {
      localStorage.setItem('bb_academic_history_v2', JSON.stringify(history));
    }
  } catch (e) {
    console.error('Failed to save session:', e);
  }
}

export function getSession() {
  const sessionId = localStorage.getItem('bb_session');
  const rollNumber = localStorage.getItem('bb_roll') || localStorage.getItem('bb_roll_id');
  const raw = localStorage.getItem('bb_data');
  const historyRaw = localStorage.getItem('bb_academic_history_v2');
  if (!sessionId || !raw) return null;
  let data = null;
  let history = null;
  try { data = JSON.parse(raw); } catch (e) { 
    localStorage.removeItem('bb_data');
    localStorage.removeItem('bb_academic_history_v2');
    return null;
  }
  try { history = historyRaw ? JSON.parse(historyRaw) : null; } catch (e) {}
  return { sessionId, rollNumber, data, history };
}

export function clearSession() {
  localStorage.removeItem('bb_session');
  localStorage.removeItem('bb_roll');
  localStorage.removeItem('bb_data');
  localStorage.removeItem('bb_academic_history_v2');
  localStorage.removeItem('bb_password');
  localStorage.removeItem('bb_roll_id');
  localStorage.removeItem('bb_semester');
  localStorage.removeItem('bb_year');
  localStorage.removeItem('bb_active_tab');
  localStorage.removeItem('bb_pro_subscription');
}