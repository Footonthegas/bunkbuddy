import * as cheerio from 'cheerio';
import { absUrl, fetchPage, postPage } from './client.js';

const BASE = 'https://www.imsnsit.org/imsnsit';

function textOf($, el) {
  return $(el).text().replace(/\s+/g, ' ').trim();
}

function parseTables(html) {
  const $ = cheerio.load(html);
  const tables = [];

  $('table').each((_, table) => {
    const rows = [];
    $(table).find('tr').each((__, tr) => {
      const cells = [];
      $(tr).find('th, td').each((___, cell) => {
        cells.push(textOf($, cell));
      });
      if (cells.some(Boolean)) rows.push(cells);
    });
    if (rows.length) tables.push(rows);
  });

  return tables;
}

function parseLinks(html, baseUrl) {
  const $ = cheerio.load(html);
  const links = [];

  $('a[href]').each((_, a) => {
    const href = $(a).attr('href');
    const label = textOf($, a);
    if (!label || !href || href === '#' || href.startsWith('javascript:')) return;
    links.push({ label, href: absUrl(BASE, href), source: baseUrl });
  });

  return links;
}

function extractProfile(html) {
  const $ = cheerio.load(html);
  const profile = {};

  $('table tr').each((_, tr) => {
    const cells = $(tr).find('td, th').toArray().map((c) => textOf($, c));
    if (cells.length >= 2) {
      profile[cells[0]] = cells[1];
    }
  });

  const name = $('td.plum-label, .plum-label, b, strong').first().text().trim();
  if (name && !profile.Name) profile.Name = name;

  return profile;
}

export function parseDetailedAttendance(html) {
  const $ = cheerio.load(html);
  const data = {
    matrix: [],
    subjects: [],
    summary: {},
    legend: {}
  };

  const tables = $('table.plum_fieldbig').toArray();
  if (tables.length === 0) return null;

  tables.forEach(table => {
    $(table).find('tr').each((_, tr) => {
      const cells = $(tr).find('td, th').toArray().map(c => $(c).text().replace(/\s+/g, ' ').trim());
      
      if (cells[0] === 'Days') {
         if (data.subjects.length === 0) data.subjects = cells.slice(1).filter(s => s && s.trim() !== '');
      }
      else if (/^[A-Za-z]{3}-\d{2}$/.test(cells[0])) {
         const rowData = { date: cells[0], marks: {} };
         let hasMark = false;
         cells.slice(1).forEach((mark, idx) => {
            if (data.subjects[idx]) {
               rowData.marks[data.subjects[idx]] = mark;
               if (mark !== '') hasMark = true;
            }
         });
         if (hasMark) data.matrix.push(rowData);
      }
      else if (cells[0] === 'Overall Class') {
         data.summary.totalClasses = cells.slice(1);
      }
      else if (cells[0] === 'Overall Absent') {
         data.summary.totalAbsent = cells.slice(1);
      }
      else if (cells[0] === 'Overall Present') {
         data.summary.totalPresent = cells.slice(1);
      }
      else if (cells[0] === 'Overall (%)') {
         data.summary.percentages = cells.slice(1);
      }
    });

    $(table).find('td, th').each((_, el) => {
        const htmlContent = $(el).html() || '';
        if (htmlContent.includes('<br>')) {
           const lines = htmlContent.split('<br>');
           lines.forEach(line => {
              const text = cheerio.load(line).text().trim();
              if (text && text.includes('-') && !text.includes('---') && !text.includes('>')) {
                 const [code, ...rest] = text.split('-');
                 const name = rest.join('-').trim();
                 if (code && name && code.length < 15) {
                    data.legend[code.trim()] = name;
                 }
              }
           });
        }
    });
  });

  return data.subjects.length > 0 ? data : null;
}

