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
            if (yearSel) {
                yearSel.value = y;
                yearSel.dispatchEvent(new Event('change', { bubbles: true }));
            }
            let semSel = document.querySelector('select[name="sem"]');
            if (semSel) {
                semSel.value = s;
                semSel.dispatchEvent(new Event('change', { bubbles: true }));
            }
            
            let encYear = document.querySelector('input[name="enc_year"]')?.value;
            let encSem = document.querySelector('input[name="enc_sem"]')?.value;
            setTimeout(() => {
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

            await page.goto('https://www.imsnsit.org/imsnsit/', { waitUntil: 'domcontentloaded', timeout: 20000 });
            console.log(`[FAST-SCRAPE] [${el()}] Homepage loaded`);

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

            async function findLoginFrame() {
                for (let i = 0; i < 200; i++) {
                    const frames = page.frames();
                    for (const frame of frames) {
                        try {
                            if (frame.isDetached()) continue;
                            const hasUid = await frame.evaluate(() => !!document.querySelector('input[name="uid"]'));
                            if (hasUid) return frame;
                        } catch (e) {}
                    }
                    if (i % 40 === 0 && frames.length === 0) {
                        console.warn(`[FAST-SCRAPE] No frames found at poll ${i}`);
                    }
                    await new Promise(r => setTimeout(r, 50));
                }
                return null;
            }

            let loginFrame = await findLoginFrame();
            if (!loginFrame) {
                console.warn(`[FAST-SCRAPE] Initial frame not found, retrying navigation...`);
                await page.evaluate(() => {
                    const link = Array.from(document.querySelectorAll('a'))
                        .find(a => a.textContent.trim().toLowerCase().includes('student login'));
                    if (link) link.click();
                }).catch(() => {});
                await new Promise(r => setTimeout(r, 500));
                loginFrame = await findLoginFrame();
                if (!loginFrame) throw new Error('Login frame not found on IMS.');
            }
            console.log(`[FAST-SCRAPE] [${el()}] Login frame located`);

            await new Promise(r => setTimeout(r, 300));

            for (let attempt = 1; attempt <= maxAttempts; attempt++) {
                loginFrame = await findLoginFrame();
                if (!loginFrame) throw new Error('Login frame lost during authentication.');

                const captchaBase64 = await pollFor(async () => {
                    try {
                        return await loginFrame.evaluate(() => {
                            const selectors = [
                                '#captchaimg',
                                'img[src*="captcha"]',
                                'img[src*="Captcha"]',
                                'img[alt*="captcha"]',
                                'img[title*="captcha"]',
                                '.captcha img',
                                '#captcha img',
                                'img[src*="captchaimg"]',
                                'img[src*="checkcode"]',
                                'img[src*="security"]',
                                'img[src*="rand"]',
                                'img[src*="random"]'
                            ];
                            const doc = document;
                            let img = null;
                            for (const sel of selectors) {
                                img = doc.querySelector(sel);
                                if (img) break;
                            }
                            if (!img) {
                                const allImgs = doc.querySelectorAll('img');
                                for (const el of allImgs) {
                                    const src = (el.src || '').toLowerCase();
                                    if (src.includes('captcha') || src.includes('checkcode') || src.includes('security') || src.includes('rand') || src.includes('random')) {
                                        img = el;
                                        break;
                                    }
                                }
                            }
                            if (!img) return null;
                            if (!img.naturalWidth && img.complete) return null;
                            if (!img.naturalWidth) return null;

                            if (img.src && img.src.startsWith('data:image')) {
                                return img.src.split(',')[1];
                            }

                            const scale = 3;
                            const canvas = doc.createElement('canvas');
                            canvas.width = img.naturalWidth * scale;
                            canvas.height = img.naturalHeight * scale;
                            const ctx = canvas.getContext('2d');
                            ctx.imageSmoothingEnabled = true;
                            ctx.imageSmoothingQuality = 'high';
                            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
                            return canvas.toDataURL('image/png').split(',')[1];
                        });
                    } catch (e) {
                        return null;
                    }
                }, 20000, 50);
                if (!captchaBase64) throw new Error('Captcha image not found.');

                const captchaText = await solveCaptchaThreaded(Buffer.from(captchaBase64, 'base64'));
                console.log(`[FAST-SCRAPE] [${el()}] CAPTCHA: ${captchaText}`);

                try {
                    await loginFrame.evaluate((u, p, c) => {
                        const uid = document.querySelector('input[name="uid"]');
                        const pwd = document.querySelector('input[name="pwd"]');
                        const cap = document.querySelector('input[name="cap"]');
                        if (uid) { uid.value = u; uid.dispatchEvent(new Event('input', {bubbles: true})); }
                        if (pwd) { pwd.value = p; pwd.dispatchEvent(new Event('input', {bubbles: true})); }
                        if (cap) { cap.value = c; cap.dispatchEvent(new Event('input', {bubbles: true})); }
                    }, rollNumber, password, captchaText);
                } catch (e) {
                    loginFrame = await findLoginFrame();
                    if (!loginFrame) throw e;
                    continue;
                }

                let alertMsg = null;
                let navResult = null;
                const dialogHandler = async (dialog) => {
                    alertMsg = dialog.message();
                    console.log(`[FAST-SCRAPE] Alert: ${alertMsg}`);
                    await dialog.accept();
                };
                page.once('dialog', dialogHandler);

                try {
                    await loginFrame.click('input[name="login"]');
                    await new Promise(r => setTimeout(r, 1000));
                    page.off('dialog', dialogHandler);

                    const stillOnLogin = await loginFrame.evaluate(() => !!document.querySelector('input[name="uid"]')).catch(() => false);
                    if (!stillOnLogin) {
                        navResult = { success: true };
                    }
                } catch (e) {
                    loginFrame = await findLoginFrame();
                    if (!loginFrame && attempt < maxAttempts) {
                        console.log(`[FAST-SCRAPE] [${el()}] Recovering login frame...`);
                        continue;
                    }
                    throw e;
                }

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
                    try {
                        await loginFrame.evaluate(() => {
                            if (typeof refreshcaptcha1 === 'function') refreshcaptcha1();
                        });
                    } catch (e) {
                        loginFrame = await findLoginFrame();
                    }
                    await new Promise(r => setTimeout(r, 500));
                    loginFrame = await findLoginFrame();
                    if (!loginFrame) {
                        console.log(`[FAST-SCRAPE] [${el()}] Re-navigating to login...`);
                        await page.evaluate(() => {
                            const link = Array.from(document.querySelectorAll('a'))
                                .find(a => a.textContent.trim().toLowerCase().includes('student login'));
                            if (link) link.click();
                        }).catch(() => {});
                        await new Promise(r => setTimeout(r, 1000));
                        loginFrame = await findLoginFrame();
                    }
                    if (!loginFrame) throw new Error('Login frame lost after captcha refresh.');
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
