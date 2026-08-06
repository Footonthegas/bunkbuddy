import axios from 'axios';
import * as cheerio from 'cheerio';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');

const IMS_BASE = 'https://www.imsnsit.org/imsnsit/';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const client = axios.create({
  baseURL: IMS_BASE,
  withCredentials: true,
  maxRedirects: 5,
  timeout: 30000,
  headers: {
    'User-Agent': USER_AGENT,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'sec-ch-ua': '"Chromium";v="146", "Not-A.Brand";v="24", "Google Chrome";v="146"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
  },
  validateStatus: (s) => s < 500,
});

function classifyTimelineStatus(raw) {
  const lower = String(raw).trim().toLowerCase();
  if (['p', 'present', '1'].includes(lower)) return 'present';
  if (['a', 'absent', '0'].includes(lower)) return 'absent';
  if (['h', 'half', '0.5'].includes(lower)) return 'half';
  return '';
}

function extractTimeline(html) {
  const $ = cheerio.load(html);
  const timeline = {};
  const subjectNames = {};
  const courses = [];

  $('table').each((_, table) => {
    const rows = $(table).find('tr');
    if (rows.length < 2) return;

    let headerTexts = [];
    let headerRowIdx = -1;
    for (let ri = 0; ri < rows.length && ri < 5; ri++) {
      const cells = rows.eq(ri).find('th, td');
      const texts = [];
      cells.each((_, cell) => {
        texts.push($(cell).text().trim().toLowerCase());
      });
      const firstHeader = texts[0] || '';
      if (firstHeader === 'days' || firstHeader === 'day' || firstHeader === 'date') {
        headerRowIdx = ri;
        headerTexts = texts;
        break;
      }
    }

    if (headerRowIdx < 0) return;

    const subjectCodes = [];
    const codeColIndices = [];
    for (let j = 1; j < headerTexts.length; j++) {
      const h = headerTexts[j];
      const codeMatch = h.match(/^[a-z]{2,}\d{3,}/i);
      if (codeMatch) {
        subjectCodes.push(codeMatch[0].toUpperCase());
        codeColIndices.push(j);
      }
    }

    if (subjectCodes.length < 2) return;

    for (const c of subjectCodes) {
      if (!timeline[c]) timeline[c] = [];
    }

    for (let dataRow = headerRowIdx + 1; dataRow < rows.length; dataRow++) {
      const dcells = rows.eq(dataRow).find('th, td');
      const dtexts = [];
      dcells.each((_, cell) => {
        dtexts.push($(cell).text().trim());
      });

      if (dtexts.length === 0) continue;

      const firstText = dtexts[0];
      const firstLower = firstText.toLowerCase();
      if (firstLower === 'overall' || firstLower.includes('total') || firstLower === 'legend' || firstLower === 'note' || firstText.includes('->')) {
        continue;
      }

      const dateLabel = firstText;
      if (!dateLabel) continue;

      let rowHasMark = false;
      for (const colIdx of codeColIndices) {
        if (colIdx >= dtexts.length) continue;
        if (dtexts[colIdx]) rowHasMark = true;
      }
      if (!rowHasMark) continue;

      for (let idx = 0; idx < subjectCodes.length; idx++) {
        const colIdx = codeColIndices[idx];
        if (colIdx >= dtexts.length) continue;
        const raw = dtexts[colIdx];
        if (!raw) continue;
        const status = classifyTimelineStatus(raw);
        timeline[subjectCodes[idx]].push({
          date: dateLabel,
          status,
          raw,
        });
      }
    }
  });

  $('table').each((_, table) => {
    const rows = $(table).find('tr');
    rows.each((_, row) => {
      const cells = $(row).find('td');
      if (cells.length >= 2) {
        const code = $(cells[0]).text().trim().toUpperCase();
        const name = $(cells[1]).text().trim();
        if (code && name && /^[A-Z]{2,}\d{3,}/.test(code)) {
          subjectNames[code] = name;
        }
      }
    });
  });

  return { timeline, subjectNames, courses };
}

