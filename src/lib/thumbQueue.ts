
const THUMB_CACHE = 'zud-thumbs-v1';
/* ============================================================================
 * PRIORITY THUMBNAIL QUEUE & SYNCHRONOUS RAM LRU CACHE
 * ============================================================================ */
const CONCURRENCY = 12;
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 900;
const MEM_CACHE_MAX = 800;

export type ThumbOutcome = 'ok' | 'fail';

interface Item {
  id: number;
  url: string;
  order: number;
  state: 'checking' | 'queued' | 'loading' | 'done';
  attempts: number;
  notBefore: number;
  startedAt: number;
  outcome?: ThumbOutcome;
  resolvedUrl?: string;
  revealed: boolean;
  cancelled: boolean;
  cb: (outcome: ThumbOutcome, resolvedUrl?: string) => void;
}

const memBlobUrls = new Map<string, string>();
const failedUrls = new Set<string>();

export const getThumbMemoryUrl = (url: string): string | undefined => {
  if (!url) return undefined;
  const hit = memBlobUrls.get(url);
  if (hit) {
    memBlobUrls.delete(url);
    memBlobUrls.set(url, hit);
  }
  return hit;
};

const rememberThumbMemoryUrl = (url: string, blobUrl: string) => {
  if (!url || !blobUrl) return;
  const prev = memBlobUrls.get(url);
  if (prev && prev !== blobUrl) {
    try { URL.revokeObjectURL(prev); } catch {}
  }
  memBlobUrls.delete(url);
  memBlobUrls.set(url, blobUrl);
  while (memBlobUrls.size > MEM_CACHE_MAX) {
    const oldestKey = memBlobUrls.keys().next().value;
    if (oldestKey === undefined) break;
    const oldBlobUrl = memBlobUrls.get(oldestKey);
    memBlobUrls.delete(oldestKey);
    if (oldBlobUrl && oldBlobUrl.startsWith('blob:')) {
      try { URL.revokeObjectURL(oldBlobUrl); } catch {}
    }
  }
};

const items = new Map<number, Item>();
let nextId = 1;
let active = 0;
let ticker: any = null;
let prefetchTimer: any = null;
const prefetched = new Set<string>();
let prefetcher: ((keys: string[]) => void) | null = null;

let cachePromise: Promise<Cache | null> | null = null;
const openCache = (): Promise<Cache | null> => {
  if (!cachePromise) {
    cachePromise = (typeof caches !== 'undefined' ? caches.open(THUMB_CACHE) : Promise.resolve(null))
      .catch(() => null);
  }
  return cachePromise;
};

const getCachedBlobUrl = async (url: string): Promise<string | null> => {
  const mem = getThumbMemoryUrl(url);
  if (mem) return mem;
  try {
    const cache = await openCache();
    if (!cache) return null;
    const match = await cache.match(url);
    if (!match || !match.ok) return null;
    const blob = await match.blob();
    if (!blob || blob.size === 0) return null;
    const blobUrl = URL.createObjectURL(blob);
    rememberThumbMemoryUrl(url, blobUrl);
    return blobUrl;
  } catch {
    return null;
  }
};

const messageKeyOf = (url: string): string | null => {
  const m = url.match(/\/thumb\/([^?]+)/);
  if (!m) return null;
  try { return decodeURIComponent(m[1]); } catch { return m[1]; }
};

export const setThumbPrefetcher = (fn: ((keys: string[]) => void) | null) => {
  prefetcher = fn;
  if (!fn) prefetched.clear();
};

const schedulePrefetch = () => {
  if (prefetchTimer || !prefetcher) return;
  prefetchTimer = setTimeout(() => {
    prefetchTimer = null;
    if (!prefetcher) return;
    const queued = Array.from(items.values())
      .filter(i => i.state === 'queued' && !i.cancelled)
      .sort((a, b) => a.order - b.order || a.id - b.id);
    const keys: string[] = [];
    for (const it of queued) {
      const k = messageKeyOf(it.url);
      if (k && !prefetched.has(k)) {
        prefetched.add(k);
        keys.push(k);
      }
    }
    if (keys.length > 0) prefetcher(keys);
  }, 12);
};

const reveal = (item: Item) => {
  if (item.revealed) return;
  item.revealed = true;
  items.delete(item.id);
  if (!item.cancelled) {
    item.cb(item.outcome || 'fail', item.resolvedUrl);
  }
};