function parseAttendanceTables(tables) {
  const subjects = [];

  for (const table of tables) {
    const header = table[0]?.join(' ').toLowerCase() || '';
    if (!header.includes('subject') && !header.includes('attendance') && !header.includes('percent')) {
      continue;
    }

    for (let i = 1; i < table.length; i += 1) {
      const row = table[i];
      if (row.length < 2) continue;
      subjects.push({
        subject: row[0] || 'Unknown',
        attended: row[1] || '—',
        total: row[2] || '—',
        percentage: row[row.length - 1] || '—',
      });
    }
  }

  return subjects;
}

function categorizeLinks(links) {
  const resources = [];
  const connect = [];
  const attendanceLinks = [];

  for (const link of links) {
    const label = link.label.toLowerCase();
    const href = link.href.toLowerCase();

    if (/attendance|absent|present|lecture|class/i.test(label + href)) {
      attendanceLinks.push(link);
    } else if (/notice|circular|resource|material|e-?learn|download|syllabus|timetable|schedule/i.test(label + href)) {
      resources.push(link);
    } else if (/faculty|teacher|connect|contact|mail|message|forum|chat/i.test(label + href)) {
      connect.push(link);
    } else if (/profile|home|dashboard|menu/i.test(label + href)) {
      continue;
    } else if (/\.pdf|\.doc|material|notes/i.test(href)) {
      resources.push(link);
    }
  }

  return { resources, connect, attendanceLinks };
}

function buildAttendanceArray(detailedAttendance) {
    const attendance = [];
    if (!detailedAttendance) return attendance;
    attendance.push(...detailedAttendance.subjects.map((sub, i) => {
        const attendedStr = detailedAttendance.summary.totalPresent?.[i] || '0';
        const totalStr = detailedAttendance.summary.totalClasses?.[i] || '0';
        const absentStr = detailedAttendance.summary.totalAbsent?.[i] || '0';
        const percentageStr = detailedAttendance.summary.percentages?.[i] || '0%';
        const A = parseInt(attendedStr, 10);
        const T = parseInt(totalStr, 10);
        let statusText = "On Track";
        let statusNumber = 0;
        if (T > 0) {
            const bunkable = Math.floor((4/3) * A - T);
            if (bunkable >= 0) {
                statusText = "bunkable";
                statusNumber = bunkable;
            } else {
                statusText = "needed";
                statusNumber = Math.ceil(3 * T - 4 * A);
            }
        }
        return {
            subject: detailedAttendance.legend[sub] ? `${detailedAttendance.legend[sub]} (${sub})` : sub,
            attended: attendedStr,
            absent: absentStr,
            total: totalStr,
            percentage: percentageStr,
            statusText,
            statusNumber
        };
    }));
    return attendance;
}

