import { getSession, clearSession, saveSession, refreshData, getHolidays, fetchAcademicHistory } from './api.js';

const WEEKDAY_ORDER = {
  'Monday': 1, 'Mon': 1, 'M': 1,
  'Tuesday': 2, 'Tue': 2, 'Tues': 2, 'Tu': 2,
  'Wednesday': 3, 'Wed': 3, 'W': 3,
  'Thursday': 4, 'Thur': 4, 'Thu': 4, 'Thurs': 4,
  'Friday': 5, 'Fri': 5, 'F': 5,
  'Saturday': 6, 'Sat': 6, 'Sa': 6,
  'Sunday': 7, 'Sun': 7, 'Su': 7,
};

function sortWeekdays(days) {
  return [...days].sort((a, b) => {
    const ia = WEEKDAY_ORDER[a] || 99;
    const ib = WEEKDAY_ORDER[b] || 99;
    return ia - ib;
  });
}

let session = null;
let data = { home: {}, attendance: [], detailedAttendance: null, resources: [], connect: [] };
let rollNumber = 'UNKNOWN';

try {
  session = getSession();
  if (!session) {
    window.location.href = '/';
  }
  data = session.data || { home: {}, attendance: [], detailedAttendance: null, resources: [], connect: [] };
  if (session.history) {
    data.history = session.history;
  }
  rollNumber = (session.rollNumber && session.rollNumber !== 'undefined' && session.rollNumber !== 'null') 
    ? session.rollNumber.toUpperCase() 
    : 'UNKNOWN';
} catch (e) {
  console.error('Session load error:', e);
  window.location.href = '/';
}

window.data = data;

const pageContainer = document.getElementById('pageContainer');
const mainTerminal = document.getElementById('mainTerminal');

let currentPage = 'home';
let isRefreshing = false;

function pctClass(pctStr) {
  const n = parseFloat(String(pctStr).replace(/[^\d.]/g, ''));
  if (Number.isNaN(n)) return '';
  if (n >= 75) return 'text-green';
  if (n >= 65) return 'text-amber';
  return 'text-red';
}

function scrollToTop() {
  if (mainTerminal) mainTerminal.scrollTo({ top: 0, behavior: 'smooth' });
}

function showError(message) {
  if (pageContainer) {
    pageContainer.innerHTML = `<div class="term-alert error">${message}</div>`;
  }
}

async function loadPage(page) {
  currentPage = page;
  if (!pageContainer) {
    showError('Terminal display not found. Please refresh.');
    return;
  }

  pageContainer.innerHTML = '<div class="terminal-line"><span class="prompt">SYS</span> <span class="dim">Loading module...</span><span class="cursor"></span></div>';
  scrollToTop();

   try {
     let html = '';
     
     if (page === 'home') {
       html = await loadHomePage();
     } else if (page === 'attendance') {
       html = await loadAttendancePage();
     } else if (page === 'academics') {
       html = await loadAcademicsPage();
     } else if (page === 'timetable') {
       html = await loadTimetablePage();
     } else if (page === 'about') {
       html = await loadStaticPage('about');
     } else if (page === 'terms') {
       html = await loadStaticPage('terms');
     } else if (page === 'privacy') {
       html = await loadStaticPage('privacy');
     } else {
       html = '<div class="term-alert warn">Module not found.</div>';
     }

     pageContainer.innerHTML = html;
     pageContainer.className = 'page-enter';

     // Initialize page-specific functionality
     if (page === 'home') initHomePage();
     if (page === 'attendance') initAttendancePage();
     if (page === 'academics') await initAcademicsPage();
     if (page === 'timetable') initTimetablePage();
     if (page === 'about') initAboutPage();
     if (page === 'terms') initLegalPage();
     if (page === 'privacy') initLegalPage();

     window.dispatchEvent(new Event('bbRefresh'));
  } catch (e) {
    console.error('Page load error:', e);
    showError(`Failed to load module: ${e.message}. <a href="#" class="term-link" onclick="location.reload()">RETRY</a>`);
  }
}

async function fetchPage(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.text();
}

async function loadHomePage() {
  return await fetchPage('pages/home.html?v=' + Date.now());
}

async function loadAttendancePage() {
  return await fetchPage('pages/attendance.html?v=' + Date.now());
}

async function loadAcademicsPage() {
  return await fetchPage('pages/academics.html?v=' + Date.now());
}

async function loadTimetablePage() {
  return await fetchPage('pages/timetable.html?v=' + Date.now());
}

async function loadStaticPage(page) {
  return await fetchPage(`pages/${page}.html?v=${Date.now()}`);
}