function extractAttendance(html) {
  const $ = cheerio.load(html);
  const attendanceMap = {};

  $('table').each((_, table) => {
    const rows = $(table).find('tr');
    rows.each((_, row) => {
      const cells = $(row).find('td');
      if (cells.length >= 4) {
        const code = $(cells[0]).text().trim().toUpperCase();
        const name = $(cells[1]).text().trim();
        const total = parseInt($(cells[2]).text().trim()) || 0;
        const present = parseInt($(cells[3]).text().trim()) || 0;
        const absent = parseInt($(cells[4]).text().trim()) || 0;
        if (code && /^[A-Z]{2,}\d{3,}/.test(code)) {
          attendanceMap[code] = { name, total, present, absent };
        }
      }
    });
  });

  return attendanceMap;
}

function extractProfile(html) {
  const $ = cheerio.load(html);
  const profile = {};
  $('table').first().find('tr').each((_, row) => {
    const cells = $(row).find('td, th');
    if (cells.length >= 2) {
      const key = $(cells[0]).text().trim().replace(/[^a-zA-Z0-9]/g, '');
      const value = $(cells[1]).text().trim();
      profile[key] = value;
    }
  });
  return profile;
}

async function solveCaptcha(captchaBytes) {
  const scriptPath = path.join(ROOT, 'fast_scraper_go', 'solve_captcha_cli.py');
  if (!fs.existsSync(scriptPath)) return '';

  const pythonCmd = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  
  return new Promise((resolve) => {
    const proc = spawn(pythonCmd, [scriptPath], { windowsHide: true });
    let stdout = '';
    let stderr = '';

    proc.stdin.write(captchaBytes);
    proc.stdin.end();

    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    const timeout = setTimeout(() => {
      proc.kill();
      resolve('');
    }, 10000);

    proc.on('close', (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        console.error('[CAPTCHA] Python script failed:', stderr.trim());
        resolve('');
      }
    });

    proc.on('error', () => {
      clearTimeout(timeout);
      resolve('');
    });
  });
}

function getInputValue($, selector) {
  const el = $(selector);
  return el.attr('value') || el.val() || '';
}

function getLinkHref($, linkText) {
  const lowerLinkText = linkText.toLowerCase();
  let foundHref = '';
  $('a').each((_, el) => {
    const text = $(el).text().trim().toLowerCase();
    if (text === lowerLinkText || text.includes(lowerLinkText)) {
      foundHref = $(el).attr('href') || '';
      return false;
    }
  });
  return foundHref;
}

function extractWithFallback(html, patterns) {
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) return match[1];
  }
  return '';
}

async function loginToIms(rollNumber, password) {
  const session = await client.get('/student_login.php');
  const html = session.data;

  console.error('[LOGIN] Response status:', session.status);
  console.error('[LOGIN] HTML length:', html.length);
  console.error('[LOGIN] HTML preview:', html.substring(0, 500));

  let fy = '', comp = '', hrand = '', captchaImg = '';

  const fyRe = /name\s*=\s*['"]?fy['"]?\s+id\s*=\s*['"]?fy['"]?\s+value\s*=\s*['"]([^'"]+)['"]/i;
  const compRe = /name\s*=\s*['"]?comp['"]?\s+id\s*=\s*['"]?comp['"]?\s+type\s*=\s*['"]hidden['"]\s+readonly\s+value\s*=\s*['"]([^'"]+)['"]/i;
  const hrandRe = /name\s*=\s*['"]?HRAND_NUM['"]?\s+id\s*=\s*['"]?HRAND_NUM['"]?\s+value\s*=\s*['"]([^'"]+)['"]/i;
  const capsrcRe = /<img[^>]+src\s*=\s*['"]([^'"]*captcha[^'"]*)['"][^>]*id\s*=\s*['"]?captchaimg['"]?/i;

  const fyMatch = html.match(fyRe);
  const compMatch = html.match(compRe);
  const hrandMatch = html.match(hrandRe);
  const capsrcMatch = html.match(capsrcRe);

  console.error('[LOGIN] Regex matches:', {
    fy: !!fyMatch,
    comp: !!compMatch,
    hrand: !!hrandMatch,
    captcha: !!capsrcMatch
  });

  if (!fyMatch && !compMatch && !hrandMatch) {
    console.error('[LOGIN] HTML snippet (first 2000 chars):', html.substring(0, 2000));
    throw new Error('Login form not found: missing fy/comp/HRAND_NUM');
  }

  fy = fyMatch ? fyMatch[1] : fy;
  comp = compMatch ? compMatch[1] : comp;
  hrand = hrandMatch ? hrandMatch[1] : hrand;
  captchaImg = capsrcMatch ? capsrcMatch[1] : captchaImg;

  if (!fy || !comp || !hrand || !captchaImg) {
    console.error('[LOGIN] Missing fields:', { fy: !!fy, comp: !!comp, hrand: !!hrand, captchaImg: !!captchaImg });
    console.error('[LOGIN] HTML length:', html.length);
    throw new Error('Login form not found: required fields missing after regex');
  }

  const captchaUrl = captchaImg.startsWith('http') ? captchaImg : IMS_BASE + captchaImg;
  const captchaResp = await client.get(captchaUrl, { responseType: 'arraybuffer' });
  const captchaText = await solveCaptcha(captchaResp.data);

  if (!captchaText) {
    throw new Error('CAPTCHA solving failed');
  }

  const formData = new URLSearchParams();
  formData.append('f', '');
  formData.append('uid', rollNumber);
  formData.append('pwd', password);
  formData.append('HRAND_NUM', hrand);
  formData.append('fy', fy);
  formData.append('comp', comp);
  formData.append('cap', captchaText);
  formData.append('logintype', 'student');

  const loginResp = await client.post('/student_login.php', formData.toString(), {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Referer': IMS_BASE + 'student_login.php',
      'Origin': 'https://www.imsnsit.org',
      'Upgrade-Insecure-Requests': '1',
    },
    maxRedirects: 0,
    validateStatus: (s) => s === 302 || s === 200,
  });

  const loginHtml = (loginResp.data || '').toString();
  const loginLower = loginHtml.toLowerCase();
  if (loginResp.status === 302 || (loginLower.includes('logout') && loginLower.includes('my activities'))) {
    return { success: true };
  }

  throw new Error('Login failed: Invalid roll number or password');
}

