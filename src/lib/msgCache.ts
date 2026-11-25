import type { TelegramClient } from 'telegram';
import { gate, getFloodWaitSeconds } from './tgGate';
import { ensureTelegramConnected } from './dcSenderPool';

const MAX_ENTRIES = 3000;
const TTL_MS = 2 * 60 * 60 * 1000;
const BATCH_DELAY_MS = 20;
const MAX_IDS_PER_REQUEST = 100;

interface Entry { msg: any; ts: number }
const cache = new Map<string, Entry>();

export const normalizeChannelKey = (id: any): string => {
  if (id === undefined || id === null) return 'me';
  let s = (typeof id === 'object' && id.value !== undefined) ? String(id.value) : String(id);
  if (!s || s === 'me' || s === '[object Object]') return 'me';
  if (s.startsWith('-100')) s = s.slice(4);
  else if (s.startsWith('-')) s = s.slice(1);
  return s;
};

const keyOf = (channelId: any, msgId: number) => `${normalizeChannelKey(channelId)}_${msgId}`;

export const putMessage = (channelId: any, msg: any) => {
  if (!msg || typeof msg.id !== 'number' || !msg.media) return;
  const key = keyOf(channelId, msg.id);
  cache.delete(key); // re-insert => becomes the "newest" entry
  cache.set(key, { msg, ts: Date.now() });
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
};

export const putMessages = (channelId: any, msgs: any[]) => {
  if (!msgs) return;
  for (const m of msgs) putMessage(channelId, m);
};

/** Returns the entry (message + timestamp) only while it is still fresh. */
export const getCachedEntry = (channelId: any, msgId: number): Entry | null => {
  const entry = cache.get(keyOf(channelId, msgId));
  if (!entry) return null;
  if (Date.now() - entry.ts > TTL_MS) return null;
  return entry;
};

export const getCachedMessage = (channelId: any, msgId: number): any | null =>
  getCachedEntry(channelId, msgId)?.msg ?? null;

export const invalidateMessage = (channelId: any, msgId: number) => {
  cache.delete(keyOf(channelId, msgId));
};

/* ---------------------------------------------------------------------- */
/* Batched + de-duplicated message fetching (never more than one in flight) */
/* ---------------------------------------------------------------------- */

interface Waiter { resolve: (m: any) => void; reject: (e: any) => void }
interface PendingChannel { entity: any; channelId: any; ids: Map<number, Waiter[]> }

const pending = new Map<string, PendingChannel>();
let flushTimer: any = null;
let pumping = false;
let clientRef: TelegramClient | null = null;

const pump = async () => {
  if (pumping) return;
  pumping = true;
  try {
    while (pending.size > 0 && clientRef) {
      const snapshot = Array.from(pending.values());
      pending.clear();

      for (const ch of snapshot) {
        // Anything fetched by a previous batch in the meantime is a free hit
        const toFetch: number[] = [];
        for (const [id, waiters] of ch.ids) {
          const hit = getCachedMessage(ch.channelId, id);
          if (hit) waiters.forEach(w => w.resolve(hit));
          else toFetch.push(id);
        }

        for (let i = 0; i < toFetch.length; i += MAX_IDS_PER_REQUEST) {
          const chunk = toFetch.slice(i, i + MAX_IDS_PER_REQUEST);
          try {
            const messages: any[] = await gate(0, async () => {
              await ensureTelegramConnected(clientRef!);
              return clientRef!.getMessages(ch.entity, { ids: chunk }) as any;
            });
            const byId = new Map<number, any>();
            for (const m of messages || []) if (m && typeof m.id === 'number') byId.set(m.id, m);
            putMessages(ch.channelId, Array.from(byId.values()));
            for (const id of chunk) {
              const m = byId.get(id);
              const waiters = ch.ids.get(id) || [];
              if (m) waiters.forEach(w => w.resolve(m));
              else waiters.forEach(w => w.reject(new Error('Message not found')));
            }
          } catch (e: any) {
            const floodSec = getFloodWaitSeconds(e);
            if (floodSec > 0) {
              await new Promise(r => setTimeout(r, Math.min(floodSec, 15) * 1000));
              try {
                const retryMsgs: any[] = await gate(0, () => clientRef!.getMessages(ch.entity, { ids: chunk }) as any);
                const byId = new Map<number, any>();
                for (const m of retryMsgs || []) if (m && typeof m.id === 'number') byId.set(m.id, m);
                putMessages(ch.channelId, Array.from(byId.values()));
                for (const id of chunk) {
                  const m = byId.get(id);
                  const waiters = ch.ids.get(id) || [];
                  if (m) waiters.forEach(w => w.resolve(m));
                  else waiters.forEach(w => w.reject(new Error('Message not found')));
                }
                continue;
              } catch (retryErr) {
                for (const id of chunk) (ch.ids.get(id) || []).forEach(w => w.reject(retryErr));
                continue;
              }
            }
            for (const id of chunk) (ch.ids.get(id) || []).forEach(w => w.reject(e));
          }
        }
      }
    }
  } finally {
    pumping = false;
  }
};

