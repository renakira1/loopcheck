import { Input, BlobSource, ALL_FORMATS, VideoSampleSink, Output, BufferTarget, Mp4OutputFormat,
  WebMOutputFormat, CanvasSource, AudioBufferSource, Quality, canEncodeVideo, canEncodeAudio } from './vendor/mediabunny-1.66.0.min.mjs';
import { blendAt, drawBlend, paintPreview } from './repair.mjs?v=software-export-1';
import { exportFrameTimes } from './export-timeline.mjs?v=software-export-1';

import { exportStep, SequentialFrameReader } from './export-runtime.mjs?v=software-export-1';

async function exportAttempt({ file, plan, audio, width, height, frameRate, cachedFrames = null, onProgress = () => {}, onStage = () => {}, signal, timeoutMs = 30000, webmOnly = false }) {
  const step = async (label, run) => {
    onStage(label);
    try { return await exportStep(run, { signal, timeoutMs, label }); }
    catch (error) { error.exportStage ??= label; throw error; }
  };
  // Re-decode the source for export, so a reduced preview never becomes the master.
  width = Math.ceil(width / 2) * 2;
  height = Math.ceil(height / 2) * 2;
  const videoQuality = new Quality({ bitrate: Math.min(24e6, Math.max(2e6, width * height * frameRate * 0.15)) });
  const audioOptions = audio ? { numberOfChannels: audio.numberOfChannels, sampleRate: audio.sampleRate } : {};
  const videoOptions = { width, height, frameRate, quality: videoQuality, hardwareAcceleration: 'prefer-software', latencyMode: 'quality' };
  const check = () => { if (signal?.aborted) throw new DOMException('Export cancelled', 'AbortError'); };
  let format, videoCodec, audioCodec;
  if (!webmOnly && await step('Checking MP4 video encoder', () => canEncodeVideo('avc', videoOptions)) && (!audio || await step('Checking AAC audio encoder', () => canEncodeAudio('aac', audioOptions)))) {
    format = new Mp4OutputFormat(); videoCodec = 'avc'; audioCodec = 'aac';
  } else if (await step('Checking WebM video encoder', () => canEncodeVideo('vp9', videoOptions)) && (!audio || await step('Checking Opus audio encoder', () => canEncodeAudio('opus', audioOptions)))) {
    format = new WebMOutputFormat(); videoCodec = 'vp9'; audioCodec = 'opus';
  } else {
    throw new Error('This browser cannot encode this clip with its audio at the original resolution. Try desktop Chrome or Edge.');
  }
  check();
  const target = new BufferTarget();
  const output = new Output({ format, target });
  const input = cachedFrames ? null : new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  let mainReader, headReader;
  let finalized = false;
  try {
    const videoTrack = input ? await step('Reading original video', () => input.getPrimaryVideoTrack()) : null;
    check();
    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    const context = canvas.getContext('2d', { alpha: false });
    const videoSource = new CanvasSource(canvas, { codec: videoCodec, quality: videoQuality, hardwareAcceleration: 'prefer-software', latencyMode: 'quality' });
    output.addVideoTrack(videoSource); // Allow the final frame to have a partial duration.
    const audioSource = audio ? new AudioBufferSource({ codec: audioCodec, quality: new Quality({ bitrate: 192000 }) }) : null;
    if (audioSource) output.addAudioTrack(audioSource);
    await step('Starting output', () => output.start());
    check();
    // Add the smaller audio data first. Both sources still carry exact timestamps;
    // encoding isn't tied to wall time, refresh rate, or playback muting.
    if (audioSource) { await step('Encoding repaired audio', () => audioSource.add(audio)); audioSource.close(); }
    const timestamps = exportFrameTimes(plan, frameRate);
    const count = timestamps.length;
    const times = timestamps.map(timestamp => blendAt(plan, timestamp));
    if (videoTrack) {
      const makeReader = start => {
        const target = document.createElement('canvas'); target.width = width; target.height = height;
        return new SequentialFrameReader(new VideoSampleSink(videoTrack).samples(start), target);
      };
      mainReader = makeReader(times[0].first);
      headReader = plan.overlap ? makeReader(plan.start) : null;
    }
    for (let i = 0; i < count; i++) {
      check();
      if (cachedFrames) {
        paintPreview(context, cachedFrames, plan, timestamps[i], width, height);
      } else {
        const first = await step(`Decoding main frame ${i + 1}/${count}`, () => mainReader.at(times[i].first));
        const second = times[i].second === null ? null : await step(`Decoding opening frame ${i + 1}/${count}`, () => headReader.at(times[i].second));
        drawBlend(context, first, second, times[i].mix, width, height);
      }
      const timestamp = timestamps[i];
      const next = timestamps[i + 1] ?? plan.duration;
      await step(`Encoding frame ${i + 1}/${count}`, () => videoSource.add(timestamp, next - timestamp));
      onProgress((i + 1) / count);
    }
    check();
    videoSource.close();
    await step('Finalizing download', () => output.finalize());
    finalized = true;
    check();
    return { blob: new Blob([target.buffer], { type: format.mimeType }), extension: format.fileExtension, width, height, frameRate };
  } catch (error) {
    error.videoCodec = videoCodec;
    throw error;
  } finally {
    // Unblock pending reads before waiting for cleanup. Never leave the UI
    // hostage to an encoder that also fails to respond to cancellation.
    const cleanup = [mainReader?.close(), headReader?.close()];
    input?.dispose();
    if (!finalized) cleanup.push(output.cancel());
    let timer;
    try { await Promise.race([Promise.allSettled(cleanup), new Promise(resolve => { timer = setTimeout(resolve, 1000); })]); }
    finally { clearTimeout(timer); }
  }
}

export async function exportLoop(options) {
  try { return await exportAttempt(options); }
  catch (error) {
    if (options.signal?.aborted || error.name === 'AbortError') throw error;
    const encodingVideo = error.exportStage?.startsWith('Encoding frame') || error.exportStage === 'Finalizing download';
    if (error.videoCodec !== 'avc' || !encodingVideo) throw error;
    // Some platform H.264 encoders accept configuration, then stop draining
    // their input queue. Restart the whole render with an independent codec.
    // Resolution, repair timing, and sound remain the same.
    options.onProgress?.(0);
    options.onStage?.('MP4 encoder failed; retrying as software WebM');
    const result = await exportAttempt({ ...options, webmOnly: true });
    return { ...result, fallbackReason: 'Used WebM after the MP4 encoder failed.' };
  }
}