// ─── Home Page ───
function initHomePage() {
  const profile = data.home?.profile || {};
  let name = profile.Name || profile.name || rollNumber;
  if (name && name !== rollNumber) {
    name = name.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
  }

  const greetingEl = document.getElementById('homeGreeting');
  const subEl = document.getElementById('homeSub');
  if (greetingEl) greetingEl.innerHTML = `<span class="text-bright">${escapeHtml(name)}</span>`;
  
  const displayRoll = (rollNumber && rollNumber !== 'UNKNOWN' && rollNumber !== 'undefined' && rollNumber !== 'null')
    ? rollNumber 
    : (session?.rollNumber && session.rollNumber !== 'undefined' && session.rollNumber !== 'null' ? session.rollNumber.toUpperCase() : 'XXXXXXXX');
  if (subEl) subEl.textContent = `Roll ${displayRoll}`;

  const semInput = document.getElementById('dashSemInput');
  const yrInput = document.getElementById('dashYearInput');
  if (semInput) {
    semInput.value = localStorage.getItem('bb_semester') || semInput.value || '1';
    semInput.addEventListener('change', () => {
      localStorage.setItem('bb_semester', semInput.value);
      refreshCurrentPage();
    });
  }
  if (yrInput) {
    yrInput.value = localStorage.getItem('bb_year') || yrInput.value || '2026-27';
    yrInput.addEventListener('change', () => {
      localStorage.setItem('bb_year', yrInput.value);
      refreshCurrentPage();
    });
  }

  const refreshBtn = document.getElementById('refreshAttendanceBtn');
  if (refreshBtn) {
    refreshBtn.onclick = () => refreshCurrentPage();
  }

  const logoutBtn = document.getElementById('homeLogoutBtn');
  if (logoutBtn) {
    logoutBtn.onclick = () => {
      if (confirm('TERMINATE SESSION?')) {
        clearSession();
        window.location.href = '/';
      }
    };
  }

  const cgpaNode = document.getElementById('dashCgpa');
  const semNode = document.getElementById('dashSemester');
  if (cgpaNode) cgpaNode.textContent = profile.cgpa || '--';
  if (semNode) semNode.textContent = profile.semester || '--';

  renderSubjectCards();
  renderCalendar();
  renderHomeTimetable();

  // Auto-refresh if no attendance data for current selection
  const attendance = data.attendance || [];
  if (attendance.length === 0 && session?.sessionId) {
    setTimeout(() => refreshCurrentPage(), 500);
  }
}

function renderSubjectCards() {
  const cardsContainer = document.getElementById('subjectCardsContainer');
  if (!cardsContainer) return;

  const attendance = data.attendance || [];
  if (attendance.length === 0) {
    cardsContainer.innerHTML = '<div class="term-alert warn">No attendance data. Press SYNC.</div>';
    return;
  }

  const sorted = [...attendance].sort((a, b) => {
    const getScore = (subj) => {
      if (subj.statusText === 'bunkable') return parseInt(subj.statusNumber) || 0;
      if (subj.statusText === 'needed') return -(parseInt(subj.statusNumber) || 0) - 100;
      return -50;
    };
    return getScore(b) - getScore(a);
  });

  cardsContainer.innerHTML = sorted.map(subj => {
    const p = parseFloat(subj.percentage);
    const color = p >= 75 ? 'var(--accent-green)' : p >= 65 ? 'var(--accent-amber)' : 'var(--accent-red)';
    const nameTrunc = (subj.subject || '').length > 35 ? (subj.subject || '').substring(0, 35) + '...' : subj.subject;

    const statusPhrase = subj.statusText === 'bunkable'
      ? `<div class="text-green" style="font-size: 1.1rem; font-weight: bold;">${subj.statusNumber} SAFE TO BUNK</div>`
      : subj.statusText === 'needed'
        ? `<div class="text-red" style="font-size: 1.1rem; font-weight: bold;">ATTEND ${subj.statusNumber} MORE</div>`
        : `<div class="text-amber" style="font-size: 1.1rem; font-weight: bold;">ON TRACK</div>`;

    const radius = 28;
    const circumference = 2 * Math.PI * radius;
    const offset = circumference - (p / 100) * circumference;

    return `
      <div class="term-card">
        <div style="font-weight: bold; font-size: 0.95rem; margin-bottom: 4px; line-height: 1.2; min-height: 2.2rem;">${escapeHtml(nameTrunc)}</div>
        <div style="font-size: 0.75rem; color: var(--text-dim); margin-bottom: 6px;">${escapeHtml(subj.code)}</div>
        <div style="display: flex; align-items: center; justify-content: space-between; gap: 10px;">
          <div style="flex: 1; min-width: 0;">
            ${statusPhrase}
            <div style="margin-top: 4px; font-size: 0.75rem; color: var(--text-dim);">
              ${subj.attended} present / ${subj.absent} absent
            </div>
          </div>
          <div style="position: relative; width: 68px; height: 68px; flex-shrink: 0;">
            <svg width="68" height="68" viewBox="0 0 68 68" style="transform: rotate(-90deg);">
              <circle cx="34" cy="34" r="${radius}" fill="none" stroke="rgba(255,255,255,0.05)" stroke-width="6"></circle>
              <circle cx="34" cy="34" r="${radius}" fill="none" stroke="${color}" stroke-width="6" stroke-dasharray="${circumference}" stroke-dashoffset="${offset}" stroke-linecap="round" style="transition: stroke-dashoffset 1s ease-out;"></circle>
            </svg>
            <div style="position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-weight: bold; font-size: 0.85rem; color: #fff;">
              ${Math.round(p)}%
            </div>
          </div>
        </div>
      </div>
    `;
  }).join('');
}

