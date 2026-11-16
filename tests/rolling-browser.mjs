import assert from 'node:assert/strict';

export async function rollingChecks(browser, base, high, small) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(base);
    await page.locator('#mode-chain').click();
    // Sequential import reproduces the reported leftover-budget failure.
    await page.locator('#chain-files').setInputFiles(high);
    await page.waitForFunction(() => document.querySelector('#chain-library').children.length === 1 && !document.querySelector('#chain-files').disabled);
    await page.locator('#chain-files').setInputFiles(high);
    await page.waitForFunction(() => document.querySelector('#chain-library').children.length === 2 && !document.querySelector('#chain-files').disabled);
    const details = await page.locator('#chain-library small').allTextContents();
    assert.ok(details.every(detail => detail.includes('1280 × 720 preview')), details.join('\n'));
    assert.equal(await page.locator('#chain-video').getAttribute('width'), '1280');
    await page.locator('#chain-play').click();
    await page.waitForFunction(() => document.querySelector('#chain-play').textContent === 'Pause');
    const result = await page.evaluate(async () => {
      const seen = new Set(); let buffering = 0, black = 0;
      for (let i = 0; i < 100; i++) {
        const label = document.querySelector('#chain-now').textContent;
        if (label.includes('Entry 2')) seen.add('second');
        if (seen.has('second') && label.includes('Entry 1')) seen.add('wrap');
        if (document.querySelector('#chain-play').textContent === 'Buffering…') buffering++;
        const canvas = document.querySelector('#chain-video');
        const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
        let bright = 0;
        for (let p = 0; p < pixels.length; p += 701) bright += pixels[p];
        if (!bright) black++;
        await new Promise(resolve => setTimeout(resolve, 90));
      }
      return { seen: [...seen], buffering, black, status: document.querySelector('#chain-status').textContent };
    });
    assert.ok(result.seen.includes('second') && result.seen.includes('wrap'), JSON.stringify(result));
    assert.equal(result.black, 0, 'no blank frames while crossing high-resolution joins');
    assert.equal(result.buffering, 0, 'normal 720p playback keeps ahead of the clock');
    await page.locator('#chain-play').click();
    // Hold a real decoder result until the initial lookahead runs out. Playback
    // must freeze instead of skipping footage, and manual Pause cancels recovery.
    await page.locator('#chain-restart').click();
    await page.waitForFunction(() => document.querySelector('#chain-now').textContent.includes('1280 × 720 preview'));
    await page.evaluate(async () => {
      const { VideoSampleSink } = await import('./vendor/mediabunny-1.66.0.min.mjs');
      const original = VideoSampleSink.prototype.samples;
      window.holdNextDecode = true;
      VideoSampleSink.prototype.samples = function (...args) {
        const iterator = original.apply(this, args);
        return {
          async next() {
            const result = await iterator.next();
            if (window.holdNextDecode && !result.done) {
              window.holdNextDecode = false;
              await new Promise(resolve => { window.releaseHeldDecode = resolve; });
            }
            return result;
          },
          return: () => iterator.return(),
        };
      };
    });
    await page.locator('#chain-play').click();
    await page.waitForFunction(() => document.querySelector('#chain-play').textContent === 'Buffering…');
    const frozen = await page.locator('#chain-now').textContent();
    await page.waitForTimeout(150);
    assert.equal(await page.locator('#chain-now').textContent(), frozen, 'picture position stays frozen while buffering');
    await page.locator('#chain-play').click();
    await page.evaluate(() => window.releaseHeldDecode());
    await page.waitForTimeout(100);
    assert.equal(await page.locator('#chain-play').textContent(), 'Play chain', 'late decoder result cannot restart a cancelled recovery');
    await page.locator('#chain-play').click();
    await page.waitForFunction(() => document.querySelector('#chain-play').textContent === 'Pause');
    await page.locator('#chain-play').click();
    // Compare cached pixels to independent direct decoding at window boundaries,
    // on both clips, after eviction, and following a backward seek/repeat.
    const decoded = await page.evaluate(async () => {
      const { decodeChainClip } = await import('./chain-decode.mjs?v=rolling-1');
      const { RollingFrameCache } = await import('./chain-cache.mjs?v=rolling-1');
      const { chainPlan } = await import('./chain-engine.mjs?v=rolling-1');
      const { Input, BlobSource, ALL_FORMATS, CanvasSink } = await import('./vendor/mediabunny-1.66.0.min.mjs');
      const file = new File([await (await fetch('/__fixture/high.mp4')).blob()], 'high.mp4');
      const signal = new AbortController().signal;
      const first = await decodeChainClip(file, 64 * 1024 * 1024, signal, () => {}); first.id = 1;
      const second = { ...first, id: 2 };
      const plan = chainPlan([{ clipId: 1, repeats: 1 }, { clipId: 2, repeats: 1 }], [first, second]);
      const cache = new RollingFrameCache();
      const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
      const sink = new CanvasSink(await input.getPrimaryVideoTrack(), { width: 1280, height: 720, fit: 'fill' });
      const canvas = document.createElement('canvas'); canvas.width = 1280; canvas.height = 720;
      const ctx = canvas.getContext('2d');
      let maxError = 0, evicted = false;
      try {
        for (const [clip, time] of [[first, 0], [first, .1], [first, .25], [first, .399], [first, .4], [first, .81], [first, 1.03], [first, 1.99], [first, 3.9], [second, 0], [second, .81], [second, 3.9], [first, 0]]) {
          await cache.update(plan, (clip.id === 2 ? first.duration : 0) + time, true);
          const frame = cache.frame(clip, time);
          if (!frame.ready || !frame.image) throw new Error(`Missing frame at ${clip.id}:${time}`);
          ctx.drawImage(frame.image, 0, 0);
          const actual = ctx.getImageData(0, 0, 1280, 720).data;
          const expected = (await sink.getCanvas(time)).canvas.getContext('2d').getImageData(0, 0, 1280, 720).data;
          for (let i = 0; i < actual.length; i += 137) maxError = Math.max(maxError, Math.abs(actual[i] - expected[i]));
          if (cache.bytes > cache.limit) throw new Error('Cache exceeded its limit');
          if (time > 1 && !cache.frame(first, 0).ready) evicted = true;
        }
        return { maxError, peakBytes: cache.peakBytes, evicted, width: second.width, height: second.height };
      } finally { cache.dispose(); input.dispose(); }
    });
    assert.equal(decoded.maxError, 0, JSON.stringify(decoded));
    assert.equal(decoded.evicted, true, 'old high-resolution frames were evicted');
    assert.ok(decoded.peakBytes <= 128 * 1024 * 1024);
    // A low-resolution first clip sets aspect ratio, not the output pixel budget.
    while (await page.locator('#chain-library>li').count()) {
      await page.locator('#chain-library>li').first().getByRole('button', { name: /from library$/ }).click();
    }
    await page.locator('#chain-files').setInputFiles(small);
    await page.waitForFunction(() => document.querySelector('#chain-library').children.length === 1 && !document.querySelector('#chain-files').disabled);
    await page.locator('#chain-files').setInputFiles(high);
    await page.waitForFunction(() => document.querySelector('#chain-library').children.length === 2 && !document.querySelector('#chain-files').disabled);
    assert.equal(await page.locator('#chain-video').getAttribute('width'), '1280');
    assert.equal(await page.locator('#chain-video').getAttribute('height'), '720');
    await page.locator('#chain-play').click();
    await page.waitForFunction(() => /Entry 2.*1280 × 720 preview/.test(document.querySelector('#chain-now').textContent));
    await page.locator('#chain-play').click();
    assert.deepEqual(errors, []);
    console.log('Rolling 720p regression passed:', { ...decoded, playbackBuffering: result.buffering });
  } finally { await page.close(); }
}
