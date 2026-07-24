import puppeteer from 'puppeteer';
import { solveCaptchaThreaded } from './captcha_threaded.js';
import { scrapeStudentData, fetchStudentDetailedProfile, parseAttendanceFromHtml } from '../server/ims/scraper.js';

class BrowserPoolManager {
    constructor() {
        this.browser = null;
        this.isInitializing = false;
        this.initPromise = null;
    }

    async getBrowser() {
        if (this.browser && this.browser.connected) return this.browser;
        if (this.isInitializing) return this.initPromise;

        this.isInitializing = true;
        this.initPromise = (async () => {
            console.log('[BROWSER-POOL] Launching warm Puppeteer browser...');
            const launchOpts = {
                headless: "shell",
                args: [
                    '--no-sandbox', 
                    '--disable-setuid-sandbox', 
                    '--disable-gpu',
                    '--disable-dev-shm-usage', 
                    '--window-position=-32000,-32000',
                    '--disable-background-networking',
                    '--disable-sync',
                    '--disable-extensions',
                    '--no-first-run',
                    '--no-default-browser-check',
                    '--disable-translate',
                    '--disable-background-timer-throttling',
                    '--disable-backgrounding-occluded-windows',
                    '--disable-renderer-backgrounding'
                ]
            };
            if (process.env.PUPPETEER_EXECUTABLE_PATH) {
                launchOpts.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
            }
            this.browser = await puppeteer.launch(launchOpts);
            this.browser.on('disconnected', () => { this.browser = null; });
            this.isInitializing = false;
            return this.browser;
        })();
        return this.initPromise;
    }

    async closeAll() {
        if (this.browser) { await this.browser.close().catch(() => {}); this.browser = null; }
    }
}

export const browserPool = new BrowserPoolManager();

// Ultra-fast poll utility (10ms interval)
async function pollFor(fn, maxMs = 4000, intervalMs = 10) {
    const end = Date.now() + maxMs;
    while (Date.now() < end) {
        const result = await fn();
        if (result) return result;
        await new Promise(r => setTimeout(r, intervalMs));
    }
    return null;
}

async function getAttendanceFrame(page) {
    let formFrame = null;
    for (const frame of page.frames()) {
        try {
            const hasForm = await frame.evaluate(() => !!document.forms['frm'] && !!document.querySelector('select[name="year"]'));
            if (hasForm) { formFrame = frame; break; }
        } catch (e) {}
    }
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
            await new Promise(r => setTimeout(r, 15));
        }
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
            await new Promise(r => setTimeout(r, 15));
        }
        for (let attempts = 0; attempts < 50; attempts++) {
            for (const frame of page.frames()) {
                try {
                    const has = await frame.evaluate(() => !!document.forms['frm'] && !!document.querySelector('select[name="year"]'));
                    if (has) { formFrame = frame; break; }
                } catch(e) {}
            }
            if (formFrame) break;
            await new Promise(r => setTimeout(r, 15));
        }
    }
    return formFrame;
}

async function submitAttendanceForm(formFrame, targetYear, targetSem) {
    let htmlSubmitted = false;
    try {
        htmlSubmitted = await formFrame.evaluate((y, s) => {
            let f = document.forms['frm'];
            if (!f) return false;
            let yearSel = document.querySelector('select[name="year"]');
            if (yearSel) yearSel.value = y;
            let semSel = document.querySelector('select[name="sem"]');
            if (semSel) semSel.value = s;
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
                return true;
            }
            return false;
        }, targetYear || '2026-27', targetSem || '1');
    } catch(evalErr) {
        console.warn("[FAST-SCRAPE] Form evaluate notice:", evalErr.message);
    }
    return htmlSubmitted;
}

async function waitForAttendanceTable(page) {
    const delay = ms => new Promise(r => setTimeout(r, ms));
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
    return finalHtml;
}

/**
 * Experimental Blazing Fast Scraper (< 3s Target)
 */
