import { spawn } from 'child_process';
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { chmod } from 'fs/promises';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');

const GO_BIN = process.env.GO_SCRAPER_BIN || (() => {
  const exe = path.join(ROOT, 'fast_scraper_go', 'fast_scraper_go.exe');
  const bare = path.join(ROOT, 'fast_scraper_go', 'fast_scraper_go');
  const candidates = process.platform === 'win32' ? [exe, bare] : [bare, exe];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
})();

let goAvailable = GO_BIN !== null;

export function isGoScraperAvailable() {
  return goAvailable;
}

export async function runGoScraper(rollNumber, password, year, semester) {
  if (!goAvailable || !GO_BIN) {
    throw new Error('Go scraper binary not found');
  }

  const args = [rollNumber, password, '--full', '--json'];
  if (year) args.push(year);
  if (semester) args.push(semester);

  try {
    await chmod(GO_BIN, 0o755);
  } catch (e) {
    console.error('[GO-SCRAPER] chmod failed:', e.message);
  }

  return new Promise((resolve, reject) => {
    const proc = spawn(GO_BIN, args, {
      windowsHide: true,
      timeout: 45000,
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (d) => {
      stdout += d.toString();
    });

    proc.stderr.on('data', (d) => {
      stderr += d.toString();
    });

    proc.on('error', (err) => {
      reject(new Error(`Go scraper spawn failed: ${err.message}`));
    });

    proc.on('close', (code) => {
      const phases = [];
      const phaseRe = /\[PHASE\]\s*(.+?):\s*(\d+)ms/;
      for (const line of stderr.split('\n')) {
        const m = line.match(phaseRe);
        if (m) {
          phases.push({ phase: m[1].trim(), ms: parseInt(m[2], 10) });
        }
      }
      if (phases.length > 0) {
        console.log(`[GO-SCRAPER] Timings: ${phases.map(p => `${p.phase} (${p.ms}ms)`).join(', ')}`);
      }

      if (stderr.trim()) {
        console.error(`[GO-SCRAPER] stderr: ${stderr.trim()}`);
      }

      if (code !== 0 && code !== null) {
        const errMsg = stderr.trim() || `Process exited with code ${code}`;
        reject(new Error(`Go scraper failed (${code}): ${errMsg}`));
        return;
      }

      const trimmed = stdout.trim();
      if (!trimmed) {
        const errMsg = stderr.trim() || 'No stdout from Go binary';
        reject(new Error(`Go scraper returned empty output: ${errMsg}`));
        return;
      }

      try {
        const json = JSON.parse(trimmed);
        if (phases.length > 0) {
          json._timings = phases;
        }
        resolve(json);
      } catch (e) {
        reject(new Error(`Go scraper returned invalid JSON: ${e.message}`));
      }
    });
  });
}

export function normalizeGoResult(goJson, semester = '1') {
  if (!goJson || goJson.status !== 'success') {
    const msg = goJson?.status === 'login_failed'
      ? 'Invalid roll number or password.'
      : goJson?.status === 'navigation_failed'
        ? 'IMS portal navigation failed.'
        : 'Scraper encountered an unknown error.';
    throw new Error(msg);
  }

  const attendanceMap = goJson.attendance || {};
  const timeline = goJson.timeline || {};
  const subjectNames = goJson.subject_names || {};
  const courses = goJson.courses || [];
  const todayTimetable = goJson.timetable_today || [];
  const weekTimetable = goJson.timetable_week || {};

  const attendance = Object.entries(attendanceMap).map(([code, counts]) => {
    const present = counts.present || 0;
    const absent = counts.absent || 0;
    const total = counts.total || present + absent;
    const pct = total > 0 ? ((present / total) * 100).toFixed(2) + '%' : '0%';
    let statusText = 'On Track';
    let statusNumber = 0;
    if (total > 0) {
      const bunkable = Math.floor((4 / 3) * present - total);
      if (bunkable >= 0) {
        statusText = 'bunkable';
        statusNumber = bunkable;
      } else {
        statusText = 'needed';
        statusNumber = Math.ceil(3 * total - 4 * present);
      }
    }
    return {
      subject: subjectNames[code] || code,
      attended: String(present),
      absent: String(absent),
      total: String(total),
      percentage: pct,
      statusText,
      statusNumber,
    };
  });

  const detailedAttendance = buildDetailedAttendance(attendanceMap, timeline, subjectNames, courses);

  const home = {
    profile: {
      name: goJson.student_name || goJson.home?.profile?.name || 'Student',
      program: 'B.Tech',
      cgpa: '--',
      semester: semester || '--',
    },
    summary: attendance.slice(0, 4),
  };

  const subjectNameMap = new Map(Object.entries(subjectNames));

   function mapSubject(subject) {
     if (!subject) return subject;
     if (subjectNameMap.has(subject)) {
       return subjectNameMap.get(subject);
     }
     return subject;
   }

  const dayMap = {
    'monday': 'Mon', 'mon': 'Mon', 'm': 'Mon',
    'tuesday': 'Tue', 'tue': 'Tue', 'tues': 'Tue', 'tu': 'Tue',
    'wednesday': 'Wed', 'wed': 'Wed', 'w': 'Wed',
    'thursday': 'Thu', 'thur': 'Thu', 'thu': 'Thu', 'thurs': 'Thu',
    'friday': 'Fri', 'fri': 'Fri', 'f': 'Fri',
    'saturday': 'Sat', 'sat': 'Sat', 'sa': 'Sat',
    'sunday': 'Sun', 'sun': 'Sun', 'su': 'Sun',
  };

  function normalizeDay(day) {
    const lower = day.toLowerCase().replace(/\s+/g, ' ').trim();
    if (dayMap[lower]) return dayMap[lower];
    return null;
  }

  const mappedTodayTimetable = todayTimetable.map(slot => ({
    time: slot.time,
    subject: mapSubject(slot.subject),
  }));

  const mappedWeekTimetable = {};
  const dayOrder = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
  const weekLookup = {};
  for (const [day, slots] of Object.entries(weekTimetable)) {
    const normDay = normalizeDay(day);
    if (!normDay || normDay === 'Sat' || normDay === 'Sun') continue;
    weekLookup[normDay] = slots;
  }
  for (const d of dayOrder) {
    if (weekLookup[d]) {
      mappedWeekTimetable[d] = weekLookup[d].map(slot => ({
        time: slot.time,
        subject: mapSubject(slot.subject),
      }));
    } else {
      mappedWeekTimetable[d] = [];
    }
  }



  return {
    home,
    attendance,
    detailedAttendance,
    resources: [],
    connect: [],
    todayTimetable: mappedTodayTimetable,
    weekTimetable: mappedWeekTimetable,
    subjectNames: subjectNames,
    courses: courses,
    _timings: goJson._timings || [],
    _elapsed_ms: goJson.elapsed_ms || null,
  };
}

function buildDetailedAttendance(attendanceMap, timeline, subjectNames, courses) {
  const subjects = Object.keys(attendanceMap).sort();
  if (subjects.length === 0) return null;

  const allEntries = [];
  for (const [code, entries] of Object.entries(timeline)) {
    for (const entry of entries) {
      allEntries.push({ code: code.toUpperCase(), date: entry.date, mark: entry.raw || '' });
    }
  }

  const monthOrder = { 'Jan': 1, 'Feb': 2, 'Mar': 3, 'Apr': 4, 'May': 5, 'Jun': 6, 'Jul': 7, 'Aug': 8, 'Sep': 9, 'Oct': 10, 'Nov': 11, 'Dec': 12 };
  allEntries.sort((a, b) => {
    const [monthA, dayA] = a.date.split('-');
    const [monthB, dayB] = b.date.split('-');
    const monthNumA = monthOrder[monthA] || 0;
    const monthNumB = monthOrder[monthB] || 0;
    if (monthNumA !== monthNumB) return monthNumA - monthNumB;
    return parseInt(dayA) - parseInt(dayB);
  });

  const grouped = new Map();
  for (const entry of allEntries) {
    if (!grouped.has(entry.date)) grouped.set(entry.date, {});
    grouped.get(entry.date)[entry.code] = entry.mark;
  }

  const dateOrder = [...new Set(allEntries.map(e => e.date))].sort((a, b) => {
    const [monthA, dayA] = a.split('-');
    const [monthB, dayB] = b.split('-');
    const monthNumA = monthOrder[monthA] || 0;
    const monthNumB = monthOrder[monthB] || 0;
    if (monthNumA !== monthNumB) return monthNumA - monthNumB;
    return parseInt(dayA) - parseInt(dayB);
  });

  const matrix = [];
  for (const date of dateOrder) {
    const marks = {};
    for (const code of subjects) {
      marks[code] = grouped.get(date)?.[code] || '';
    }
    matrix.push({ date, marks });
  }

  const totalClasses = subjects.map((code) => attendanceMap[code]?.total || 0);
  const totalPresent = subjects.map((code) => attendanceMap[code]?.present || 0);
  const totalAbsent = subjects.map((code) => attendanceMap[code]?.absent || 0);
  const percentages = subjects.map((code, i) => {
    const t = totalClasses[i];
    return t > 0 ? ((totalPresent[i] / t) * 100).toFixed(2) + '%' : '0%';
  });

  const legend = {};
  for (const code of subjects) {
    if (subjectNames[code]) {
      legend[code] = subjectNames[code];
    } else if (courses) {
      const course = courses.find(c => c.code === code);
      if (course && course.name) {
        legend[code] = course.name;
      }
    }
  }

  return {
    matrix,
    subjects,
    summary: { totalClasses, totalAbsent, totalPresent, percentages },
    legend,
  };
}

export function normalizeNodeResult(nodeJson) {
  const data = nodeJson?.data || {};
  const attendanceMap = {};
  (data.attendance || []).forEach(a => {
    attendanceMap[a.code || a.subject] = {
      total: parseInt(a.total) || 0,
      present: parseInt(a.attended) || 0,
      absent: parseInt(a.absent) || ((parseInt(a.total) || 0) - (parseInt(a.attended) || 0)),
    };
  });

  const subjectNames = {};
  (data.courses || []).forEach(c => {
    if (c.code && c.name) subjectNames[c.code] = c.name;
  });

  const attendance = (data.attendance || []).map(a => {
    const present = parseInt(a.attended) || 0;
    const total = parseInt(a.total) || 0;
    const absent = parseInt(a.absent) || (total - present);
    const pct = total > 0 ? ((present / total) * 100).toFixed(2) + '%' : '0%';
    let statusText = 'On Track';
    let statusNumber = 0;
    if (total > 0) {
      const bunkable = Math.floor((4 / 3) * present - total);
      if (bunkable >= 0) {
        statusText = 'bunkable';
        statusNumber = bunkable;
      } else {
        statusText = 'needed';
        statusNumber = Math.ceil(3 * total - 4 * present);
      }
    }
    return {
      subject: subjectNames[a.code || a.subject] || a.subject,
      attended: String(present),
      absent: String(absent),
      total: String(total),
      percentage: pct,
      statusText,
      statusNumber,
    };
  });

  const home = data.home || {
    profile: { name: 'Student', program: 'B.Tech', cgpa: '--', semester: '1' },
    summary: attendance.slice(0, 4),
  };

  const subjectNameMap = new Map(Object.entries(subjectNames));
  const mapSubject = (s) => !s ? s : (subjectNameMap.has(s) ? subjectNameMap.get(s) : s);

  const mappedToday = (data.timetable_today || []).map(slot => ({
    time: slot.time,
    subject: mapSubject(slot.subject),
  }));

  const mappedWeek = {};
  const dayOrder = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
  const dayMap = {
    'monday': 'Mon', 'mon': 'Mon', 'm': 'Mon',
    'tuesday': 'Tue', 'tue': 'Tue', 'tues': 'Tue', 'tu': 'Tue',
    'wednesday': 'Wed', 'wed': 'Wed', 'w': 'Wed',
    'thursday': 'Thu', 'thur': 'Thu', 'thu': 'Thu', 'thurs': 'Thu',
    'friday': 'Fri', 'fri': 'Fri', 'f': 'Fri',
    'saturday': 'Sat', 'sat': 'Sat', 'sa': 'Sat',
    'sunday': 'Sun', 'sun': 'Sun', 'su': 'Sun',
  };
  function normalizeDay(day) {
    const lower = day.toLowerCase().replace(/\s+/g, ' ').trim();
    return dayMap[lower] || null;
  }
  const weekLookup = {};
  for (const [day, slots] of Object.entries(data.timetable_week || {})) {
    const normDay = normalizeDay(day);
    if (!normDay || normDay === 'Sat' || normDay === 'Sun') continue;
    weekLookup[normDay] = slots;
  }
  for (const d of dayOrder) {
    if (weekLookup[d]) {
      mappedWeek[d] = weekLookup[d].map(slot => ({
        time: slot.time,
        subject: mapSubject(slot.subject),
      }));
    } else {
      mappedWeek[d] = [];
    }
  }

  return {
    home,
    attendance,
    detailedAttendance: data.detailedAttendance || null,
    resources: data.resources || [],
    connect: data.connect || [],
    todayTimetable: mappedToday,
    weekTimetable: mappedWeek,
    subjectNames,
    courses: data.courses || [],
    _timings: nodeJson?._timings || [],
    _elapsed_ms: nodeJson?.elapsed_ms || nodeJson?.elapsedMs || null,
  };
}
