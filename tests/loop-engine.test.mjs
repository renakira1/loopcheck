import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loopPosition, frameAt, copyAudioChunk, LoopTransport } from '../loop-engine.mjs';

test('frame selection wraps directly from last frame to first, including VFR', () => {
  const frames = [{timestamp: 0}, {timestamp: .05}, {timestamp: .2}];
  for (let cycle = 0; cycle < 1000; cycle++) {
    assert.equal(frameAt(frames, loopPosition(cycle + .999, 1)), 2);
    assert.equal(frameAt(frames, loopPosition(cycle + 1, 1)), 0);
  }
  assert.equal(frameAt([{timestamp: .1}], 0), -1);
  assert.equal(frameAt(frames, .05), 1);
});
function buffer(values, rate = 4) {
  const data = Float32Array.from(values);
  return { sampleRate: rate, numberOfChannels: 1, length: data.length, getChannelData: () => data };
}
test('PCM assembly preserves negative priming, track offsets, gaps, and end clipping', () => {
  const target = buffer(new Array(8).fill(0));
  copyAudioChunk(target, buffer([8,9,1,2]), -.5);
  copyAudioChunk(target, buffer([3,4]), 1);
  copyAudioChunk(target, buffer([5,6,7]), 1.75);
  assert.deepEqual([...target.getChannelData(0)], [1,2,0,0,3,4,0,5]);
  assert.throws(() => copyAudioChunk(target, buffer([1], 8), 0), /format changes/);
});
test('one continuously looping source is scheduled; pause/resume retains phase', () => {
  const sources = [];
  const context = {currentTime: 10, createBufferSource() {
    const source = {connect(){}, start(...args){this.started = args;}, stop(){this.stopped = true;}, disconnect(){}};
    sources.push(source); return source;
  }};
  const transport = new LoopTransport(context, {});
  transport.configure(1, {});
  transport.start();
  assert.equal(sources[0].loop, true);
  assert.deepEqual(sources[0].started, [10.05, 0]);
  for (let cycle = 0; cycle < 100; cycle++) {
    context.currentTime = 10.05 + cycle + .5;
    assert.ok(Math.abs(transport.position() - .5) < 1e-10);
  }
  assert.equal(sources.length, 1);
  transport.pause();
  assert.equal(sources[0].stopped, true);
  context.currentTime += 10;
  transport.start();
  assert.ok(Math.abs(sources[1].started[1] - .5) < 1e-10);
  transport.configure(2, null);
  assert.equal(transport.offset, 0);
  transport.start();
  assert.equal(sources.length, 2, 'silent clips use the clock without an audio source');
});