export async function pooledLoginAndScrape(rollNumber, password, year, semester, maxAttempts = 4, maxRetries = 2) {
    let lastError;
    for (let retry = 0; retry <= maxRetries; retry++) {
        const browser = await browserPool.getBrowser();
        const context = await browser.createBrowserContext();
        const t0 = Date.now();
        const el = () => `${((Date.now() - t0) / 1000).toFixed(2)}s`;

        try {
            const page = await context.newPage();
            await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

        await page.setRequestInterception(true);
        page.on('request', (req) => {
            const type = req.resourceType();
            const url = req.url().toLowerCase();
            if (type === 'image' && (url.includes('captcha') || url.includes('captchaimg'))) {
                req.continue();
            } else if (['image', 'stylesheet', 'font', 'media'].includes(type) || url.includes('google-analytics') || url.includes('ads')) {
                req.abort();
            } else {
                req.continue();
            }
        });

        console.log(`[FAST-SCRAPE] [${el()}] Starting live scrape for ${rollNumber}...`);

        // ── STEP 1: Navigate to base IMS ──
        await page.goto('https://www.imsnsit.org/imsnsit/', { waitUntil: 'domcontentloaded', timeout: 20000 });
        console.log(`[FAST-SCRAPE] [${el()}] Homepage loaded`);

        // ── STEP 2: Click Student Login link (15ms poll) ──
        const clickedLogin = await pollFor(async () => {
            for (const frame of page.frames()) {
                try {
                    const found = await frame.evaluate(() => {
                        const link = Array.from(document.querySelectorAll('a'))
                            .find(a => a.textContent.trim().toLowerCase().includes('student login'));
                        if (link) { link.click(); return true; }
                        return false;
                    });
                    if (found) return true;
                } catch (e) {}
            }
            return false;
        }, 4000, 15);
        if (!clickedLogin) throw new Error('Student Login link not found.');
        console.log(`[FAST-SCRAPE] [${el()}] Student Login clicked`);

        // ── STEP 3: Locate login frame with input[name="uid"] ──
        const loginFrame = await pollFor(async () => {
            for (const frame of page.frames()) {
                try {
                    const hasUid = await frame.evaluate(() => !!document.querySelector('input[name="uid"]'));
                    if (hasUid) return frame;
                } catch (e) {}
            }
            return null;
        }, 5000, 15);
        if (!loginFrame) throw new Error('Login frame not found on IMS.');
        console.log(`[FAST-SCRAPE] [${el()}] Login frame located`);

        // ── STEP 4: Solve CAPTCHA & Authenticate ──
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            const captchaBase64 = await pollFor(async () => {
                return await loginFrame.evaluate(() => {
                    const img = document.querySelector('#captchaimg') || document.querySelector('img[src*="captcha"]');
                    if (!img || !img.naturalWidth) return null;
                    const c = document.createElement('canvas');
                    c.width = img.naturalWidth; c.height = img.naturalHeight;
                    c.getContext('2d').drawImage(img, 0, 0);
                    return c.toDataURL('image/jpeg', 1.0).split(',')[1];
                });
            }, 20000, 50);
            if (!captchaBase64) throw new Error('Captcha image not found.');

            const captchaText = await solveCaptchaThreaded(Buffer.from(captchaBase64, 'base64'));
            console.log(`[FAST-SCRAPE] [${el()}] CAPTCHA: ${captchaText}`);

            // Fill credentials in single evaluate
            await loginFrame.evaluate((u, p, c) => {
                const uid = document.querySelector('input[name="uid"]');
                const pwd = document.querySelector('input[name="pwd"]');
                const cap = document.querySelector('input[name="cap"]');
                if (uid) { uid.value = u; uid.dispatchEvent(new Event('input', {bubbles: true})); }
                if (pwd) { pwd.value = p; pwd.dispatchEvent(new Event('input', {bubbles: true})); }
                if (cap) { cap.value = c; cap.dispatchEvent(new Event('input', {bubbles: true})); }
            }, rollNumber, password, captchaText);

            let alertMsg = null;
            const dialogHandler = async (dialog) => {
                alertMsg = dialog.message();
                console.log(`[FAST-SCRAPE] Alert: ${alertMsg}`);
                await dialog.accept();
            };
            page.once('dialog', dialogHandler);

            const navPromise = page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 4000 }).catch(() => null);
            await loginFrame.click('input[name="login"]');
            const navResult = await Promise.race([navPromise, new Promise(r => setTimeout(r, 600))]);

            if (navResult) {
                console.log(`[FAST-SCRAPE] [${el()}] ✅ Authenticated!`);

                const cookies = await context.cookies();
                const cookieJar = await import('tough-cookie').then(m => {
                    const jar = new m.CookieJar();
                    for (const c of cookies) {
                        try { jar.setCookieSync(`${c.name}=${c.value}; Domain=${c.domain}; Path=${c.path};`); } catch(e) {}
                    }
                    return jar;
                }).catch(() => null);

                const resultHubPromise = fetchStudentDetailedProfile(rollNumber, null, browser).catch(e => {
                    console.warn(`[FAST-SCRAPE] ResultHub error: ${e.message}`);
                    return { success: false, history: null };
                });

                console.log(`[FAST-SCRAPE] [${el()}] Executing live attendance extraction...`);
                const data = await scrapeStudentData(page, browser, year, semester, rollNumber);
                console.log(`[FAST-SCRAPE] [${el()}] Live attendance extracted (${data?.attendance?.length || 0} subjects)`);

                const rhResult = await resultHubPromise;
                const history = rhResult?.success ? rhResult.history : null;

                console.log(`[FAST-SCRAPE] [${el()}] 🚀 TOTAL TIME: ${el()}`);
                return { success: true, data, history, rollNumber: rollNumber.toUpperCase(), cookies, cookieJar };
            }

            if (alertMsg && alertMsg.toLowerCase().includes('invalid') && !alertMsg.toLowerCase().includes('security') && !alertMsg.toLowerCase().includes('captcha')) {
                throw new Error('Invalid roll number or password.');
            }

            if (attempt < maxAttempts) {
                console.log(`[FAST-SCRAPE] [${el()}] CAPTCHA wrong. Refreshing...`);
                await loginFrame.evaluate(() => { if (typeof refreshcaptcha1 === 'function') refreshcaptcha1(); }).catch(() => {});
                await new Promise(r => setTimeout(r, 250));
            }
        }

        throw lastError || new Error('Login failed after maximum attempts.');
    } catch (err) {
        if (err.message.includes('Invalid roll number or password')) {
            throw err;
        }
        lastError = err;
        if (retry < maxRetries) {
            console.warn(`[FAST-SCRAPE] Retry ${retry + 1}/${maxRetries}: ${err.message}`);
            await new Promise(r => setTimeout(r, 500));
        }
    } finally {
        await context.close().catch(() => {});
    }
}
throw lastError || new Error('Login failed after maximum attempts.');
}

