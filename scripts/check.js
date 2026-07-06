require("dotenv").config();
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const axios = require("axios");

const TIMETABLE_URL =
  process.env.TIMETABLE_URL ||
  "https://ss-stavebnikolin.bakalari.cz/Timetable/Public/Next/Class/7B";
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const DISCORD_USER_ID = process.env.DISCORD_USER_ID || null;
const STATE_PATH = path.join(__dirname, "..", "data", "state.json");

// ---------- state ----------

function loadState() {
  if (!fs.existsSync(STATE_PATH)) return { lessons: {} };
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, "utf-8"));
  } catch {
    return { lessons: {} };
  }
}

function saveState(state) {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

// ---------- extrakce z Bakalářů ----------

async function extractLessons(page) {
  return page.$$eval("[data-detail]", (nodes) =>
    nodes
      .map((el) => {
        let detail;
        try {
          detail = JSON.parse(el.getAttribute("data-detail"));
        } catch {
          return null;
        }
        const middle = el.querySelector(".middle");
        const subjectAbbrev =
          middle?.querySelector("div")?.textContent?.trim() || "";
        const teacherAbbrev =
          middle?.querySelector(".teacher-name")?.textContent?.trim() || "";
        const room =
          el.querySelector(".top .right .first")?.textContent?.trim() ||
          detail.room ||
          "";
        const group =
          el.querySelector(".top .left .groups-names")?.textContent?.trim() ||
          detail.group ||
          "";

        return {
          identCode: (detail.IdentCode || "").trim(),
          day: detail.day,
          time: detail.time,
          subjectAbbrev,
          teacherAbbrev,
          room,
          group,
          infoChangeCode: detail.infoChangeCode,
        };
      })
      .filter((l) => l && l.identCode)
  );
}

// ---------- diff ----------

function diffLessons(oldLessons, newLessons) {
  const changes = [];
  for (const [identCode, next] of Object.entries(newLessons)) {
    const prev = oldLessons[identCode];
    if (!prev) continue; // nová hodina v rozvrhu (jiný týden) - nepočítá se jako substituce

    const fields = ["subjectAbbrev", "teacherAbbrev", "room"];
    const changed = fields.filter((f) => prev[f] !== next[f]);
    if (changed.length > 0) {
      changes.push({ day: next.day, time: next.time, prev, next, changed });
    }
  }
  return changes;
}

// ---------- Discord ----------

function buildDiffLine(label, oldVal, newVal) {
  return `${label}: ~~${oldVal || "—"}~~ → **${newVal || "—"}**`;
}

async function sendDiscordNotification(changes) {
  if (!DISCORD_WEBHOOK_URL) {
    console.log("DISCORD_WEBHOOK_URL není nastaveno, notifikaci neposílám.");
    return;
  }

  const ping = DISCORD_USER_ID ? `<@${DISCORD_USER_ID}> ` : "";

  const fields = changes.map((c) => {
    const lines = [];
    if (c.changed.includes("subjectAbbrev")) {
      lines.push(buildDiffLine("Předmět", c.prev.subjectAbbrev, c.next.subjectAbbrev));
    }
    if (c.changed.includes("teacherAbbrev")) {
      lines.push(buildDiffLine("Učitel", c.prev.teacherAbbrev, c.next.teacherAbbrev));
    }
    if (c.changed.includes("room")) {
      lines.push(buildDiffLine("Učebna", c.prev.room, c.next.room));
    }
    return {
      name: `${c.day} · ${c.time}`,
      value: lines.join("\n"),
    };
  });

  const payload = {
    content: `${ping}🔔 Změna v rozvrhu`,
    allowed_mentions: { parse: ["users"] },
    embeds: [
      {
        color: 0xe67e22,
        fields,
        footer: { text: "Rozvrh 7B" },
      },
    ],
    components: [
      {
        type: 1,
        components: [
          {
            type: 2,
            style: 5,
            label: "Odkaz na rozvrh",
            url: TIMETABLE_URL,
          },
        ],
      },
    ],
  };

  await axios.post(DISCORD_WEBHOOK_URL, payload);
}

// ---------- main ----------

async function main() {
  const state = loadState();
  const oldLessons = state.lessons || {};

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(TIMETABLE_URL, { waitUntil: "networkidle" });

    const lessonsArr = await extractLessons(page);
    const newLessons = {};
    for (const l of lessonsArr) newLessons[l.identCode] = l;

    const changes = diffLessons(oldLessons, newLessons);

    if (changes.length > 0) {
      console.log(`Zjištěno ${changes.length} změn(y), posílám notifikaci.`);
      await sendDiscordNotification(changes);
      state.lastChangedAt = new Date().toISOString();
    } else {
      console.log("Žádná změna oproti poslednímu stavu.");
    }

    state.lessons = newLessons;
    delete state.lastError;
    saveState(state);
  } catch (err) {
    console.error("Chyba při kontrole rozvrhu:", err);
    state.lastError = { message: err.message, at: new Date().toISOString() };
    saveState(state);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

main();