// ─── Attendance Page ───
function initAttendancePage() {
  const syncBtn = document.getElementById('attendanceSyncBtn');
  if (syncBtn) {
    syncBtn.onclick = () => refreshCurrentPage();
  }
  renderAttendance();
}

function renderAttendance() {
  const detailed = data.detailedAttendance;
  const tableEl = document.getElementById('attendanceTable');

  if (!detailed || !detailed.matrix || detailed.matrix.length === 0) {
    const rows = data.attendance || [];
    if (!rows.length) {
      if (tableEl) tableEl.innerHTML = '<div class="term-alert warn">No attendance records. Press SYNC.</div>';
      return;
    }
    if (tableEl) {
      tableEl.innerHTML = `
        <div style="display: flex; flex-direction: column; gap: 8px;">
          ${rows.map(r => `
            <div class="term-card" style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px;">
              <div style="flex: 1; min-width: 140px;">
                <div style="font-weight: 500; font-size: 0.95rem; color: #fff;">${escapeHtml(r.subject)}</div>
                <div style="font-size: 0.8rem; color: var(--text-dim); margin-top: 2px;">${escapeHtml(r.code)}</div>
                <div style="font-size: 0.8rem; color: var(--text-dim); margin-top: 2px;">${r.attended} present / ${r.absent} absent</div>
              </div>
              <div style="display: flex; align-items: center; gap: 12px;">
                <span style="font-size: 0.85rem; font-weight: 600;">${r.statusText === 'bunkable' ? '<span class="text-green">Clear ' + r.statusNumber + ' bunks</span>' : r.statusText === 'needed' ? '<span class="text-red">Need ' + r.statusNumber + ' classes</span>' : '<span class="text-amber">On Track</span>'}</span>
                <span class="${pctClass(r.percentage)}" style="font-weight: bold; font-size: 1.1rem; min-width: 45px; text-align: right;">${r.percentage}</span>
              </div>
            </div>
          `).join('')}
        </div>
      `;
    }
    return;
  }

  const { subjects, matrix, summary, legend } = detailed;
  let html = '<div class="attendance-scroll" style="overflow-x: auto; padding-bottom: 16px;">';
  html += '<table class="term-table" style="white-space: nowrap;"><thead><tr>';
  html += '<th style="position: sticky; left: 0; background: var(--screen-bg); z-index: 2; padding-right: 16px;">DATE</th>';
  subjects.forEach(sub => {
    const name = (legend && legend[sub]) ? legend[sub] : '';
    const label = name ? `${escapeHtml(name)} <span style="font-weight: normal; color: var(--text-dim); font-size: 0.75em;">(${escapeHtml(sub)})</span>` : escapeHtml(sub);
    html += `<th style="text-align: center;">${label}</th>`;
  });
  html += '</tr></thead><tbody>';

  matrix.forEach(row => {
    html += '<tr>';
    html += `<td style="position: sticky; left: 0; background: var(--screen-bg); z-index: 1; font-weight: bold;">${escapeHtml(row.date)}</td>`;
    subjects.forEach(sub => {
      let mark = row.marks[sub] || '';
      let bg = 'transparent';
      if (mark.includes('1')) bg = 'rgba(51, 255, 51, 0.08)';
      else if (mark.includes('0')) bg = 'rgba(255, 68, 68, 0.08)';
      else if (mark !== '') bg = 'rgba(255, 176, 0, 0.08)';

      let textHtml = mark.split('+').map(m => {
        if (m === '1') return '<span class="text-green" style="font-weight: bold;">P</span>';
        if (m === '0') return '<span class="text-red" style="font-weight: bold;">A</span>';
        if (m) return `<span class="text-amber" style="font-size: 0.8em;">${escapeHtml(m)}</span>`;
        return '';
      }).join('<span style="color:#666; font-size:0.7em; margin: 0 2px;">+</span>');

      html += `<td style="background: ${bg}; text-align: center;">${textHtml}</td>`;
    });
    html += '</tr>';
  });

  html += '<tr style="border-top: 2px solid rgba(255,255,255,0.1);"><td style="position: sticky; left: 0; background: var(--screen-bg); z-index: 1; padding-top: 12px;"><strong>Total</strong></td>';
  subjects.forEach((sub, i) => html += `<td style="text-align: center; padding-top: 12px; color: var(--text-dim);">${summary.totalClasses?.[i] || 0}</td>`);
  html += '</tr>';

  html += '<tr><td style="position: sticky; left: 0; background: var(--screen-bg); z-index: 1;"><strong>Present</strong></td>';
  subjects.forEach((sub, i) => html += `<td style="text-align: center; color: var(--accent-green);">${summary.totalPresent?.[i] || 0}</td>`);
  html += '</tr>';

  html += '<tr><td style="position: sticky; left: 0; background: var(--screen-bg); z-index: 1; padding-bottom: 12px;"><strong>%</strong></td>';
  subjects.forEach((sub, i) => {
    let pct = summary.percentages?.[i] || '0%';
    html += `<td class="${pctClass(pct)}" style="text-align: center; font-weight: bold; padding-bottom: 12px; font-size: 1.1em;">${pct}</td>`;
  });
  html += '</tr></tbody></table></div>';

  if (Object.keys(legend).length > 0) {
    html += '<div style="margin-top: 16px; display: flex; flex-wrap: wrap; gap: 12px; font-size: 0.8rem; color: var(--text-dim);">';
    html += '<span style="background: rgba(51,255,51,0.1); padding: 4px 10px; border-radius: 4px;"><strong class="text-green">P</strong> = Present</span>';
    html += '<span style="background: rgba(255,68,68,0.1); padding: 4px 10px; border-radius: 4px;"><strong class="text-red">A</strong> = Absent</span>';
    html += '<span style="background: rgba(255,176,0,0.1); padding: 4px 10px; border-radius: 4px;"><strong class="text-amber">GH/TL</strong> = Holiday/Leave</span>';
    html += '</div>';
  }

  if (tableEl) tableEl.innerHTML = html;

  // Render subject code legend
  const legendContainer = document.getElementById('subjectLegend');
  const legendContent = document.getElementById('subjectLegendContent');
  if (legendContainer && legendContent && legend && subjects) {
    const codeEntries = subjects.filter(code => legend[code]).map(code => ({
      code,
      name: legend[code]
    }));
    if (codeEntries.length > 0) {
      legendContent.innerHTML = codeEntries.map(({ code, name }) => `
        <div style="display: flex; justify-content: space-between; padding: 4px 8px; background: rgba(255,255,255,0.02); border-radius: 4px;">
          <span style="color: var(--accent-cyan); font-weight: bold;">${escapeHtml(code)}</span>
          <span style="color: var(--text-dim);">${escapeHtml(name)}</span>
        </div>
      `).join('');
      legendContainer.style.display = 'block';
    } else {
      legendContainer.style.display = 'none';
    }
  }
}

