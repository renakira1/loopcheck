import { chainAt } from './chain-engine.mjs?v=rolling-1';
import { frameAt } from './loop-engine.mjs?v=rolling-1';
import { ChainVideoReader, VIDEO_CACHE_BYTES, chainStep } from './chain-decode.mjs?v=rolling-1';

export function windowDuration(clip, limit = VIDEO_CACHE_BYTES) {
  // Three protected windows, plus room for predecessors and transient bitmaps.
  const count = Math.max(1, Math.floor(limit / 4 / (clip.width * clip.height * 4)) - 2);
  return Math.min(.4, count / (clip.frameRate * 1.25));
}
export function windowAt(clip, position, limit = VIDEO_CACHE_BYTES) {
  const span = windowDuration(clip, limit);
  const index = Math.floor(Math.max(0, Math.min(position, clip.duration - 1e-9)) / span);
  const start = index * span;
  return { key: `${clip.id}:${index}`, clip, start, end: Math.min(clip.duration, (index + 1) * span) };
}

// Walk actual playback order, including entry repeats, short clips and wrap.
export function upcomingWindows(plan, position, loop, limit = VIDEO_CACHE_BYTES) {
  const windows = [];
  const seen = new Set();
  let time = position;
  const stop = Math.min(position + .8, loop ? Infinity : plan.duration);
  for (let step = 0; step < 100 && time < stop && windows.length < 3; step++) {
    const local = loop ? ((time % plan.duration) + plan.duration) % plan.duration : time;
    const current = chainAt(plan, local);
    if (!current) break;
    const window = windowAt(current.segment.clip, current.position, limit);
    if (!seen.has(window.key)) { windows.push(window); seen.add(window.key); }
    const remaining = window.end - current.position;
    // Tiny rounding errors at a repeated boundary must not strand prefetch.
    time += Math.max(1e-8, remaining);
  }
  // Play-once final-frame inspection still needs the last window.
  if (!windows.length && plan.duration) windows.push(windowAt(plan.segments.at(-1).clip, plan.segments.at(-1).clip.duration, limit));
  return windows;
}

export class RollingFrameCache {
  constructor({ limit = VIDEO_CACHE_BYTES, makeReader = clip => new ChainVideoReader(clip), timeoutMs = 15000 } = {}) {
    this.limit = limit;
    this.makeReader = makeReader;
    this.timeoutMs = timeoutMs;
    this.windows = new Map();
    this.readers = new Map();
    this.bytes = 0;
    this.peakBytes = 0;
    this.targets = [];
    this.controller = new AbortController();
  }
  frame(clip, position) {
    const window = this.windows.get(windowAt(clip, position, this.limit).key);
    if (!window) return { ready: false };
    return { ready: true, image: window.frames[frameAt(window.frames, position)]?.image ?? null };
  }
  evict(key) {
    const window = this.windows.get(key);
    if (!window) return;
    this.windows.delete(key);
    this.bytes -= window.bytes;
    for (const frame of window.frames) frame.image.close();
  }
  update(plan, position, loop) {
    if (this.disposed) return Promise.reject(new DOMException('Cancelled', 'AbortError'));
    this.targets = upcomingWindows(plan, position, loop, this.limit);
    if (this.work) return this.work;
    const signal = this.controller.signal;
    const work = this.fill(signal);
    this.work = work;
    work.finally(() => { if (this.work === work) this.work = null; }).catch(() => {});
    return work;
  }
  async fill(signal) {
    try {
      while (true) {
        signal.throwIfAborted();
        const target = this.targets.find(target => !this.windows.has(target.key));
        if (!target) break;
        const pinned = new Set(this.targets.map(target => target.key));
        // Reserve a full window before decoding so partial allocations count too.
        const reserve = Math.floor(this.limit / 4);
        for (const key of this.windows.keys()) {
          if (this.bytes + reserve <= this.limit) break;
          if (!pinned.has(key)) this.evict(key);
        }
        if (this.bytes + reserve > this.limit) throw new Error('The preview window exceeds its memory budget. Resolution was not reduced.');
        let reader = this.readers.get(target.clip.id);
        if (reader && Math.abs(reader.end - target.start) > 1e-8) {
          reader.close(); this.readers.delete(target.clip.id); reader = null;
        }
        if (!reader) {
          // Keep no more than two live decoder pipelines; cached windows remain reusable.
          if (this.readers.size >= 2) {
            const [id, old] = this.readers.entries().next().value;
            old.close(); this.readers.delete(id);
          }
          reader = this.makeReader(target.clip);
          this.readers.set(target.clip.id, reader);
        }
        const result = await chainStep(() => reader.read(target.start, target.end, reserve, signal), signal, 'Decoding preview', this.timeoutMs);
        if (signal.aborted || this.disposed) {
          for (const frame of result.frames) frame.image.close();
          signal.throwIfAborted();
        }
        this.windows.set(target.key, result);
        this.bytes += result.bytes;
        this.peakBytes = Math.max(this.peakBytes, this.bytes);
      }
    } catch (error) {
      // Disposing the input also releases a hung codec and late-returned samples.
      if (this.controller.signal === signal) {
        for (const reader of this.readers.values()) reader.close();
        this.readers.clear();
      }
      throw error;
    }
  }
  suspend() {
    this.controller.abort();
    this.controller = new AbortController();
    for (const reader of this.readers.values()) reader.close();
    this.readers.clear();
    this.work = null;
  }
  dispose() {
    this.disposed = true;
    this.suspend();
    for (const key of this.windows.keys()) this.evict(key);
  }
}
