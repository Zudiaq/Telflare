import { TelegramClient, Api } from 'telegram';
import type { VirtualFile } from './vfs';
import bigInt from 'big-integer';
import { resolveTelegramEntity } from './telegramEntity';
import {
  getDcSender,
  invalidateDcSender,
  sendWithDcSender,
  ensureTelegramConnected,
  warmDcSenderLanes,
} from './dcSenderPool';
import { getFloodWaitSeconds } from './tgGate';

/* ============================================================================
 * DOWNLOAD FLOW CONTROL & PAUSE / CANCEL STATE
 * ============================================================================ */
export class DownloadControl {
  paused = false;
  cancelled = false;
  
  async wait() {
    if (!this.paused && !this.cancelled) return;
    return new Promise<void>(resolve => {
      const check = setInterval(() => {
        if (!this.paused) {
          clearInterval(check);
          if (this.cancelled) throw new Error('CANCELLED');
          resolve();
        }
        if (this.cancelled) {
          clearInterval(check);
          throw new Error('CANCELLED');
        }
      }, 200);
    });
  }
  
  pause() { this.paused = true; }
  resume() { this.paused = false; }
  cancel() { this.cancelled = true; }
}

/* ============================================================================
 * 3-LANE OPFS / IN-MEMORY STREAMING DOWNLOADER
 * ============================================================================ */
