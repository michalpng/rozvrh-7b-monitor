require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const { chromium } = require('playwright');

// URL sledované třídy - Bakaláři "Next" rozvrh je JS aplikace (SPA),
// proto se musí obsah stahovat přes headless prohlížeč (Playwright), ne přes obyčejné HTTP GET.
const URL = 'https://ss-stavebnikolin.bakalari.cz/Timetable/Public/Next/Class/7B';

// CSS selector oblasti, kterou sledujeme. Výchozí je "body" (celá stránka).
// DOPORUČENÍ: po prvním nasazení otevřete stránku v prohlížeči, přes DevTools (F12)
// najděte element obsahující samotnou tabulku rozvrhu (např. by mohl mít třídu
// jako ".bk-timetable-main" nebo podobně) a nastavte přesnější selector přes
// proměnnou prostředí TIMETABLE_SELECTOR - omezí se tak riziko "falešných" upozornění
// na nepodstatné změny mimo tabulku.
const SELECTOR = process.env.TIMETABLE_SELECTOR || 'body';

const STATE_FILE = path.join(__dirname, '..', 'data', 'state.json');
const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const MAX_FAILURES = 3;

function loadState() {
  if (!fs.existsSync(STATE_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

function saveState(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function hash(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

/** Stáhne vykreslený obsah stránky pomocí headless Chromia. */
async function fetchTimetableText() {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  try {
    const page = await browser.newPage({ userAgent: 'Mozilla/5.0 (compatible; RozvrhMonitor/1.0)' });
    await page.goto(URL, { waitUntil: 'networkidle', timeout: 30000 });
    // Krátké dodatečné čekání - Bakaláři gridy se občas dorenderují až po networkidle
    await page.waitForTimeout(1500);

    const text = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      return (el || document.body).innerText;
    }, SELECTOR);

    return text.replace(/\s+/g, ' ').trim();
  } finally {
    await browser.close();
  }
}

async function sendDiscord(payload) {
  if (!WEBHOOK_URL) {
    console.error('Chybí DISCORD_WEBHOOK_URL (nastavte GitHub Secret nebo .env pro lokální test).');
    return;
  }
  await axios.post(WEBHOOK_URL, payload, { timeout: 10000 });
}

/** Retry s prodlevou - ošetří dočasné výpadky serveru Bakalářů. */
async function withRetry(fn, retries = 2, delayMs = 2000) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < retries) await new Promise((r) => setTimeout(r, delayMs * (attempt + 1)));
    }
  }
  throw lastErr;
}

async function main() {
  const state = loadState();
  const now = new Date().toISOString();
  let stateChanged = false;

  try {
    const text = await withRetry(fetchTimetableText);
    const currentHash = hash(text);

    // Pokud jsme předtím hlásili výpadek, dej vědět, že je zase vše v pořádku
    if ((state.failCount || 0) >= MAX_FAILURES) {
      await sendDiscord({
        embeds: [{ title: '✅ Rozvrh 7B je opět dostupný', color: 0x5865f2 }]
      });
    }

    if (!state.hash) {
      console.log('První běh – ukládám počáteční stav rozvrhu (bez notifikace).');
      state.hash = currentHash;
      state.lastChangedAt = now;
      stateChanged = true;
    } else if (state.hash !== currentHash) {
      console.log('Detekována změna rozvrhu.');
      await sendDiscord({
        embeds: [
          {
            title: '🔔 Změna v rozvrhu třídy 7B',
            description: 'Na Bakalářích došlo ke změně rozvrhu.',
            url: URL,
            color: 0x3ba55d,
            fields: [{ name: 'Odkaz na rozvrh', value: URL }],
            timestamp: now
          }
        ]
      });
      state.hash = currentHash;
      state.lastChangedAt = now;
      stateChanged = true;
    } else {
      console.log('Beze změny.');
    }

    if ((state.failCount || 0) !== 0) {
      state.failCount = 0;
      delete state.lastError;
      stateChanged = true;
    }
  } catch (err) {
    console.error('Chyba při kontrole:', err.message);
    const prevFail = state.failCount || 0;

    // Počítadlo chyb necháváme narůst jen do MAX_FAILURES, aby se zbytečně
    // nekomitoval state.json při dlouhodobém výpadku donekonečna.
    if (prevFail < MAX_FAILURES) {
      state.failCount = prevFail + 1;
      state.lastError = err.message;
      stateChanged = true;

      if (state.failCount === MAX_FAILURES) {
        await sendDiscord({
          embeds: [
            {
              title: '⚠️ Rozvrh 7B se nepodařilo zkontrolovat',
              description: err.message.slice(0, 500),
              color: 0xed4245,
              url: URL
            }
          ]
        });
      }
    }
  }

  if (stateChanged) {
    state.lastCheckedAt = now;
    saveState(state);
    console.log('Stav uložen.');
  } else {
    console.log('Stav se nemění, žádný zápis (šetří commity v repozitáři).');
  }
}

main().catch((err) => {
  console.error('Neočekávaná chyba:', err);
  process.exit(1);
});