/**
 * Resolve a Telegram message. Served from memory when possible, otherwise
 * queued and fetched together with every other message requested within the
 * next few milliseconds (max 100 ids per API call, one call at a time).
 */
export const fetchMessageBatched = (
  client: TelegramClient,
  entity: any,
  channelId: any,
  msgId: number
): Promise<any> => {
  const cached = getCachedMessage(channelId, msgId);
  if (cached) return Promise.resolve(cached);

  clientRef = client;
  return new Promise<any>((resolve, reject) => {
    const ck = normalizeChannelKey(channelId);
    let ch = pending.get(ck);
    if (!ch) {
      ch = { entity, channelId, ids: new Map() };
      pending.set(ck, ch);
    }
    const waiters = ch.ids.get(msgId);
    if (waiters) waiters.push({ resolve, reject });
    else ch.ids.set(msgId, [{ resolve, reject }]);

    if (!flushTimer && !pumping) {
      flushTimer = setTimeout(() => {
        flushTimer = null;
        pump().catch(console.error).finally(() => {
          // Requests that arrived while pumping but after the last loop check
          if (pending.size > 0 && !flushTimer && !pumping) {
            flushTimer = setTimeout(() => { flushTimer = null; pump().catch(console.error); }, BATCH_DELAY_MS);
          }
        });
      }, BATCH_DELAY_MS);
    }
  });
};

/**
 * Highest-priority single message fetch (used when the user starts a stream). Bypasses batching,
 * overtakes every queued thumbnail / sync request, and is de-duplicated.
 */
export const fetchMessageUrgent = async (
  client: TelegramClient,
  entity: any,
  channelId: any,
  msgId: number
): Promise<any> => {
  const hit = getCachedMessage(channelId, msgId);
  if (hit) return hit;
  return dedupeInflight(`urgent:${normalizeChannelKey(channelId)}_${msgId}`, async () => {
    const messages: any[] = await gate(-1, async () => {
      await ensureTelegramConnected(client);
      return client.getMessages(entity, { ids: [msgId] }) as any;
    });
    const m = messages && messages.length > 0 ? messages[0] : null;
    if (m) putMessage(channelId, m);
    return m;
  });
};

/* ---------------------------------------------------------------------- */
/* Small concurrency helpers                                                */
/* ---------------------------------------------------------------------- */

export const createLimiter = (max: number) => {
  let active = 0;
  const queue: (() => void)[] = [];
  const next = () => {
    while (active < max && queue.length > 0) {
      active++;
      queue.shift()!();
    }
  };
  return <T>(fn: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      queue.push(() => {
        fn().then(resolve, reject).finally(() => { active--; next(); });
      });
      next();
    });
};

const inflight = new Map<string, Promise<any>>();
/** Collapses concurrent identical jobs into one promise. */
export const dedupeInflight = <T>(key: string, fn: () => Promise<T>): Promise<T> => {
  const existing = inflight.get(key);
  if (existing) return existing as Promise<T>;
  const p = fn().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
};

/* Lets low-priority background work (cache validation) yield to thumbnails */
let activeThumbs = 0;
export const thumbActivityStart = () => { activeThumbs++; };
export const thumbActivityEnd = () => { activeThumbs = Math.max(0, activeThumbs - 1); };
export const waitForThumbIdle = async (maxWaitMs = 20000) => {
  const start = Date.now();
  while (activeThumbs > 0 && Date.now() - start < maxWaitMs) {
    await new Promise(r => setTimeout(r, 250));
  }
};