// ─── Academics Page ───
async function initAcademicsPage() {
  let historyObj = null;
  if (window.data && window.data.history) {
    historyObj = window.data.history;
  } else if (session && session.history) {
    historyObj = session.history;
  } else {
    const cached = localStorage.getItem('bb_academic_history_v2');
    if (cached) {
      try { historyObj = JSON.parse(cached); } catch (e) {}
    }
  }

  const homeAcademicSection = document.getElementById('homeAcademicSection');
  if (homeAcademicSection) homeAcademicSection.style.display = 'block';

  const setText = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val || '--'; };
  const setLoading = (id, isLoading) => {
    const el = document.getElementById(id);
    if (!el) return;
    if (isLoading) {
      el.textContent = 'PLEASE WAIT...';
      el.className = 'text-amber';
    }
  };

  // Show loading state for data that might be fetched
  setLoading('homeCgpa', true);
  setLoading('homeRank', true);
  setLoading('academicCgpa', true);
  setLoading('academicUniRank', true);
  setLoading('academicDeptRank', true);
  setLoading('academicCredits', true);
  setLoading('academicName', true);
  setLoading('academicBranch', true);

  if (!historyObj || Object.keys(historyObj).length === 0 || !historyObj.cgpa || historyObj.cgpa === '--') {
    if (session?.sessionId) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15000);
        const apiResult = await fetchAcademicHistory(session.sessionId, controller.signal);
        clearTimeout(timeout);
        if (apiResult.ok && apiResult.history) {
          historyObj = apiResult.history;
          if (session.data) session.data.history = historyObj;
          localStorage.setItem('bb_academic_history_v2', JSON.stringify(historyObj));
        }
      } catch (e) {
        console.error('Failed to fetch academic history:', e.message);
        if (e.name === 'AbortError') {
          if (statusEl) statusEl.innerHTML = '<span class="text-amber">Academics timeout. Press SYNC to retry.</span>';
        }
      }
    }
  }

  if (!historyObj || Object.keys(historyObj).length === 0) {
    historyObj = { cgpa: '--', deptRank: '--', universityRank: '--', credits: '--', name: '--', major: '--' };
  }

  setText('homeCgpa', historyObj.cgpa);
  setText('homeRank', historyObj.deptRank);
  setText('academicCgpa', historyObj.cgpa);
  setText('academicUniRank', historyObj.universityRank);
  setText('academicDeptRank', historyObj.deptRank);
  setText('academicCredits', historyObj.credits);

  let rollNum = window.data?.home?.profile?.RollNo || "Student";
  let profileName = historyObj.name && historyObj.name !== 'Student'
    ? historyObj.name
    : (window.data && window.data.home && window.data.home.profile && (window.data.home.profile.Name || window.data.home.profile.name)) || rollNum;
  profileName = profileName.toLowerCase().split(' ').map(w => w.charAt(0).toUpperCase() + w.substring(1)).join(' ').trim();
  setText('academicName', profileName);
  setText('academicRoll', rollNum);

  let branch = historyObj.major && historyObj.major !== 'B.Tech' ? historyObj.major : '--';
  if (branch === '--') {
    if (rollNum.includes('UME')) branch = 'Mechanical Engineering';
    else if (rollNum.includes('UCO')) branch = 'Computer Engg (COE)';
    else if (rollNum.includes('UEC')) branch = 'Electronics & Comm (ECE)';
    else if (rollNum.includes('UIT')) branch = 'Information Tech (IT)';
    else if (rollNum.includes('UEE')) branch = 'Electrical Engg (EE)';
    else if (rollNum.includes('UMA')) branch = 'Mech & Auto (MAC)';
    else if (rollNum.includes('UBF')) branch = 'Bio-Technology';
    else branch = 'Engineering (B.Tech)';
  }
  setText('academicBranch', branch);

  const initials = profileName.split(' ').map(n => n[0]).join('').substring(0, 2).toUpperCase();
  setText('academicInitials', initials);

  const trendData = historyObj.sgpa || [];
  const labelsArray = trendData.map((_, i) => `${i + 1} Sem`);

  const hdHome = document.getElementById('homeChart');
  const ctxHome = hdHome ? hdHome.getContext('2d') : null;
  const hdAcad = document.getElementById('cgpaTrendChart');
  const ctxAcad = hdAcad ? hdAcad.getContext('2d') : null;

  if (window.chartHomeHandle) window.chartHomeHandle.destroy();
  if (window.chartAcadHandle) window.chartAcadHandle.destroy();

  const chartCfg = {
    type: 'line',
    data: {
      labels: labelsArray,
      datasets: [{
        label: 'SGPA',
        data: trendData,
        borderColor: '#33FF33',
        backgroundColor: 'rgba(51, 255, 51, 0.08)',
        fill: true,
        tension: 0.4,
        borderWidth: 2,
        pointBackgroundColor: '#33FF33',
        pointBorderColor: '#fff',
        pointBorderWidth: 2,
        pointRadius: 5,
        pointHoverRadius: 7
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      layout: { padding: { bottom: 10 } },
      plugins: { legend: { display: false } },
      scales: {
        y: { display: false },
        x: { grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: '#6B8E7B' } }
      }
    }
  };

  if (ctxHome) window.chartHomeHandle = new Chart(ctxHome, chartCfg);
  if (ctxAcad) window.chartAcadHandle = new Chart(ctxAcad, chartCfg);

  const semGrid = document.getElementById('semestersGrid');
  if (semGrid) {
    const semsData = trendData.map((sgpa, i) => ({
      name: `Semester ${['I','II','III','IV','V','VI','VII','VIII'][i] || 'Sem ' + (i+1)}`,
      sgpa: String(sgpa),
    }));

    if (semsData.length > 0) {
      semGrid.innerHTML = semsData.map(sem => `
        <div class="term-card">
          <div style="display: flex; justify-content: space-between; align-items: center; padding-bottom: 8px; border-bottom: 1px dashed rgba(255,255,255,0.08);">
            <span style="font-weight: bold;">${sem.name}</span>
            <span class="text-green" style="font-weight: bold; font-size: 1.1rem;">${sem.sgpa}</span>
          </div>
        </div>
      `).join('');
    } else {
      semGrid.innerHTML = '<div class="term-alert info">Semester-wise data not available.</div>';
    }
  }

  const compCtx = document.getElementById('comparisonChart');
  if (compCtx && window.Chart) {
    if (window.chartCompHandle) window.chartCompHandle.destroy();
    const myCgpa = parseFloat(historyObj.cgpa) || 0;
    window.chartCompHandle = new Chart(compCtx.getContext('2d'), {
      type: 'bar',
      data: {
        labels: ['Your CGPA', 'Branch Avg', 'Topper CGPA'],
        datasets: [{
          label: 'CGPA',
          data: [myCgpa, 5.965, 9.699],
          backgroundColor: ['rgba(51, 255, 51, 0.3)', 'rgba(100, 116, 139, 0.3)', 'rgba(0, 255, 209, 0.3)'],
          borderColor: ['#33FF33', '#64748b', '#00FFD1'],
          borderWidth: 1,
          borderRadius: 4
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          y: { display: true, beginAtZero: true, max: 10, ticks: { color: '#6B8E7B' }, grid: { color: 'rgba(255,255,255,0.05)' } },
          x: { grid: { display: false }, ticks: { color: '#6B8E7B' } }
        }
      }
    });
  }
}

// ─── About Page ───
function initAboutPage() {
  // About page is static, no dynamic loading needed
}

// ─── Timetable Page ───
function initTimetablePage() {
  const container = document.getElementById('timetableContainer');
  const todayBtn = document.getElementById('ttTodayBtn');
  const weekBtn = document.getElementById('ttWeekBtn');
  const clockEl = document.getElementById('ttClock');
  if (!container) return;

  const today = (window.data && window.data.todayTimetable) || [];
  const week = (window.data && window.data.weekTimetable) || {};

  function parseTimeRange(timeStr) {
    const parts = timeStr.split('-');
    if (parts.length !== 2) return null;
    const parse = (s) => {
      s = s.trim().toLowerCase();
      let mer = 'am';
      if (s.includes('pm')) { mer = 'pm'; s = s.replace('pm', ''); }
      else if (s.includes('am')) { mer = 'am'; s = s.replace('am', ''); }
      const tp = s.split(':');
      let h = parseInt(tp[0]) || 0;
      let m = tp.length > 1 ? parseInt(tp[1]) || 0 : 0;
      if (mer === 'pm' && h < 12) h += 12;
      if (mer === 'am' && h === 12) h = 0;
      return h * 60 + m;
    };
    return { start: parse(parts[0]), end: parse(parts[1]) };
  }

  function isCurrentClass(timeStr) {
    const range = parseTimeRange(timeStr);
    if (!range) return false;
    const now = new Date();
    const current = now.getHours() * 60 + now.getMinutes();
    return current >= range.start && current < range.end;
  }

  function updateClock() {
    if (!clockEl) return;
    const now = new Date();
    const h = String(now.getHours()).padStart(2, '0');
    const m = String(now.getMinutes()).padStart(2, '0');
    clockEl.textContent = `${h}:${m}`;
  }

  let mode = 'today';
  let renderInterval = null;

  function render() {
    if (mode === 'today') {
      if (today.length === 0) {
        container.innerHTML = '<div class="term-alert info">No classes scheduled for today.</div>';
        return;
      }
      container.innerHTML = today.map(slot => {
        const isActive = isCurrentClass(slot.time);
        const highlightStyle = isActive
          ? 'border: 1px solid var(--accent-green); box-shadow: 0 0 12px rgba(51,255,51,0.15);'
          : '';
        const activeLabel = isActive ? '<span class="text-green" style="font-size: 0.75rem; margin-left: 8px;">● LIVE</span>' : '';
        const roomLine = slot.room ? `<div style="font-size: 0.8rem; color: var(--text-dim); margin-top: 2px;">Room: ${escapeHtml(slot.room)}</div>` : '';
        return `
          <div class="term-card" style="display: flex; justify-content: space-between; align-items: center; padding: 12px 16px; ${highlightStyle}">
            <div>
              <div style="font-weight: bold; color: #fff;">${escapeHtml(slot.subject)}${activeLabel}</div>
              ${roomLine}
            </div>
            <div style="color: var(--accent-cyan); font-weight: bold; font-size: 0.9rem;">${escapeHtml(slot.time)}</div>
          </div>
        `;
      }).join('');
    } else {
      const days = sortWeekdays(Object.keys(week));
      if (days.length === 0) {
        container.innerHTML = '<div class="term-alert info">No weekly timetable data available.</div>';
        return;
      }
      const now = new Date();
      const currentDay = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][now.getDay()];
      container.innerHTML = days.map(day => {
        const isToday = day === currentDay;
        const dayLabel = isToday ? `${escapeHtml(day)} <span class="text-green" style="font-size:0.75rem;">● TODAY</span>` : escapeHtml(day);
        const slotsHtml = week[day].map(slot => {
          const isActive = isCurrentClass(slot.time);
          const highlightStyle = isActive
            ? 'border: 1px solid var(--accent-green); box-shadow: 0 0 12px rgba(51,255,51,0.15);'
            : '';
          const activeLabel = isActive ? '<span class="text-green" style="font-size: 0.75rem; margin-left: 8px;">● LIVE</span>' : '';
          const roomLine = slot.room ? `<div style="font-size: 0.8rem; color: var(--text-dim); margin-top: 2px;">Room: ${escapeHtml(slot.room)}</div>` : '';
          return `
            <div class="term-card" style="display: flex; justify-content: space-between; align-items: center; padding: 10px 14px; ${highlightStyle}">
              <div>
                <div style="font-weight: 500; color: #fff;">${escapeHtml(slot.subject)}${activeLabel}</div>
                ${roomLine}
              </div>
              <div style="color: var(--text-dim); font-size: 0.85rem;">${escapeHtml(slot.time)}</div>
            </div>
          `;
        }).join('');
        return `
          <div style="margin-bottom: 16px;">
            <div style="font-size: 0.85rem; color: var(--accent-cyan); text-transform: uppercase; letter-spacing: 0.1em; margin-bottom: 8px;">${dayLabel}</div>
            <div style="display: flex; flex-direction: column; gap: 8px;">
              ${slotsHtml}
            </div>
          </div>
        `;
      }).join('');
    }
  }

  if (todayBtn) {
    todayBtn.onclick = () => {
      mode = 'today';
      todayBtn.classList.add('active');
      if (weekBtn) weekBtn.classList.remove('active');
      render();
    };
  }
  if (weekBtn) {
    weekBtn.onclick = () => {
      mode = 'week';
      weekBtn.classList.add('active');
      if (todayBtn) todayBtn.classList.remove('active');
      render();
    };
  }

  if (todayBtn) todayBtn.classList.add('active');
  render();
  updateClock();
  if (renderInterval) clearInterval(renderInterval);
  renderInterval = setInterval(() => {
    updateClock();
    render();
  }, 30000);
}

