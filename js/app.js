import { getSession, clearSession, saveSession, refreshData } from './api.js';

const session = getSession();
if (!session) {
    window.location.href = 'index.html';
}

const data = session.data || { home: {}, attendance: [], detailedAttendance: null, resources: [], connect: [] };
window.data = data;
const rollNumber = session.rollNumber ? session.rollNumber.toUpperCase() : 'UNKNOWN';

// Auto-refresh if data is missing
if (!session.data || !session.data.attendance || session.data.attendance.length === 0) {
    const pwd = localStorage.getItem('bb_password');
    if (pwd && session.sessionId) {
        setTimeout(() => doBackgroundRefresh(), 500);
    }
}

function pctClass(pctStr) {
    const n = parseFloat(String(pctStr).replace(/[^\d.]/g, ''));
    if (Number.isNaN(n)) return '';
    if (n >= 75) return 'pct-good';
    if (n >= 65) return 'pct-warn';
    return 'pct-bad';
}

window.isRefreshing = false;
async function doBackgroundRefresh() {
    if (window.isRefreshing) return;
    const pwd = localStorage.getItem('bb_password');
    if (!pwd) return;

    window.isRefreshing = true;
    const btn = document.getElementById('refreshAttendanceBtn');
    const syncProg = document.getElementById('homeSyncProgressContainer');
    const syncBar = document.getElementById('homeSyncProgressBar');
    if (btn) btn.innerHTML = '<i class="ph ph-spinner ph-spin" style="animation: spin 1s linear infinite;"></i> Syncing...';
    if (syncProg) {
        syncProg.style.display = 'block';
        void syncProg.offsetWidth;
        if (syncBar) {
            syncBar.style.width = '70%';
            syncBar.style.background = '#10b981';
        }
    }

    try {
        const targetRoll = rollNumber || localStorage.getItem('bb_roll_id') || "";
        const sem = document.getElementById('dashSemInput')?.value || localStorage.getItem('bb_semester') || '1';
        const yr = document.getElementById('dashYearInput')?.value || localStorage.getItem('bb_year') || '2026-27';

        localStorage.setItem('bb_semester', sem);
        localStorage.setItem('bb_year', yr);

        const result = await refreshData(session.sessionId, yr, sem);
        if (result.ok && result.success) {
            saveSession(result.sessionId, result.rollNumber, result.data, result.history);
            if (result.history) {
                localStorage.setItem('bb_academic_history_v2', JSON.stringify(result.history));
            }
            if (window.data) {
                Object.assign(window.data, result.data);
                if (result.history) window.data.history = result.history;
            }
            if (session && session.data) {
                Object.assign(session.data, result.data);
                if (result.history) session.history = result.history;
            }
            renderHome();
            renderAttendance();
            loadAcademics();
            if (btn) btn.innerHTML = '<i class="ph ph-check-circle" style="color: #10b981;"></i> Sync Complete';
            if (syncBar) syncBar.style.width = '100%';
        } else {
            console.error("Auto refresh failed", result.message || result.status);
            if (btn) btn.innerHTML = '<i class="ph ph-warning" style="color: #ef4444;"></i> Auth Failed!';
            if (syncBar) { syncBar.style.width = '100%'; syncBar.style.background = '#ef4444'; }
        }
    } catch (e) {
        console.error("Refresh error", e);
        const isNetworkError = e instanceof TypeError && (e.message === 'Failed to fetch' || e.message === 'NetworkError when attempting to fetch resource.');
        if (btn) btn.innerHTML = isNetworkError 
            ? '<i class="ph ph-warning" style="color: #ef4444;"></i> Network Error'
            : `<i class="ph ph-warning" style="color: #ef4444;"></i> Error: ${e.message}`;
        if (syncBar) { syncBar.style.width = '100%'; syncBar.style.background = '#ef4444'; }
    } finally {
        window.isRefreshing = false;
        setTimeout(() => {
            if (btn) btn.innerHTML = '<i class="ph ph-arrows-clockwise"></i> Refresh Data';
            if (typeof syncProg !== 'undefined' && syncProg) syncProg.style.display = 'none';
            if (typeof syncBar !== 'undefined' && syncBar) syncBar.style.width = '0%';
        }, 5000);
    }
}