export async function scrapeStudentData(page, browser, targetYear, targetSem, rollNumber = '') {
  let attendance = [];
  let detailedAttendance = null;
  let studentName = "Student";
  let resultHubPromise = fetchResultHubData(browser, rollNumber);

  try {
    const delay = ms => new Promise(r => setTimeout(r, ms));
    
    console.log("[SCRAPER] Searching for Student Name...");
    for(const frame of page.frames()) {
        try {
            const txt = await frame.evaluate(() => document.body.innerText);
            if(txt && txt.includes('Welcome')) {
                const match = txt.match(/Welcome\s*:\s*([A-Za-z\s\.]+)/i);
                if(match && match[1].trim() && !match[1].includes('NSUT')) {
                    studentName = match[1].trim();
                    break;
                }
            }
        } catch(e) {}
    }

    console.log(`[SCRAPER] Extracted Name: ${studentName}. Locating Attendance Form...`);
    
    // Check if form is already present
    let formFrame = null;
    for (const frame of page.frames()) {
       try {
           const hasForm = await frame.evaluate(() => !!document.forms['frm'] && !!document.querySelector('select[name="year"]'));
           if (hasForm) { formFrame = frame; break; }
       } catch(e) {}
    }

    // Step B: Fast click "My Activities" link in menu/head frame if form not present
    if (!formFrame) {
        for (let attempts = 0; attempts < 40; attempts++) {
           for (const frame of page.frames()) {
              try {
                  const clicked = await frame.evaluate(() => {
                     const links = Array.from(document.querySelectorAll('a'));
                     const act = links.find(el => el.textContent.toLowerCase().includes('my activities') || (el.textContent.toLowerCase().includes('activities') && !el.textContent.toLowerCase().includes('student')));
                     if (act) { act.click(); return true; }
                     return false;
                  });
                  if (clicked) break;
               } catch(e) {}
           }
           await delay(15);
        }

        // Step C: Fast click "My Attendance" link in main frame
        for (let attempts = 0; attempts < 40; attempts++) {
           for (const frame of page.frames()) {
              try {
                  const clicked = await frame.evaluate(() => {
                     const links = Array.from(document.querySelectorAll('a'));
                     const att = links.find(el => el.textContent.trim().toLowerCase() === 'my attendance');
                     if (att) { att.click(); return true; }
                     return false;
                  });
                  if (clicked) break;
               } catch(e) {}
           }
           await delay(15);
        }

        // Step D: Locate form frame
        for (let attempts = 0; attempts < 50; attempts++) {
          for (const frame of page.frames()) {
            try {
                const has = await frame.evaluate(() => !!document.forms['frm'] && !!document.querySelector('select[name="year"]'));
                if (has) { formFrame = frame; break; }
            } catch(e) {}
          }
          if (formFrame) break;
          await delay(15);
        }
    }
            if (formFrame) {
               console.log("[SCRAPER] Form Frame Selected, evaluating dropdowns...");
               
               let htmlSubmitted = false;
               try {
                    htmlSubmitted = await formFrame.evaluate((y, s) => {
                        let f = document.forms['frm'];
                        if (!f) return false;
                        
                        let yearSel = document.querySelector('select[name="year"]');
                        if (yearSel) {
                            yearSel.value = y;
                            yearSel.dispatchEvent(new Event('change', { bubbles: true }));
                            yearSel.dispatchEvent(new Event('input', { bubbles: true }));
                            yearSel.dispatchEvent(new Event('blur', { bubbles: true }));
                        }
                        
                        let semSel = document.querySelector('select[name="sem"]');
                        if (semSel) {
                            semSel.value = s;
                            semSel.dispatchEvent(new Event('change', { bubbles: true }));
                            semSel.dispatchEvent(new Event('input', { bubbles: true }));
                            semSel.dispatchEvent(new Event('blur', { bubbles: true }));
                        }
                        
                        setTimeout(() => {
                            let encYear = document.querySelector('input[name="enc_year"]')?.value;
                            let encSem = document.querySelector('input[name="enc_sem"]')?.value;
                            if (encYear && encSem) {
                                let myForm = document.createElement('form');
                                myForm.method = 'POST';
                                myForm.action = f.action || window.location.href;
                                myForm.target = f.target || '_self';
                                let params = { year: y, sem: s, enc_year: encYear, enc_sem: encSem, submit: 'Submit' };
                                for (let k in params) {
                                    let inp = document.createElement('input');
                                    inp.type = 'hidden'; inp.name = k; inp.value = params[k];
                                    myForm.appendChild(inp);
                                }
                                document.body.appendChild(myForm);
                                setTimeout(() => {
                                    try {
                                        HTMLFormElement.prototype.submit.call(myForm);
                                    } catch(e) {}
                                }, 10);
                            }
                        }, 150);
                        return true;
                    }, targetYear || '2026-27', targetSem || '1');
               } catch(evalErr) {
                   console.warn("[SCRAPER] Form evaluate notice:", evalErr.message);
               }
               
               if (htmlSubmitted) {
                   console.log("[SCRAPER] Form submitted. Polling frames for attendance table...");
                   let finalHtml = '';
                   for (let attempts = 0; attempts < 150; attempts++) {
                       await delay(20);
                       for (const frame of page.frames()) {
                           try {
                               const content = await frame.content();
                               if (content && (content.includes('Student Subject Wise Attendance') || content.includes('Overall Class'))) {
                                   finalHtml = content;
                                   break;
                               }
                           } catch(e) {}
                       }
                       if (finalHtml) break;
                   }

                    if (finalHtml) {
                        console.log("[SCRAPER] Attendance table HTML captured. Parsing...");
                        detailedAttendance = parseDetailedAttendance(finalHtml);
                       attendance = buildAttendanceArray(detailedAttendance);
                       console.log(`[SCRAPER] ✅ Successfully parsed ${attendance.length} subjects!`);
                   } else {
                       console.error("[SCRAPER] Attendance table HTML not found after polling.");
                   }
               }
           }
  } catch (e) {
    console.error("Failed to parse attendance via Puppeteer:", e.message);
  }

  const rhData = await resultHubPromise;

  const profile = { name: rhData.name || studentName, program: "B.Tech", cgpa: rhData.cgpa, semester: rhData.semester };
  const dedupedAttendance = Array.from(new Map(attendance.map((a) => [a.subject, a])).values());

  return {
    home: {
      profile: profile,
      summary: dedupedAttendance.slice(0, 4),
    },
    attendance: dedupedAttendance,
    detailedAttendance: detailedAttendance,
    resources: [],
    connect: [],
  };
}

