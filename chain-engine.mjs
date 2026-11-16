import { loopPosition } from './loop-engine.mjs?v=chains-1';

export function chainPlan(entries, clips) {
  let duration = 0;
  const segments = entries.map(entry => {
    const clip = clips.find(clip => clip.id === entry.clipId);
    if (!clip || !(clip.duration > 0)) throw new Error('A sequence clip is missing.');
    if (!Number.isInteger(entry.repeats) || entry.repeats < 1 || entry.repeats > 999) {
      throw new Error('Repeat counts must be whole numbers from 1 to 999.');
    }
    const start = duration;
    duration += clip.duration * entry.repeats;
    return { clip, repeats: entry.repeats, start, end: duration };
  });
  return { segments, duration };
}

export function chainAt(plan, position) {
  if (!plan.segments.length) return null;
  const time = Math.max(0, Math.min(position, plan.duration));
  const index = plan.segments.findIndex(segment => segment.end > time);
  const segment = plan.segments[index < 0 ? plan.segments.length - 1 : index];
  const local = Math.max(0, time - segment.start);
  const repetition = Math.min(segment.repeats - 1, Math.floor(local / segment.clip.duration));
  return { segment, index: index < 0 ? plan.segments.length - 1 : index, repetition,
    position: Math.min(segment.clip.duration, local - repetition * segment.clip.duration) };
}

export function chainWarnings(plan, loop) {
  const warnings = [];
  const mismatch = (from, to, description) => {
    if (from.endLabel && to.startLabel && from.endLabel !== to.startLabel) {
      warnings.push(`${description}: ${from.endLabel} → ${to.startLabel} do not match.`);
    }
  };
  plan.segments.forEach((segment, i) => {
    if (segment.repeats > 1) mismatch(segment.clip, segment.clip, `Entry ${i + 1} repeats`);
    if (i) mismatch(plan.segments[i - 1].clip, segment.clip, `Join ${i} → ${i + 1}`);
  });
  if (loop && plan.segments.length) mismatch(plan.segments.at(-1).clip, plan.segments[0].clip, 'End → start');
  return warnings;
}

// Schedule decoded buffers on one audio clock, ahead of the display. A repeated
// entry uses one looping source; repeated pictures reference the same cache.
export class ChainTransport {
  constructor(context, gain) {
    this.context = context;
    this.gain = gain;
    this.sources = new Set();
    this.offset = 0;
    this.running = false;
  }
  configure(plan, loop = true) {
    this.pause();
    this.plan = plan;
    this.loop = loop;
    this.offset = 0;
  }
  elapsed(audible = false) {
    let clock = this.context.currentTime;
    if (audible && this.context.getOutputTimestamp) {
      const stamp = this.context.getOutputTimestamp();
      if (stamp.performanceTime > 0) clock = Math.min(clock,
        stamp.contextTime + (performance.now() - stamp.performanceTime) / 1000);
    }
    return this.offset + (this.running ? Math.max(0, clock - this.origin) : 0);
  }
  position(audible = false) {
    const time = this.elapsed(audible);
    return this.loop ? loopPosition(time, this.plan.duration) : Math.min(time, this.plan.duration);
  }
  start() {
    if (this.running || !this.plan?.duration) return;
    if (this.offset >= this.plan.duration) this.offset = 0;
    this.origin = this.context.currentTime + .05;
    this.next = this.offset;
    this.cycle = 0;
    this.index = chainAt(this.plan, this.offset).index;
    this.running = true;
    this.schedule();
  }
  schedule() {
    if (!this.running) return;
    const horizon = this.elapsed() + 2;
    while (this.next < horizon && (this.loop || this.next < this.plan.duration)) {
      const segment = this.plan.segments[this.index];
      const local = this.next - this.cycle * this.plan.duration - segment.start;
      const position = loopPosition(local, segment.clip.duration);
      const last = this.index === this.plan.segments.length - 1;
      const end = last ? (this.cycle + 1) * this.plan.duration : this.cycle * this.plan.duration + segment.end;
      const duration = end - this.next;
      if (!(duration > 0)) break;
      if (segment.clip.audio) {
        const source = this.context.createBufferSource();
        source.buffer = segment.clip.audio;
        source.loop = true;
        source.loopStart = 0;
        source.loopEnd = segment.clip.duration;
        source.connect(this.gain);
        const when = this.origin + this.next - this.offset;
        source.start(when, position);
        source.stop(when + duration);
        this.sources.add(source);
        source.onended = () => { source.disconnect(); this.sources.delete(source); };
      }
      this.next = end;
      if (last) { this.cycle++; this.index = 0; }
      else this.index++;
    }
  }
  pause() {
    if (this.running) this.offset = this.position(true);
    this.running = false;
    for (const source of this.sources) {
      source.onended = null;
      source.stop();
      source.disconnect();
    }
    this.sources.clear();
  }
}