function renderHome() {
    const profile = data.home?.profile || {};
    let name = profile.Name || profile.name || rollNumber;
    if (name && name !== rollNumber) {
        name = name.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
    }
    const homeGreeting = document.getElementById('homeGreeting');
    if (homeGreeting) homeGreeting.innerHTML = `Welcome, <span style='font-weight: normal; margin-left: 8px;'>${name}</span>`;
    const homeSub = document.getElementById('homeSub');
    if (homeSub) homeSub.textContent = `Roll ${rollNumber}`;

    const semInput = document.getElementById('dashSemInput');
    const yrInput = document.getElementById('dashYearInput');
    if (semInput) semInput.value = localStorage.getItem('bb_semester') || '1';
    if (yrInput) yrInput.value = localStorage.getItem('bb_year') || '2026-27';

    const refreshBtn = document.getElementById('refreshAttendanceBtn');
    if (refreshBtn) {
        refreshBtn.onclick = doBackgroundRefresh;
    }

    const attendance = data.attendance || [];

    const cgpaNode = document.getElementById('dashCgpa');
    const semNode = document.getElementById('dashSemester');

    if (cgpaNode) cgpaNode.textContent = profile.cgpa || '--';
    if (semNode) semNode.textContent = profile.semester || '--';

    // Subject Summary
    const cardsContainer = document.getElementById('subjectCardsContainer');
    if (cardsContainer) {
        if (attendance.length === 0) {
            cardsContainer.innerHTML = '<div class="empty-state" style="grid-column: 1/-1;">No Data!</div>';
        } else {
            const sortedAttendance = [...attendance].sort((a, b) => {
                const getScore = (subj) => {
                    if (subj.statusText === 'bunkable') return parseInt(subj.statusNumber) || 0;
                    if (subj.statusText === 'needed') return - (parseInt(subj.statusNumber) || 0) - 100;
                    return -50;
                };
                return getScore(b) - getScore(a);
            });

            cardsContainer.innerHTML = sortedAttendance.map(subj => {
                const p = parseFloat(subj.percentage);
                const color = p >= 75 ? '#22c55e' : p >= 65 ? '#f59e0b' : '#ef4444';
                const nameTrunc = (subj.subject || '').length > 40 ? (subj.subject || '').substring(0, 40) + '...' : subj.subject;

                const statusPhrase = subj.statusText === 'bunkable'
                    ? `<div style="font-size: 2rem; font-weight: 700; color: #22c55e;">${subj.statusNumber} <span style="font-size: 0.9rem; font-weight: normal; color: var(--text-secondary);">Safe to Bunk</span></div>`
                    : subj.statusText === 'needed'
                        ? `<div style="font-size: 1.5rem; font-weight: 700; color: #ef4444;">Need ${subj.statusNumber} <span style="font-size: 0.9rem; font-weight: normal; color: var(--text-secondary);">more for 75%</span></div>`
                        : `<div style="font-size: 1.5rem; font-weight: 700; color: #f59e0b;">On Track</div>`;

                // Calculate SVG Circle
                const radius = 35;
                const circumference = 2 * Math.PI * radius;
                const offset = circumference - (p / 100) * circumference;

                return `
                <div class="dash-card" style="padding: 20px; display: flex; flex-direction: column; justify-content: space-between; border-radius: 20px; position: relative; overflow: hidden;">
                    <div style="font-weight: 600; font-size: 1.05rem; margin-bottom: 20px; line-height: 1.3; min-height: 3rem;">${nameTrunc}</div>
                    
                    <div style="display: flex; align-items: flex-end; justify-content: space-between;">
                        <div>
                            ${statusPhrase}
                            <div style="margin-top: 5px; font-size: 0.8rem; color: var(--text-muted);">
                                ${subj.attended} attended / ${subj.absent} missed
                            </div>
                        </div>
                        <div style="position: relative; width: 80px; height: 80px;">
                            <svg width="80" height="80" viewBox="0 0 80 80" style="transform: rotate(-90deg);">
                                <circle cx="40" cy="40" r="35" fill="none" stroke="rgba(255,255,255,0.05)" stroke-width="8"></circle>
                                <circle cx="40" cy="40" r="35" fill="none" stroke="${color}" stroke-width="8" stroke-dasharray="${circumference}" stroke-dashoffset="${offset}" stroke-linecap="round" style="transition: stroke-dashoffset 1s ease-out;"></circle>
                            </svg>
                            <div style="position: absolute; top: 0; left: 0; width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; font-weight: bold; font-size: 1.1rem; color: #fff;">
                                ${Math.round(p)}%
                            </div>
                        </div>
                    </div>
                </div>
              `;
            }).join('');
        }
    }

    }

