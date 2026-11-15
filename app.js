import { Input, BlobSource, ALL_FORMATS, CanvasSink, AudioBufferSink } from './vendor/mediabunny-1.66.0.min.mjs';
import { copyAudioChunk, LoopTransport } from './loop-engine.mjs?v=lossless-1';

import { repairPlan, paintPreview, quietEdges, repairedAudio } from './repair.mjs?v=lossless-1';
import { exportLoop } from './export-video.mjs?v=lossless-1';

const $ = selector => document.querySelector(selector);
const fileInput = $('#file');
const canvas = $('#video');
const draw = canvas.getContext('2d', { alpha: false });
const stage = $('#dropzone');
const play = $('#play');
const mute = $('#mute');
const loading = $('#loading');
const message = $('#message');
const MEMORY_LIMIT = 128 * 1024 * 1024;
const MAX_DURATION = 30;
let context, gain, transport, prepared;
let task = null;
let dragDepth = 0;
let animation = 0;
let activePlan, activeAudio;
let repairedPlan, repairBuffer, repairGain = 1;
let mode = 'repaired';
let exportController = null;
let downloadUrl;
let lastTick = 0;
let muted = false;
let playbackRequest = 0;
let pendingPlay = false;

function release(media) {
  for (const frame of media?.frames ?? []) frame.image.close();
}
function pause(reason) {
  playbackRequest++;
  pendingPlay = false;
  transport?.pause();
  cancelAnimationFrame(animation);
  play.textContent = 'Play';
  if (reason) message.textContent = reason;
}
function render() {
  if (!transport?.running || !prepared) return;
  const now = performance.now();
  if (lastTick && now - lastTick > 100) {
    message.textContent = 'Display stalled during playback. Pause other work and replay before judging the seam.';
  }
  lastTick = now;
  paint(transport.position(true));
  animation = requestAnimationFrame(render);
}
function paint(position) {
  paintPreview(draw, prepared.frames, activePlan, position, canvas.width, canvas.height);
}
function invalidateDownload() {
  if (downloadUrl) URL.revokeObjectURL(downloadUrl);
  downloadUrl = null;
  $('#download').hidden = true;
  $('#download').removeAttribute('href');
  $('#export-status').textContent = '';
}
function selectPreview(nextMode) {
  pause();
  mode = nextMode;
  $('#original').setAttribute('aria-pressed', String(mode === 'original'));
  $('#repaired').setAttribute('aria-pressed', String(mode === 'repaired'));
  activePlan = mode === 'original' ? repairPlan(prepared.duration, prepared.sampleRate, 0) : repairedPlan;
  activeAudio = mode === 'original' ? prepared.audio : repairBuffer;
  transport.configure(activePlan.duration, activeAudio);
  paint(0);
  $('#duration').textContent = `${activePlan.duration.toFixed(2)}s · ${mode}`;
  message.textContent = `${mode === 'original' ? 'Original' : 'Repaired'} preview ready. Press Play or play across the join.`;
}
function applyRepair() {
  if (!prepared || exportController) return;
  pause();
  invalidateDownload();
  const trim = $('#trim-silence').checked;
  repairedPlan = repairPlan(prepared.duration, prepared.sampleRate, Number($('#overlap').value) / 1000,
    trim ? prepared.trimStart : 0, trim ? prepared.trimEnd : 0);
  const result = repairedAudio(prepared.audio, repairedPlan, $('#audio-curve').value);
  repairBuffer = result.buffer;
  repairGain = result.gain;
  $('#overlap-value').textContent = `${Math.round(repairedPlan.overlap * 1000)} ms`;
  $('#repair-info').textContent = `Original ${prepared.duration.toFixed(2)}s → repaired ${repairedPlan.duration.toFixed(2)}s. ` +
    `${Math.round(repairedPlan.overlap * 1000)} ms end-to-start overlap.` +
    (trim ? ` Quiet-edge removal: ${Math.round(prepared.trimStart * 1000)} ms start, ${Math.round(prepared.trimEnd * 1000)} ms end.` : '') +
    (repairGain < 1 ? ` Audio lowered ${(-20 * Math.log10(repairGain)).toFixed(1)} dB across the whole clip to prevent clipping.` : '');
  selectPreview(mode);
}
function setupEditor() {
  const edges = quietEdges(prepared.audio);
  prepared.trimStart = edges.leading >= .01 ? Math.min(edges.leading, .5, prepared.duration / 4) : 0;
  prepared.trimEnd = edges.trailing >= .01 ? Math.min(edges.trailing, .5, prepared.duration / 4) : 0;
  $('#trim-silence').checked = false;
  $('#trim-silence').disabled = !prepared.audio || (!prepared.trimStart && !prepared.trimEnd);
  $('#audio-curve').disabled = !prepared.audio;
  const missing = Math.max(0, prepared.duration - prepared.decodedAudioEnd);
  $('#audio-diagnostic').textContent = !prepared.audio ? 'This clip has no audio track.' : edges.allQuiet ? 'The audio is near-silent throughout; edge removal is disabled.' :
    `Quiet edges (below −60 dB): ${Math.round(edges.leading * 1000)} ms start, ${Math.round(edges.trailing * 1000)} ms end. ` +
    (missing > .005 ? `The original timeline extends ${Math.round(missing * 1000)} ms beyond decoded audio; that section is padded with silence. ` : '') +
    'Removal is optional and limited to 500 ms per edge. Quiet audio may be intentional.';
  const maximum = Math.floor(Math.min(2, prepared.duration / 3) * 100) * 10;
  $('#overlap').max = maximum;
  $('#overlap').value = Math.min(250, Math.floor(prepared.duration * 1000 / 8 / 10) * 10, maximum);
  mode = 'repaired';
  $('#editor').hidden = false;
  updateExportSpec();
  applyRepair();
}
function checkTask(current) {
  if (task !== current) throw new DOMException('Cancelled', 'AbortError');
}
async function loadVideo(file) {
  if (!file) return;
  if (exportController) { message.textContent = 'Cancel or finish the download preparation before changing videos.'; return; }
  if (file.type && !file.type.startsWith('video/')) {
    message.textContent = 'Choose a video file to check its loop.';
    return;
  }
  pause();
  invalidateDownload();
  $('#editor').hidden = true;
  activeAudio = repairBuffer = null;
  if (transport) transport.audio = null;
  if (task) { task.cancelled = true; task.input?.dispose(); }
  const current = {};
  task = current;
  release(prepared);
  prepared = null;
  canvas.hidden = true;
  $('#empty').hidden = true;
  $('#controls').hidden = false;
  play.disabled = true;
  loading.hidden = false;
  loading.textContent = 'Preparing loop…';
  message.textContent = 'Decoding every frame and audio sample. Nothing is uploaded.';
  $('#filename').textContent = file.name;
  $('#duration').textContent = '';
  $('#quality').textContent = '';
  const frames = [];
  let input;
  try {
    if (!window.isSecureContext || !window.VideoDecoder || !window.AudioContext || !window.createImageBitmap) {
      throw new Error('This player needs HTTPS and a browser with WebCodecs, Web Audio, and ImageBitmap support. Try a current Chrome, Edge, or Safari.');
    }
    if (file.size > 100 * 1024 * 1024) throw new Error('Choose a video smaller than 100 MB.');
    if (!context) {
      context = new AudioContext();
      gain = context.createGain();
      gain.gain.value = muted ? 0 : 1;
      gain.connect(context.destination);
      transport = new LoopTransport(context, gain);
      context.addEventListener('statechange', () => {
        if (context.state !== 'running' && transport.running) pause('Playback was interrupted. Press Play to resume.');
      });
    }
    input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
    current.input = input;
    const videoTrack = await input.getPrimaryVideoTrack();
    const audioTrack = await input.getPrimaryAudioTrack();
    checkTask(current);
    if (!videoTrack || !await videoTrack.canDecode()) throw new Error('This browser cannot decode the video codec in this file. Try another browser or file.');
    if (audioTrack && !await audioTrack.canDecode()) throw new Error('This browser cannot decode this file’s audio. The loop test requires its original sound.');
    const end = await input.computeDuration(audioTrack ? [videoTrack, audioTrack] : [videoTrack]);
    if (!(end > 0) || end > MAX_DURATION) throw new Error('Use a video up to 30 seconds long for a fully predecoded loop.');
    const sampleRate = audioTrack ? await audioTrack.getSampleRate() : 48000;
    const channels = audioTrack ? await audioTrack.getNumberOfChannels() : 0;
    // Audio and picture share exactly the same period, quantized once to an audio sample.
    const sampleCount = Math.ceil(end * sampleRate);
    const duration = sampleCount / sampleRate;
    const audioBytes = sampleCount * channels * 4 * 2; // Reserve original + repaired PCM.
    if (audioBytes > MEMORY_LIMIT / 2) throw new Error('This audio track needs too much memory for a mobile-safe loop.');
    const metrics = await videoTrack.computeFrameRateMetrics();
    const estimatedFrames = Math.ceil(end * Math.max(1, metrics.bestGuessFrameRate || 30) * 1.1);
    const originalWidth = videoTrack.displayWidth;
    const originalHeight = videoTrack.displayHeight;
    const scale = Math.min(1, 1280 / Math.max(originalWidth, originalHeight),
      Math.sqrt((MEMORY_LIMIT - audioBytes) * 0.8 / (estimatedFrames * originalWidth * originalHeight * 4)));
    const width = Math.max(1, Math.floor(originalWidth * scale));
    const height = Math.max(1, Math.floor(originalHeight * scale));
    const frameBytes = width * height * 4;
    checkTask(current);
    const sink = new CanvasSink(videoTrack, { width, height, fit: 'fill', poolSize: 1 });
    let usedBytes = audioBytes;
    for await (const result of sink.canvases()) {
      checkTask(current);
      if (result.timestamp + result.duration <= 0) continue;
      if (usedBytes + frameBytes > MEMORY_LIMIT) throw new Error('The decoded clip exceeds the 128 MB cache limit. Use a shorter or lower-resolution video.');
      const image = await createImageBitmap(result.canvas);
      frames.push({ image, timestamp: Math.max(0, result.timestamp) });
      usedBytes += frameBytes;
      loading.textContent = `Preparing loop… ${Math.min(99, Math.round(result.timestamp / end * 100))}%`;
    }
    checkTask(current);
    if (!frames.length) throw new Error('No video frames could be decoded.');
    let audio = null;
    let decodedAudioEnd = 0;
    if (audioTrack) {
      audio = new AudioBuffer({ length: sampleCount, numberOfChannels: channels, sampleRate });
      let chunks = 0;
      for await (const chunk of new AudioBufferSink(audioTrack).buffers()) {
        checkTask(current);
        copyAudioChunk(audio, chunk.buffer, chunk.timestamp);
        decodedAudioEnd = Math.max(decodedAudioEnd, chunk.timestamp + chunk.buffer.duration);
        chunks++;
      }
      if (!chunks) throw new Error('The audio track could not be decoded.');
    }
    checkTask(current);
    prepared = { frames, audio, duration, sampleRate, decodedAudioEnd, file, width: originalWidth, height: originalHeight,
      frameRate: Math.min(60, Math.max(1, metrics.bestGuessFrameRate || 30)) };
    canvas.width = width;
    canvas.height = height;
    updateFullscreenControls();
    canvas.hidden = false;
    setupEditor();
    $('#quality').textContent = `${frames.length} frames cached · ${width} × ${height}${scale < 0.999 ? ' preview (reduced resolution)' : ' preview'} · ${audio ? 'audio cached' : 'no audio track'}`;
    play.disabled = false;
    message.textContent = 'Repaired preview ready. Compare with Original, or play across the join.';
  } catch (error) {
    release({ frames });
    if (task === current) {
      prepared = null;
      $('#editor').hidden = true;
      message.textContent = error.message || 'This file could not be decoded.';
      $('#quality').textContent = '';
    }
  } finally {
    input?.dispose();
    if (task === current) { loading.hidden = true; task = null; }
  }
}
fileInput.addEventListener('change', () => {
  loadVideo(fileInput.files[0]);
  fileInput.value = '';
});
play.addEventListener('click', async () => {
  if (!prepared || exportController) return;
  if (transport.running || pendingPlay) { pause('Paused. Press Play to resume.'); return; }
  const media = prepared;
  const request = ++playbackRequest;
  pendingPlay = true;
  play.textContent = 'Starting…';
  try {
    await context.resume();
    if (request !== playbackRequest || prepared !== media || exportController || document.hidden || transport.running) return;
    if (context.state !== 'running') throw new Error('Audio is suspended. Press Play again.');
    transport.start();
    lastTick = 0;
    play.textContent = 'Pause';
    message.textContent = `Playing ${mode} from memory. Watch and listen for the seam.`;
    render();
  } catch (error) {
    if (request === playbackRequest) message.textContent = error.message || 'Playback could not start.';
  } finally {
    if (request === playbackRequest) {
      pendingPlay = false;
      if (!transport.running) play.textContent = 'Play';
    }
  }
});
mute.addEventListener('click', () => {
  muted = !muted;
  if (gain) gain.gain.setTargetAtTime(muted ? 0 : 1, context.currentTime, 0.005);
  mute.textContent = muted ? 'Unmute' : 'Mute';
  mute.setAttribute('aria-pressed', String(muted));
});
let fullscreenStyles = null;
function updateFullscreenControls() {
  const expanded = document.fullscreenElement === stage || stage.classList.contains('expanded');
  const exit = $('#exit-fullscreen');
  exit.hidden = !expanded;
  exit.style.display = expanded ? 'inline-flex' : 'none';
  $('#fullscreen').textContent = expanded ? 'Exit fullscreen' : 'Fullscreen';
  $('#fullscreen').setAttribute('aria-pressed', String(expanded));
  if (expanded) {
    // Keep critical sizing and visibility independent of stylesheet caching.
    // Set the actual fitted box, rather than trusting grid intrinsic sizing.
    fullscreenStyles ??= { stage: stage.getAttribute('style'), canvas: canvas.getAttribute('style'), overflow: document.body.style.overflow };
    document.body.style.overflow = 'hidden';
    Object.assign(stage.style, { position: 'fixed', inset: '0', display: 'block', width: '100%', height: '100%',
      minWidth: '0', minHeight: '0', maxWidth: 'none', maxHeight: 'none', margin: '0', padding: '0',
      background: '#000', border: '0', borderRadius: '0', overflow: 'hidden', zIndex: '10' });
    const bounds = stage.getBoundingClientRect();
    const scale = Math.min(bounds.width / canvas.width, bounds.height / canvas.height);
    const width = canvas.width * scale;
    const height = canvas.height * scale;
    Object.assign(canvas.style, { position: 'absolute', inset: 'auto', left: `${(bounds.width - width) / 2}px`,
      top: `${(bounds.height - height) / 2}px`, width: `${width}px`, height: `${height}px`,
      minWidth: '0', minHeight: '0', maxWidth: 'none', maxHeight: 'none', objectFit: 'contain', margin: '0' });
    Object.assign(exit.style, { position: 'absolute', top: '16px', right: '16px', zIndex: '20', background: '#111c', color: '#fff' });
  } else if (fullscreenStyles) {
    for (const [element, original] of [[stage, fullscreenStyles.stage], [canvas, fullscreenStyles.canvas]]) {
      if (original === null) element.removeAttribute('style');
      else element.setAttribute('style', original);
    }
    document.body.style.overflow = fullscreenStyles.overflow;
    fullscreenStyles = null;
  }
}
async function exitFullscreen() {
  try {
    if (document.fullscreenElement === stage) await document.exitFullscreen();
    stage.classList.remove('expanded');
    updateFullscreenControls();
    $('#fullscreen').focus({ preventScroll: true });
  } catch { message.textContent = 'Fullscreen could not close. Press Escape to exit.'; }
}
$('#fullscreen').addEventListener('click', async () => {
  if (document.fullscreenElement === stage || stage.classList.contains('expanded')) {
    await exitFullscreen();
    return;
  }
  try {
    if (stage.requestFullscreen) await stage.requestFullscreen();
    else stage.classList.add('expanded');
    updateFullscreenControls();
    $('#exit-fullscreen').focus({ preventScroll: true });
  } catch { message.textContent = 'Fullscreen could not open. You can continue watching here.'; }
});
$('#exit-fullscreen').addEventListener('click', exitFullscreen);
document.addEventListener('fullscreenchange', updateFullscreenControls);
window.addEventListener('resize', updateFullscreenControls);
window.visualViewport?.addEventListener('resize', updateFullscreenControls);
updateFullscreenControls();
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && stage.classList.contains('expanded')) exitFullscreen();
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden && (transport?.running || pendingPlay)) pause('Paused while the page is hidden. Press Play to continue the test.');
});
window.addEventListener('dragover', event => event.preventDefault());
window.addEventListener('drop', event => event.preventDefault());
stage.addEventListener('dragenter', event => { event.preventDefault(); dragDepth++; stage.classList.add('dragging'); });
stage.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) stage.classList.remove('dragging'); });
stage.addEventListener('drop', event => {
  event.preventDefault(); dragDepth = 0; stage.classList.remove('dragging'); loadVideo(event.dataTransfer.files[0]);
});
window.addEventListener('pagehide', () => { pause(); exportController?.abort(); });

