#!/usr/bin/env node
/* ui-shot — headless screenshot of a Pehverse UI surface, for verifying UI changes without unit
 * tests. Drives the system Brave (Chromium-based) via playwright-core — no bundled browser needed.
 * Usage: node ui-shot.mjs [url] [out.png] [--mobile]
 *   node ui-shot.mjs http://127.0.0.1:18796 /tmp/grove.png --mobile
 */
import { chromium } from 'playwright-core';
const BRAVE = '/usr/bin/brave-browser';
const args = process.argv.slice(2);
const url = args.find((a) => a.startsWith('http')) || 'http://127.0.0.1:18796';
const out = args.find((a) => a.endsWith('.png')) || '/tmp/ui-shot.png';
const mobile = args.includes('--mobile');
const browser = await chromium.launch({ executablePath: BRAVE, headless: true, args: ['--no-sandbox', '--disable-gpu'] });
const ctx = await browser.newContext(
  mobile
    ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }
    : { viewport: { width: 1280, height: 900 } },
);
await ctx.addInitScript(() => { try { localStorage.setItem('pehverse-onboarded','1'); } catch(e){} });
const page = await ctx.newPage();
await page.goto(url, { waitUntil: 'networkidle', timeout: 25000 }).catch((e) => console.error('nav:', e.message));
await page.waitForTimeout(2200);
await page.screenshot({ path: out });
await browser.close();
console.log('ui-shot ->', out);