function renderAttendance() {
    const detailed = data.detailedAttendance;

    // Backwards compatibility fallback if no detailed matrix is present
    if (!detailed || !detailed.matrix || detailed.matrix.length === 0) {
        const rows = data.attendance || [];
        if (!rows.length) {
            document.getElementById('attendanceTable').innerHTML = '<div class="empty-state">No attendance records scraped. Try refreshing from IMS.</div>';
            return;
        }

        document.getElementById('attendanceTable').innerHTML = `
        <table class="data-table">
          <thead>
            <tr>
              <th>Subject</th>
              <th>Present</th>
              <th>Absent</th>
              <th>Bunk Status</th>
              <th>Percentage</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map((r) => `
            <tr>
              <td><div style="font-weight: 500; font-size: 0.95rem; white-space: normal; line-height: 1.3;">${r.subject}</div></td>
              <td style="color: #22c55e;">${r.attended}</td>
              <td style="color: #ef4444;">${r.absent}</td>
              <td>
                 ${r.statusText === 'bunkable'
                ? `<span style="color: #22c55e; font-weight: 600;">You can clear ${r.statusNumber} bunks</span>`
                : r.statusText === 'needed'
                    ? `<span style="color: #ef4444; font-weight: 600;">Attend next ${r.statusNumber} classes</span>`
                    : `<span style="color: #f59e0b; font-weight: 600;">On Track</span>`}
              </td>
              <td class="${pctClass(r.percentage)}">${r.percentage}</td>
            </tr>`).join('')}
          </tbody>
        </table>`;
        return;
    }

    // Draw Detailed Day-by-Day Matrix
    const { subjects, matrix, summary, legend } = detailed;

    let html = `<div class="matrix-container" style="overflow-x: auto; padding-bottom: 20px;">`;
    html += `<table class="data-table" style="white-space: nowrap;">`;

    // Headers
    html += `<thead><tr>`;
    html += `<th style="position: sticky; left: 0; background: var(--surface); z-index: 2; padding-right: 25px;">Date <span style="font-size: 0.7em; color: var(--text-muted); opacity: 0.7">(&darr;)</span></th>`;
    subjects.forEach(sub => {
        html += `<th style="text-align: center;">${sub}</th>`;
    });
    html += `</tr></thead><tbody>`;

    // Matrix Rows (Iterate dates)
    matrix.forEach(row => {
        html += `<tr>`;
        html += `<td style="position: sticky; left: 0; background: var(--surface); z-index: 1;"><strong>${row.date}</strong></td>`;
        subjects.forEach(sub => {
            let mark = row.marks[sub] || '';
            let bg = 'transparent';

            if (mark.includes('1')) bg = 'rgba(34, 197, 94, 0.05)';
            else if (mark.includes('0')) bg = 'rgba(239, 68, 68, 0.05)';
            else if (mark !== '') bg = 'rgba(245, 158, 11, 0.05)';

            // Format 1+1 or 1+0 into P+P / P+A nicely
            let textHtml = mark;
            textHtml = textHtml.split('+').map(m => {
                if (m === '1') return '<span style="color: #22c55e; font-weight: bold;">P</span>';
                if (m === '0') return '<span style="color: #ef4444; font-weight: bold;">A</span>';
                if (m) return `<span style="color: #f59e0b; font-size: 0.8em;">${m}</span>`;
                return '';
            }).join('<span style="color:#666; font-size:0.7em; margin: 0 2px;">+</span>');

            html += `<td style="background: ${bg}; text-align: center;">${textHtml}</td>`;
        });
        html += `</tr>`;
    });

    // Overall Summary Metrics Block
    html += `<tr style="border-top: 2px solid var(--border);"><td style="position: sticky; left: 0; background: var(--surface); z-index: 1; padding-top: 15px;"><strong>Total Classes</strong></td>`;
    subjects.forEach((sub, i) => html += `<td style="text-align: center; padding-top: 15px; color: var(--text-muted);">${summary.totalClasses?.[i] || 0}</td>`);
    html += `</tr>`;

    html += `<tr><td style="position: sticky; left: 0; background: var(--surface); z-index: 1;"><strong>Total Present</strong></td>`;
    subjects.forEach((sub, i) => html += `<td style="text-align: center; color: #22c55e;">${summary.totalPresent?.[i] || 0}</td>`);
    html += `</tr>`;

    html += `<tr><td style="position: sticky; left: 0; background: var(--surface); z-index: 1; padding-bottom:15px;"><strong>Overall (%)</strong></td>`;
    subjects.forEach((sub, i) => {
        let pct = summary.percentages?.[i] || '0%';
        html += `<td class="${pctClass(pct)}" style="text-align: center; font-weight: bold; padding-bottom:15px; font-size: 1.1em;">${pct}</td>`;
    });
    html += `</tr>`;

    html += `</tbody></table></div>`;

    // Draw Legend Glossary
    if (Object.keys(legend).length > 0) {
        html += `<div style="margin-top: 20px; font-size: 0.85em; display: flex; flex-wrap: wrap; gap: 15px; color: var(--text-muted); background: rgba(255,255,255,0.03); padding: 15px; border-radius: 8px; border: 1px solid var(--border);">`;
        Object.entries(legend).forEach(([code, title]) => {
            html += `<div><strong style="color: var(--text)">${code}</strong>: ${title}</div>`;
        });
        html += `</div>`;

        html += `<div style="margin-top: 15px; font-size: 0.8em; color: var(--text-muted); display: flex; flex-wrap: wrap; gap: 15px; justify-content: center; opacity: 0.8;">
        <span style="background: rgba(34,197,94,0.1); padding: 4px 10px; border-radius: 4px;"><strong style="color: #22c55e;">P</strong> = Present (1)</span>
        <span style="background: rgba(239,68,68,0.1); padding: 4px 10px; border-radius: 4px;"><strong style="color: #ef4444;">A</strong> = Absent (0)</span>
        <span style="background: rgba(245,158,11,0.1); padding: 4px 10px; border-radius: 4px;"><strong style="color: #f59e0b;">GH / TL / MS</strong> = Holidays / Leaves</span>
      </div>`;
    }

    // Appendix: Removed broken tables based on user request.
    document.getElementById('attendanceTable').innerHTML = html;
}

