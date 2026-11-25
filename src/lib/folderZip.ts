import { TelegramClient, Api } from 'telegram';
import { Zip, ZipPassThrough } from 'fflate';
import bigInt from 'big-integer';
import type { VirtualFolder, VirtualFile } from './vfs';
import { resolveTelegramEntity } from './telegramEntity';
import { getDcSender, invalidateDcSender, sendWithDcSender, ensureTelegramConnected, warmDcSenderLanes } from './dcSenderPool';
import { getFloodWaitSeconds } from './tgGate';
import { DownloadControl, triggerInstantBrowserSave } from './opfsDownload';

export interface FolderZipProgress {
  bytesDownloaded: number;
  totalBytes: number;
  currentFileName: string;
  filesProcessed: number;
  totalFiles: number;
  percent: number;
}

export interface FolderFileEntry {
  file: VirtualFile;
  relativePath: string;
}

export function collectFolderFiles(
  folder: VirtualFolder,
  basePath = ''
): { files: FolderFileEntry[]; emptyDirs: string[] } {
  const files: FolderFileEntry[] = [];
  const emptyDirs: string[] = [];

  const currentDir = basePath
    ? `${basePath}/${folder.name || 'Folder'}`
    : (folder.name && folder.id !== 'root' ? folder.name : 'CloudFolder');

  const cleanDir = currentDir.replace(/[\\/:*?"<>|]/g, '_').trim();

  const directFiles = folder.files || [];
  const subfolders = Object.values(folder.folders || {});

  if (directFiles.length === 0 && subfolders.length === 0) {
    emptyDirs.push(cleanDir);
    return { files, emptyDirs };
  }

  for (const file of directFiles) {
    const cleanFileName = (file.name || 'file').replace(/[\\/:*?"<>|]/g, '_');
    files.push({
      file,
      relativePath: `${cleanDir}/${cleanFileName}`,
    });
  }

  for (const sub of subfolders) {
    const subResult = collectFolderFiles(sub, cleanDir);
    files.push(...subResult.files);
    emptyDirs.push(...subResult.emptyDirs);
  }

  return { files, emptyDirs };
}

/**
 * Streams chunks of a VirtualFile directly from Telegram
 */
export async function streamFileToZipEntry(
  file: VirtualFile,
  client: TelegramClient,
  zipEntry: ZipPassThrough,
  control: DownloadControl,
  onProgressChunk: (chunkBytes: number) => void,
  fallbackClient?: TelegramClient | null
): Promise<void> {
  const CHUNK_SIZE = 524288; // 512KB chunks for smooth streaming & zip compression

  if (!file.parts || file.parts.length === 0) {
    // Empty file or metadata only
    zipEntry.push(new Uint8Array(0), true);
    return;
  }

  for (let partIndex = 0; partIndex < file.parts.length; partIndex++) {
    const part = file.parts[partIndex];
    const rawChannel = part.channelId ? String(part.channelId) : 'me';
    await ensureTelegramConnected(client);
    const entity = await resolveTelegramEntity(client, rawChannel, fallbackClient);

    const msgs = await client.getMessages(entity, { ids: [part.messageId] });
    const msg = msgs[0];
    if (!msg || !msg.media) {
      console.warn(`[FolderZip] Message ${part.messageId} not found or has no media`);
      continue;
    }

    let location: any;
    if (msg.media.className === 'MessageMediaDocument' && msg.media.document) {
      const doc = msg.media.document as Api.Document;
      location = new Api.InputDocumentFileLocation({
        id: doc.id,
        accessHash: doc.accessHash,
        fileReference: doc.fileReference,
        thumbSize: '',
      });
    } else {
      console.warn(`[FolderZip] Unsupported media type in message ${part.messageId}`);
      continue;
    }

    let fileSender: any = undefined;
    let docDcId: number = Number((msg.media?.document as any)?.dcId || (client.session as any)?.dcId || 4);
    void warmDcSenderLanes(client, docDcId);
    try {
      fileSender = await getDcSender(client, docDcId);
    } catch (e) {
      console.warn(`[FolderZip] Failed to acquire sender for DC ${docDcId}:`, e);
    }

    let nextOffsetToFetch = 0;
    let nextOffsetToWrite = 0;
    const MAX_CONCURRENCY = 8;
    const pendingChunks = new Map<number, Uint8Array>();
    const activeTasks = new Set<Promise<void>>();
    let isDone = false;
    let error: any = null;

    while (nextOffsetToWrite < part.size) {
      await control.wait();
      if (control.cancelled) throw new Error('CANCELLED');
      if (error) throw error;

      while (activeTasks.size < MAX_CONCURRENCY && pendingChunks.size < 14 && nextOffsetToFetch < part.size && !isDone && !error) {
        const offset = nextOffsetToFetch;
        nextOffsetToFetch += CHUNK_SIZE;

        const task = (async () => {
          const req = new Api.upload.GetFile({
            location,
            offset: bigInt(offset) as any,
            limit: CHUNK_SIZE,
          });
          let result: any;
          for (let attempt = 0; attempt < 5; attempt++) {
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
              if (migrateDc && attempt < 4) {
                docDcId = migrateDc;
                void warmDcSenderLanes(client, migrateDc);
                fileSender = await getDcSender(client, migrateDc).catch(() => undefined);
                continue;
              }
              const floodSec = getFloodWaitSeconds(e);
              if (floodSec > 0 && attempt < 4) {
                await new Promise(r => setTimeout(r, Math.min(floodSec, 15) * 1000));
                continue;
              }
              if (attempt < 4 && /disconnected|reconnect|closed|not connected|was closed|unsuccessful|timeout|usable|recycled|maximum reconnection|aborting|connection_not_inited/i.test(errMsg)) {
                await invalidateDcSender(client, docDcId, fileSender);
                await ensureTelegramConnected(client).catch(() => {});
                fileSender = await getDcSender(client, docDcId).catch(() => undefined);
                await new Promise(r => setTimeout(r, 250 * (attempt + 1)));
                continue;
              }
              throw e;
            }
          }
          const chunkBuffer = result.bytes as Buffer;
          if (!chunkBuffer || chunkBuffer.length === 0) {
            isDone = true;
            return;
          }
          pendingChunks.set(offset, new Uint8Array(chunkBuffer));
        })().catch(e => { error = e; });

        activeTasks.add(task);
        task.finally(() => activeTasks.delete(task));
      }

      if (pendingChunks.has(nextOffsetToWrite)) {
        const chunk = pendingChunks.get(nextOffsetToWrite)!;
        pendingChunks.delete(nextOffsetToWrite);

        const isLastPartChunk = (nextOffsetToWrite + chunk.length >= part.size) && (partIndex === file.parts.length - 1);
        zipEntry.push(chunk, isLastPartChunk);

        nextOffsetToWrite += chunk.length;
        onProgressChunk(chunk.length);

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

  // Ensure entry ends even if empty or ended early
  try {
    zipEntry.push(new Uint8Array(0), true);
  } catch (_) {
    // Already ended
  }
}

/**
 * Downloads a complete virtual folder recursively and bundles it into a .zip archive
 */
export async function downloadFolderAsZip(
  folder: VirtualFolder,
  client: TelegramClient,
  control: DownloadControl,
  onProgress?: (received: number, total: number, statusText: string) => void,
  fallbackClient?: TelegramClient | null
): Promise<void> {
  const { files, emptyDirs } = collectFolderFiles(folder);
  const totalBytes = files.reduce((sum, item) => sum + (item.file.size || 0), 0);
  const zipFileName = `${(folder.name || 'CloudFolder').replace(/[\\/:*?"<>|]/g, '_')}.zip`;

  let bytesDownloaded = 0;
  const inMemoryChunks: Uint8Array[] = [];
  let opfsHandle: any = null;
  let opfsWritable: any = null;

  try {
    if (typeof navigator !== 'undefined' && navigator.storage && navigator.storage.getDirectory) {
      const root = await navigator.storage.getDirectory();
      opfsHandle = await root.getFileHandle(zipFileName, { create: true });
      if (typeof opfsHandle.createWritable === 'function') {
        opfsWritable = await opfsHandle.createWritable();
      }
    }
  } catch (err) {
    console.warn('[FolderZip] OPFS storage unavailable, using in-memory zip buffering:', err);
    opfsWritable = null;
  }

  let zipWritePromise = Promise.resolve();

  const zip = new Zip((err, dat) => {
    if (err) {
      console.error('[FolderZip] Compression error:', err);
      return;
    }
    if (dat && dat.length > 0) {
      if (opfsWritable) {
        zipWritePromise = zipWritePromise.then(() => opfsWritable.write(dat));
      } else {
        inMemoryChunks.push(dat);
      }
    }
  });

  for (const emptyDir of emptyDirs) {
    const dirPath = emptyDir.endsWith('/') ? emptyDir : `${emptyDir}/`;
    const dirEntry = new ZipPassThrough(dirPath);
    zip.add(dirEntry);
    dirEntry.push(new Uint8Array(0), true);
  }

  // If no files to download, just close zip
  if (files.length === 0) {
    zip.end();
    await zipWritePromise;
    if (opfsWritable) await opfsWritable.close();
    await triggerBrowserSave(opfsHandle, inMemoryChunks, zipFileName);
    onProgress?.(totalBytes, totalBytes, 'Completed');
    return;
  }

  // Stream each file
  for (let i = 0; i < files.length; i++) {
    await control.wait();
    if (control.cancelled) {
      if (opfsWritable) try { await opfsWritable.abort(); } catch (_) {}
      throw new Error('CANCELLED');
    }

    const { file, relativePath } = files[i];
    const zipEntry = new ZipPassThrough(relativePath);
    zip.add(zipEntry);

    onProgress?.(
      bytesDownloaded,
      totalBytes,
      `Zipping [${i + 1}/${files.length}]: ${file.name}`
    );

    try {
      await streamFileToZipEntry(
        file,
        client,
        zipEntry,
        control,
        (chunkBytes) => {
          bytesDownloaded += chunkBytes;
          onProgress?.(
            bytesDownloaded,
            totalBytes,
            `Zipping [${i + 1}/${files.length}]: ${file.name}`
          );
        },
        fallbackClient
      );
    } catch (fileErr: any) {
      if (fileErr?.message === 'CANCELLED') throw fileErr;
      console.error(`[FolderZip] Error streaming file ${file.name}:`, fileErr);
      try {
        zipEntry.push(new Uint8Array(0), true);
      } catch (_) {}
    }
  }

  // Finish the ZIP stream
  zip.end();
  await zipWritePromise;

  if (opfsWritable) {
    await opfsWritable.close();
  }

  onProgress?.(totalBytes, totalBytes, 'Finalizing download...');
  await triggerBrowserSave(opfsHandle, inMemoryChunks, zipFileName);
}

/**
 * Triggers native browser download dialog from OPFS or Memory Blob using instant typed blob handoff
 */
async function triggerBrowserSave(
  opfsHandle: any,
  inMemoryChunks: Uint8Array[],
  filename: string
): Promise<void> {
  let blobOrFile: File | Blob;

  if (opfsHandle) {
    blobOrFile = await opfsHandle.getFile();
  } else {
    blobOrFile = new Blob(inMemoryChunks as any, { type: 'application/zip' });
  }

  triggerInstantBrowserSave(blobOrFile, filename, 'application/zip');
}