// ─── Legal Pages ───
function initLegalPage() {
  // Terms and privacy pages are static
}

// ─── Calendar ───
function renderCalendar() {
  const grid = document.getElementById('calendarGrid');
  const monthYear = document.getElementById('calMonthYear');
  if (!grid) return;

  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  if (monthYear) {
    const monthNames = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
    monthYear.textContent = `${monthNames[month]} ${year}`;
  }

  let html = '';
  for (let i = 0; i < firstDay; i++) {
    html += '<div></div>';
  }
  for (let day = 1; day <= daysInMonth; day++) {
    const isToday = day === now.getDate();
    html += `<div style="padding: 4px; border-radius: 3px; ${isToday ? 'background: var(--accent-green); color: var(--screen-bg); font-weight: bold;' : ''}">${day}</div>`;
  }
  grid.innerHTML = html;
}

// ─── Home Timetable ───
function renderHomeTimetable() {
  const section = document.getElementById('homeTimetableSection');
  const container = document.getElementById('homeTimetableContainer');
  if (!section || !container) return;

  const today = (window.data && window.data.todayTimetable) || [];
  if (today.length === 0) {
    section.style.display = 'none';
    return;
  }

  section.style.display = 'block';
  container.innerHTML = today.map(slot => `
    <div class="term-card" style="display: flex; justify-content: space-between; align-items: center; padding: 10px 14px; margin-bottom: 8px;">
      <div style="font-weight: 500; color: #fff;">${escapeHtml(slot.subject)}</div>
      <div style="color: var(--accent-cyan); font-weight: bold; font-size: 0.85rem;">${escapeHtml(slot.time)}</div>
    </div>
  `).join('');
}