function renderLinks(containerId, items, emptyMsg) {
    const el = document.getElementById(containerId);
    if (!el) return;

    if (!items?.length) {
        el.innerHTML = `<div class="empty-state">${emptyMsg}</div>`;
        return;
    }

    el.innerHTML = items.map((item) => `
    <a class="link-item" href="${item.href}" target="_blank" rel="noopener">
      ${item.label}
      <span>↗ IMS</span>
    </a>`).join('');
}

function setupNav() {
    const pills = document.querySelectorAll('.nav-pill[data-page]');
    const panels = document.querySelectorAll('.page-panel');

    pills.forEach((pill) => {
        pill.addEventListener('click', () => {
            const page = pill.dataset.page;
            pills.forEach((p) => p.classList.toggle('active', p === pill));
            panels.forEach((panel) => panel.classList.toggle('active', panel.id === `page-${page}`));
            localStorage.setItem('bb_active_tab', page);
            
            if (page === 'home' || page === 'academics') {
                setTimeout(() => {
                    loadAcademics();
                }, 100);
            }
        });
    });

    const savedTab = localStorage.getItem('bb_active_tab');
    if (savedTab) {
        const targetPill = Array.from(pills).find(p => p.dataset.page === savedTab);
        if (targetPill) targetPill.click();
    }
}

function setupTheme() {
    const html = document.documentElement;
    const btn = document.getElementById('themeToggleBtn');
    if (!btn) return;

    btn.addEventListener('click', () => {
        const next = html.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
        html.setAttribute('data-theme', next);
        btn.textContent = next === 'dark' ? 'DARK' : 'LIGHT';
        localStorage.setItem('bb_theme', next);
    });

    const saved = localStorage.getItem('bb_theme');
    if (saved) {
        html.setAttribute('data-theme', saved);
        btn.textContent = saved === 'dark' ? 'DARK' : 'LIGHT';
    }
}

function setupEtherealShadows() {
    // Shader intentionally removed
}

function initThreeJS(container) {
    // Shader intentionally removed
}

const logoutBtn = document.getElementById('logoutBtn');
if (logoutBtn) {
    logoutBtn.addEventListener('click', () => {
        clearSession();
        localStorage.removeItem('bb_password');
        localStorage.removeItem('bb_roll_id');
        window.location.href = 'index.html';
    });
} else {
    console.warn('[APP] Logout button not found');
}

