import { Input, BlobSource, ALL_FORMATS, VideoSampleSink, AudioBufferSink } from './vendor/mediabunny-1.66.0.min.mjs';
import { copyAudioChunk } from './loop-engine.mjs?v=rolling-1';

export const VIDEO_CACHE_BYTES = 128 * 1024 * 1024;
export const AUDIO_CACHE_BYTES = 64 * 1024 * 1024;

export function releaseClip(clip) {
  // Video pictures belong to the rolling cache, not the library.
  if (clip) clip.audio = null;
}

export async function chainStep(run, signal, label = 'Preparing preview', timeoutMs = 15000) {
  signal.throwIfAborted();
  let timer, abort;
  try {
    return await Promise.race([
      Promise.resolve().then(() => { signal.throwIfAborted(); return run(); }),
      new Promise((_, reject) => { abort = () => reject(new DOMException('Cancelled', 'AbortError')); signal.addEventListener('abort', abort, { once: true }); }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} stopped responding. Try Play again or another browser.`)), timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
  }
}

// Import metadata and PCM only. Video resolution never depends on library size.
export async function decodeChainClip(file, audioBudget, signal, progress) {
  if (!window.isSecureContext || !window.VideoDecoder || !window.AudioContext || !window.createImageBitmap) {
    throw new Error('Use HTTPS and a browser with WebCodecs and Web Audio support.');
  }
  if (file.size > 100 * 1024 * 1024) throw new Error('Each clip must be smaller than 100 MB.');
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  const abort = () => input.dispose();
  signal.addEventListener('abort', abort, { once: true });
  try {
    return await chainStep(async () => {
      const video = await input.getPrimaryVideoTrack();
      const sound = await input.getPrimaryAudioTrack();
      if (!video || !await video.canDecode()) throw new Error('This video codec cannot be decoded by this browser.');
      if (sound && !await sound.canDecode()) throw new Error('This audio codec cannot be decoded by this browser.');
      const end = await input.computeDuration(sound ? [video, sound] : [video]);
      if (!(end >= .05) || end > 30) throw new Error('Each clip must be between 0.05 and 30 seconds long.');
      const sampleRate = sound ? await sound.getSampleRate() : 48000;
      const channels = sound ? await sound.getNumberOfChannels() : 0;
      const samples = Math.ceil(end * sampleRate);
      const bytes = samples * channels * 4;
      if (bytes > audioBudget) throw new Error('The 64 MiB audio cache is full. Remove a clip or use shorter files. Preview resolution is unchanged.');
      const metrics = await video.computeFrameRateMetrics();
      const scale = Math.min(1, 1280 / Math.max(video.displayWidth, video.displayHeight));
      const width = Math.max(1, Math.floor(video.displayWidth * scale));
      const height = Math.max(1, Math.floor(video.displayHeight * scale));
      let audio = null;
      if (sound) {
        audio = new AudioBuffer({ length: samples, numberOfChannels: channels, sampleRate });
        let chunks = 0;
        for await (const chunk of new AudioBufferSink(sound).buffers()) {
          signal.throwIfAborted();
          copyAudioChunk(audio, chunk.buffer, chunk.timestamp);
          progress(Math.min(99, Math.round(chunk.timestamp / end * 100)));
          chunks++;
        }
        if (!chunks) throw new Error('No audio samples could be decoded.');
      }
      signal.throwIfAborted();
      return { name: file.name, file, audio, duration: samples / sampleRate, width, height, bytes,
        sourceWidth: video.displayWidth, sourceHeight: video.displayHeight,
        frameRate: Math.max(1, metrics.bestGuessFrameRate || 30), startLabel: '', endLabel: '' };
    }, signal, 'Reading clip');
  } finally {
    signal.removeEventListener('abort', abort);
    input.dispose();
  }
}

// A sequential sample reader survives adjacent cache windows, avoiding a seek
// back to a keyframe for every window. At most one lookahead sample is retained.
export class ChainVideoReader {
  constructor(clip) {
    this.clip = clip;
    this.input = new Input({ source: new BlobSource(clip.file), formats: ALL_FORMATS });
    this.canvas = document.createElement('canvas');
    this.canvas.width = clip.width; this.canvas.height = clip.height;
    this.context = this.canvas.getContext('2d', { alpha: false });
    this.timestamp = -Infinity;
    this.end = -Infinity;
    this.closed = false;
  }
  async read(start, end, maxBytes, signal) {
    const frames = [];
    const frameBytes = this.clip.width * this.clip.height * 4;
    const check = () => {
      signal.throwIfAborted();
      if (this.closed) throw new DOMException('Cancelled', 'AbortError');
    };
    const capture = async () => {
      if ((frames.length + 1) * frameBytes > maxBytes) throw new Error('This video has too many frames in one preview window. Try another browser or clip; resolution was not reduced.');
      const image = await createImageBitmap(this.canvas);
      if (signal.aborted || this.closed) { image.close(); check(); }
      frames.push({ image, timestamp: this.timestamp });
    };
    try {
      check();
      if (!this.iterator) {
        const track = await this.input.getPrimaryVideoTrack();
        check();
        this.iterator = new VideoSampleSink(track).samples(start);
      }
      if (this.timestamp > -Infinity) await capture();
      while (!this.done) {
        check();
        if (!this.peek) {
          const result = await this.iterator.next();
          if (signal.aborted || this.closed) { result.value?.close(); check(); }
          if (result.done) { this.done = true; break; }
          this.peek = result.value;
        }
        if (this.peek.timestamp >= end) break;
        const sample = this.peek; this.peek = null;
        try {
          this.context.fillStyle = '#000';
          this.context.fillRect(0, 0, this.clip.width, this.clip.height);
          sample.draw(this.context, 0, 0, this.clip.width, this.clip.height);
          this.timestamp = sample.timestamp;
        } finally { sample.close(); }
        // samples(start) includes the predecessor needed for VFR and track gaps.
        await capture();
      }
      check();
      this.end = end;
      return { frames, bytes: frames.length * frameBytes };
    } catch (error) {
      for (const frame of frames) frame.image.close();
      throw error;
    }
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.peek?.close(); this.peek = null;
    this.input.dispose();
    // Input disposal unblocks a pending read. Do not await a stuck iterator.
    Promise.resolve(this.iterator?.return()).catch(() => {});
    this.canvas.width = this.canvas.height = 1;
  }
}
