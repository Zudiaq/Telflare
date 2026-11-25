
const BASE_GAP_MS = 120;
const MAX_GAP_MS = 3000;
const CALM_AFTER_MS = 60000;

interface Job {
  prio: number;
  seq: number;
  fn: () => Promise<any>;
  resolve: (v: any) => void;
  reject: (e: any) => void;
}

const queue: Job[] = [];
let running = false;
let seq = 0;
let lastStart = 0;
let blockedUntil = 0;
let lastFlood = 0;
let gap = BASE_GAP_MS;

const sleep = (ms: number) => new Promise(res => setTimeout(res, ms));

export const getFloodWaitSeconds = (error: any): number => {
  if (Number(error?.seconds) > 0) return Number(error.seconds);
  const message = String(
    error?.message ||
    error?.errorMessage ||
    error?.error?.message ||
    error ||
    ''
  );
  const match = message.match(
    /(?:FLOOD_WAIT_|(?:a\s+)?wait(?:ing)?\s*(?:for|of)?\s*|sleeping\s+for\s+)(\d+)\s*s?/i
  );
  return match ? Number(match[1]) : 0;
};

export const noteFlood = (seconds: number) => {
  if (!Number.isFinite(seconds) || seconds <= 0) return;
  const now = Date.now();
  blockedUntil = Math.max(blockedUntil, now + seconds * 1000 + 300);
  lastFlood = now;
  gap = Math.min(MAX_GAP_MS, Math.round(gap * 1.6));
};

export const isFloodBlocked = () => Date.now() < blockedUntil;

const loop = async () => {
  if (running) return;
  running = true;
  try {
    while (queue.length > 0) {
      const now = Date.now();
      if (gap > BASE_GAP_MS && now - lastFlood > CALM_AFTER_MS) {
        gap = Math.max(BASE_GAP_MS, Math.round(gap * 0.7));
      }
      queue.sort((a, b) => a.prio - b.prio || a.seq - b.seq);
      const job = queue.shift()!;
      const wait = Math.max(
        blockedUntil - now,
        lastStart + gap - now
      );
      if (wait > 0) {
        queue.unshift(job);
        await sleep(Math.min(wait, 1000));
        continue;
      }
      lastStart = Date.now();
      try {
        job.resolve(await job.fn());
      } catch (e: any) {
        const floodWaitSeconds = getFloodWaitSeconds(e);
        if (floodWaitSeconds > 0) noteFlood(floodWaitSeconds);
        job.reject(e);
      }
    }
  } finally {
    running = false;
  }
};

export const gate = <T>(prio: number, fn: () => Promise<T>): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    queue.push({ prio, seq: seq++, fn, resolve, reject });
    loop();
  });