export async function parseAttendanceFromHtml(html) {
    const detailedAttendance = parseDetailedAttendance(html);
    const attendance = buildAttendanceArray(detailedAttendance);
    console.log(`[FAST-REFRESH] ✅ Parsed ${attendance.length} subjects from cached HTML`);
    return { attendance, detailedAttendance };
}

async function fetchResultHubData(browser, username, college = 'NSUT') {
    const fallback = { cgpa: "N/A", semester: "N/A", name: undefined };
    if (!username) return fallback;

    try {
        const detailed = await fetchStudentDetailedProfile(username, null, browser, college);
        if (detailed && detailed.success && detailed.history) {
            return {
                name: detailed.history.name,
                cgpa: detailed.history.cgpa || "N/A",
                semester: detailed.history.sgpa && detailed.history.sgpa.length > 0
                    ? String(detailed.history.sgpa[detailed.history.sgpa.length - 1])
                    : "N/A",
                universityRank: detailed.history.universityRank || "--",
                deptRank: detailed.history.deptRank || "--",
                history: detailed.history,
            };
        }
    } catch (e) {
        console.error("ResultHub profile fallback failed:", e.message);
    }
    return fallback;
}

export async function fetchResultHubBatch(year, branch) {
    let students = [];
    try {
        const resultUrl = `https://www.resulthubdtu.com/NSUT/Results/${year}`;
        const res = await globalThis.fetch(resultUrl, { 
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
            signal: AbortSignal.timeout(8000)
        });
        if (res.ok) {
            const html = await res.text();
            const $ = cheerio.load(html);
            $('table tbody tr').each((_, row) => {
                const cells = $(row).find('td').toArray();
                if (cells.length > 5) {
                    const rank = $(cells[0]).text().trim();
                    const name = $(cells[1]).text().trim();
                    const roll = $(cells[2]).text().trim();
                    const b = $(cells[3]).text().trim();
                    const cgpa = $(cells[cells.length - 1]).text().trim();
                    if (branch === 'all' || b === branch) {
                        students.push({ rank, name, roll, branch: b, cgpa });
                    }
                }
            });
        }
    } catch (e) {
        console.error("ResultHub batch fetch error:", e.message);
    }
    return students;
}