$('#original').addEventListener('click', () => { if (!exportController && prepared) selectPreview('original'); });
$('#repaired').addEventListener('click', () => { if (!exportController && prepared) selectPreview('repaired'); });
$('#overlap').addEventListener('input', () => { $('#overlap-value').textContent = `${$('#overlap').value} ms`; });
$('#overlap').addEventListener('change', applyRepair);
$('#audio-curve').addEventListener('change', applyRepair);
$('#trim-silence').addEventListener('change', applyRepair);
$('#preview-join').addEventListener('click', () => {
  if (!prepared || exportController) return;
  pause();
  transport.offset = Math.max(0, activePlan.duration - Math.max(.5, activePlan.overlap * 1.5));
  paint(transport.offset);
  play.click();
});
function updateExportSpec() {
  if (!prepared) return;
  const lossless = $('#export-quality').value === 'lossless';
  if (lossless) $('#export-size').value = 'original';
  $('#export-size option[value="preview"]').disabled = lossless;
  const smaller = $('#export-size').value === 'preview';
  const width = Math.ceil((smaller ? canvas.width : prepared.width) / 2) * 2;
  const height = Math.ceil((smaller ? canvas.height : prepared.height) / 2) * 2;
  const reduced = width < Math.ceil(prepared.width / 2) * 2 || height < Math.ceil(prepared.height / 2) * 2;
  const quality = lossless ? 'lossless VP9 + float PCM · MKV' : $('#export-quality').value === 'high' ? 'high quality · lossy MP4/WebM' : 'smaller file · lossy MP4/WebM';
  $('#export-spec').textContent = `Download: ${width} × ${height} · ${quality} · ${prepared.frameRate.toFixed(2).replace(/\.00$/, '')} fps base cadence + dissolve frames. ` +
    (smaller ? (reduced ? 'Reduced resolution: this discards detail. ' : 'Cached preview at source dimensions. ') : 'Original resolution. ') + 'Mute affects preview only.';
  $('#quality-help').textContent = lossless ? 'No lossy codec fallback. Picture blending and canvas color conversion still change pixels. Large MKV files may need a compatible player such as VLC.' : 'Re-encoding is lossy, even at original resolution. High quality prioritizes detail over file size. Dissolves can still ghost.';
}
for (const id of ['#export-size', '#export-quality']) $(id).addEventListener('change', () => { updateExportSpec(); invalidateDownload(); });
$('#cancel-export').addEventListener('click', () => exportController?.abort());
$('#export').addEventListener('click', async () => {
  if (!prepared || exportController) return;
  pause('Preparing the repaired download. Playback is paused.');
  invalidateDownload();
  const controller = new AbortController();
  exportController = controller;
  $('#repair-settings').disabled = true;
  $('#export-size').disabled = true;
  $('#export-quality').disabled = true;
  fileInput.disabled = true;
  for (const selector of ['#play', '#original', '#repaired', '#preview-join', '#export']) $(selector).disabled = true;
  $('#cancel-export').hidden = false;
  $('#export-status').textContent = 'Checking encoders…';
  let progress = 0;
  const smaller = $('#export-size').value === 'preview';
  const dimensions = smaller ? { width: canvas.width, height: canvas.height } : { width: prepared.width, height: prepared.height };
  try {
    const result = await exportLoop({ file: prepared.file, plan: repairedPlan, audio: repairBuffer,
      ...dimensions, qualityMode: $('#export-quality').value, cachedFrames: smaller ? prepared.frames : null, frameRate: prepared.frameRate, signal: controller.signal,
      onProgress: fraction => { progress = Math.round(fraction * 100); $('#export-status').textContent = `Rendering repaired video… ${progress}%`; },
      onStage: stage => { $('#export-status').textContent = progress ? `Rendering repaired video… ${progress}% · ${stage}` : `${stage}…`; } });
    downloadUrl = URL.createObjectURL(result.blob);
    $('#download').href = downloadUrl;
    $('#download').download = `${prepared.file.name.replace(/\.[^.]+$/, '')}-repaired.${result.extension.replace(/^\./, '')}`;
    $('#download').hidden = false;
    $('#export-status').textContent = `Ready: ${repairedPlan.duration.toFixed(2)}s · ${result.width} × ${result.height} · ${(result.blob.size / 1024 / 1024).toFixed(1)} MB. Download and re-open it to check the encoded result.${result.fallbackReason ? ` ${result.fallbackReason}` : ''}`;
  } catch (error) {
    $('#export-status').textContent = error.name === 'AbortError' ? 'Download preparation cancelled.' : `Download could not be prepared: ${error.message}`;
  } finally {
    exportController = null;
    $('#repair-settings').disabled = false;
    $('#export-size').disabled = false;
    $('#export-quality').disabled = false;
    fileInput.disabled = false;
    for (const selector of ['#play', '#original', '#repaired', '#preview-join', '#export']) $(selector).disabled = false;
    $('#cancel-export').hidden = true;
  }
});
