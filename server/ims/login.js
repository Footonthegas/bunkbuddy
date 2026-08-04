import puppeteer from 'puppeteer';
import { solveCaptcha } from './captcha.js';
import { createImsClient } from './client.js';

const MAX_ATTEMPTS = 3;

export async function loginToIms(rollNumber, password) {
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: "new",
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--window-position=-32000,-32000']
    });

    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    
    // Aggressive request interception for extreme scraper speed
    await page.setRequestInterception(true);
    page.on('request', (req) => {
        const type = req.resourceType();
        const url = req.url().toLowerCase();
        
        // Whitelist captcha images so OCR can function
        if (type === 'image' && (url.includes('captcha') || url.includes('captchaimg'))) {
            req.continue();
        } else if (['image', 'stylesheet', 'font', 'media'].includes(type) || url.includes('google-analytics') || url.includes('ads')) {
            req.abort();
        } else {
            req.continue();
        }
    });

    // Step 1: Navigate to main IMS page
    console.time("Step1_Goto");
    console.log(`[LOGIN] Starting for ${rollNumber}...`);
    await page.goto('https://www.imsnsit.org/imsnsit/', { waitUntil: 'domcontentloaded', timeout: 20000 });
    console.timeEnd("Step1_Goto");

    // Step 2: Click "Student Login" using an active retry instead of static delays
    console.time("Step2_ClickLogin");
    let clickedLogin = false;
    for (let attempts = 0; attempts < 100; attempts++) {
      for (const frame of page.frames()) {
        try {
          const found = await frame.evaluate(() => {
            const links = Array.from(document.querySelectorAll('a'));
            const link = links.find(el => el.textContent.trim().toLowerCase().includes('student login'));
            if (link) { link.click(); return true; }
            return false;
          });
          if (found) { clickedLogin = true; break; }
        } catch (e) {}
      }
      if (clickedLogin) break;
      await new Promise(r => setTimeout(r, 50));
    }
    if (!clickedLogin) {
        console.timeEnd("Step2_ClickLogin");
        throw new Error('Could not find Student Login link on IMS homepage.');
    }
    console.timeEnd("Step2_ClickLogin");

    // Step 3: Find login frame with lightning fast polling
    console.time("Step3_WaitLoginFrame");
    let loginFrame = null;
    for (let i = 0; i < 150; i++) {
      for (const frame of page.frames()) {
        try {
          const hasUid = await frame.evaluate(() => !!document.querySelector('input[name="uid"]'));
          if (hasUid) { loginFrame = frame; break; }
        } catch (e) {}
      }
      if (loginFrame) break;
      await new Promise(r => setTimeout(r, 50));
    }
    if (!loginFrame) throw new Error('Login frame not found. IMS portal may be down.');
    console.timeEnd("Step3_WaitLoginFrame");
    
    // Step 4: Attempt login up to MAX_ATTEMPTS times
    console.time("Step4_AttemptLogin");
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      console.log(`[LOGIN] Attempt ${attempt}/${MAX_ATTEMPTS}...`);

      // Extract captcha directly from browser canvas (the EXACT image displayed)
      // Extract captcha directly from browser canvas (the EXACT image displayed)
      const captchaBase64 = await page.evaluate(() => {
        const allFrames = [window, ...Array.from(document.querySelectorAll('iframe, frame'))];
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

        for (const frame of allFrames) {
            try {
                const doc = frame.document || frame.contentDocument;
                if (!doc) continue;
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
                if (!img) continue;
                if (!img.naturalWidth && img.complete) continue;
                if (!img.naturalWidth) return null;

                if (img.src && img.src.startsWith('data:image')) {
                    return img.src.split(',')[1];
                }

                const scale = 2;
                const canvas = doc.createElement('canvas');
                canvas.width = img.naturalWidth * scale;
                canvas.height = img.naturalHeight * scale;
                const ctx = canvas.getContext('2d');
                ctx.imageSmoothingEnabled = true;
                ctx.imageSmoothingQuality = 'high';
                ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
                return canvas.toDataURL('image/png').split(',')[1];
            } catch (e) {}
        }
        return null;
      });

      if (!captchaBase64) {
          if (attempt === MAX_ATTEMPTS) {
              console.timeEnd("Step4_AttemptLogin");
              throw new Error('Captcha image not found in login frame.');
          }
          continue;
      }
      const captchaBuffer = Buffer.from(captchaBase64, 'base64');
      const captchaText = await solveCaptcha(captchaBuffer);
      console.log(`[LOGIN] Captcha solved: ${captchaText}`);

      // Clear fields and type fresh
      await loginFrame.evaluate(() => {
        const uid = document.querySelector('input[name="uid"]');
        const pwd = document.querySelector('input[name="pwd"]');
        const cap = document.querySelector('input[name="cap"]');
        if (uid) uid.value = '';
        if (pwd) pwd.value = '';
        if (cap) cap.value = '';
      });

      await loginFrame.type('input[name="uid"]', rollNumber);
      await loginFrame.type('input[name="pwd"]', password);
      await loginFrame.type('input[name="cap"]', captchaText);

      // Handle alert dialogs (IMS shows alerts for invalid captcha)
      let alertMsg = null;
      const dialogHandler = async (dialog) => {
        alertMsg = dialog.message();
        console.log(`[LOGIN] Alert: ${alertMsg}`);
        await dialog.accept();
      };
      page.once('dialog', dialogHandler);

      // Click login
      await loginFrame.click('input[name="login"]');
      await delay(800);
      page.off('dialog', dialogHandler);

      // Check result: if uid input still exists → we're still on login page
      const stillOnLogin = await loginFrame.evaluate(() => !!document.querySelector('input[name="uid"]')).catch(() => false);

      if (!stillOnLogin) {
        // SUCCESS! We navigated away from login page
        console.log(`[LOGIN] ✅ Login successful on attempt ${attempt}!`);
        console.timeEnd("Step4_AttemptLogin");

        // Extract cookies from browser and inject into an axios client for the scraper
        const cookies = await page.cookies('https://www.imsnsit.org');
        const { client, jar } = createImsClient();

        // Inject all browser cookies into the axios jar
        for (const cookie of cookies) {
          const cookieStr = `${cookie.name}=${cookie.value}; Domain=${cookie.domain}; Path=${cookie.path}`;
          await jar.setCookie(cookieStr, 'https://www.imsnsit.org');
        }

        // Grab the current page HTML for the scraper
        let html = '';
        for (const frame of page.frames()) {
          try {
            const content = await frame.content();
            if (content.length > html.length) html = content;
          } catch {}
        }

        const sessionId = cookies.find(c => c.name === 'PHPSESSID')?.value;

        // DO NOT CLOSE BROWSER YET: Scraper requires the live browser context for frameset resolution
        // await browser.close();

        return {
          success: true,
          client,
          html,
          sessionId,
          rollNumber,
          data: {},
          browser,
          page
        };
      }

      // Still on login page → check if it's wrong credentials or wrong captcha
      if (alertMsg && (alertMsg.toLowerCase().includes('invalid') && !alertMsg.toLowerCase().includes('security'))) {
        // Explicit "Invalid roll number or password" from server
        console.timeEnd("Step4_AttemptLogin");
        await browser.close();
        throw new Error('Invalid roll number or password.');
      }

      // Captcha was wrong → refresh and retry
      if (attempt < MAX_ATTEMPTS) {
        console.log(`[LOGIN] Captcha likely wrong. Refreshing...`);
        await loginFrame.evaluate(() => {
          if (typeof refreshcaptcha1 === 'function') refreshcaptcha1();
        }).catch(() => {});
        await delay(500);
      }
    }

    // Exhausted all attempts
    console.timeEnd("Step4_AttemptLogin");
    await browser.close();
    throw new Error('Invalid roll number or password.');

  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    throw err;
  }
}

function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}