/**
 * Fast refresh using cached cookies - no CAPTCHA needed
 */
export async function fastRefreshWithCookies(cookies, rollNumber, year, semester) {
    const browser = await browserPool.getBrowser();
    const context = await browser.createBrowserContext();
    const t0 = Date.now();
    const el = () => `${((Date.now() - t0) / 1000).toFixed(2)}s`;

    try {
        const page = await context.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

        await page.setRequestInterception(true);
        page.on('request', (req) => {
            const type = req.resourceType();
            const url = req.url().toLowerCase();
            if (type === 'image' && (url.includes('captcha') || url.includes('captchaimg'))) {
                req.continue();
            } else if (['image', 'stylesheet', 'font', 'media'].includes(type) || url.includes('google-analytics') || url.includes('ads')) {
                req.abort();
            } else {
                req.continue();
            }
        });

        console.log(`[FAST-REFRESH] [${el()}] Restoring session for ${rollNumber}...`);

        console.log(`[FAST-REFRESH] [${el()}] Navigating to attendance portal...`);
        await page.goto('https://www.imsnsit.org/imsnsit/', { waitUntil: 'domcontentloaded', timeout: 20000 });

        if (cookies && cookies.length > 0) {
            try {
                await page.setCookie(...cookies);
                console.log(`[FAST-REFRESH] [${el()}] Cookies applied (${cookies.length})`);
            } catch (cookieErr) {
                console.warn(`[FAST-REFRESH] Cookie error: ${cookieErr.message}`);
            }
            await page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
        }

        console.log(`[FAST-REFRESH] [${el()}] Looking for attendance form...`);
        const formFrame = await getAttendanceFrame(page);
        if (!formFrame) {
            throw new Error('Attendance form frame not found. Session may have expired.');
        }

        console.log(`[FAST-REFRESH] [${el()}] Submitting attendance form...`);
        const htmlSubmitted = await submitAttendanceForm(formFrame, year, semester);
        if (!htmlSubmitted) {
            throw new Error('Could not submit attendance form.');
        }

        const finalHtml = await waitForAttendanceTable(page);
        if (!finalHtml) {
            throw new Error('Attendance table not found after form submit.');
        }

        const { attendance, detailedAttendance } = await parseAttendanceFromHtml(finalHtml);
        const dedupedAttendance = Array.from(new Map(attendance.map((a) => [a.subject, a])).values());

        let studentName = rollNumber;
        for (const frame of page.frames()) {
            try {
                const txt = await frame.evaluate(() => document.body.innerText);
                if (txt && txt.includes('Welcome')) {
                    const match = txt.match(/Welcome\s*:\s*([A-Za-z\s\.]+)/i);
                    if (match && match[1].trim() && !match[1].includes('NSUT')) {
                        studentName = match[1].trim();
                        break;
                    }
                }
            } catch(e) {}
        }

        let history = null;
        try {
            const rhProfile = await fetchStudentDetailedProfile(rollNumber, null, browser);
            if (rhProfile && rhProfile.success) {
                history = rhProfile.history;
            }
        } catch (e) {
            console.warn(`[FAST-REFRESH] ResultHub Puppeteer fetch failed: ${e.message}`);
        }

        const profileName = history?.name && history.name !== 'Student' ? history.name : studentName;

        const data = {
            home: {
                profile: { name: profileName, program: "B.Tech", cgpa: history?.cgpa || '--', semester: history?.semester || '--' },
                summary: dedupedAttendance.slice(0, 4),
            },
            attendance: dedupedAttendance,
            detailedAttendance,
            resources: [],
            connect: [],
        };

        console.log(`[FAST-REFRESH] [${el()}] ✅ Done`);
        return { success: true, data, history, rollNumber: rollNumber.toUpperCase() };
    } finally {
        await context.close().catch(() => {});
    }
}