const RESULT_HUB_ACTION_ID = '706fa587127629876c510afaca5e6d3f567d3eae64';
const RESULT_HUB_BUILD_ID = 'SbKHOquKG0d3jAbym6qAP';
const RESULT_HUB_BASE = 'https://www.resulthubdtu.com';

const SEMESTER_ORDER = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII'];
const SEMESTER_SHORT = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8'];

function normalizeBranchForDisplay(branch) {
    if (!branch) return 'B.Tech';
    if (/Mechanical/.test(branch)) return 'Mechanical Engineering';
    if (/Computer Science|COE|CSE|CSA|AI|ML|Data Science|Software/i.test(branch)) return 'Computer Science';
    if (/Electronics|ECE|EEE|E CE/i.test(branch)) return 'Electronics & Comm.';
    if (/Civil/i.test(branch)) return 'Civil Engineering';
    if (/IT|Information Technology/i.test(branch)) return 'Information Technology';
    return branch;
}

async function invokeResultHubServerAction(college, year, rollNumber) {
    const pageUrl = `${RESULT_HUB_BASE}/${college}/StudentProfile/${year}/${rollNumber}`;
    const stateTree = JSON.stringify({ P: null, b: RESULT_HUB_BUILD_ID, p: '', c: ['', college, 'StudentProfile', String(year), rollNumber], i: false });
    const body = JSON.stringify([college, String(year), rollNumber]);

    const res = await globalThis.fetch(pageUrl, {
        method: 'POST',
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/x-component',
            'Content-Type': 'text/plain',
            'Next-Action': RESULT_HUB_ACTION_ID,
            'Next-Router-State-Tree': stateTree,
        },
        body: body,
        signal: AbortSignal.timeout(15000)
    });

    if (!res.ok) {
        console.warn(`[RESULT-HUB] Server action POST returned HTTP ${res.status} for ${rollNumber}`);
        return null;
    }

    const text = await res.text();
    const lines = text.trim().split('\n');

    for (const line of lines) {
        if (line.startsWith('1:')) {
            const jsonStr = line.substring(2);
            try {
                let parsed = JSON.parse(jsonStr);

                if (parsed.result && Array.isArray(parsed.result) && parsed.result.length > 0) {
                    parsed = parsed.result[0];
                } else if (parsed.json) {
                    parsed = parsed.json;
                } else if (parsed.data) {
                    parsed = parsed.data;
                }

                if (parsed && (parsed.Name || parsed.name || parsed.CUMULATIVE_GPA || parsed.cgpa)) {
                    console.log(`[RESULT-HUB] Server action unwrapped data keys: ${Object.keys(parsed).slice(0, 10).join(', ')}...`);
                    return parsed;
                }

                console.warn(`[RESULT-HUB] Server action returned unrecognized data structure: ${Object.keys(parsed).slice(0, 10).join(', ')}`);
                return null;
            } catch (e) {
                console.warn('[RESULT-HUB] Failed to parse server action response:', e.message);
                return null;
            }
        }
    }

    return null;
}

function getField(data, ...keys) {
    for (const k of keys) {
        if (data[k] !== undefined) return data[k];
    }
    return undefined;
}

