import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chainPlan } from '../chain-engine.mjs';
import { RollingFrameCache, upcomingWindows, windowAt } from '../chain-cache.mjs';

const clip = (id, duration = 3) => ({ id, duration, width: 100, height: 100, frameRate: 30 });
test('prefetch follows repeats, next entries and whole-chain wrap', () => {
  const clips = [clip(1, .1), clip(2, .1)];
  const plan = chainPlan([{ clipId: 1, repeats: 2 }, { clipId: 2, repeats: 1 }], clips);
  assert.deepEqual(upcomingWindows(plan, .09, true).map(window => window.clip.id), [1, 2]);
  assert.deepEqual(upcomingWindows(plan, .29, true).map(window => window.clip.id), [2, 1]);
  assert.deepEqual(upcomingWindows(plan, .29, false).map(window => window.clip.id), [2]);
  assert.equal(windowAt(clips[1], clips[1].duration).end, clips[1].duration);
});
test('rolling cache evicts and releases frames while maintaining resolution and at most two readers', async () => {
  const limit = 1024 * 1024;
  const pictures = [], readers = [];
  let active = 0, maxActive = 0;
  const clips = [clip(1), clip(2), clip(3)];
  const plan = chainPlan(clips.map(clip => ({ clipId: clip.id, repeats: 2 })), clips);
  const cache = new RollingFrameCache({ limit, makeReader(clip) {
    active++; maxActive = Math.max(maxActive, active);
    const reader = { end: -Infinity, closed: false, async read(start, end) {
      this.end = end;
      const image = { width: clip.width, height: clip.height, closed: false, close() { this.closed = true; } };
      pictures.push(image);
      return { frames: [{ timestamp: start, image }], bytes: clip.width * clip.height * 4 };
    }, close() { if (!this.closed) active--; this.closed = true; } };
    readers.push(reader); return reader;
  } });
  for (let position = 0; position < plan.duration; position += .05) {
    await cache.update(plan, position, true);
    const current = plan.segments.find(segment => segment.end > position);
    const sourceTime = (position - current.start) % current.clip.duration;
    const frame = cache.frame(current.clip, sourceTime);
    assert.equal(frame.ready, true);
    assert.equal(frame.image.closed, false);
    assert.equal(frame.image.width, 100);
    assert.ok(cache.bytes <= limit);
  }
  assert.ok(pictures.some(image => image.closed), 'old frames released during playback');
  assert.ok(maxActive <= 2);
  assert.ok(readers.some(reader => reader.closed), 'old pipelines released');
  cache.dispose();
  assert.equal(cache.bytes, 0);
  assert.equal(active, 0);
  assert.ok(pictures.every(image => image.closed));
});
test('cancelling a stalled decoder frees it and a new prepare can complete', async () => {
  const clips = [clip(1)];
  const plan = chainPlan([{ clipId: 1, repeats: 1 }], clips);
  let started, release;
  const ready = new Promise(resolve => { started = resolve; });
  let attempts = 0;
  const cache = new RollingFrameCache({ makeReader() {
    const stalled = attempts++ === 0;
    return { end: -Infinity, read(start, end) {
      this.end = end;
      if (!stalled) return Promise.resolve({ frames: [], bytes: 0 });
      started(); return new Promise((_, reject) => { release = () => reject(new DOMException('Cancelled', 'AbortError')); });
    }, close() { if (stalled) release?.(); } };
  } });
  const pending = cache.update(plan, 0, true);
  await ready;
  cache.suspend();
  const retry = cache.update(plan, 0, true);
  await assert.rejects(pending, { name: 'AbortError' });
  await retry;
  assert.equal(cache.frame(clips[0], 0).ready, true);
  cache.dispose();
});
test('a nonresponding codec times out and closes its pipeline', async () => {
  let closed = false;
  const clips = [clip(1)];
  const cache = new RollingFrameCache({ timeoutMs: 10, makeReader: () => ({
    end: -Infinity, read: () => new Promise(() => {}), close() { closed = true; },
  }) });
  await assert.rejects(cache.update(chainPlan([{ clipId: 1, repeats: 1 }], clips), 0, true), /stopped responding/);
  assert.equal(closed, true);
  cache.dispose();
});
