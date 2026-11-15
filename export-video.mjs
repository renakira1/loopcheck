import { Input, BlobSource, ALL_FORMATS, CanvasSink, Output, BufferTarget, Mp4OutputFormat,
  WebMOutputFormat, CanvasSource, AudioBufferSource, Quality, canEncodeVideo, canEncodeAudio } from './vendor/mediabunny-1.66.0.min.mjs';
import { blendAt, drawBlend } from './repair.mjs?v=audit-fixes-1';
import { exportFrameTimes } from './export-timeline.mjs?v=audit-fixes-1';

export async function exportLoop({ file, plan, audio, width, height, frameRate, onProgress = () => {}, signal }) {
  // Re-decode the source for export, so a reduced preview never becomes the master.
  width = Math.ceil(width / 2) * 2;
  height = Math.ceil(height / 2) * 2;
  const videoQuality = new Quality({ bitrate: Math.min(24e6, Math.max(2e6, width * height * frameRate * 0.15)) });
  const audioOptions = audio ? { numberOfChannels: audio.numberOfChannels, sampleRate: audio.sampleRate } : {};
  const videoOptions = { width, height, frameRate, quality: videoQuality };
  const check = () => { if (signal?.aborted) throw new DOMException('Export cancelled', 'AbortError'); };
  let format, videoCodec, audioCodec;
  if (await canEncodeVideo('avc', videoOptions) && (!audio || await canEncodeAudio('aac', audioOptions))) {
    format = new Mp4OutputFormat(); videoCodec = 'avc'; audioCodec = 'aac';
  } else if (await canEncodeVideo('vp9', videoOptions) && (!audio || await canEncodeAudio('opus', audioOptions))) {
    format = new WebMOutputFormat(); videoCodec = 'vp9'; audioCodec = 'opus';
  } else {
    throw new Error('This browser cannot encode this clip with its audio at the original resolution. Try desktop Chrome or Edge.');
  }
  check();
  const target = new BufferTarget();
  const output = new Output({ format, target });
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  let mainIterator, headIterator;
  let finalized = false;
  try {
    const videoTrack = await input.getPrimaryVideoTrack();
    check();
    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    const context = canvas.getContext('2d', { alpha: false });
    const videoSource = new CanvasSource(canvas, { codec: videoCodec, quality: videoQuality });
    output.addVideoTrack(videoSource); // Allow the final frame to have a partial duration.
    const audioSource = audio ? new AudioBufferSource({ codec: audioCodec, quality: new Quality({ bitrate: 192000 }) }) : null;
    if (audioSource) output.addAudioTrack(audioSource);
    await output.start();
    check();
    // Add the smaller audio data first. Both sources still carry exact timestamps;
    // encoding isn't tied to wall time, refresh rate, or playback muting.
    if (audioSource) { await audioSource.add(audio); audioSource.close(); }
    const timestamps = exportFrameTimes(plan, frameRate);
    const count = timestamps.length;
    const times = timestamps.map(timestamp => blendAt(plan, timestamp));
    const options = { width, height, fit: 'contain', poolSize: 1 };
    mainIterator = new CanvasSink(videoTrack, options).canvasesAtTimestamps(times.map(time => time.first));
    headIterator = new CanvasSink(videoTrack, options).canvasesAtTimestamps(times.filter(time => time.second !== null).map(time => time.second));
    for (let i = 0; i < count; i++) {
      check();
      const first = (await mainIterator.next()).value?.canvas;
      const second = times[i].second === null ? null : (await headIterator.next()).value?.canvas;
      drawBlend(context, first, second, times[i].mix, width, height);
      const timestamp = timestamps[i];
      const next = timestamps[i + 1] ?? plan.duration;
      await videoSource.add(timestamp, next - timestamp);
      onProgress((i + 1) / count);
    }
    check();
    videoSource.close();
    await output.finalize();
    finalized = true;
    check();
    return { blob: new Blob([target.buffer], { type: format.mimeType }), extension: format.fileExtension, width, height, frameRate };
  } finally {
    // Release decoders even on cancellation or encoder failure.
    await Promise.allSettled([mainIterator?.return(), headIterator?.return()]);
    if (!finalized) await output.cancel().catch(() => {});
    input.dispose();
  }
}