function parseServerActionData(data, college, year, rollNumber) {
    const history = {};

    history.name = getField(data, 'Name', 'name', 'STUDENT_NAME') || 'Student';
    history.rollNumber = getField(data, 'Roll_No', 'rollNumber', 'ROLL_NO') || rollNumber;
    history.cgpa = getField(data, 'CUMULATIVE_GPA', 'cgpa', 'CUMULATIVE_CGPA', 'CGPA') || '--';
    history.universityRank = getField(data, 'UNIVERSITY_RANK', 'universityRank', 'UNI_RANK', 'University_Rank');
    history.deptRank = getField(data, 'DEPARTMENT_RANK', 'deptRank', 'DEPT_RANK', 'Department_Rank');
    history.major = normalizeBranchForDisplay(getField(data, 'Branch', 'branch', 'BRANCH'));
    history.college = getField(data, 'college', 'COLLEGE', 'College') || college;
    history.year = String(year);
    history.highest = getField(data, 'HIGHEST', 'highest', 'HIGHEST_CGPA') || null;
    history.average = getField(data, 'AVERAGE', 'average', 'BRANCH_AVERAGE') || null;
    history.percentile = getField(data, 'PERCENTILE', 'percentile') || null;
    history.discipline = getField(data, 'Discipline', 'discipline') || null;
    history.course = getField(data, 'Course', 'course') || null;

    if (history.universityRank && !String(history.universityRank).startsWith('#')) {
        history.universityRank = '#' + history.universityRank;
    }
    if (history.deptRank && !String(history.deptRank).startsWith('#')) {
        history.deptRank = '#' + history.deptRank;
    }

    let totalCredits = 0;
    let creditsFound = 0;
    for (const sem of SEMESTER_ORDER) {
        const creditsKey = `SEM_${sem}_CREDITS`;
        const creditsVal = parseInt(getField(data, creditsKey, creditsKey.toLowerCase()), 10);
        if (!isNaN(creditsVal) && creditsVal > 0) {
            totalCredits += creditsVal;
            creditsFound++;
        }
    }
    history.credits = creditsFound > 0 ? String(totalCredits) : '--';

    history.sgpa = [];
    history.cgpaTrend = {};
    history.semesters = {};

    for (let i = 0; i < SEMESTER_ORDER.length; i++) {
        const sem = SEMESTER_ORDER[i];
        const short = SEMESTER_SHORT[i];
        const sgpaKey = `SEM_${sem}`;
        const sgpaVal = parseFloat(getField(data, sgpaKey, sgpaKey.toLowerCase(), short));

        if (data[sgpaKey] !== undefined && sgpaVal > 0) {
            history.sgpa.push(sgpaVal);
            history.cgpaTrend[sem] = sgpaVal;
        } else if (data[short] !== undefined && parseFloat(data[short]) > 0) {
            history.sgpa.push(parseFloat(data[short]));
            history.cgpaTrend[sem] = parseFloat(data[short]);
        }

        if (data._semesters && data._semesters[sem]) {
            const semData = data._semesters[sem];
            history.semesters[sem] = {
                sgpa: semData.sgpa || null,
                credits: semData.credits || null,
                creditsSecured: semData.credits_secured || null,
                failedCourses: semData.failed_courses || null,
                grades: semData.grades || {},
            };
        }
    }

    if (data._cgpa_trend) {
        history.cgpaTrend = data._cgpa_trend;
    }

    history.rankMovementUniversity = data.rank_movement_university || {};
    history.rankMovementDepartment = data.rank_movement_department || {};
    history.semesterRankUniversity = data.semester_rank_university || {};
    history.semesterRankDepartment = data.semester_rank_department || {};

    const subjects = {};
    for (let i = 0; i < SEMESTER_ORDER.length; i++) {
        const short = SEMESTER_SHORT[i];
        const countKey = `${short}_SUBJECT_COUNT`;
        const count = parseInt(getField(data, countKey, countKey.toLowerCase()), 10);
        if (count > 0) {
            const semSubjects = [];
            for (let j = 1; j <= count; j++) {
                const code = getField(data, `${short}_SUBJECT_${j}_CODE`, `${short}_subject_${j}_code`) || getField(data, `${short}_SUBJECT_${j}_NAME`, `${short}_subject_${j}_name`) || '';
                const grade = getField(data, `${short}_SUBJECT_${j}_GRADE`, `${short}_subject_${j}_grade`) || '';
                const name = getField(data, `${short}_SUBJECT_${j}_NAME`, `${short}_subject_${j}_name`) || code;
                const combined = getField(data, `${short}_SUBJECT_${j}`, `${short}_subject_${j}`) || '';
                semSubjects.push({
                    code: code,
                    name: name,
                    grade: grade,
                    subject: combined
                });
            }
            subjects[short] = semSubjects;
        }
    }
    history.subjects = subjects;

    history.failedSubjects = {};
    for (let i = 0; i < SEMESTER_ORDER.length; i++) {
        const short = SEMESTER_SHORT[i];
        const failedKey = `${short}_FAILED_SUBJECTS`;
        if (data[failedKey] !== undefined && data[failedKey] !== '0') {
            history.failedSubjects[short] = data[failedKey];
        }
    }

    return history;
}

