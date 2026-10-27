// Records the /scene page frame by frame for the article video:
//   npm i -D puppeteer-core && node web/scripts/record-scene.mjs 'http://localhost:4321/#/scene?demo&crack=2&record' frames 12.5
// then: ffmpeg -framerate 30 -i frames/f%04d.png -c:v libx264 -pix_fmt yuv420p round.mp4
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
const [url, out, secs, fps = '30'] = process.argv.slice(2);
fs.mkdirSync(out, { recursive: true });
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=d3d11'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 900, deviceScaleFactor: 1 });
page.on('console', (m) => m.type() === 'error' && console.log('page:', m.text()));
await page.goto(url, { waitUntil: 'networkidle0' });
await page.waitForFunction('window.__scene', { timeout: 30000 });
await new Promise((r) => setTimeout(r, 1500)); // let the demo queue a second round
console.log('backend', await page.$eval('canvas', (c) => c.dataset.backend));
const n = Math.round(Number(secs) * Number(fps));
for (let i = 0; i < n; i++) {
  await page.evaluate((dt) => window.__scene.step(dt), 1 / Number(fps));
  await page.screenshot({ path: `${out}/f${String(i).padStart(4, '0')}.png` });
  if (i % 60 === 0) console.log(i, '/', n);
}
await browser.close();