async function loadAcademics() {
    try {
        localStorage.removeItem('bb_academic_history');

        let historyObj = null;

        if (window.data && window.data.history) {
            historyObj = window.data.history;
        } else if (session && session.history) {
            historyObj = session.history;
        } else {
            const cached = localStorage.getItem('bb_academic_history_v2');
            if (cached) {
                try {
                    historyObj = JSON.parse(cached);
                } catch (e) {
                    console.warn('Failed to parse cached academic history', e);
                }
            }
        }

        if (!historyObj || Object.keys(historyObj).length === 0) {
            historyObj = { cgpa: '--', deptRank: '--', universityRank: '--', credits: '--', name: '--', major: '--' };
        }

        if (historyObj) {
            const data = { history: historyObj };

            document.getElementById('homeAcademicSection').style.display = 'block';
            document.getElementById('homeCgpa').textContent = data.history.cgpa || '--';
            document.getElementById('homeRank').textContent = data.history.deptRank || '--';

            document.getElementById('academicCgpa').textContent = data.history.cgpa || '--';
            const rnkU = data.history.universityRank || '--';
            const rnkD = data.history.deptRank || '--';
            const creds = data.history.credits || '--';

            document.getElementById('academicUniRank').textContent = rnkU;
            document.getElementById('academicDeptRank').textContent = rnkD;
            document.getElementById('academicCredits').textContent = creds;

            let rollNumber = window.data?.home?.profile?.RollNo || "Student";
            let profileName = data.history.name && data.history.name !== 'Student'
                ? data.history.name
                : (window.data && window.data.home && window.data.home.profile && (window.data.home.profile.Name || window.data.home.profile.name)) || rollNumber;

            profileName = profileName.toLowerCase().split(' ').map(w => w.charAt(0).toUpperCase() + w.substring(1)).join(' ').trim();

            document.getElementById('academicName').textContent = profileName;
            document.getElementById('academicRoll').textContent = rollNumber;

            let branch = data.history.major && data.history.major !== 'B.Tech' ? data.history.major : '--';
            if (branch === '--') {
                if (rollNumber.includes('UME')) branch = 'Mechanical Engineering';
                else if (rollNumber.includes('UCO')) branch = 'Computer Engg (COE)';
                else if (rollNumber.includes('UEC')) branch = 'Electronics & Comm (ECE)';
                else if (rollNumber.includes('UIT')) branch = 'Information Tech (IT)';
                else if (rollNumber.includes('UEE')) branch = 'Electrical Engg (EE)';
                else if (rollNumber.includes('UMA')) branch = 'Mech & Auto (MAC)';
                else if (rollNumber.includes('UBF')) branch = 'Bio-Technology';
                else branch = 'Engineering (B.Tech)';
            }
            document.getElementById('academicBranch').textContent = branch;

            const initials = profileName.split(' ').map(n => n[0]).join('').substring(0, 2).toUpperCase();
            document.getElementById('academicInitials').textContent = initials;

            let trendData = data.history.sgpa || [];
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
                        borderColor: '#22d3ee',
                        backgroundColor: 'rgba(34,211,238,0.1)',
                        fill: true,
                        tension: 0.4,
                        borderWidth: 3,
                        pointBackgroundColor: '#22d3ee',
                        pointBorderColor: '#fff',
                        pointBorderWidth: 2,
                        pointRadius: 6,
                        pointHoverRadius: 8
                    }]
                },
                options: {
                    maintainAspectRatio: false,
                    layout: { padding: { bottom: 10 } },
                    plugins: { legend: { display: false } },
                    scales: {
                        y: { display: false },
                        x: { grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: '#94a3b8' } }
                    }
                }
            };

            if (ctxHome) window.chartHomeHandle = new Chart(ctxHome, chartCfg);
            if (ctxAcad) window.chartAcadHandle = new Chart(ctxAcad, chartCfg);

            const semGrid = document.getElementById('semestersGrid');
            if (semGrid) {
                const semsData = data.history.sgpa && data.history.sgpa.length > 0
                    ? data.history.sgpa.map((sgpa, i) => ({
                        name: `Semester ${['I','II','III','IV','V','VI','VII','VIII'][i] || 'Sem ' + (i+1)}`,
                        cr: '--',
                        sgpa: String(sgpa),
                        sgpaColor: '#94a3b8',
                        subjects: []
                    }))
                    : [];
                let semHTML = '';
                if (semsData.length > 0) {
                    for (let sem of semsData) {
                        let subHtml = sem.subjects.length > 0
                            ? sem.subjects.map(sub => `<div style="display: flex; justify-content: space-between; padding: 10px; border-bottom: 1px solid rgba(255,255,255,0.03);"><span style="color: #60a5fa; font-size: 0.85rem; font-family: var(--font-mono); letter-spacing: 0.5px;">${sub[0]}</span><span style="color: ${sub[2]}; font-weight: bold; font-size: 0.85rem;">${sub[1]}</span></div>`).join('')
                            : '<div style="color: #64748b; padding: 15px;">Detailed subject data not available from ResultHub.</div>';
                        semHTML += `<div class="sem-card" style="background: rgba(30, 41, 59, 0.4); border: 1px solid rgba(255,255,255,0.05); border-radius: 12px; overflow: hidden; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);">
                            <div style="display: flex; justify-content: space-between; align-items: center; padding: 18px 20px; background: rgba(15, 23, 42, 0.8); border-bottom: 2px solid ${sem.sgpaColor};">
                                <h4 style="margin: 0; font-size: 1.15rem; color: #f8fafc; font-weight: 700;">${sem.name}</h4>
                                <div style="font-size: 0.85rem; font-family: var(--font-mono);"><span style="color: #64748b; margin-right: 12px;">${sem.cr} cr</span><span style="color: ${sem.sgpaColor}; font-weight: 900; font-size: 1.1rem;">${sem.sgpa}</span></div>
                            </div>
                            <div style="padding: 10px 15px;">
                                ${subHtml}
                            </div>
                        </div>`;
                    }
                } else {
                    semHTML = '<div style="color: #64748b; padding: 20px; text-align: center;">Semester-wise SGPA data not available from ResultHub.</div>';
                }
                semGrid.innerHTML = semHTML;
            }

            const compCtx = document.getElementById('comparisonChart');
            if (compCtx && window.Chart) {
                if (window.chartCompHandle) window.chartCompHandle.destroy();
                const myCgpa = parseFloat(data.history.cgpa) || 0;
                const branchAvg = 5.965;
                const topperCgpa = 9.699;

                window.chartCompHandle = new Chart(compCtx.getContext('2d'), {
                    type: 'bar',
                    data: {
                        labels: ['Your CGPA', 'Branch Average', 'Topper CGPA'],
                        datasets: [{
                            label: 'CGPA Breakdown',
                            data: [myCgpa, branchAvg, topperCgpa],
                            backgroundColor: [
                                '#a855f7',
                                'rgba(100, 116, 139, 0.5)',
                                '#10b981'
                            ],
                            borderColor: [
                                '#d8b4fe',
                                '#94a3b8',
                                '#6ee7a0'
                            ],
                            borderWidth: 1,
                            borderRadius: 6
                        }]
                    },
                    options: {
                        maintainAspectRatio: false,
                        plugins: { legend: { display: false }, tooltip: { backgroundColor: 'rgba(15, 23, 42, 0.9)', titleColor: '#fff', bodyColor: '#fff', padding: 12, cornerRadius: 8 } },
                        scales: {
                            y: { display: true, beginAtZero: true, max: 10, ticks: { color: 'rgba(255,255,255,0.7)' }, grid: { color: 'rgba(255,255,255,0.05)' } },
                            x: { grid: { display: false }, ticks: { color: 'rgba(255,255,255,0.7)', font: { size: 12 } } }
                        },
                        animation: {
                            duration: 2000,
                            easing: 'easeOutQuart'
                        }
                    }
                });
            }

        }
    } catch (e) {
        console.error("Failed to load academic history:", e);
    }
}
function setupCloudMascot() {
    const container = document.getElementById('cloudSignupContainer');
    const mascot = document.getElementById('cloudMascot');
    const emailInput = document.getElementById('cloudEmailInput');
    if (!container || !mascot || !emailInput) return;

    const eyes = mascot.querySelectorAll('.cloud-eye');
    const pupils = mascot.querySelectorAll('.cloud-pupil');
    let isTyping = false;
    let isBlinking = false;
    
    // Typing interaction
    emailInput.addEventListener('focus', () => {
        isTyping = true;
        updateEyes();
    });
    
    emailInput.addEventListener('blur', () => {
        isTyping = false;
        updateEyes();
    });
    
    // Mouse tracking for pupils
    window.addEventListener('mousemove', (e) => {
        if (isTyping || isBlinking) return;
        const offsetX = ((e.clientX / window.innerWidth) - 0.5) * 40;
        const offsetY = ((e.clientY / window.innerHeight) - 0.5) * 20;
        
        pupils.forEach(pupil => {
            pupil.style.transform = `translate(${offsetX}px, ${offsetY}px)`;
        });
    });
    
    // Blink every 3 seconds
    setInterval(() => {
        isBlinking = true;
        updateEyes();
        setTimeout(() => {
            isBlinking = false;
            updateEyes();
        }, 200);
    }, 3000);
    
    function updateEyes() {
        eyes.forEach(eye => {
            if (isTyping) {
                eye.style.height = '4px';
                eye.style.backgroundColor = 'black';
                eye.style.borderRadius = '2px';
                eye.querySelector('.cloud-pupil').style.display = 'none';
            } else if (isBlinking) {
                eye.style.height = '6px';
                eye.style.backgroundColor = 'black';
                eye.style.borderRadius = '2px';
                eye.querySelector('.cloud-pupil').style.display = 'none';
            } else {
                eye.style.height = '40px';
                eye.style.backgroundColor = 'white';
                eye.style.borderRadius = '50% / 60%';
                eye.querySelector('.cloud-pupil').style.display = 'block';
            }
        });
    }
}