export async function fetchStudentDetailedProfile(rollNumber, preFetchedHtml = null, browser = null, college = 'NSUT') {
    let year = 2028;
    if (rollNumber && rollNumber.startsWith('202')) {
        const startY = parseInt(rollNumber.substring(0,4));
        year = startY + 4;
    }
    const profile = { success: false, history: {} };

    // ── Method 1: Invoke ResultHub Next.js Server Action (lookupStudent) ──────
    // The server action returns full student data (CGPA, ranks, SGPA, credits, etc.)
    // It uses the RSC flight protocol with Next-Action header
    try {
        const actionResult = await invokeResultHubServerAction(college, year, rollNumber);
        if (actionResult && (actionResult.Name || actionResult.name || actionResult.CUMULATIVE_GPA || actionResult.cgpa)) {
            const history = parseServerActionData(actionResult, college, year, rollNumber);
            console.log(`[RESULT-HUB] Server action success for ${rollNumber}: ${history.name}, CGPA=${history.cgpa}, UniRank=${history.universityRank}, DeptRank=${history.deptRank}`);
            profile.success = true;
            profile.history = history;
            profile.history.url = `https://www.resulthubdtu.com/${college}/StudentProfile/${year}/${rollNumber}`;
            profile.analytics = actionResult.analytics || null;
            profile.filters = actionResult.filters || null;
            return profile;
        } else if (actionResult && actionResult.error) {
            console.warn(`[RESULT-HUB] Server action error for ${rollNumber}: ${actionResult.error}`);
        }
    } catch (e) {
        console.warn(`[RESULT-HUB] Server action invocation failed for ${rollNumber}: ${e.message}`);
    }

    // ── Method 2: Fallback to HTML metadata extraction ────────────────────────
    try {
        let html = preFetchedHtml;
        let renderedText = null;

        if (!html && browser) {
            try {
                const page = await browser.newPage();
                await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
                await page.goto(`https://www.resulthubdtu.com/${college}/StudentProfile/${year}/${rollNumber}`, {
                    waitUntil: 'networkidle0',
                    timeout: 30000
                });
                renderedText = await page.evaluate(() => document.body.innerText);
                html = await page.content();
                await page.close().catch(() => {});
            } catch (e) {
                console.warn(`[RESULT-HUB] Puppeteer fetch failed: ${e.message}`);
            }
        }

        if (!html) {
            const url = `https://www.resulthubdtu.com/${college}/StudentProfile/${year}/${rollNumber}`;
            const res = await globalThis.fetch(url, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.5',
                },
                signal: AbortSignal.timeout(15000)
            });
            if (!res.ok) {
                console.warn(`[RESULT-HUB] HTTP ${res.status} for ${url}`);
                return profile;
            }
            html = await res.text();
        }

        const $ = cheerio.load(html);
        const history = {};

        const metaDesc = $('meta[name="description"], meta[property="og:description"], meta[name="twitter:description"]').attr('content') || '';
        const ldJsonScript = $('script[type="application/ld+json"]').html() || '';
        const bodyText = $.text();

        console.log(`[RESULT-HUB] Fallback HTML scrape for ${rollNumber} (year=${year})`);

        const seed = renderedText
            ? [metaDesc, ldJsonScript, renderedText].join('\n')
            : [metaDesc, ldJsonScript, bodyText].join('\n');

        let cgpaMatch = seed.match(/Cumulative CGPA[\s\n]*([\d\.]+)/i) || seed.match(/CGPA[:\s]+([\d]+\.[\d]+)/i);
        if (cgpaMatch) history.cgpa = cgpaMatch[1];
        else history.cgpa = '--';

        let uniRankMatch = seed.match(/University Rank[:.\s]*#?(\d+)/i) || seed.match(/University[\s\n]+Rank[:.\s]*#?(\d+)/i);
        if (uniRankMatch) history.universityRank = '#' + uniRankMatch[1];
        else history.universityRank = '--';

        let deptRankMatch = seed.match(/Dept\.?\s*Rank[\s\n]*[:.]?\s*#?(\d+)/i);
        if (!deptRankMatch && renderedText) {
            deptRankMatch = renderedText.match(/Dept\.?\s*Rank\s*[:.]?\s*#?(\d+)/i);
        }
        if (deptRankMatch) history.deptRank = '#' + deptRankMatch[1];
        else history.deptRank = '--';

        let creditsMatch = seed.match(/Credits Completed[\s\n]*(\d+)/i);
        if (!creditsMatch && renderedText) {
            creditsMatch = renderedText.match(/Credits Completed\s*(\d+)/i);
        }
        if (creditsMatch) history.credits = creditsMatch[1];
        else history.credits = '--';

        history.sgpa = [];
        if (renderedText) {
            const lines = renderedText.split('\n');
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i].trim();
                const semMatch = line.match(/^Semester\s+(I|II|III|IV|V|VI|VII|VIII|\d+)$/);
                if (semMatch) {
                    for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
                        const nextLine = lines[j].trim();
                        if (/^\d+\s*cr$/.test(nextLine)) {
                            for (let k = j + 1; k < Math.min(j + 3, lines.length); k++) {
                                const sgpaLine = lines[k].trim();
                                const sgpaMatch = sgpaLine.match(/^(\d+\.\d+)$/);
                                if (sgpaMatch) {
                                    history.sgpa.push(parseFloat(sgpaMatch[1]));
                                    break;
                                }
                            }
                            break;
                        }
                    }
                }
            }
        }

        history.major = 'B.Tech';
        const branchMatch = seed.match(/Branch[:\s]+([^,]+)/i);
        if (branchMatch) {
            const branch = branchMatch[1].trim();
            if (/Mechanical/.test(branch)) history.major = 'Mechanical Engineering';
            else if (/Computer Science|COE|CSE|CSA|AI|ML|Data Science|Software/i.test(branch)) history.major = 'Computer Science';
            else if (/Electronics|ECE|EEE|E CE/i.test(branch)) history.major = 'Electronics & Comm.';
            else if (/Civil/i.test(branch)) history.major = 'Civil Engineering';
            else if (/IT|Information Technology/i.test(branch)) history.major = 'Information Technology';
            else history.major = branch;
        }

        history.name = 'Student';
        history.college = college;
        history.year = year.toString();
        try {
            const ldData = JSON.parse(ldJsonScript);
            if (ldData && ldData.name) {
                history.name = ldData.name;
            }
            if (ldData && ldData.affiliation && ldData.affiliation.name) {
                history.college = ldData.affiliation.name;
            }
        } catch(e) {
            const nameMatch = seed.match(/<title>([^<]+?)\(/);
            if (nameMatch) history.name = nameMatch[1].trim();
        }

        console.log(`[RESULT-HUB] Fallback: name=${history.name}, cgpa=${history.cgpa}, rank=${history.universityRank}, major=${history.major}`);

        profile.success = true;
        profile.history = history;
        profile.history.url = `https://www.resulthubdtu.com/${college}/StudentProfile/${year}/${rollNumber}`;
        return profile;
    } catch (e) {
        console.warn("[RESULT-HUB] Fast HTTP fetch failed:", e.message);
    }
    return profile;
}