async function navigateToAttendance(year, semester) {
  const bannerResp = await client.get('/student_login.php', {
    headers: { 'Referer': IMS_BASE + 'student_login.php' }
  });
  const bannerHtml = bannerResp.data;

  let myActivitiesHref = '';
  const $banner = cheerio.load(bannerHtml);
  myActivitiesHref = getLinkHref($banner, 'My Activities');

  if (!myActivitiesHref) {
    const myActivitiesRe = /href=['"](https:\/\/www\.imsnsit\.org\/imsnsit\/plum_url\.php\?[^'"]+)['"][^>]*>\s*My Activities\s*</i;
    const match = bannerHtml.match(myActivitiesRe);
    if (match) myActivitiesHref = match[1];
  }

  if (!myActivitiesHref) {
    console.error('[NAV] My Activities not found. HTML snippet:', bannerHtml.substring(0, 1000));
    throw new Error('My Activities link not found');
  }

  const myActivitiesResp = await client.get(myActivitiesHref, {
    headers: { 'Referer': IMS_BASE + 'student_login.php' }
  });
  const menuHtml = myActivitiesResp.data;

  let attendanceHref = '';
  const $menu = cheerio.load(menuHtml);
  attendanceHref = getLinkHref($menu, 'My Attendance');

  if (!attendanceHref) {
    const attendanceRe = /href=['"](https:\/\/www\.imsnsit\.org\/imsnsit\/plum_url\.php\?[^'"]+)['"][^>]*>\s*My Attendance\s*</i;
    const match = menuHtml.match(attendanceRe);
    if (match) attendanceHref = match[1];
  }

  if (!attendanceHref) {
    console.error('[NAV] My Attendance not found. HTML snippet:', menuHtml.substring(0, 1000));
    throw new Error('My Attendance link not found');
  }

  const attendanceResp = await client.get(attendanceHref, {
    headers: { 'Referer': myActivitiesHref }
  });
  const attendanceHtml = attendanceResp.data;
  const $att = cheerio.load(attendanceHtml);

  let encYear = getInputValue($att, "input[name='enc_year']");
  let encSem = getInputValue($att, "input[name='enc_sem']");
  let recentity = getInputValue($att, "input[name='recentitycode']");
  let dept = getInputValue($att, "input[name='dept']");
  let degree = getInputValue($att, "input[name='degree']");

  if (!encYear || !encSem || !recentity || !dept || !degree) {
    const patterns = {
      encYear: /name=['"]?enc_year['"]?\s+(?:id=['"]?enc_year['"]?\s+)?value=['"]([^'"]+)['"]/i,
      encSem: /name=['"]?enc_sem['"]?\s+(?:id=['"]?enc_sem['"]?\s+)?value=['"]([^'"]+)['"]/i,
      recentity: /name=['"]?recentitycode['"]?\s+(?:id=['"]?recentitycode['"]?\s+)?value=['"]([^'"]+)['"]/i,
      dept: /name=['"]?dept['"]?\s+(?:id=['"]?dept['"]?\s+)?value=['"]([^'"]+)['"]/i,
      degree: /name=['"]?degree['"]?\s+(?:id=['"]?degree['"]?\s+)?value=['"]([^'"]+)['"]/i,
    };

    const encYearMatch = attendanceHtml.match(patterns.encYear);
    const encSemMatch = attendanceHtml.match(patterns.encSem);
    const recentityMatch = attendanceHtml.match(patterns.recentity);
    const deptMatch = attendanceHtml.match(patterns.dept);
    const degreeMatch = attendanceHtml.match(patterns.degree);

    if (!encYearMatch && !encSemMatch && !recentityMatch) {
      console.error('[NAV] Attendance form fields not found. HTML snippet:', attendanceHtml.substring(0, 2000));
      throw new Error('Attendance form fields not found');
    }

    encYear = encYearMatch ? encYearMatch[1] : encYear;
    encSem = encSemMatch ? encSemMatch[1] : encSem;
    recentity = recentityMatch ? recentityMatch[1] : recentity;
    dept = deptMatch ? deptMatch[1] : dept;
    degree = degreeMatch ? degreeMatch[1] : degree;
  }

  if (!encYear || !encSem || !recentity || !dept || !degree) {
    console.error('[NAV] Missing fields after fallback:', { encYear: !!encYear, encSem: !!encSem, recentity: !!recentity, dept: !!dept, degree: !!degree });
    throw new Error('Attendance form fields not found: required fields missing after fallback');
  }

  const resolvedYear = year || extractWithFallback(attendanceHtml, [
    /name=['"]?year['"]?\s+(?:id=['"]?year['"]?\s+)?value=['"]([^'"]+)['"]/i,
    /<select[^>]*name=['"]year['"][^>]*>.*?value=['"]([^'"]+)['"]/i
  ]) || '';
  const resolvedSemester = semester || extractWithFallback(attendanceHtml, [
    /name=['"]?sem['"]?\s+(?:id=['"]?sem['"]?\s+)?value=['"]([^'"]+)['"]/i,
    /<select[^>]*name=['"]sem['"][^>]*>.*?value=['"]([^'"]+)['"]/i
  ]) || '';

  const formData = new URLSearchParams();
  formData.append('year', resolvedYear);
  formData.append('enc_year', encYear);
  formData.append('sem', resolvedSemester);
  formData.append('enc_sem', encSem);
  formData.append('submit', 'Submit');
  formData.append('recentitycode', recentity);
  formData.append('dept', dept);
  formData.append('degree', degree);
  formData.append('ename', '');
  formData.append('ecode', '');

  const resultResp = await client.post(attendanceHref, formData.toString(), {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Referer': attendanceHref,
      'Origin': 'https://www.imsnsit.org',
      'Upgrade-Insecure-Requests': '1',
    }
  });

  return resultResp.data;
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

async function scrapeStudentData(year, semester) {
  const attendanceHtml = await navigateToAttendance(year, semester);

  const { timeline, subjectNames, courses } = extractTimeline(attendanceHtml);
  const attendanceMap = extractAttendance(attendanceHtml);
  const profile = extractProfile(attendanceHtml);

  return {
    home: { profile, attendance: Object.values(attendanceMap) },
    attendance: Object.entries(attendanceMap).map(([code, data]) => ({
      code,
      name: data.name,
      total: data.total,
      present: data.present,
      absent: data.absent,
      percentage: data.total > 0 ? ((data.present / data.total) * 100).toFixed(2) + '%' : '0%',
    })),
    detailedAttendance: buildDetailedAttendance(attendanceMap, timeline, subjectNames, courses),
    courses,
    timetable_today: [],
    timetable_week: {},
  };
}

export async function scrapeWithNode(rollNumber, password, year, semester) {
  try {
    await loginToIms(rollNumber, password);
    const data = await scrapeStudentData(year, semester);
    return { status: 'success', data };
  } catch (err) {
    return { status: 'error', error: err.message };
  }
}
