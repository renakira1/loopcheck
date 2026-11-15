// Retain source cadence outside the dissolve, and explicitly sample the
// dissolve itself. A short overlap must not disappear between source frames.
export function exportFrameTimes(plan, frameRate) {
  if (!(frameRate > 0) || !Number.isFinite(frameRate)) throw new Error('Invalid export frame rate.');
  const times = [];
  const blendStart = plan.duration - plan.overlap;
  const count = Math.ceil(plan.duration * frameRate);
  for (let i = 0; i < count; i++) {
    const time = i / frameRate;
    if (!plan.overlap || time < blendStart) times.push(time);
  }
  if (plan.overlap) {
    // Four intervals ensure quarter/midpoint/three-quarter blend samples even
    // when the whole dissolve is shorter than one normal frame interval.
    const intervals = Math.max(4, Math.ceil(plan.overlap * Math.max(60, frameRate)));
    for (let i = 0; i < intervals; i++) times.push(blendStart + plan.overlap * i / intervals);
  }
  // WebCodecs timestamps have microsecond precision. Deduplicate after rounding
  // so very short segments cannot generate coincident encoded frames.
  const end = Math.round(plan.duration * 1e6);
  const ticks = [...new Set(times.map(time => Math.round(time * 1e6)).filter(tick => tick >= 0 && tick < end))].sort((a,b) => a-b);
  return ticks.map(tick => tick / 1e6);
}