const revealPass = () => {
  for (const it of Array.from(items.values())) {
    if (!it.revealed && !it.cancelled && it.state === 'done') {
      reveal(it);
    }
  }

  if (items.size === 0) {
    if (ticker) { clearInterval(ticker); ticker = null; }
  } else if (!ticker) {
    ticker = setInterval(() => { revealPass(); pump(); }, 500);
  }
};

const finish = (item: Item, outcome: ThumbOutcome, resolvedUrl?: string) => {
  item.state = 'done';
  item.outcome = outcome;
  item.resolvedUrl = resolvedUrl;
};

const inflightFetches = new Map<string, Promise<string | 'not_found'>>();

const fetchThumbOnce = (url: string): Promise<string | 'not_found'> => {
  const existing = inflightFetches.get(url);
  if (existing) return existing;

  const job = (async (): Promise<string | 'not_found'> => {
    const res = await fetch(url);
    if (res.status === 404 || res.status === 400) {
      failedUrls.add(url);
      return 'not_found';
    }
    const type = res.headers.get('content-type') || '';
    if (!res.ok || !type.startsWith('image/')) {
      throw new Error(`thumb status ${res.status}`);
    }
    const blob = await res.blob();
    if (!blob || blob.size === 0) {
      throw new Error('empty thumb blob');
    }
    const blobUrl = URL.createObjectURL(blob);
    rememberThumbMemoryUrl(url, blobUrl);
    return blobUrl;
  })().finally(() => {
    inflightFetches.delete(url);
  });

  inflightFetches.set(url, job);
  return job;
};

const load = async (item: Item) => {
  try {
    const mem = getThumbMemoryUrl(item.url);
    if (mem) {
      finish(item, 'ok', mem);
      return;
    }
    const result = await fetchThumbOnce(item.url);
    if (result === 'not_found') {
      finish(item, 'fail');
      return;
    }
    finish(item, 'ok', result);
  } catch {
    item.attempts++;
    if (item.cancelled || item.attempts >= MAX_ATTEMPTS) {
      finish(item, 'fail');
    } else {
      item.state = 'queued';
      item.notBefore = Date.now() + RETRY_DELAY_MS * item.attempts;
    }
  } finally {
    active--;
    if (item.cancelled) items.delete(item.id);
    revealPass();
    pump();
  }
};

const pump = () => {
  const now = Date.now();
  let retryWait = false;
  while (active < CONCURRENCY) {
    let next: Item | null = null;
    for (const it of items.values()) {
      if (it.state !== 'queued' || it.cancelled) continue;
      if (it.notBefore > now) { retryWait = true; continue; }
      if (!next || it.order < next.order || (it.order === next.order && it.id < next.id)) next = it;
    }
    if (!next) break;
    next.state = 'loading';
    next.startedAt = now;
    active++;
    void load(next);
  }
  if (retryWait && !ticker) {
    ticker = setInterval(() => { revealPass(); pump(); }, 500);
  }
};

/**
 * Register a thumbnail. If already in RAM, calls `cb('ok', blobUrl)` synchronously!
 */
export const registerThumb = (
  url: string,
  order: number,
  cb: (outcome: ThumbOutcome, resolvedUrl?: string) => void,
): (() => void) => {
  const memHit = getThumbMemoryUrl(url);
  if (memHit) {
    cb('ok', memHit);
    return () => {};
  }
  if (failedUrls.has(url)) {
    cb('fail');
    return () => {};
  }

  const item: Item = {
    id: nextId++,
    url,
    order,
    state: 'checking',
    attempts: 0,
    notBefore: 0,
    startedAt: 0,
    revealed: false,
    cancelled: false,
    cb,
  };
  items.set(item.id, item);

  void getCachedBlobUrl(url).then((blobUrl) => {
    if (item.cancelled || item.revealed) return;
    if (blobUrl) {
      finish(item, 'ok', blobUrl);
      reveal(item);
      revealPass();
      return;
    }
    item.state = 'queued';
    schedulePrefetch();
    pump();
    revealPass();
  });

  return () => {
    item.cancelled = true;
    if (item.state !== 'loading') items.delete(item.id);
    if (items.size === 0 && ticker) { clearInterval(ticker); ticker = null; }
    revealPass();
  };
};
