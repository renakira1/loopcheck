// Race every browser codec wait against cancellation and a no-progress deadline.
export async function exportStep(run, { signal, timeoutMs = 30000, label = 'Processing video' } = {}) {
  let timer, abort;
  const cancelled = () => new DOMException('Export cancelled', 'AbortError');
  if (signal?.aborted) throw cancelled();
  try {
    return await Promise.race([
      Promise.resolve().then(() => { if (signal?.aborted) throw cancelled(); return run(); }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} stopped responding for ${Math.round(timeoutMs / 1000)} seconds. Try the smaller export size or another browser.`)), timeoutMs); }),
      new Promise((_, reject) => { abort = () => reject(cancelled()); signal?.addEventListener('abort', abort, { once: true }); }),
    ]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

// The raw sample iterator can be returned while next() is pending. In contrast,
// an async-generator wrapper queues return() behind a hung next().
export class SequentialFrameReader {
  constructor(iterator, canvas) {
    this.iterator = iterator;
    this.canvas = canvas;
    this.context = canvas.getContext('2d', { alpha: false });
    this.peek = null;
    this.done = false;
    this.hasFrame = false;
  }
  async at(timestamp) {
    while (!this.done) {
      if (!this.peek) {
        const result = await this.iterator.next();
        if (result.done) { this.done = true; break; }
        this.peek = result.value;
      }
      if (this.peek.timestamp > timestamp + 1e-8) break;
      const frame = this.peek;
      this.peek = null;
      try {
        const scale = Math.min(this.canvas.width / frame.displayWidth, this.canvas.height / frame.displayHeight);
        const width = frame.displayWidth * scale, height = frame.displayHeight * scale;
        this.context.fillStyle = '#000';
        this.context.fillRect(0, 0, this.canvas.width, this.canvas.height);
        frame.draw(this.context, (this.canvas.width - width) / 2, (this.canvas.height - height) / 2, width, height);
        this.hasFrame = true;
      } finally { frame.close(); }
    }
    return this.hasFrame ? this.canvas : null;
  }
  close() {
    this.peek?.close();
    this.peek = null;
    this.done = true;
    return this.iterator.return();
  }
}
