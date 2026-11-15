// Timeline helpers are independent of display refresh rate and loop count.
export function loopPosition(time, period) {
  return ((time % period) + period) % period;
}

export function frameAt(frames, position) {
  let low = 0;
  let high = frames.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (frames[mid].timestamp <= position) low = mid + 1;
    else high = mid;
  }
  return low - 1; // -1 means the video track has not started yet.
}

// Preserve track offsets and gaps. Clip only samples outside the container timeline.
export function copyAudioChunk(target, chunk, timestamp) {
  if (chunk.sampleRate !== target.sampleRate || chunk.numberOfChannels !== target.numberOfChannels) {
    throw new Error('Audio format changes within this file are not supported.');
  }
  const start = Math.round(timestamp * target.sampleRate);
  const sourceStart = Math.max(0, -start);
  const destinationStart = Math.max(0, start);
  const count = Math.min(chunk.length - sourceStart, target.length - destinationStart);
  if (count <= 0) return;
  for (let channel = 0; channel < target.numberOfChannels; channel++) {
    target.getChannelData(channel).set(
      chunk.getChannelData(channel).subarray(sourceStart, sourceStart + count), destinationStart,
    );
  }
}

export class LoopTransport {
  constructor(context, gain) {
    this.context = context;
    this.gain = gain;
    this.offset = 0;
    this.running = false;
  }
  configure(duration, audio) {
    this.pause();
    this.duration = duration;
    this.audio = audio;
    this.offset = 0;
  }
  start() {
    if (this.running) return;
    this.origin = this.context.currentTime + 0.05;
    if (this.audio) {
      const source = this.context.createBufferSource();
      source.buffer = this.audio;
      source.loop = true;
      source.loopStart = 0;
      source.loopEnd = this.duration;
      source.connect(this.gain);
      source.start(this.origin, this.offset);
      this.source = source;
    }
    this.running = true;
  }
  position(audible = false) {
    let clock = this.context.currentTime;
    // Align canvas presentation with audio reaching the output device, where supported.
    if (audible && this.context.getOutputTimestamp) {
      const stamp = this.context.getOutputTimestamp();
      if (stamp.performanceTime > 0) {
        clock = Math.min(clock, stamp.contextTime + (performance.now() - stamp.performanceTime) / 1000);
      }
    }
    return loopPosition(this.offset + (this.running ? Math.max(0, clock - this.origin) : 0), this.duration);
  }
  pause() {
    if (this.running) this.offset = this.position(true);
    this.running = false;
    if (this.source) {
      this.source.stop();
      this.source.disconnect();
      this.source = null;
    }
  }
}
