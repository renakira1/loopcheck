// Lossless has no bitrate fallback: unsupported constant-quantizer encoding
// must fail visibly rather than silently producing another lossy download.
export function encodingQuality(mode, width, height, frameRate) {
  if (mode === 'lossless') return { quantizer: 0 };
  if (mode === 'high') return { quantizer: 12, bitrate: Math.min(80e6, Math.max(8e6, width * height * frameRate * .6)) };
  if (mode === 'standard') return { bitrate: Math.min(24e6, Math.max(2e6, width * height * frameRate * .15)) };
  throw new Error('Unknown export quality.');
}
