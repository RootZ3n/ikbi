#!/usr/bin/env node
/* ui-check — a PASS/FAIL UI verification for ikbi + the agents, solving "the UI has no tests".
 * Loads a UI surface headlessly (system Brave via playwright-core), FAILS on JS/console errors, runs
 * optional element/text assertions, and saves a screenshot. Exits 0 = pass, 1 = fail — so ikbi's
 * builder (or peh-ui) can gate a UI change on it, the way run_checks gates a code change.
 *
 * Usage:
 *   node ui-check.mjs <url> [--mobile] [--fresh] [--shot=out.png]
 *        [--present=<sel>] [--absent=<sel>] [--text=<substring>]
 * Example (verifies the mobile Grove: star gone, welcome text there, no errors):
 *   node ui-check.mjs http://127.0.0.1:18796 --mobile --fresh \
 *        --absent='.peh-onboard-help' --text='Welcome to the Grove' --shot=/tmp/grove.png
 */
import { chromium } from 'playwright-core';
const BRAVE = '/usr/bin/brave-browser';
const args = process.argv.slice(2);
const val = (k) => { const a = args.find((x) => x.startsWith(k + '=')); return a ? a.slice(k.length + 1) : null; };
const url = args.find((a) => a.startsWith('http')) || 'http://127.0.0.1:18796';
const mobile = args.includes('--mobile');
const shot = val('--shot');
const present = args.filter((a) => a.startsWith('--present=')).map((a) => a.slice(10));
const absent = args.filter((a) => a.startsWith('--absent=')).map((a) => a.slice(9));
const text = args.filter((a) => a.startsWith('--text=')).map((a) => a.slice(7));

const fails = [];
const browser = await chromium.launch({ executablePath: BRAVE, headless: true, args: ['--no-sandbox', '--disable-gpu'] });
const ctx = await browser.newContext(
  mobile ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }
         : { viewport: { width: 1280, height: 900 } },
);
if (!args.includes('--fresh')) {
  await ctx.addInitScript(() => { try { localStorage.setItem('pehverse-onboarded', '1'); } catch (e) {} });
}
const page = await ctx.newPage();
const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));

await page.goto(url, { waitUntil: 'networkidle', timeout: 25000 }).catch((e) => fails.push('navigation failed: ' + e.message));
await page.waitForTimeout(2000);

if (consoleErrors.length) fails.push(`${consoleErrors.length} console/page error(s): ` + consoleErrors.slice(0, 5).join(' | '));
for (const sel of present) {
  const vis = await page.locator(sel).first().isVisible().catch(() => false);
  if (!vis) fails.push(`expected present+visible but missing: ${sel}`);
}
for (const sel of absent) {
  const vis = await page.locator(sel).first().isVisible().catch(() => false);
  if (vis) fails.push(`expected absent but VISIBLE: ${sel}`);
}
for (const t of text) {
  const body = await page.textContent('body').catch(() => '');
  if (!body || !body.includes(t)) fails.push(`expected text not found: "${t}"`);
}
if (shot) await page.screenshot({ path: shot });
await browser.close();

if (fails.length) {
  console.error('UI CHECK FAILED:');
  for (const f of fails) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log('UI CHECK PASSED' + (shot ? ` (shot: ${shot})` : ''));
process.exit(0);