export async function startOPFSDownload(
  file: VirtualFile, 
  client: TelegramClient,
  control: DownloadControl,
  onProgress: (received: number, total: number) => void,
  entityFallbackClient?: TelegramClient | null
): Promise<void> {
  let fileHandle: any = null;
  let writable: any = null;
  const inMemoryChunks: Uint8Array[] = [];

  try {
    if (typeof navigator !== 'undefined' && navigator.storage && typeof navigator.storage.getDirectory === 'function') {
      const root = await navigator.storage.getDirectory();
      const safeName = (file.name || 'download').replace(/[\\/:*?"<>|]/g, '_');
      fileHandle = await root.getFileHandle(safeName, { create: true });
      if (typeof fileHandle.createWritable === 'function') {
        writable = await fileHandle.createWritable();
      } else {
        fileHandle = null;
      }
    }
  } catch (opfsErr) {
    console.warn('[Download] OPFS writable unavailable, using in-memory stream fallback:', opfsErr);
    fileHandle = null;
    writable = null;
  }

  let bytesReceived = 0;
  
  for (let partIndex = 0; partIndex < file.parts.length; partIndex++) {
    const part = file.parts[partIndex];
    const CHUNK_SIZE = 524288;
    const MAX_CONCURRENCY = 9;

    const rawChannel = part.channelId ? String(part.channelId) : 'me';
    await ensureTelegramConnected(client);
    const entity = await resolveTelegramEntity(client, rawChannel, entityFallbackClient);

    const resolveLocation = async () => {
      const msg = (await client.getMessages(entity, { ids: [part.messageId] }))[0];
      if (!msg || !msg.media) throw new Error('Message not found or has no media');
      if (msg.media.className === 'MessageMediaDocument' && msg.media.document) {
        const doc = msg.media.document as Api.Document;
        return {
          dcId: Number((doc as any).dcId || (client.session as any)?.dcId || 4),
          location: new Api.InputDocumentFileLocation({
            id: doc.id,
            accessHash: doc.accessHash,
            fileReference: doc.fileReference,
            thumbSize: '',
          }),
        };
      }
      if (msg.media.className === 'MessageMediaPhoto' && msg.media.photo) {
        const photo = msg.media.photo as Api.Photo;
        const sizes = (photo.sizes || []) as any[];
        const largest = sizes[sizes.length - 1];
        return {
          dcId: Number((photo as any).dcId || (client.session as any)?.dcId || 4),
          location: new Api.InputPhotoFileLocation({
            id: photo.id,
            accessHash: photo.accessHash,
            fileReference: photo.fileReference,
            thumbSize: largest?.type || 'y',
          }),
        };
      }
      throw new Error('Unsupported media for OPFS download');
    };

    let { location, dcId: docDcId } = await resolveLocation();
    let fileSender: any = undefined;
    void warmDcSenderLanes(client, docDcId);
    try {
      fileSender = await getDcSender(client, docDcId);
    } catch (e) {
      console.warn(`Failed to pre-acquire sender for DC ${docDcId}:`, e);
    }

    let nextOffsetToFetch = 0;
    let nextOffsetToWrite = 0;
    const pendingChunks = new Map<number, Uint8Array>();
    const activeTasks = new Set<Promise<void>>();
    let isDone = false;
    let error: any = null;

    while (nextOffsetToWrite < part.size) {
      await control.wait();
      if (control.cancelled) throw new Error('CANCELLED');
      if (error) throw error;

      // Bound out-of-order RAM buffer to <= 16 chunks (8 MB) while keeping all 9 workers saturated
      while (
        activeTasks.size < MAX_CONCURRENCY &&
        pendingChunks.size < 16 &&
        nextOffsetToFetch < part.size &&
        !isDone &&
        !error
      ) {
        const offset = nextOffsetToFetch;
        nextOffsetToFetch += CHUNK_SIZE;

        const task = (async () => {
          let result: any;
          for (let attempt = 0; attempt < 6; attempt++) {
            await control.wait();
            if (control.cancelled) throw new Error('CANCELLED');
            const req = new Api.upload.GetFile({
              location,
              offset: bigInt(offset) as any,
              limit: CHUNK_SIZE,
            });
            try {
              const sent = await sendWithDcSender(client, docDcId, req, 22000);
              fileSender = sent.sender;
              result = sent.result;
              break;
            } catch (e: any) {
              fileSender = e?._zudSenderUsed || fileSender;
              const errMsg = String(e?.message || e?.errorMessage || e || '');
              const migrateMatch = errMsg.match(/stored in DC (\d+)/i) || errMsg.match(/FILE_MIGRATE_(\d+)/i);
              const migrateDc = e?.newDc || (migrateMatch ? parseInt(migrateMatch[1], 10) : null);
              if (migrateDc && attempt < 5) {
                docDcId = migrateDc;
                void warmDcSenderLanes(client, migrateDc);
                fileSender = await getDcSender(client, migrateDc).catch(() => undefined);
                continue;
              }
              if (/FILE_REFERENCE/i.test(errMsg) && attempt < 5) {
                const refreshed = await resolveLocation();
                location = refreshed.location;
                docDcId = refreshed.dcId;
                continue;
              }
              const floodSec = getFloodWaitSeconds(e);
              if (floodSec > 0 && attempt < 5) {
                await new Promise((r) => setTimeout(r, Math.min(floodSec, 15) * 1000));
                continue;
              }
              if (attempt < 5 && /disconnected|reconnect|closed|not connected|was closed|unsuccessful|timeout|usable|recycled|maximum reconnection|aborting|connection_not_inited/i.test(errMsg)) {
                await invalidateDcSender(client, docDcId, fileSender);
                await ensureTelegramConnected(client).catch(() => {});
                fileSender = await getDcSender(client, docDcId).catch(() => undefined);
                await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
                continue;
              }
              throw e;
            }
          }
          const chunkBuffer = result?.bytes as Buffer;
          if (!chunkBuffer || chunkBuffer.length === 0) {
            isDone = true;
            return;
          }
          pendingChunks.set(offset, new Uint8Array(chunkBuffer));
        })().catch((e) => { error = e; });

        activeTasks.add(task);
        task.finally(() => activeTasks.delete(task));
      }

      if (pendingChunks.has(nextOffsetToWrite)) {
        const chunk = pendingChunks.get(nextOffsetToWrite)!;
        pendingChunks.delete(nextOffsetToWrite);
        
        if (writable) {
          await writable.write({ type: 'write', position: bytesReceived, data: chunk } as any);
        } else {
          inMemoryChunks.push(chunk);
        }
        nextOffsetToWrite += chunk.length;
        bytesReceived += chunk.length;
        onProgress(bytesReceived, file.size);

        if (chunk.length < CHUNK_SIZE) {
           isDone = true;
           break;
        }
      } else if (activeTasks.size > 0) {
        await Promise.race(activeTasks);
      } else {
        break;
      }
    }
  }

  if (writable && fileHandle) {
    await writable.close();
    const downloadedFile = await fileHandle.getFile();
    triggerInstantBrowserSave(downloadedFile, file.name, file.mimeType);
  } else {
    const blob = new Blob(inMemoryChunks as any[], { type: file.mimeType || 'application/octet-stream' });
    triggerInstantBrowserSave(blob, file.name, file.mimeType);
  }
}

/**
 * Triggers instant native browser save from locally buffered OPFS File or Memory Blob.
 * Ensures typed Blob slice to bypass browser content re-sniffing, uses MouseEvent click,
 * and maintains ObjectURL lifetime for complete local disk transfer without network re-fetching.
 */
/* ============================================================================
 * NATIVE BROWSER FILE SAVE DISPATCHER
 * ============================================================================ */
export function triggerInstantBrowserSave(
  fileOrBlob: File | Blob,
  filename: string,
  mimeType?: string
): void {
  const safeMime = mimeType || fileOrBlob.type || 'application/octet-stream';
  const finalBlob = fileOrBlob.type === safeMime
    ? fileOrBlob
    : (fileOrBlob instanceof File
        ? fileOrBlob.slice(0, fileOrBlob.size, safeMime)
        : new Blob([fileOrBlob as any], { type: safeMime }));

  const url = URL.createObjectURL(finalBlob);
  const anchor = document.createElement('a');
  anchor.style.display = 'none';
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';

  document.body.appendChild(anchor);
  anchor.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));

  requestAnimationFrame(() => {
    if (anchor.parentNode) {
      anchor.parentNode.removeChild(anchor);
    }
  });

  // Hold URL alive for 3 minutes so even large gigabyte files finish local writing to disk
  setTimeout(() => {
    try {
      URL.revokeObjectURL(url);
    } catch (_) {}
  }, 180000);
}
