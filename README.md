# Monitoring rozvrhu 7B → Discord

Sleduje stránku
`https://ss-stavebnikolin.bakalari.cz/Timetable/Public/Next/Class/7B`
a při jakékoli změně pošle upozornění do Discordu. Běží **zdarma na GitHub
Actions** — žádný server, žádná kreditka, žádná údržba.

## Proč GitHub Actions a ne VPS

Bakaláři rozvrh se nemění každou vteřinu, ale nanejvýš párkrát týdně.
GitHub Actions umí spouštět skript podle plánu (cron) a je to jediné
řešení, které je **skutečně 100% zdarma bez rizika platby** — u veřejného
repozitáře jsou minuty na Actions neomezené, u soukromého je zdarma
2000 min/měsíc (s tímto nastavením se do limitu vejdete i tak).

Nevýhoda oproti VPS: kontrola po 10 minutách místo po 10–30 sekundách.
Pro rozvrh je to ale naprosto v pořádku.

## Jak to funguje

1. GitHub Actions spustí `scripts/check.js` každých 10 minut (plán v
   `.github/workflows/monitor.yml`).
2. Skript otevře stránku v headless Chromiu (Playwright) — je to nutné,
   protože rozvrh je JS aplikace a obsah se vykresluje až v prohlížeči.
3. Extrahuje text, spočítá SHA-256 hash a porovná ho s hashem uloženým
   v `data/state.json`.
4. Pokud se hash liší → pošle zprávu na Discord webhook a uloží nový hash.
5. Aktualizovaný `data/state.json` se commitne zpět do repozitáře (jen
   pokud se opravdu něco změnilo — díky tomu nevznikají zbytečné commity).

## Nastavení krok za krokem

### 1. Vytvoření GitHub repozitáře
- Na [github.com](https://github.com) vytvořte nový repozitář (klidně
  **veřejný** — obsahuje jen skript a hash rozvrhu, žádná citlivá data;
  veřejný repo navíc znamená neomezené a garantovaně zdarma Actions minuty).
- Nahrajte do něj tento projekt (viz krok 3).

### 2. Vývoj a test lokálně ve VS Code
```bash
git clone <URL_VASEHO_REPOZITARE>
cd rozvrh-7b-monitor
npm install
npx playwright install chromium

cp .env.example .env
# do .env vložte svůj Discord webhook (jen pro lokální test!)
```
Otevřete složku ve VS Code, upravte co potřebujete a otestujte:
```bash
node scripts/check.js
```
První spuštění jen uloží počáteční stav (žádná notifikace nepřijde – to je
správné chování, nejde o "změnu"). Pokud chcete notifikaci vyzkoušet, smažte
obsah `data/state.json` na `{}` a spusťte skript znovu poté, co se rozvrh
reálně změní, nebo si dočasně upravte selector, aby vrátil jiný text.

### 3. Nahrání na GitHub
```bash
git add .
git commit -m "Initial commit - monitoring rozvrhu 7B"
git branch -M main
git remote add origin <URL_VASEHO_REPOZITARE>
git push -u origin main
```

### 4. Nastavení Discord webhooku jako GitHub Secret
V repozitáři: **Settings → Secrets and variables → Actions → New repository
secret**
- Name: `DISCORD_WEBHOOK_URL`
- Value: váš webhook z Discordu

Webhook se tak nikdy neobjeví v kódu ani v historii commitů.

### 5. Hotovo
Workflow se spustí automaticky podle plánu. Ruční spuštění (např. pro test)
najdete v záložce **Actions → Monitoring rozvrhu 7B → Run workflow**.

## Jak sledovat, kdy proběhla poslední kontrola

Historii všech běhů (úspěšných i neúspěšných, s přesným časem a logem)
najdete v záložce **Actions** repozitáře — není potřeba nic dalšího budovat,
GitHub to eviduje automaticky a zdarma.

`data/state.json` navíc obsahuje `lastChangedAt` (kdy se rozvrh naposledy
opravdu změnil) a při chybách `lastError`.

## Doladění selectoru (doporučeno)

Výchozí nastavení sleduje **celou stránku** (`body`). Funguje to, ale je
citlivější na nepodstatné změny (např. jiný vybraný učitel v menu). Pro
přesnější sledování:

1. Otevřete stránku rozvrhu v prohlížeči, klikněte pravým na samotnou
   tabulku rozvrhu → **Prozkoumat** (F12).
2. Najděte obalující element tabulky, klikněte pravým na zvýrazněný tag
   v DevTools → **Copy → Copy selector**.
3. V GitHub Secrets přidejte `TIMETABLE_SELECTOR` s touto hodnotou (stejným
   postupem jako u webhooku), případně upravte přímo v `.env` pro lokální
   testování.
4. Ve workflow (`monitor.yml`) přidejte řádek do `env:` sekce kroku
   „Spuštění kontroly rozvrhu“:
   ```yaml
   env:
     DISCORD_WEBHOOK_URL: ${{ secrets.DISCORD_WEBHOOK_URL }}
     TIMETABLE_SELECTOR: ${{ secrets.TIMETABLE_SELECTOR }}
   ```

Pozn.: teď je léto/prázdniny, takže "příští týden" může být v rozvrhu
prázdné ("Volno") — to je normální, monitoring bude fungovat stejně, jen
zatím nebude co hlásit až do doby, kdy se rozvrh začne skutečně měnit.

## Bezpečnost
- Webhook URL je jen v GitHub Secrets, nikdy v kódu ani v `.env` na GitHubu
  (`.env` je v `.gitignore`).
- Pokud by webhook někdy unikl, v Discordu (Nastavení kanálu → Integrace →
  Webhooky) ho můžete kdykoliv smazat a vytvořit nový.

## Změna intervalu kontroly
V `.github/workflows/monitor.yml` upravte cron výraz, např. na 30 minut:
```yaml
- cron: '*/30 * * * *'
```
