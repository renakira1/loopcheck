import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
const root = resolve(import.meta.dirname, '..');
const temp = await mkdtemp(resolve(tmpdir(), 'loopcheck-chain-'));
const red = resolve(temp, 'red.mp4'), blue = resolve(temp, 'blue.mp4');
for (const [path, color, rate, sound] of [[red, 'red', 24, true], [blue, 'blue', 30, false]]) {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=${color}:size=${sound ? '160x90' : '90x160'}:rate=${rate}:duration=0.5`,
    ...(sound ? ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=0.5'] : []),
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', ...(sound ? ['-c:a', 'aac', '-shortest'] : ['-an']), '-y', path]);
}
const server = createServer(async (req, res) => {
  try {
    const path = resolve(root, '.' + (req.url.split('?')[0] === '/' ? '/index.html' : req.url.split('?')[0]));
    if (!path.startsWith(root + '/')) { res.writeHead(403).end(); return; }
    res.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css' })[extname(path)] || 'application/octet-stream');
    res.end(await readFile(path));
  } catch { res.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.locator('#mode-chain').click();
  await page.locator('#chain-files').setInputFiles([red, blue]);
  await page.waitForFunction(() => document.querySelector('#chain-library').children.length === 2 && !document.querySelector('#chain-files').disabled);
  assert.equal(await page.locator('#chain-sequence>li').count(), 2);
  await page.getByRole('spinbutton', { name: 'Repeats for entry 1', exact: true }).fill('2');
  await page.getByRole('spinbutton', { name: 'Repeats for entry 1', exact: true }).press('Tab');
  assert.match(await page.locator('#chain-summary').textContent(), /3 clip plays/);
  await page.getByRole('textbox', { name: 'Start for red.mp4', exact: true }).fill('A');
  await page.getByRole('textbox', { name: 'End for red.mp4', exact: true }).fill('A');
  await page.getByRole('textbox', { name: 'Start for blue.mp4', exact: true }).fill('B');
  await page.getByRole('textbox', { name: 'End for blue.mp4', exact: true }).fill('A');
  await page.getByRole('textbox', { name: 'End for blue.mp4', exact: true }).press('Tab');
  assert.match(await page.locator('#chain-warnings').textContent(), /A → B/);
  // Collect actual canvas output through repeats, a mixed-aspect join and chain wrap.
  await page.locator('#chain-play').click();
  await page.waitForFunction(() => document.querySelector('#chain-play').textContent === 'Pause');
  const samples = await page.evaluate(async () => {
    const result = [];
    const canvas = document.querySelector('#chain-video'), ctx = canvas.getContext('2d');
    for (let i = 0; i < 38; i++) {
      const pixel = [...ctx.getImageData(canvas.width / 2, canvas.height / 2, 1, 1).data];
      result.push({ pixel, label: document.querySelector('#chain-now').textContent });
      await new Promise(resolve => setTimeout(resolve, 65));
    }
    return result;
  });
  const colors = samples.map(({ pixel }) => pixel[0] > 150 ? 'red' : pixel[2] > 150 ? 'blue' : 'black');
  assert.ok(colors.includes('red') && colors.includes('blue'));
  assert.ok(!colors.includes('black'), 'no blank frames at cached joins');
  assert.ok(samples.some(sample => /repeat 2\/2/.test(sample.label)));
  assert.ok(colors.indexOf('blue') > 8, 'red repeated before blue');
  assert.ok(colors.slice(colors.indexOf('blue') + 7).includes('red'), 'whole chain wraps');
  await page.locator('#chain-play').click();
  await page.getByRole('button', { name: 'Move entry 2 up', exact: true }).click();
  assert.match(await page.locator('#chain-sequence>li').first().textContent(), /blue.mp4/);
  await page.getByRole('button', { name: 'Add red.mp4 to sequence', exact: true }).click();
  assert.equal(await page.locator('#chain-sequence>li').count(), 3);
  await page.getByRole('button', { name: 'Remove entry 3', exact: true }).click();
  await page.locator('#chain-loop').uncheck();
  await page.locator('#chain-play').click();
  await page.waitForFunction(() => document.querySelector('#chain-status').textContent.includes('Chain finished'));
  assert.match(await page.locator('#chain-now').textContent(), /red.mp4/);
  await page.locator('#chain-play').click();
  await page.locator('#mode-single').click();
  assert.equal(await page.locator('#chain-play').textContent(), 'Play chain');
  await page.locator('#mode-chain').click();
  await page.locator('#chain-files').setInputFiles({ name: 'broken.mp4', mimeType: 'video/mp4', buffer: Buffer.from('broken') });
  await page.waitForFunction(() => !document.querySelector('#chain-files').disabled);
  assert.match(await page.locator('#chain-status').textContent(), /broken.mp4/);
  assert.equal(await page.locator('#chain-library>li').count(), 2, 'invalid input preserves library');
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'mobile layout fits');
  // Gate the pending resume promise, then edit. A late resume cannot restart playback.
  await page.evaluate(() => {
    const original = AudioContext.prototype.resume;
    AudioContext.prototype.resume = function () {
      return new Promise(resolve => { window.finishChainResume = async () => { await original.call(this); resolve(); }; });
    };
  });
  await page.locator('#chain-play').click();
  await page.waitForFunction(() => !!window.finishChainResume);
  await page.locator('#chain-restart').click();
  await page.evaluate(() => window.finishChainResume());
  assert.equal(await page.locator('#chain-play').textContent(), 'Play chain');
  await page.getByRole('button', { name: 'Remove red.mp4 from library', exact: true }).click();
  assert.equal(await page.locator('#chain-sequence>li').count(), 1);
  await page.getByRole('button', { name: 'Remove blue.mp4 from library', exact: true }).click();
  assert.equal(await page.locator('#chain-play').isDisabled(), true);
  assert.equal(await page.locator('#chain-empty').isVisible(), true);
  // Offline PCM verifies every sample across repeats, clip joins, silence and wraps.
  const maxError = await page.evaluate(async () => {
    const { ChainTransport, chainPlan } = await import('./chain-engine.mjs');
    const context = new OfflineAudioContext(1, 10000, 48000);
    const gain = context.createGain(); gain.connect(context.destination);
    const audio = value => {
      const buffer = context.createBuffer(1, 240, 48000);
      buffer.getChannelData(0).fill(value); return buffer;
    };
    const clips = [ { id: 1, duration: .005, audio: audio(.5) }, { id: 2, duration: .005, audio: audio(.25) }, { id: 3, duration: .005, audio: null } ];
    const plan = chainPlan([{ clipId: 1, repeats: 2 }, { clipId: 2, repeats: 1 }, { clipId: 3, repeats: 1 }], clips);
    const transport = new ChainTransport(context, gain); transport.configure(plan, true); transport.start();
    const output = (await context.startRendering()).getChannelData(0);
    let error = 0;
    for (let i = 2400; i < output.length; i++) {
      const local = (i - 2400) % 960;
      const expected = local < 480 ? .5 : local < 720 ? .25 : 0;
      error = Math.max(error, Math.abs(output[i] - expected));
    }
    return error;
  });
  assert.ok(maxError < 1e-6, `gapless PCM error ${maxError}`);
  assert.deepEqual(errors, []);
  console.log('Chain browser checks passed: decoding, repeats, joins, wraps, stop, ordering, removal, labels, errors, mobile, stale Play, sample-exact audio.');
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
  await rm(temp, { recursive: true, force: true });
}
