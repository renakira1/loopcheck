import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chainPlan, chainAt, chainWarnings, ChainTransport } from '../chain-engine.mjs';

const clips = [
  { id: 1, duration: .3, startLabel: 'A', endLabel: 'A', audio: { id: 'a' } },
  { id: 2, duration: .2, startLabel: 'A', endLabel: 'B', audio: { id: 'b' } },
  { id: 3, duration: .4, startLabel: 'B', endLabel: 'B', audio: null },
  { id: 4, duration: .1, startLabel: 'B', endLabel: 'A', audio: { id: 'd' } },
];
const entries = [{ clipId: 1, repeats: 3 }, { clipId: 2, repeats: 1 }, { clipId: 3, repeats: 5 }, { clipId: 4, repeats: 1 }];
test('chain lookup preserves repeated clips, boundary ownership, silence and final frame', () => {
  const plan = chainPlan(entries, clips);
  assert.ok(Math.abs(plan.duration - 3.2) < 1e-12);
  assert.equal(chainAt(plan, .31).repetition, 1);
  assert.equal(chainAt(plan, plan.segments[1].start).segment.clip.id, 2);
  assert.equal(chainAt(plan, plan.segments[2].start).segment.clip.audio, null);
  assert.equal(chainAt(plan, plan.duration).segment.clip.id, 4);
  assert.ok(Math.abs(chainAt(plan, plan.duration).position - .1) < 1e-12);
  assert.deepEqual(chainWarnings(plan, true), []);
  assert.throws(() => chainPlan([{ clipId: 1, repeats: 0 }], clips), /Repeat counts/);
  assert.throws(() => chainPlan([{ clipId: 99, repeats: 1 }], clips), /missing/);
  assert.equal(chainAt(chainPlan([], []), 0), null);
});
test('endpoint warnings cover transition repeats, adjacent entries, and optional wrap', () => {
  const plan = chainPlan([{ clipId: 2, repeats: 2 }, { clipId: 1, repeats: 1 }], clips);
  assert.equal(chainWarnings(plan, false).length, 2);
  const transition = chainPlan([{ clipId: 2, repeats: 1 }], clips);
  assert.equal(chainWarnings(transition, false).length, 0);
  assert.equal(chainWarnings(transition, true).length, 1);
});
function mockContext() {
  const sources = [];
  return { currentTime: 0, sources, createBufferSource() {
    const source = { connect() {}, disconnect() {}, start(...args) { this.started = args; }, stop(time) { this.stopped = time; } };
    sources.push(source); return source;
  } };
}
test('audio schedule has contiguous boundaries and compressed repeats across many cycles', () => {
  const context = mockContext();
  const transport = new ChainTransport(context, {});
  const plan = chainPlan([{ clipId: 1, repeats: 3 }, { clipId: 2, repeats: 1 }], clips);
  transport.configure(plan, true);
  transport.start();
  for (let i = 0; i < 1000; i++) { context.currentTime += .1; transport.schedule(); }
  assert.ok(context.sources.length > 100);
  for (let i = 1; i < context.sources.length; i++) {
    assert.ok(Math.abs(context.sources[i].started[0] - context.sources[i - 1].stopped) < 1e-12);
  }
  assert.equal(context.sources[0].buffer, clips[0].audio);
  assert.ok(Math.abs(context.sources[0].stopped - .95) < 1e-12);
  assert.equal(context.sources[0].loop, true);
  transport.pause();
  assert.equal(transport.sources.size, 0);
});
test('pause/resume in a repetition starts at the correct source offset; play-once stops', () => {
  const context = mockContext();
  const transport = new ChainTransport(context, {});
  const plan = chainPlan(entries, clips);
  transport.configure(plan, false);
  transport.start();
  context.currentTime = .4;
  transport.pause();
  assert.ok(Math.abs(transport.offset - .35) < 1e-12);
  const before = context.sources.length;
  transport.start();
  assert.ok(Math.abs(context.sources[before].started[1] - .05) < 1e-12);
  context.currentTime = 20;
  transport.schedule();
  assert.equal(transport.position(), plan.duration);
  assert.ok(context.sources.every(source => source.buffer !== null));
  transport.pause(); transport.start();
  assert.equal(transport.offset, 0);
});
