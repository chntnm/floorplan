/**
 * `build/icon.svg` → `build/icon.png`, the master electron-builder converts from.
 *
 * Rendered with the Chromium the end-to-end suite already installs rather than with an
 * image library, so the icon has no dependency of its own and the file that is checked
 * in — the SVG — is the one a human can edit. Run it after changing the drawing:
 *
 *     node build/icon.mjs
 */

import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const SIZE = 512;

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: SIZE, height: SIZE },
  deviceScaleFactor: 1,
});

const svg = readFileSync(join(here, 'icon.svg'), 'utf8');
await page.setContent(`<style>html,body{margin:0;padding:0}</style>${svg}`);

// `omitBackground` keeps the corners the rounded rect leaves transparent, which is
// what stops the icon rendering as a square on a light taskbar.
await page.screenshot({ path: join(here, 'icon.png'), omitBackground: true });
await browser.close();

console.log(`build/icon.png — ${SIZE}x${SIZE}`);