// ─── Refresh ───
async function refreshCurrentPage() {
  if (isRefreshing) return;
  const pwd = localStorage.getItem('bb_password');
  if (!pwd || !session?.sessionId) return;

  isRefreshing = true;
  const sem = localStorage.getItem('bb_semester') || '1';
  const yr = localStorage.getItem('bb_year') || '2026-27';

  const statusEl = document.getElementById('refreshStatus');
  if (statusEl) {
    statusEl.innerHTML = '<span class="warning">SYNCING DATA...</span><div class="term-progress"><div class="term-progress-fill" style="width: 0%; transition: width 0.3s ease;"></div></div>';
  }

  let progress = 0;
  const progressInterval = setInterval(() => {
    progress += Math.random() * 15;
    if (progress > 90) progress = 90;
    const fill = statusEl?.querySelector('.term-progress-fill');
    if (fill) fill.style.width = Math.min(progress, 100) + '%';
  }, 200);

  try {
    const result = await refreshData(session.sessionId, yr, sem);
    clearInterval(progressInterval);
    const fill = statusEl?.querySelector('.term-progress-fill');
    if (fill) fill.style.width = '100%';
    if (result.ok && result.success) {
      saveSession(result.sessionId, result.rollNumber, result.data, result.history);
      if (result.history) localStorage.setItem('bb_academic_history_v2', JSON.stringify(result.history));
      if (window.data) {
        Object.assign(window.data, result.data);
        if (result.history) window.data.history = result.history;
      }
      if (session && session.data) {
        Object.assign(session.data, result.data);
        if (result.history) session.history = result.history;
      }
      if (statusEl) statusEl.innerHTML = '<span class="success">SYNC COMPLETE</span>';
      loadPage(currentPage);
    } else {
      if (statusEl) statusEl.innerHTML = `<span class="error">SYNC FAILED: ${result.message || 'Unknown error'}</span>`;
    }
  } catch (e) {
    if (statusEl) statusEl.innerHTML = `<span class="error">SYNC ERROR: ${e.message}</span>`;
  } finally {
    isRefreshing = false;
    setTimeout(() => {
      if (statusEl) statusEl.innerHTML = '';
    }, 3000);
  }
}