function initializeApp() {
    try {
        renderHome();
        renderAttendance();
        renderLinks('resourcesList', window.data ? window.data.resources : [], 'No resource links found on IMS.');
        renderLinks('connectList', window.data ? window.data.connect : [], 'No connect links found on IMS.');
        setupNav();
        setupTheme();
        setupEtherealShadows();
        setupCloudMascot();
        loadAcademics();
    } catch (e) {
        console.error('[APP] Initialization error:', e);
    }
    setupAttendanceSync();
}

function setupAttendanceSync() {
    const attendanceSyncBtn = document.getElementById('attendanceSyncBtn');
    const syncProgressContainer = document.getElementById('syncProgressContainer');
    const syncProgressBar = document.getElementById('syncProgressBar');

    if (attendanceSyncBtn) {
        attendanceSyncBtn.addEventListener('click', async (e) => {
            attendanceSyncBtn.innerHTML = '<i class="ph ph-spinner" style="animation: spin 1s linear infinite;"></i> Syncing...';
            attendanceSyncBtn.disabled = true;

            syncProgressContainer.style.display = 'block';
            void syncProgressContainer.offsetWidth;
            syncProgressBar.style.width = '70%';

            try {
                await doBackgroundRefresh();
                syncProgressBar.style.width = '100%';
                attendanceSyncBtn.innerHTML = '<i class="ph ph-check" style="color: #10b981;"></i> Sync Complete';
                attendanceSyncBtn.style.color = '#10b981';

                setTimeout(() => {
                    syncProgressContainer.style.display = 'none';
                    syncProgressBar.style.width = '0%';
                    attendanceSyncBtn.innerHTML = '<i class="ph ph-arrows-clockwise"></i> Refresh';
                    attendanceSyncBtn.style.color = '';
                    attendanceSyncBtn.disabled = false;
                }, 5000);

            } catch (err) {
                syncProgressBar.style.width = '100%';
                syncProgressBar.style.background = '#ef4444';
                attendanceSyncBtn.innerHTML = '<i class="ph ph-warning" style="color: #ef4444;"></i> Sync Failed';
                attendanceSyncBtn.style.color = '#ef4444';

                setTimeout(() => {
                    syncProgressContainer.style.display = 'none';
                    syncProgressBar.style.width = '0%';
                    syncProgressBar.style.background = 'var(--accent)';
                    attendanceSyncBtn.innerHTML = '<i class="ph ph-arrows-clockwise"></i> Refresh';
                    attendanceSyncBtn.style.color = '';
                    attendanceSyncBtn.disabled = false;
                }, 5000);
            }
        });
    }
}

if (window.__bb_pagesLoaded) {
    initializeApp();
} else {
    document.addEventListener('pagesLoaded', initializeApp);
}

window.addEventListener('error', (e) => {
    console.error('[APP] Global error:', e.message);
});
