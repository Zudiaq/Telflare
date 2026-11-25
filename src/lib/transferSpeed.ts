const WINDOW_MS = 750;

export class TransferSpeedTracker {
  private samples: Array<{ time: number; bytes: number }> = [];

  reset(bytes = 0): void {
    this.samples = [{ time: performance.now(), bytes }];
  }

  update(bytes: number, now = performance.now()): number {
    if (this.samples.length === 0) this.reset(bytes);
    this.samples.push({ time: now, bytes });
    const cutoff = now - WINDOW_MS;
    while (this.samples.length > 2 && this.samples[1].time < cutoff) {
      this.samples.shift();
    }
    const first = this.samples[0];
    const elapsed = now - first.time;
    if (elapsed < 80) return 0;
    return Math.max(0, (bytes - first.bytes) * 1000 / elapsed);
  }
}
