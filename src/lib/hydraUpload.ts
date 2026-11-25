
import { Api } from 'telegram';
import type { TelegramClient } from 'telegram';
import { Buffer } from 'buffer';
import bigInt from 'big-integer';
import {
  ensureTelegramConnected,
  invalidateDcSender,
  sendWithDcSender,
  warmDcSenderLanes,
} from './dcSenderPool';
import { getFloodWaitSeconds } from './tgGate';

/* ============================================================================
 * 3-LANE SELF-HEALING UPLOAD ENGINE CONFIGURATION
 * ============================================================================ */
const PART_SIZE = 512 * 1024;
const SMALL_FILE_THRESHOLD = 10 * 1024 * 1024;
const MAX_TOTAL_PARTS = 8000;
const BIG_CONCURRENCY = 6;
const SMALL_CONCURRENCY = 4;
const WS_BUF_LIMIT = 1.5 * 1024 * 1024;
const WS_POLL_MS = 25;
const TIMEOUT_MS = 32_000;
const MAX_RETRIES = 6;

export const HYDRA_MIN_SIZE = SMALL_FILE_THRESHOLD;

export interface HydraControl {
  wait(): Promise<void>;
  throwIfCancelled(): void;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export const canHydraUpload = (sz: number): boolean =>
  sz > 0 && Math.ceil(sz / PART_SIZE) <= MAX_TOTAL_PARTS;

function nativeWs(sender: any): WebSocket | null {
  try {
    return sender?._connection?.socket?.client ?? sender?._connection?._socket?.client ?? null;
  } catch {
    return null;
  }
}

async function drainSocket(sender: any, limit: number): Promise<void> {
  const sock = nativeWs(sender);
  if (!sock) return;
  let spins = 0;
  while (sock.readyState === 1 && sock.bufferedAmount > limit && spins < 80) {
    spins++;
    await sleep(WS_POLL_MS);
  }
}

/* ============================================================================
 * PARALLEL 512KB SLIDING-WINDOW UPLOAD PIPELINE
 * ============================================================================ */
export async function hydraUploadFile(
  client: TelegramClient,
  file: Blob,
  name: string,
  onProgress?: (fraction: number) => void,
  control?: HydraControl,
): Promise<Api.InputFileBig | Api.InputFile> {
  const size = file.size;
  const isBig = size > SMALL_FILE_THRESHOLD;
  const totalParts = Math.max(1, Math.ceil(size / PART_SIZE));
  const fileId = bigInt.randBetween(
    bigInt('-9223372036854775808'),
    bigInt('9223372036854775807'),
  );

  await ensureTelegramConnected(client);
  const homeDcId = Number((client.session as any)?.dcId || 4);
  void warmDcSenderLanes(client, homeDcId);

  let nextPart = 0;
  let doneCount = 0;
  let failure: any = null;
  let lastSenderUsed: any = null;
  onProgress?.(0);

  const worker = async (): Promise<void> => {
    while (!failure) {
      await control?.wait();
      control?.throwIfCancelled();

      const idx = nextPart++;
      if (idx >= totalParts) return;

      const blob = file.slice(idx * PART_SIZE, Math.min(size, (idx + 1) * PART_SIZE));
      const bytes = Buffer.from(await blob.arrayBuffer());

      const req = isBig
        ? new Api.upload.SaveBigFilePart({
            fileId: fileId as any,
            filePart: idx,
            fileTotalParts: totalParts,
            bytes,
          })
        : new Api.upload.SaveFilePart({
            fileId: fileId as any,
            filePart: idx,
            bytes,
          });

      let attempt = 0;
      while (true) {
        try {
          await control?.wait();
          control?.throwIfCancelled();

          if (lastSenderUsed) {
            await drainSocket(lastSenderUsed, WS_BUF_LIMIT);
          }

          const sent = await sendWithDcSender<any>(client, homeDcId, req, TIMEOUT_MS);
          lastSenderUsed = sent.sender;
          break;
        } catch (err: any) {
          control?.throwIfCancelled();
          const senderUsed = err?._zudSenderUsed || lastSenderUsed;
          const errMsg = String(err?.message || err?.errorMessage || err || '');
          attempt++;
          if (failure || attempt >= MAX_RETRIES) throw err;

          const floodSec = getFloodWaitSeconds(err);
          if (floodSec > 0) {
            await sleep(Math.min(floodSec, 15) * 1000);
            continue;
          }

          if (/disconnected|reconnect|closed|not connected|was closed|unsuccessful|timeout|usable|recycled|aborting|connection_not_inited/i.test(errMsg)) {
            await invalidateDcSender(client, homeDcId, senderUsed);
            await ensureTelegramConnected(client).catch(() => {});
            await sleep(Math.min(2500, 350 * attempt));
            continue;
          }

          await sleep(Math.min(2500, 450 * attempt));
        }
      }

      doneCount++;
      if (onProgress) {
        onProgress(doneCount / totalParts);
      }
    }
  };

  const concurrency = Math.min(isBig ? BIG_CONCURRENCY : SMALL_CONCURRENCY, totalParts);
  const workers = Array.from({ length: concurrency }, () =>
    worker().catch((e) => {
      if (!failure) failure = e;
    }),
  );

  await Promise.all(workers);
  if (failure) throw failure;

  if (isBig) {
    return new Api.InputFileBig({ id: fileId as any, parts: totalParts, name });
  }
  return new Api.InputFile({ id: fileId as any, parts: totalParts, name, md5Checksum: '' });
}

export async function hydraUploadBigFile(
  client: TelegramClient,
  file: Blob,
  name: string,
  onProgress?: (fraction: number) => void,
  control?: HydraControl,
): Promise<Api.InputFileBig> {
  return (await hydraUploadFile(client, file, name, onProgress, control)) as Api.InputFileBig;
}
