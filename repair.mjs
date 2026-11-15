import { frameAt } from './loop-engine.mjs?v=audit-fixes-1';

// One shared, sample-aligned timeline keeps the audio and picture in sync.
export function repairPlan(duration, sampleRate, overlap, trimStart = 0, trimEnd = 0) {
  const total = Math.round(duration * sampleRate);
  const start = Math.min(total - 1, Math.max(0, Math.round(trimStart * sampleRate)));
  const end = Math.max(start + 1, total - Math.max(0, Math.round(trimEnd * sampleRate)));
  const count = Math.min(Math.floor((end - start) / 2), Math.max(0, Math.round(overlap * sampleRate)));
  return { start: start / sampleRate, end: end / sampleRate, overlap: count / sampleRate,
    duration: (end - start - count) / sampleRate, sampleRate, startSample: start, endSample: end, overlapSamples: count };
}

// Start after the opening overlap, then blend the tail into that opening.
// At wrap, the incoming opening continues at start+overlap: no repeated segment.
export function blendAt(plan, position) {
  const first = plan.start + plan.overlap + position;
  const blendStart = plan.duration - plan.overlap;
  if (!plan.overlap || position < blendStart) return { first, second: null, mix: 0 };
  const fraction = Math.max(0, Math.min(1, (position - blendStart) / plan.overlap));
  return { first, second: plan.start + position - blendStart, mix: fraction * fraction * (3 - 2 * fraction) };
}

export function drawBlend(context, first, second, mix, width, height) {
  context.globalAlpha = 1;
  context.fillStyle = '#000';
  context.fillRect(0, 0, width, height);
  if (first) context.drawImage(first, 0, 0, width, height);
  if (mix > 0) {
    context.globalAlpha = mix;
    if (second) context.drawImage(second, 0, 0, width, height);
    else context.fillRect(0, 0, width, height);
  }
  context.globalAlpha = 1;
}

export function paintPreview(context, frames, plan, position, width, height) {
  const blend = blendAt(plan, position);
  const first = frames[frameAt(frames, blend.first)]?.image;
  const second = blend.second === null ? null : frames[frameAt(frames, blend.second)]?.image;
  drawBlend(context, first, second, blend.mix, width, height);
}

// This detects quiet samples, not intent: removing them is always an explicit choice.
export function quietEdges(audio, threshold = 0.001) {
  if (!audio) return { leading: 0, trailing: 0, allQuiet: false };
  const channels = Array.from({ length: audio.numberOfChannels }, (_, c) => audio.getChannelData(c));
  const quiet = i => channels.every(channel => Math.abs(channel[i]) <= threshold);
  let start = 0;
  while (start < audio.length && quiet(start)) start++;
  if (start === audio.length) return { leading: 0, trailing: 0, allQuiet: true };
  let end = audio.length;
  while (end > start && quiet(end - 1)) end--;
  return { leading: start / audio.sampleRate, trailing: (audio.length - end) / audio.sampleRate, allQuiet: false };
}

export function repairedAudio(audio, plan, curve = 'equal-power', createBuffer = options => new AudioBuffer(options)) {
  if (!audio) return { buffer: null, gain: 1 };
  const { startSample: start, endSample: end, overlapSamples: overlap } = plan;
  const length = end - start - overlap;
  const buffer = createBuffer({ length, numberOfChannels: audio.numberOfChannels, sampleRate: audio.sampleRate });
  let peak = 0;
  for (let channel = 0; channel < audio.numberOfChannels; channel++) {
    const source = audio.getChannelData(channel);
    const target = buffer.getChannelData(channel);
    target.set(source.subarray(start + overlap, end));
    for (let i = 0; i < overlap; i++) {
      const fraction = i / overlap;
      const outgoing = curve === 'equal-power' ? Math.cos(fraction * Math.PI / 2) : 1 - fraction;
      const incoming = curve === 'equal-power' ? Math.sin(fraction * Math.PI / 2) : fraction;
      target[length - overlap + i] = source[end - overlap + i] * outgoing + source[start + i] * incoming;
    }
    for (let i = 0; i < length; i++) peak = Math.max(peak, Math.abs(target[i]));
  }
  // Constant-power blending can boost correlated audio. Use one static gain for
  // the whole clip rather than clipping samples or pumping just at the seam.
  const gain = peak > 1 ? 1 / peak : 1;
  if (gain < 1) {
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      const channel = buffer.getChannelData(c);
      for (let i = 0; i < channel.length; i++) channel[i] *= gain;
    }
  }
  return { buffer, gain };
}
