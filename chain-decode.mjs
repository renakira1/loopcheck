import { Input, BlobSource, ALL_FORMATS, CanvasSink, AudioBufferSink } from './vendor/mediabunny-1.66.0.min.mjs';
import { copyAudioChunk } from './loop-engine.mjs?v=chains-1';

export function releaseClip(clip) {
  for (const frame of clip?.frames ?? []) frame.image.close();
}

export async function decodeChainClip(file, budget, signal, progress) {
  if (!window.isSecureContext || !window.VideoDecoder || !window.AudioContext || !window.createImageBitmap) {
    throw new Error('Use HTTPS and a browser with WebCodecs and Web Audio support.');
  }
  if (file.size > 100 * 1024 * 1024) throw new Error('Each clip must be smaller than 100 MB.');
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  const frames = [];
  const abort = () => input.dispose();
  signal.addEventListener('abort', abort, { once: true });
  try {
    signal.throwIfAborted();
    const video = await input.getPrimaryVideoTrack();
    const sound = await input.getPrimaryAudioTrack();
    if (!video || !await video.canDecode()) throw new Error('This video codec cannot be decoded by this browser.');
    if (sound && !await sound.canDecode()) throw new Error('This audio codec cannot be decoded by this browser.');
    const end = await input.computeDuration(sound ? [video, sound] : [video]);
    if (!(end >= .05) || end > 30) throw new Error('Each clip must be between 0.05 and 30 seconds long.');
    const sampleRate = sound ? await sound.getSampleRate() : 48000;
    const channels = sound ? await sound.getNumberOfChannels() : 0;
    const samples = Math.ceil(end * sampleRate);
    const duration = samples / sampleRate;
    let bytes = samples * channels * 4;
    if (bytes > budget / 2) throw new Error('Not enough cache space. Remove a clip or use shorter files.');
    const metrics = await video.computeFrameRateMetrics();
    const estimatedFrames = Math.ceil(end * Math.max(1, metrics.bestGuessFrameRate || 30) * 1.1);
    const scale = Math.min(1, 960 / Math.max(video.displayWidth, video.displayHeight),
      Math.sqrt((budget - bytes) * .8 / (estimatedFrames * video.displayWidth * video.displayHeight * 4)));
    const width = Math.max(1, Math.floor(video.displayWidth * scale));
    const height = Math.max(1, Math.floor(video.displayHeight * scale));
    const frameBytes = width * height * 4;
    for await (const result of new CanvasSink(video, { width, height, fit: 'fill', poolSize: 1 }).canvases()) {
      signal.throwIfAborted();
      if (result.timestamp + result.duration <= 0) continue;
      if (bytes + frameBytes > budget) throw new Error('The clip exceeds the remaining cache space. Remove a clip or use a shorter file.');
      const image = await createImageBitmap(result.canvas);
      frames.push({ image, timestamp: Math.max(0, result.timestamp) });
      bytes += frameBytes;
      progress(Math.min(99, Math.round(result.timestamp / end * 100)));
    }
    if (!frames.length) throw new Error('No video frames could be decoded.');
    let audio = null;
    if (sound) {
      audio = new AudioBuffer({ length: samples, numberOfChannels: channels, sampleRate });
      let chunks = 0;
      for await (const chunk of new AudioBufferSink(sound).buffers()) {
        signal.throwIfAborted();
        copyAudioChunk(audio, chunk.buffer, chunk.timestamp);
        chunks++;
      }
      if (!chunks) throw new Error('No audio samples could be decoded.');
    }
    signal.throwIfAborted();
    return { name: file.name, frames, audio, duration, width, height, bytes, startLabel: '', endLabel: '' };
  } catch (error) {
    releaseClip({ frames });
    throw error;
  } finally {
    signal.removeEventListener('abort', abort);
    input.dispose();
  }
}