window.addEventListener('bbRefresh', () => {
  if (currentPage === 'home') {
    renderSubjectCards();
    renderHomeTimetable();
  }
  if (currentPage === 'attendance') renderAttendance();
});

// ─── Utilities ───
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// ─── Navigation Setup ───
function setupNav() {
  document.querySelectorAll('.nav-pill').forEach(pill => {
    pill.addEventListener('click', () => {
      const page = pill.dataset.page;
      document.querySelectorAll('.nav-pill').forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      loadPage(page);
      scrollToTop();
    });
  });
}

// ─── Initialization ───
setupNav();
loadPage('home');

// Clean up any stale roll values from old versions
if (localStorage.getItem('bb_roll') === 'undefined' || localStorage.getItem('bb_roll') === 'null') {
  localStorage.removeItem('bb_roll');
}
if (localStorage.getItem('bb_roll_id') === 'undefined' || localStorage.getItem('bb_roll_id') === 'null') {
  localStorage.removeItem('bb_roll_id');
}

// Auto-sync on page load if session exists
if (session?.sessionId) {
  const sem = localStorage.getItem('bb_semester') || '1';
  const yr = localStorage.getItem('bb_year') || '2026-27';
  refreshData(session.sessionId, yr, sem).then(result => {
    if (result.ok && result.success) {
      saveSession(result.sessionId, result.rollNumber, result.data, result.history);
      if (result.history) localStorage.setItem('bb_academic_history_v2', JSON.stringify(result.history));
      if (window.data) {
        Object.assign(window.data, result.data);
        if (result.history) window.data.history = result.history;
      }
      if (session && session.data) {
        Object.assign(session.data, result.data);
        if (result.history) session.history = result.history;
      }
      loadPage(currentPage);
    }
  }).catch(e => console.error('Auto-sync failed:', e));
}

window.addEventListener('pagesLoaded', () => {
  // Additional initialization if needed
});

// Expose functions to global scope for inline onclick handlers
window.loadPage = loadPage;
window.scrollUp = () => {
  if (mainTerminal) mainTerminal.scrollBy({ top: -200, behavior: 'smooth' });
};
window.scrollDown = () => {
  if (mainTerminal) mainTerminal.scrollBy({ top: 200, behavior: 'smooth' });
};
window.refreshCurrentPage = refreshCurrentPage;
window.logout = () => {
  if (confirm('TERMINATE SESSION?')) {
    clearSession();
    window.location.href = '/';
  }
};