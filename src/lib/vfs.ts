import { Api, TelegramClient } from 'telegram';
import { openDB } from 'idb';
import type { IDBPDatabase } from 'idb';
import { putMessages, getCachedEntry, waitForThumbIdle } from './msgCache';
import { gate } from './tgGate';
import { resolveTelegramEntity, saveChannelAccessHash } from './telegramEntity';
import { ensureTelegramConnected } from './dcSenderPool';

const VALIDATE_INTERVAL_MS = 15000;
const HISTORY_PAGE = 100;
const MAX_HISTORY_PAGES = 50; // Normal channels <= 5,000 msgs; larger channels use Lazy Cloud Mode!
const LAZY_CHANNEL_THRESHOLD = 1500;
const BACKFILL_CHECKPOINT_PAGES = 5;
const INITIAL_BURST_PAGES = 2;
const DIR_SEARCH_MAX_PAGES = 80; // Up to 8,000 Directory definitions in ~1s
const SUBFOLDER_SEARCH_MAX_PAGES = 40; // Up to 4,000 files per single subfolder
const FOLDER_BUCKET_STALE_MS = 45000;

const activeBackfillJobs = new Set<string>();
const activeSubfolderSyncs = new Map<string, Promise<number>>();

export const isChannelBackfilling = (channelId: string): boolean => activeBackfillJobs.has(String(channelId));

export interface FolderEntry {
  id: string;
  name: string;
  pId: string;
  msgId?: number;
}

interface FolderLookup {
  byId: Map<string, FolderEntry>;
  pathCache: Map<string, string | null>;
}

const createFolderLookup = (foldersList?: FolderEntry[]): FolderLookup => {
  const byId = new Map<string, FolderEntry>();
  if (foldersList) {
    for (const f of foldersList) {
      if (f && f.id) {
        byId.set(String(f.id), f);
      }
    }
  }
  return { byId, pathCache: new Map<string, string | null>() };
};

const resolveFolderPathFast = (
  pId: string,
  lookup: FolderLookup,
  visiting?: Set<string>,
): string | null => {
  if (!pId || pId === 'root' || pId === '0') return '';
  const key = String(pId);
  if (lookup.pathCache.has(key)) return lookup.pathCache.get(key)!;
  if (visiting?.has(key)) return '';

  const folder = lookup.byId.get(key);
  if (!folder) {
    // Unknown/missing parent ID: return null when resolving a FILE's pId,
    // but for a FOLDER whose own parent is missing we hoist it to root below!
    lookup.pathCache.set(key, null);
    return null;
  }

  const nextVisiting = visiting || new Set<string>();
  nextVisiting.add(key);
  const rawParentPath = resolveFolderPathFast(folder.pId, lookup, nextVisiting);
  nextVisiting.delete(key);

  // CRITICAL: NEVER drop a folder just because its parent folder wasn't fetched or was deleted!
  // Hoist orphan folders to channel root so they (and all their children) ALWAYS render!
  const parentPath = rawParentPath === null ? '' : rawParentPath;
  const full = parentPath ? `${parentPath}/${folder.name}` : folder.name;
  lookup.pathCache.set(key, full);
  return full;
};

export const resolveFolderPath = (
  pId: string,
  foldersList?: FolderEntry[],
  _visiting?: Set<string>,
): string | null => {
  if (!pId || pId === 'root') return '';
  const lookup = createFolderLookup(foldersList);
  return resolveFolderPathFast(pId, lookup);
};

const searchChannelMessages = async (
  client: TelegramClient,
  peer: any,
  query: string,
  maxPages = 25,
): Promise<any[]> => {
  const out: any[] = [];
  let offsetId = 0;
  for (let p = 0; p < maxPages; p++) {
    const res: any = await gate(1, async () => {
      await ensureTelegramConnected(client);
      return client.invoke(
        new Api.messages.Search({
          peer,
          q: query,
          filter: new Api.InputMessagesFilterEmpty(),
          minDate: 0,
          maxDate: 0,
          offsetId,
          addOffset: 0,
          limit: HISTORY_PAGE,
          maxId: 0,
          minId: 0,
          hash: 0 as any,
        }),
      );
    });
    const msgs: any[] = Array.isArray(res?.messages) ? res.messages : [];
    if (msgs.length === 0) break;
    for (const m of msgs) {
      if (m && typeof m.id === 'number') out.push(m);
    }
    if (msgs.length < HISTORY_PAGE) break;
    offsetId = msgs[msgs.length - 1].id;
  }
  return out;
};

const fetchOldestHistoryPages = async (
  client: TelegramClient,
  peer: any,
  pages = 2,
): Promise<any[]> => {
  const out: any[] = [];
  let minOffsetId = 1;
  for (let p = 0; p < pages; p++) {
    try {
      const res: any = await gate(1, async () => {
        await ensureTelegramConnected(client);
        return client.invoke(
          new Api.messages.GetHistory({
            peer,
            limit: HISTORY_PAGE,
            offsetId: minOffsetId,
            offsetDate: 0,
            addOffset: -HISTORY_PAGE,
            maxId: 0,
            minId: 0,
            hash: 0 as any,
          }),
        );
      });
      const msgs: any[] = Array.isArray(res?.messages) ? res.messages : [];
      if (msgs.length === 0) break;
      let maxIdInPage = 0;
      for (const m of msgs) {
        if (m && typeof m.id === 'number') {
          out.push(m);
          if (m.id > maxIdInPage) maxIdInPage = m.id;
        }
      }
      if (msgs.length < HISTORY_PAGE || maxIdInPage <= minOffsetId) break;
      minOffsetId = maxIdInPage + 1;
    } catch {
      break;
    }
  }
  return out;
};

const fetchSingleHistoryPage = async (
  client: TelegramClient,
  peer: any,
  opts: { offsetId?: number; minId?: number; limit?: number },
): Promise<{ messages: any[]; totalCount?: number }> => {
  const limit = opts.limit || HISTORY_PAGE;
  const page: any = await gate(1, async () => {
    await ensureTelegramConnected(client);
    const getOpts: any = { limit };
    if (opts.offsetId && opts.offsetId > 0) getOpts.offsetId = opts.offsetId;
    if (opts.minId && opts.minId > 0) getOpts.minId = opts.minId;
    return client.getMessages(peer, getOpts) as any;
  });
  const list = Array.isArray(page) ? page : [];
  const totalCount = typeof (page as any)?.total === 'number' && (page as any).total > 0
    ? Number((page as any).total)
    : undefined;
  return { messages: list, totalCount };
};

export const fetchChannelTopInfo = async (
  client: TelegramClient,
  peer: any,
): Promise<{ topId: number; totalCount: number }> => {
  try {
    const res: any = await gate(1, async () => {
      await ensureTelegramConnected(client);
      return client.invoke(
        new Api.messages.GetHistory({
          peer,
          limit: 1,
          offsetId: 0,
          offsetDate: 0,
          addOffset: 0,
          maxId: 0,
          minId: 0,
          hash: 0 as any,
        }),
      );
    });
    const topMsg = Array.isArray(res?.messages) ? res.messages[0] : null;
    const topId = Number(topMsg?.id || 0);
    const totalCount = Number(res?.count || (Array.isArray(res?.messages) ? res.messages.length : 0));
    return { topId, totalCount };
  } catch {
    const { messages, totalCount } = await fetchSingleHistoryPage(client, peer, { limit: 1 });
    return {
      topId: Number(messages[0]?.id || 0),
      totalCount: Number(totalCount || messages.length || 0),
    };
  }
};

export interface FileMetadata {
  f?: string;
  n?: string;
  p?: number;
  tp?: number;
  t: string;
  path?: string;
  pId?: string;
  id?: string;
  dur?: number;
  totalDur?: number;
  w?: number;
  h?: number;
  audios?: any[];
  subs?: any[];
  s?: number;
  mime?: string;
  performer?: string;
  title?: string;
}

export interface VirtualFile {
  id: string;
  name: string;
  path: string;
  mimeType: string;
  size: number;
  duration?: number;
  width?: number;
  height?: number;
  audioTracks?: any[];
  subtitleTracks?: any[];
  parts: { partNum: number; messageId: number; channelId: any; size: number; duration?: number }[];
  isComplete: boolean;
  date?: number;
  performer?: string;
  title?: string;
  pId?: string;
  isUncaptioned?: boolean;
  isUnindexed?: boolean;
}

export interface VirtualFolder {
  id: string;
  name: string;
  path: string;
  files: VirtualFile[];
  folders: { [name: string]: VirtualFolder };
  isLoaded?: boolean;
  channelId?: any;
  accessHash?: any;
  msgId?: number;
  folderId?: string;
  serverTotalCount?: number;
  estimatedTotalBytes?: number;
  historyComplete?: boolean;
  isLazyChannel?: boolean;
  subfolderSynced?: boolean;
}

export interface CachedFolderBucket {
  channelId: string;
  folderId: string;
  files: VirtualFile[];
  syncedAt: number;
  complete: boolean;
}

export interface CachedChannel {
  channelId: string;
  lastMessageId: number;
  minSyncedId?: number;
  historyComplete?: boolean;
  lazyMode?: boolean;
  serverTotalCount?: number;
  avgFileBytes?: number;
  files: VirtualFile[];
  foldersList?: FolderEntry[];
  counts?: Record<string, {
    directFileCount: number;
    directFolderCount: number;
    recursiveFileCount: number;
    recursiveFolderCount: number;
  }>;
  cacheVersion?: number;
  lastSyncedAt?: number;
  lastValidation?: number;
}

const DB_NAME = 'ZudCloud_VFS';
const DB_VERSION = 2;
const STORE_NAME = 'channels';
const FOLDER_STORE_NAME = 'folder_items';

let dbPromise: Promise<IDBPDatabase> | null = null;
export const getDb = () => {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME);
        }
        if (!db.objectStoreNames.contains(FOLDER_STORE_NAME)) {
          db.createObjectStore(FOLDER_STORE_NAME);
        }
      },
    });
  }
  return dbPromise;
};

const folderBucketKey = (channelId: string, folderId: string) => `${channelId}:${folderId || 'root'}`;

export const loadFolderBucket = async (channelId: string, folderId: string): Promise<CachedFolderBucket | null> => {
  try {
    const db = await getDb();
    const bucket = await db.get(FOLDER_STORE_NAME, folderBucketKey(channelId, folderId));
    if (bucket && Array.isArray(bucket.files)) {
      return bucket as CachedFolderBucket;
    }
    return null;
  } catch (e) {
    console.warn('Failed to load folder bucket:', channelId, folderId, e);
    return null;
  }
};

export const saveFolderBucket = async (
  channelId: string,
  folderId: string,
  files: VirtualFile[],
  complete = true,
) => {
  try {
    const db = await getDb();
    const bucket: CachedFolderBucket = {
      channelId,
      folderId: folderId || 'root',
      files,
      syncedAt: Date.now(),
      complete,
    };
    await db.put(FOLDER_STORE_NAME, bucket, folderBucketKey(channelId, folderId));
  } catch (e) {
    console.warn('Failed to save folder bucket:', channelId, folderId, e);
  }
};

const clearChannelFolderBuckets = async (channelId: string) => {
  try {
    const db = await getDb();
    const tx = db.transaction(FOLDER_STORE_NAME, 'readwrite');
    const range = IDBKeyRange.bound(`${channelId}:`, `${channelId}:\uffff`);
    let cursor = await tx.store.openCursor(range);
    while (cursor) {
      await cursor.delete();
      cursor = await cursor.continue();
    }
    await tx.done;
  } catch (e) {
    console.warn('Failed to clear folder buckets for channel:', channelId, e);
  }
};

const buildChannelCounts = (cache: CachedChannel) => {
  const counts: NonNullable<CachedChannel['counts']> = {};
  const folders = cache.foldersList || [];
  const lookup = createFolderLookup(folders);

  const fileCounts = new Map<string, number>();
  const folderIdByPath = new Map<string, string>();
  for (const folder of folders) {
    const p = resolveFolderPathFast(folder.id, lookup);
    if (p !== null) folderIdByPath.set(p, folder.id);
  }

  for (const file of cache.files || []) {
    const parent = file.path.includes('/')
      ? file.path.slice(0, file.path.lastIndexOf('/'))
      : '';
    const key = (file.pId && lookup.byId.has(String(file.pId)))
      ? String(file.pId)
      : (folderIdByPath.get(parent) || 'root');
    fileCounts.set(key, (fileCounts.get(key) || 0) + 1);
  }

  const children = new Map<string, string[]>();
  for (const folder of folders) {
    counts[folder.id] ||= {
      directFileCount: fileCounts.get(folder.id) || 0,
      directFolderCount: 0,
      recursiveFileCount: fileCounts.get(folder.id) || 0,
      recursiveFolderCount: 0,
    };
    const parent = folder.pId || 'root';
    counts[parent] ||= { directFileCount: 0, directFolderCount: 0, recursiveFileCount: 0, recursiveFolderCount: 0 };
    counts[parent].directFolderCount += 1;
    let list = children.get(parent);
    if (!list) {
      list = [];
      children.set(parent, list);
    }
    list.push(folder.id);
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): NonNullable<CachedChannel['counts']>[string] => {
    const entry = counts[id] ||= {
      directFileCount: fileCounts.get(id) || 0,
      directFolderCount: 0,
      recursiveFileCount: fileCounts.get(id) || 0,
      recursiveFolderCount: 0,
    };
    if (visited.has(id) || visiting.has(id)) return entry;
    visiting.add(id);
    for (const child of children.get(id) || []) {
      const childStats = visit(child);
      entry.recursiveFileCount += childStats.recursiveFileCount;
      entry.recursiveFolderCount += childStats.recursiveFolderCount + 1;
    }
    visiting.delete(id);
    visited.add(id);
    return entry;
  };
  visit('root');
  return counts;
};

export const sanitizeFileParts = (parts: VirtualFile['parts']): VirtualFile['parts'] => {
  if (!parts || parts.length === 0) return [];
  if (parts.length === 1) return parts;
  const byPartNum = new Map<number, VirtualFile['parts'][number]>();
  for (const part of parts) {
    if (!part || typeof part.messageId !== 'number') continue;
    const prev = byPartNum.get(part.partNum);
    if (!prev || part.messageId >= prev.messageId) {
      byPartNum.set(part.partNum, part);
    }
  }
  const sorted = Array.from(byPartNum.values()).sort((a, b) => a.partNum - b.partNum);
  if (sorted.length <= 1) return sorted;

  const part1 = sorted.find(p => p.partNum === 1);
  if (part1) {
    const hasStaleParts = sorted.some(p => p.partNum > 1 && p.messageId <= part1.messageId);
    if (hasStaleParts) {
      const validGeneration = sorted.filter(p => p.partNum === 1 || p.messageId > part1.messageId);
      if (validGeneration.length === 1) {
        return [part1];
      }
      return validGeneration;
    }
  }
  return sorted;
};

export const saveChannelCache = async (channelId: string, cache: CachedChannel) => {
  try {
    cache.cacheVersion = 3;
    cache.lastSyncedAt = Date.now();
    // In lazyMode, keep the channel metadata record ultra-lightweight (folder tree + root/recent files only)
    // so page refresh loads in < 20ms instead of deserializing an 80MB monolithic blob!
    if (cache.lazyMode && cache.files.length > 400) {
      cache.files = cache.files.filter(f => !f.pId || f.pId === 'root').slice(-300);
    }
    if (!cache.lazyMode) {
      cache.counts = buildChannelCounts(cache);
    } else {
      cache.counts = undefined;
    }
    const db = await getDb();
    await db.put(STORE_NAME, cache, channelId);
  } catch (e) {
    console.warn('Failed to save channel cache:', e);
  }
};

export const clearChannelCache = async (channelId: string) => {
  try {
    const db = await getDb();
    await db.delete(STORE_NAME, channelId);
    await clearChannelFolderBuckets(channelId);
  } catch (e) {
    console.warn('Failed to clear channel cache:', e);
  }
};

export const loadChannelCache = async (channelId: string): Promise<CachedChannel | null> => {
  try {
    const db = await getDb();
    const data = await db.get(STORE_NAME, channelId) as CachedChannel | undefined;
    if (!data) return null;

    if (!Array.isArray(data.files) || typeof data.lastMessageId !== 'number') {
      console.warn('Cache corruption detected! Rebuilding cache for', channelId);
      await clearChannelCache(channelId);
      return null;
    }

    // Auto-migrate any legacy massive monolithic cache (> LAZY_CHANNEL_THRESHOLD files)
    // into normalized per-folder IndexedDB buckets so refresh NEVER freezes again!
    const isOversizedMonolith = data.files.length > LAZY_CHANNEL_THRESHOLD ||
      ((data.serverTotalCount || 0) > LAZY_CHANNEL_THRESHOLD && data.files.length > 400);

    if (isOversizedMonolith) {
      const byFolder = new Map<string, VirtualFile[]>();
      const rootFiles: VirtualFile[] = [];
      for (const file of data.files) {
        const pid = file.pId && file.pId !== 'root' ? String(file.pId) : 'root';
        if (pid === 'root') {
          rootFiles.push(file);
        } else {
          let list = byFolder.get(pid);
          if (!list) {
            list = [];
            byFolder.set(pid, list);
          }
          list.push(file);
        }
      }

      // Persist partitioned folder buckets in one fast IDB transaction
      const tx = db.transaction(FOLDER_STORE_NAME, 'readwrite');
      const now = Date.now();
      for (const [fid, files] of byFolder.entries()) {
        await tx.store.put(
          { channelId, folderId: fid, files, syncedAt: now, complete: false } as CachedFolderBucket,
          folderBucketKey(channelId, fid),
        );
      }
      await tx.done;

      data.lazyMode = true;
      data.historyComplete = true;
      data.files = rootFiles.slice(-300);
      data.counts = undefined;
      data.cacheVersion = 3;
      await db.put(STORE_NAME, data, channelId);
      return data;
    }

    // Fast path for already-clean v3 caches: skip expensive full-array healing on every refresh!
    if (data.cacheVersion === 3) {
      return data;
    }

    let hasHealed = false;
    for (const file of data.files) {
      if (file.parts && file.parts.length > 0) {
        const firstPart = file.parts[0];
        if (typeof firstPart.messageId !== 'number' || typeof firstPart.channelId !== 'string') {
          console.warn('Cache legacy corruption detected (BigInts/Objects)! Rebuilding...', channelId);
          await clearChannelCache(channelId);
          return null;
        }
        if (file.parts.length > 1) {
          const originalLen = file.parts.length;
          const cleaned = sanitizeFileParts(file.parts);
          if (cleaned.length !== originalLen) {
            file.parts = cleaned;
            file.size = cleaned.reduce((sum: number, p: any) => sum + (p.size || 0), 0);
            if (cleaned.length === 1) file.isComplete = true;
            hasHealed = true;
          }
        }
      }
    }

    if ((data.serverTotalCount || 0) > LAZY_CHANNEL_THRESHOLD) {
      data.lazyMode = true;
      data.historyComplete = true;
      hasHealed = true;
    }

    if (!data.lazyMode && (!data.counts || data.cacheVersion !== 3 || hasHealed)) {
      data.counts = buildChannelCounts(data);
    }
    data.cacheVersion = 3;
    await db.put(STORE_NAME, data, channelId);
    return data;
  } catch (e) {
    console.warn('Failed to load channel cache, assuming corrupt:', e);
    await clearChannelCache(channelId);
    return null;
  }
};

export const parseDocSize = (size: any): number => {
  if (size === undefined || size === null) return 0;
  if (typeof size === 'number') return size;
  if (typeof size === 'bigint') return Number(size);
  if (typeof size.toJSNumber === 'function') return size.toJSNumber();
  const n = Number(size);
  return isNaN(n) ? 0 : n;
};

export const parsePhotoSize = (photo: any): number => {
  if (!photo || !Array.isArray(photo.sizes)) return 0;
  let maxBytes = 0;
  for (const sz of photo.sizes) {
    if (!sz) continue;
    if (typeof sz.size === 'number' && sz.size > maxBytes) {
      maxBytes = sz.size;
    } else if (Array.isArray(sz.sizes) && sz.sizes.length > 0) {
      const last = Number(sz.sizes[sz.sizes.length - 1] || 0);
      if (last > maxBytes) maxBytes = last;
    } else if (sz.bytes && typeof sz.bytes.length === 'number' && sz.bytes.length > maxBytes) {
      maxBytes = sz.bytes.length;
    }
  }
  return maxBytes;
};

export const parseMetadataList = (caption?: string): FileMetadata[] => {
  try {
    if (!caption) return [];
    const firstBrace = caption.indexOf('{');
    const firstArray = caption.indexOf('[');
    const start = firstArray !== -1 && (firstBrace === -1 || firstArray < firstBrace)
      ? firstArray
      : firstBrace;
    if (start === -1) return [];
    const lastObject = caption.lastIndexOf('}');
    const lastArray = caption.lastIndexOf(']');
    const end = lastArray > lastObject ? lastArray : lastObject;
    if (end <= start) return [];
    const parsed = JSON.parse(caption.slice(start, end + 1));
    if (Array.isArray(parsed)) return parsed.filter(item => item && typeof item === 'object') as FileMetadata[];
    if (parsed && typeof parsed === 'object') return [parsed as FileMetadata];
  } catch {
    try {
      const match = caption?.match(/\[[\s\S]*\]|\{[\s\S]*\}/);
      if (match) {
        const parsed = JSON.parse(match[0]);
        if (Array.isArray(parsed)) return parsed.filter(item => item && typeof item === 'object') as FileMetadata[];
        if (parsed && typeof parsed === 'object') return [parsed as FileMetadata];
      }
    } catch (_) {}
  }
  return [];
};

export const parseMetadata = (caption?: string): FileMetadata | null => {
  const metadata = parseMetadataList(caption);
  return metadata[0] || null;
};

export const getMimeType = (t: string, filename: string, explicitMime?: string): string => {
  if (explicitMime && explicitMime !== 'application/octet-stream') return explicitMime;
  const ext = filename.split('.').pop()?.toLowerCase();

  if (t === 'video' || ['mp4', 'mkv', 'webm', 'mov', 'avi', 'flv', 'm4v', 'ts', '3gp', 'wmv', 'asf', 'ogv'].includes(ext || '')) {
    if (ext === 'mkv') return 'video/x-matroska';
    if (ext === 'webm') return 'video/webm';
    if (ext === 'mov') return 'video/quicktime';
    if (ext === 'avi') return 'video/x-msvideo';
    if (ext === 'flv') return 'video/x-flv';
    if (ext === 'ts') return 'video/mp2t';
    if (ext === '3gp') return 'video/3gpp';
    if (ext === 'wmv') return 'video/x-ms-wmv';
    if (ext === 'asf') return 'video/x-ms-asf';
    if (ext === 'ogv') return 'video/ogg';
    return 'video/mp4';
  }

  if (t === 'audio') {
    if (ext === 'mp3') return 'audio/mpeg';
    if (ext === 'ogg') return 'audio/ogg';
    if (ext === 'wav') return 'audio/wav';
    if (ext === 'flac') return 'audio/flac';
    if (ext === 'm4a') return 'audio/mp4';
    return 'audio/mpeg';
  }

  if (t === 'image') {
    if (ext === 'png') return 'image/png';
    if (ext === 'gif') return 'image/gif';
    if (ext === 'webp') return 'image/webp';
    if (ext === 'svg') return 'image/svg+xml';
    return 'image/jpeg';
  }

  if (t === 'pdf' || ext === 'pdf') return 'application/pdf';
  if (t === 'document' || ['txt', 'md', 'csv', 'json', 'xml', 'html', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx'].includes(ext || '')) {
    const documentTypes: Record<string, string> = {
      txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', json: 'application/json',
      xml: 'application/xml', html: 'text/html', doc: 'application/msword',
      docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      xls: 'application/vnd.ms-excel',
      xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      ppt: 'application/vnd.ms-powerpoint',
      pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    };
    return documentTypes[ext || ''] || 'text/plain';
  }

  return 'application/octet-stream';
};

export const insertFileIntoFolderTree = (
  channelFolder: VirtualFolder,
  file: VirtualFile,
  seenByFolder?: WeakMap<VirtualFolder, Set<string>>,
) => {
  const pathParts = file.path.split('/');
  let currentFolder = channelFolder;
  for (let i = 0; i < pathParts.length - 1; i++) {
    const folderName = pathParts[i];
    if (!currentFolder.folders[folderName]) {
      currentFolder.folders[folderName] = {
        id: `${currentFolder.id}/${folderName}`,
        name: folderName,
        path: `${currentFolder.id}/${folderName}`,
        files: [],
        folders: {},
        channelId: channelFolder.channelId,
        isLoaded: channelFolder.isLoaded ?? true,
        isLazyChannel: channelFolder.isLazyChannel,
      };
    }
    currentFolder = currentFolder.folders[folderName];
  }
  if (seenByFolder) {
    let seen = seenByFolder.get(currentFolder);
    if (!seen) {
      seen = new Set<string>();
      seenByFolder.set(currentFolder, seen);
    }
    if (!seen.has(file.id)) {
      seen.add(file.id);
      currentFolder.files.push(file);
    }
  } else if (!currentFolder.files.some(f => f.id === file.id)) {
    currentFolder.files.push(file);
  }
};

export const insertFolderIntoTree = (
  channelFolder: VirtualFolder,
  path: string,
  msgId?: number,
  folderId?: string,
): VirtualFolder | null => {
  if (!path) return null;
  const pathParts = path.split('/');
  let currentFolder = channelFolder;
  for (let i = 0; i < pathParts.length; i++) {
    const folderName = pathParts[i];
    if (!currentFolder.folders[folderName]) {
      currentFolder.folders[folderName] = {
        id: `${currentFolder.id}/${folderName}`,
        name: folderName,
        path: `${currentFolder.id}/${folderName}`,
        files: [],
        folders: {},
        msgId: undefined,
        channelId: channelFolder.channelId,
        isLoaded: channelFolder.isLoaded ?? true,
        isLazyChannel: channelFolder.isLazyChannel,
      };
    }
    currentFolder = currentFolder.folders[folderName];
  }
  if (msgId !== undefined) {
    currentFolder.msgId = msgId;
  }
  if (folderId !== undefined) {
    currentFolder.folderId = folderId;
  }
  return currentFolder;
};

const findSubfolderNodeById = (root: VirtualFolder, targetFolderId: string): VirtualFolder | null => {
  const stack: VirtualFolder[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.folderId && String(node.folderId) === String(targetFolderId)) {
      return node;
    }
    for (const sub of Object.values(node.folders)) {
      stack.push(sub);
    }
  }
  return null;
};

export const markFoldersLoaded = (folder: VirtualFolder) => {
  const stack: VirtualFolder[] = [folder];
  while (stack.length > 0) {
    const node = stack.pop()!;
    node.isLoaded = true;
    if (node.folders) {
      for (const sub of Object.values(node.folders)) {
        stack.push(sub);
      }
    }
  }
};

const dedupeCachedFiles = (files: VirtualFile[]): VirtualFile[] => {
  if (!files || files.length === 0) return [];
  const byId = new Map<string, VirtualFile>();
  for (const file of files) {
    const existing = byId.get(file.id);
    if (!existing) {
      const cleanParts = sanitizeFileParts(file.parts || []);
      if (cleanParts !== file.parts) {
        byId.set(file.id, {
          ...file,
          parts: cleanParts,
          size: cleanParts.reduce((sum, p) => sum + (p.size || 0), 0),
        });
      } else {
        byId.set(file.id, file);
      }
      continue;
    }
    const allParts = [...(existing.parts || []), ...(file.parts || [])];
    const cleanParts = sanitizeFileParts(allParts);
    existing.parts = cleanParts;
    existing.size = cleanParts.reduce((total, part) => total + (part.size || 0), 0);
    existing.isComplete = existing.parts.length > 0;
    existing.date = Math.max(existing.date || 0, file.date || 0) || undefined;
    existing.duration = file.duration || existing.duration;
    existing.width = file.width || existing.width;
    existing.height = file.height || existing.height;
  }
  return Array.from(byId.values());
};

export const hydrateChannelFromCache = (
  channelFolder: VirtualFolder,
  cached: CachedChannel,
  globalFilesMap?: { [path: string]: VirtualFile },
) => {
  if (!cached) return;

  // Preserve any already-synced subfolder files in lazyMode so refreshing channel metadata doesn't wipe opened folders!
  const preservedLazySubfolders = new Map<string, { files: VirtualFile[]; subfolderSynced?: boolean }>();
  if (cached.lazyMode && Object.keys(channelFolder.folders).length > 0) {
    const stack: VirtualFolder[] = Object.values(channelFolder.folders);
    while (stack.length > 0) {
      const node = stack.pop()!;
      if (node.folderId && (node.files.length > 0 || node.subfolderSynced)) {
        preservedLazySubfolders.set(String(node.folderId), {
          files: node.files,
          subfolderSynced: node.subfolderSynced,
        });
      }
      for (const sub of Object.values(node.folders)) {
        stack.push(sub);
      }
    }
  }

  cached.files = dedupeCachedFiles(cached.files || []);
  channelFolder.files = [];
  channelFolder.folders = {};
  channelFolder.isLazyChannel = Boolean(cached.lazyMode);

  // Build O(1) folder lookup ONCE — eliminates O(N * F) main-thread freezes!
  const lookup = createFolderLookup(cached.foldersList);

  // 1. Rebuild subfolders from foldersList in O(F)
  if (cached.foldersList && cached.foldersList.length > 0) {
    for (const folder of cached.foldersList) {
      const fullPath = resolveFolderPathFast(folder.id, lookup);
      if (fullPath === null || !fullPath) continue;
      const node = insertFolderIntoTree(channelFolder, fullPath, folder.msgId, folder.id);
      if (node && cached.lazyMode) {
        node.isLazyChannel = true;
        const preserved = preservedLazySubfolders.get(String(folder.id));
        if (preserved) {
          node.files = preserved.files;
          node.subfolderSynced = preserved.subfolderSynced;
        }
      }
    }
  }

  // 2. Insert cached files in O(N) using O(1) folder lookup + WeakMap dedupe!
  const seenByFolder = new WeakMap<VirtualFolder, Set<string>>();
  if (cached.files) {
    for (const file of cached.files) {
      if (file.pId && file.pId !== 'root') {
        const resolved = resolveFolderPathFast(file.pId, lookup);
        if (resolved !== null && resolved !== '') {
          const nextPath = `${resolved}/${file.name}`;
          if (file.path !== nextPath) {
            file.path = nextPath;
            file.id = `${channelFolder.id}/${nextPath}`;
          }
        }
      }
      if (globalFilesMap) {
        globalFilesMap[file.id] = file;
        globalFilesMap[file.path] = file;
      }
      insertFileIntoFolderTree(channelFolder, file, seenByFolder);
    }
  }

  channelFolder.serverTotalCount = cached.serverTotalCount;
  if (cached.lazyMode && cached.avgFileBytes && cached.avgFileBytes > 0 && cached.serverTotalCount && cached.serverTotalCount > 0) {
    channelFolder.estimatedTotalBytes = Math.round(cached.avgFileBytes * cached.serverTotalCount);
  }
  channelFolder.historyComplete = cached.lazyMode ? true : cached.historyComplete;
  markFoldersLoaded(channelFolder);
};

const parseMessagesIntoFilesAndFolders = (
  channelIdStr: string,
  channelFolderId: string,
  foldersList: FolderEntry[],
  existingFiles: VirtualFile[],
  batch: any[],
  externalMaps?: { byIdMap: Map<string, VirtualFile>; byMsgIdMap: Map<number, VirtualFile> },
): { hasNewFiles: boolean; hasNewFolders: boolean; maxMsgId: number; touchedFolderIds: Set<string> } => {
  const touchedFolderIds = new Set<string>();
  if (!batch || batch.length === 0) {
    return { hasNewFiles: false, hasNewFolders: false, maxMsgId: 0, touchedFolderIds };
  }

  const sorted = [...batch].filter(m => m && typeof m.id === 'number').sort((a, b) => a.id - b.id);
  if (sorted.length === 0) {
    return { hasNewFiles: false, hasNewFolders: false, maxMsgId: 0, touchedFolderIds };
  }

  let byIdMap = externalMaps?.byIdMap;
  let byMsgIdMap = externalMaps?.byMsgIdMap;
  if (!byIdMap || !byMsgIdMap) {
    byIdMap = new Map<string, VirtualFile>();
    byMsgIdMap = new Map<number, VirtualFile>();
    for (const f of existingFiles) {
      byIdMap.set(f.id, f);
      for (const p of f.parts || []) {
        byMsgIdMap.set(p.messageId, f);
      }
    }
  }

  let hasNewFiles = false;
  let hasNewFolders = false;
  let maxMsgId = 0;

  const folderById = new Map<string, FolderEntry>();
  for (const f of foldersList) {
    folderById.set(String(f.id), f);
  }

  for (const msg of sorted) {
    if (msg.id > maxMsgId) maxMsgId = msg.id;
    const metadataList = parseMetadataList(msg.message);
    for (const meta of metadataList) {
      if (meta.t !== 'dir' || !meta.id) continue;
      const fid = String(meta.id);
      const existingFolder = folderById.get(fid);
      if (existingFolder) {
        if (
          existingFolder.name !== (meta.n || existingFolder.name) ||
          existingFolder.pId !== (meta.pId || existingFolder.pId || 'root') ||
          existingFolder.msgId !== msg.id
        ) {
          existingFolder.name = meta.n || existingFolder.name;
          existingFolder.pId = meta.pId || existingFolder.pId || 'root';
          existingFolder.msgId = msg.id;
          hasNewFolders = true;
        }
      } else {
        const nf: FolderEntry = {
          id: fid,
          name: meta.n || 'Unnamed',
          pId: String(meta.pId || 'root'),
          msgId: msg.id,
        };
        foldersList.push(nf);
        folderById.set(fid, nf);
        hasNewFolders = true;
      }
    }
  }

  const lookup = createFolderLookup(foldersList);

  for (const msg of sorted) {
    let meta = parseMetadata(msg.message);
    const document = msg.media?.className === 'MessageMediaDocument' ? (msg.media.document as any) : null;
    const photo = msg.media?.className === 'MessageMediaPhoto' ? (msg.media.photo as any) : null;
    const isUncaptionedMsg = !meta && !!(document || photo);

    if (!meta && (document || photo)) {
      const filenameAttr = document?.attributes?.find((a: any) => a.className === 'DocumentAttributeFilename');
      if (
        filenameAttr?.fileName === 'playlist_order.txt' ||
        msg.message?.includes('#ZUD_PLAYLIST_ORDER') ||
        msg.message?.startsWith('ZUD_ORDER:')
      ) {
        continue;
      }

      const audioAttr = document?.attributes?.find((a: any) => a.className === 'DocumentAttributeAudio');
      const videoAttr = document?.attributes?.find((a: any) => a.className === 'DocumentAttributeVideo');
      const isDocAudio = document?.mimeType?.startsWith('audio/') || !!audioAttr;
      const isDocVideo = document?.mimeType?.startsWith('video/') || !!videoAttr;
      const isDocImage = document?.mimeType?.startsWith('image/') || !!photo;

      let fn = filenameAttr?.fileName;
      if (!fn) {
        const rawCaption = (msg.message || '').trim();
        if (rawCaption && !rawCaption.startsWith('{') && !rawCaption.startsWith('[')) {
          let firstLine = rawCaption.split('\n')[0].trim();
          firstLine = firstLine.replace(/^(?:📄\s*)?File:\s*/i, '').trim();
          firstLine = firstLine.replace(/[\\/:*?"<>|]/g, '_');
          if (firstLine.length > 0 && firstLine.length < 255) {
            fn = firstLine;
          }
        }
      }

      if (!fn) {
        if (audioAttr?.title) {
          fn = audioAttr.performer ? `${audioAttr.performer} - ${audioAttr.title}.mp3` : `${audioAttr.title}.mp3`;
        } else if (isDocVideo) {
          fn = `Video_${msg.id}.mp4`;
        } else if (isDocImage || photo) {
          fn = `Image_${msg.id}.jpg`;
        } else {
          fn = `File_${msg.id}`;
        }
      }

      if (fn && !fn.includes('.')) {
        if (isDocVideo) fn += '.mp4';
        else if (isDocAudio) fn += '.mp3';
        else if (isDocImage || photo) fn += '.jpg';
      }

      let type = 'file';
      if (isDocAudio) type = 'audio';
      else if (isDocVideo) type = 'video';
      else if (isDocImage || photo) type = 'image';

      const docSize = document ? parseDocSize(document.size) : (photo ? parsePhotoSize(photo) : 0);

      meta = {
        n: fn,
        pId: 'root',
        t: type,
        s: docSize,
        dur: Number(audioAttr?.duration || videoAttr?.duration || 0),
        p: 1,
        tp: 1,
        mime: document?.mimeType || (isDocAudio ? 'audio/mpeg' : (isDocVideo ? 'video/mp4' : (isDocImage || photo ? 'image/jpeg' : 'application/octet-stream'))),
        performer: audioAttr?.performer,
        title: audioAttr?.title,
        w: videoAttr?.w,
        h: videoAttr?.h,
      };
    }

    if (meta && meta.t !== 'dir') {
      if (!meta.pId && !meta.path) continue;
      const fileName = meta.n || meta.f || 'UnknownFile';
      const resolvedDir = meta.path || resolveFolderPathFast(meta.pId || 'root', lookup);
      const dirPath = resolvedDir !== null ? resolvedDir : '';

      let fullPath = fileName;
      if (dirPath !== 'Root' && dirPath !== '') fullPath = `${dirPath}/${fileName}`;
      const uniquePath = `${channelFolderId}/${fullPath}`;

      const msgId = Number(msg.id);
      const pIdStr = meta.pId ? String(meta.pId) : 'root';
      let fileEntry = byIdMap.get(uniquePath) || byMsgIdMap.get(msgId);
      if (!fileEntry) {
        fileEntry = {
          id: uniquePath,
          name: fileName,
          path: fullPath,
          mimeType: getMimeType(meta.t, fileName, meta.mime),
          size: 0,
          duration: 0,
          parts: [],
          isComplete: false,
          performer: meta.performer,
          title: meta.title,
          pId: pIdStr,
          isUncaptioned: isUncaptionedMsg,
        };
        existingFiles.push(fileEntry);
        byIdMap.set(uniquePath, fileEntry);
        hasNewFiles = true;
        touchedFolderIds.add(pIdStr);
      } else {
        if (fileEntry.id !== uniquePath) {
          byIdMap.delete(fileEntry.id);
          fileEntry.id = uniquePath;
          byIdMap.set(uniquePath, fileEntry);
        }
        fileEntry.name = fileName;
        fileEntry.path = fullPath;
        if (meta.pId) fileEntry.pId = pIdStr;
        fileEntry.isUncaptioned = Boolean(isUncaptionedMsg);
        if (meta.mime) fileEntry.mimeType = getMimeType(meta.t, fileName, meta.mime);
        if (meta.performer) fileEntry.performer = meta.performer;
        if (meta.title) fileEntry.title = meta.title;
      }

      const telegramPartSize = document?.className === 'Document'
        ? parseDocSize(document.size)
        : (photo ? parsePhotoSize(photo) : 0);
      const partSize = telegramPartSize || Number(meta.s || 0);
      const videoAttribute = document?.attributes?.find((attribute: any) => attribute.className === 'DocumentAttributeVideo');
      const audioAttribute = document?.attributes?.find((attribute: any) => attribute.className === 'DocumentAttributeAudio');
      if (audioAttribute) {
        if (audioAttribute.performer && !fileEntry.performer) fileEntry.performer = audioAttribute.performer;
        if (audioAttribute.title && !fileEntry.title) fileEntry.title = audioAttribute.title;
      }
      const partDuration = Number(meta.dur || videoAttribute?.duration || audioAttribute?.duration || 0);
      const msgVersion = Number(msg.editDate || msg.date || 0);
      const incomingPartNum = Number(meta.p || 1);
      const totalParts = Number(meta.tp || 1);

      const maxExistingMsgId = fileEntry.parts && fileEntry.parts.length > 0
        ? Math.max(...fileEntry.parts.map(p => p.messageId))
        : 0;

      if (
        fileEntry.parts &&
        fileEntry.parts.length > 0 &&
        msgId > maxExistingMsgId &&
        (incomingPartNum === 1 || totalParts === 1 || totalParts < fileEntry.parts.length)
      ) {
        fileEntry.parts = [];
        fileEntry.size = 0;
        fileEntry.duration = 0;
        fileEntry.isComplete = false;
        hasNewFiles = true;
        touchedFolderIds.add(pIdStr);
      }

      const existingPart = fileEntry.parts.find(p => p.partNum === incomingPartNum || p.messageId === msgId);
      if (!existingPart) {
        fileEntry.parts.push({
          partNum: incomingPartNum,
          messageId: msgId,
          channelId: channelIdStr,
          size: Number(partSize),
          duration: partDuration,
        });
        byMsgIdMap.set(msgId, fileEntry);
        hasNewFiles = true;
        touchedFolderIds.add(pIdStr);
      } else {
        let updatedPart = false;
        if (existingPart.messageId !== msgId) {
          existingPart.messageId = msgId;
          byMsgIdMap.set(msgId, fileEntry);
          updatedPart = true;
        }
        if (existingPart.partNum !== incomingPartNum) {
          existingPart.partNum = incomingPartNum;
          updatedPart = true;
        }
        if (partSize > 0 && existingPart.size !== partSize) {
          existingPart.size = partSize;
          updatedPart = true;
        }
        if (partDuration > 0 && existingPart.duration !== partDuration) {
          existingPart.duration = partDuration;
          updatedPart = true;
        }
        if (updatedPart) {
          hasNewFiles = true;
          touchedFolderIds.add(pIdStr);
        }
      }

      if (totalParts >= 1 && fileEntry.parts.some(p => p.partNum > totalParts)) {
        fileEntry.parts = fileEntry.parts.filter(p => p.partNum <= totalParts);
        hasNewFiles = true;
        touchedFolderIds.add(pIdStr);
      }

      fileEntry.parts = sanitizeFileParts(fileEntry.parts);
      const aggregateSize = fileEntry.parts.reduce((total, part) => total + (part.size || 0), 0);
      if (fileEntry.size !== aggregateSize) {
        fileEntry.size = aggregateSize;
        hasNewFiles = true;
      }

      if (meta.totalDur) {
        fileEntry.duration = meta.totalDur;
      } else {
        const durationTotal = fileEntry.parts.reduce((total, part) => total + (part.duration || 0), 0);
        if (durationTotal > 0) fileEntry.duration = durationTotal;
      }

      if (meta.w && !fileEntry.width) fileEntry.width = meta.w;
      if (meta.h && !fileEntry.height) fileEntry.height = meta.h;
      if (videoAttribute) {
        if (!fileEntry.width && videoAttribute.w) fileEntry.width = videoAttribute.w;
        if (!fileEntry.height && videoAttribute.h) fileEntry.height = videoAttribute.h;
      }
      if (meta.audios && (!fileEntry.audioTracks || fileEntry.audioTracks.length === 0)) fileEntry.audioTracks = meta.audios;
      if (meta.subs && (!fileEntry.subtitleTracks || fileEntry.subtitleTracks.length === 0)) fileEntry.subtitleTracks = meta.subs;

      if (msgVersion > (fileEntry.date || 0)) {
        fileEntry.date = msgVersion;
        hasNewFiles = true;
      }

      fileEntry.isComplete = fileEntry.parts.length === totalParts;
    }
  }

  return { hasNewFiles, hasNewFolders, maxMsgId, touchedFolderIds };
};

const ingestBatchIntoCache = (
  channelIdStr: string,
  channelFolderId: string,
  cached: CachedChannel,
  batch: any[],
  externalMaps?: { byIdMap: Map<string, VirtualFile>; byMsgIdMap: Map<number, VirtualFile> },
): boolean => {
  if (!batch || batch.length === 0) return false;
  if (!cached.foldersList) cached.foldersList = [];
  if (cached.files.length < 400) {
    const sortedForMsgCache = batch.filter(m => m && typeof m.id === 'number').slice(-200);
    if (sortedForMsgCache.length > 0) putMessages(channelIdStr, sortedForMsgCache as any[]);
  }
  const { hasNewFiles, hasNewFolders, maxMsgId } = parseMessagesIntoFilesAndFolders(
    channelIdStr,
    channelFolderId,
    cached.foldersList,
    cached.files,
    batch,
    externalMaps,
  );
  if (maxMsgId > cached.lastMessageId) cached.lastMessageId = maxMsgId;
  return hasNewFiles || hasNewFolders;
};

/**
 * Persist delta-synced files for a lazyMode channel directly into their per-folder IndexedDB buckets
 * so newly uploaded/moved files appear immediately even in 124,000+ item channels!
 */
const mergeDeltaFilesIntoLazyBuckets = async (
  channelIdStr: string,
  deltaFiles: VirtualFile[],
) => {
  if (deltaFiles.length === 0) return;
  const byFolder = new Map<string, VirtualFile[]>();
  for (const f of deltaFiles) {
    const pid = f.pId && f.pId !== 'root' ? String(f.pId) : 'root';
    if (pid === 'root') continue;
    let list = byFolder.get(pid);
    if (!list) {
      list = [];
      byFolder.set(pid, list);
    }
    list.push(f);
  }
  for (const [fid, incoming] of byFolder.entries()) {
    const existing = await loadFolderBucket(channelIdStr, fid);
    const merged = dedupeCachedFiles([...(existing?.files || []), ...incoming]);
    await saveFolderBucket(channelIdStr, fid, merged, existing?.complete ?? false);
  }
};

/**
 * On-Demand Subfolder Loader (Lazy Cloud Mode):
 * 1. Instant < 3ms hydration from normalized per-folder IndexedDB bucket (`folder_items`).
 * 2. Background/on-demand Telegram server-side search for `targetFolderId` (~250ms) when uncached or stale/forced.
 * 3. Automatically removes deleted files and updates renamed files inside the opened subfolder!
 */
export const syncSubfolderOnDemand = async (
  client: TelegramClient,
  channelFolder: VirtualFolder,
  targetFolderId: string,
  globalFilesMap: { [path: string]: VirtualFile },
  onUpdate: () => void,
  opts?: { forceRefresh?: boolean },
): Promise<number> => {
  if (!client || !channelFolder?.channelId || !targetFolderId || targetFolderId === 'root') return 0;
  const channelIdStr = typeof channelFolder.channelId === 'object' && channelFolder.channelId.value !== undefined
    ? String(channelFolder.channelId.value)
    : String(channelFolder.channelId);
  if (!channelIdStr || channelIdStr === 'me' || channelIdStr === 'root') return 0;

  const jobKey = `${channelIdStr}:${targetFolderId}`;
  const inFlight = activeSubfolderSyncs.get(jobKey);
  if (inFlight && !opts?.forceRefresh) {
    return inFlight;
  }

  const run = async (): Promise<number> => {
    try {
      let cached = await loadChannelCache(channelIdStr);
      if (!cached) {
        cached = {
          channelId: channelIdStr,
          lastMessageId: 0,
          minSyncedId: 0,
          historyComplete: true,
          lazyMode: Boolean(channelFolder.isLazyChannel),
          files: [],
          foldersList: [],
        };
      }
      if (!cached.foldersList) cached.foldersList = [];

      const applyFilesToSubfolderNode = (files: VirtualFile[], markSynced: boolean) => {
        const lookup = createFolderLookup(cached!.foldersList);
        const resolvedDir = resolveFolderPathFast(targetFolderId, lookup);
        let subNode = findSubfolderNodeById(channelFolder, targetFolderId);
        if (!subNode && resolvedDir) {
          subNode = insertFolderIntoTree(channelFolder, resolvedDir, undefined, targetFolderId);
        }
        if (subNode) {
          subNode.files = files;
          subNode.isLoaded = true;
          if (markSynced) subNode.subfolderSynced = true;
        }
        for (const f of files) {
          if (resolvedDir) {
            const nextPath = `${resolvedDir}/${f.name}`;
            if (f.path !== nextPath) {
              f.path = nextPath;
              f.id = `${channelFolder.id}/${nextPath}`;
            }
          }
          globalFilesMap[f.id] = f;
          globalFilesMap[f.path] = f;
        }
      };

      // Step 1: Instant < 3ms local hydration from per-folder IndexedDB bucket!
      const bucket = await loadFolderBucket(channelIdStr, targetFolderId);
      if (bucket && bucket.files.length > 0) {
        applyFilesToSubfolderNode(bucket.files, bucket.complete);
        onUpdate();
        // If bucket is fresh & complete and not forced, return immediately (0 network!)
        if (!opts?.forceRefresh && bucket.complete && Date.now() - bucket.syncedAt < FOLDER_BUCKET_STALE_MS) {
          return bucket.files.length;
        }
      }

      // Step 2: Fetch authoritative current files & child directories for this subfolder from Telegram (~250ms)
      const peerEntity = channelFolder.accessHash
        ? { id: channelFolder.channelId, accessHash: channelFolder.accessHash }
        : (channelFolder.channelId || channelFolder.id);
      const peer = await resolveTelegramEntity(client, peerEntity);

      const found = await searchChannelMessages(client, peer, targetFolderId, SUBFOLDER_SEARCH_MAX_PAGES);
      const freshFiles: VirtualFile[] = [];
      const { hasNewFolders } = parseMessagesIntoFilesAndFolders(
        channelIdStr,
        channelFolder.id,
        cached.foldersList,
        freshFiles,
        found,
      );

      // Keep only files belonging to this exact targetFolderId (in case query matched a filename substring)
      const exactFolderFiles = dedupeCachedFiles(
        freshFiles.filter(f => String(f.pId || '') === String(targetFolderId)),
      );

      // If new child directories were discovered under this folder, insert them into the tree & save metadata
      if (hasNewFolders) {
        const lookup = createFolderLookup(cached.foldersList);
        for (const folder of cached.foldersList) {
          const fullPath = resolveFolderPathFast(folder.id, lookup);
          if (fullPath) {
            const node = insertFolderIntoTree(channelFolder, fullPath, folder.msgId, folder.id);
            if (node && cached.lazyMode) node.isLazyChannel = true;
          }
        }
        await saveChannelCache(channelIdStr, cached);
      }

      // Save ONLY this subfolder's normalized bucket to IndexedDB (~5KB instead of 80MB!)
      await saveFolderBucket(channelIdStr, targetFolderId, exactFolderFiles, true);

      // If not lazyMode (small channel), also merge into channel cache for consistency
      if (!cached.lazyMode && exactFolderFiles.length > 0) {
        const mergedAll = dedupeCachedFiles([...cached.files, ...exactFolderFiles]);
        cached.files = mergedAll;
        await saveChannelCache(channelIdStr, cached);
      }

      applyFilesToSubfolderNode(exactFolderFiles, true);
      onUpdate();
      return exactFolderFiles.length;
    } catch (e) {
      console.warn(`On-demand subfolder search failed for ${targetFolderId}:`, e);
      return 0;
    } finally {
      activeSubfolderSyncs.delete(jobKey);
    }
  };

  const promise = run();
  activeSubfolderSyncs.set(jobKey, promise);
  return promise;
};

/**
 * Hybrid Telegram Server-Side Search across 124,000+ items in ~150ms
 * without ever needing to sync or deserialize all 124,000 items locally!
 */
export const searchChannelOnDemand = async (
  client: TelegramClient,
  channelFolder: VirtualFolder,
  query: string,
  globalFilesMap: { [path: string]: VirtualFile },
  onUpdate: () => void,
): Promise<number> => {
  const cleanQ = query.trim();
  if (!client || !channelFolder?.channelId || cleanQ.length < 2) return 0;
  const channelIdStr = typeof channelFolder.channelId === 'object' && channelFolder.channelId.value !== undefined
    ? String(channelFolder.channelId.value)
    : String(channelFolder.channelId);
  if (!channelIdStr || channelIdStr === 'me' || channelIdStr === 'root') return 0;

  try {
    const peerEntity = channelFolder.accessHash
      ? { id: channelFolder.channelId, accessHash: channelFolder.accessHash }
      : (channelFolder.channelId || channelFolder.id);
    const peer = await resolveTelegramEntity(client, peerEntity);
    const found = await searchChannelMessages(client, peer, cleanQ, 2);
    if (found.length === 0) return 0;

    let cached = await loadChannelCache(channelIdStr);
    if (!cached) {
      cached = {
        channelId: channelIdStr,
        lastMessageId: 0,
        minSyncedId: 0,
        historyComplete: true,
        lazyMode: Boolean(channelFolder.isLazyChannel),
        files: [],
        foldersList: [],
      };
    }
    if (!cached.foldersList) cached.foldersList = [];

    if (cached.lazyMode) {
      // Lightweight lazy merge: attach matched files directly into memory tree without bloating channels[id]!
      const matchedFiles: VirtualFile[] = [];
      const { hasNewFolders } = parseMessagesIntoFilesAndFolders(
        channelIdStr,
        channelFolder.id,
        cached.foldersList,
        matchedFiles,
        found,
      );
      if (hasNewFolders) {
        const lookup = createFolderLookup(cached.foldersList);
        for (const folder of cached.foldersList) {
          const fullPath = resolveFolderPathFast(folder.id, lookup);
          if (fullPath) {
            const node = insertFolderIntoTree(channelFolder, fullPath, folder.msgId, folder.id);
            if (node) node.isLazyChannel = true;
          }
        }
        await saveChannelCache(channelIdStr, cached);
      }
      if (matchedFiles.length > 0) {
        for (const f of matchedFiles) {
          globalFilesMap[f.id] = f;
          globalFilesMap[f.path] = f;
          insertFileIntoFolderTree(channelFolder, f);
        }
        onUpdate();
      }
      return matchedFiles.length;
    }

    const changed = ingestBatchIntoCache(channelIdStr, channelFolder.id, cached, found);
    if (changed) {
      hydrateChannelFromCache(channelFolder, cached, globalFilesMap);
      await saveChannelCache(channelIdStr, cached);
      onUpdate();
    }
    return found.length;
  } catch (e) {
    console.warn(`Live server search failed for channel ${channelIdStr}:`, e);
    return 0;
  }
};

export const syncChannelFiles = async (
  client: TelegramClient,
  channelFolder: VirtualFolder,
  globalFilesMap: { [path: string]: VirtualFile },
  onUpdate: () => void,
  opts?: { validate?: boolean; initialBurstOnly?: boolean; refreshDirectories?: boolean },
) => {
  if (!channelFolder.channelId || channelFolder.id === 'root') {
    channelFolder.isLoaded = true;
    return;
  }

  let channelIdStr = '';
  if (typeof channelFolder.channelId === 'object' && channelFolder.channelId.value !== undefined) {
    channelIdStr = String(channelFolder.channelId.value);
  } else {
    channelIdStr = String(channelFolder.channelId);
  }

  if (!channelIdStr || channelIdStr === 'me' || channelIdStr === 'root') {
    channelFolder.isLoaded = true;
    return;
  }

  if (channelFolder.accessHash) {
    saveChannelAccessHash(channelIdStr, channelFolder.accessHash);
  }

  let cached = await loadChannelCache(channelIdStr);
  if (cached) {
    const hasStaleUnknownFolderPaths = cached.files.some(file =>
      String(file.path || '').split('/').includes('UnknownFolder'),
    );
    if (hasStaleUnknownFolderPaths) {
      await clearChannelCache(channelIdStr);
      cached = {
        channelId: channelIdStr,
        lastMessageId: 0,
        minSyncedId: 0,
        historyComplete: false,
        lazyMode: false,
        files: [],
        foldersList: [],
      };
    }
    hydrateChannelFromCache(channelFolder, cached, globalFilesMap);
    onUpdate();
  } else {
    cached = {
      channelId: channelIdStr,
      lastMessageId: 0,
      minSyncedId: 0,
      historyComplete: false,
      lazyMode: false,
      files: [],
      foldersList: [],
    };
    channelFolder.files = [];
    channelFolder.folders = {};
  }

  const localTotal = cached.files.length + (cached.foldersList?.length || 0);
  if (cached.lazyMode) {
    cached.historyComplete = true;
  } else if (cached.historyComplete === undefined && cached.lastMessageId > 0 && localTotal > 0) {
    cached.historyComplete = true;
  } else if (localTotal === 0) {
    cached.historyComplete = false;
  }

  const byIdMap = new Map<string, VirtualFile>();
  const byMsgIdMap = new Map<number, VirtualFile>();
  for (const f of cached.files) {
    byIdMap.set(f.id, f);
    for (const p of f.parts || []) {
      byMsgIdMap.set(p.messageId, f);
    }
  }

  const ingestMessagesBatch = (batch: any[]): boolean =>
    ingestBatchIntoCache(channelIdStr, channelFolder.id, cached!, batch, { byIdMap, byMsgIdMap });

  const flushToUiAndCache = async () => {
    hydrateChannelFromCache(channelFolder, cached!, globalFilesMap);
    await saveChannelCache(channelIdStr, cached!);
    onUpdate();
  };

  const peerEntity = channelFolder.accessHash
    ? { id: channelFolder.channelId, accessHash: channelFolder.accessHash }
    : (channelFolder.channelId || channelFolder.id);

  try {
    const peer = await resolveTelegramEntity(client, peerEntity);

    // 1 lightweight RPC (~150ms) to get exact total count & latest message ID
    const topInfo = await fetchChannelTopInfo(client, peer);
    if (topInfo.totalCount > 0) {
      cached.serverTotalCount = topInfo.totalCount;
      channelFolder.serverTotalCount = topInfo.totalCount;

      // AUTOMATIC LAZY CLOUD MODE for massive channels (> 1,500 items, e.g. 124,000 photos!)
      // Never crawl 1,240 history pages in the background — load Directory tree + latest burst + on-demand subfolders!
      if (topInfo.totalCount > LAZY_CHANNEL_THRESHOLD) {
        cached.lazyMode = true;
        cached.historyComplete = true;
        channelFolder.isLazyChannel = true;
        channelFolder.historyComplete = true;
      } else {
        const localCount = cached.files.length + (cached.foldersList?.length || 0);
        if (localCount === 0 || (topInfo.totalCount > 500 && localCount < 100)) {
          cached.historyComplete = false;
          cached.minSyncedId = 0;
          channelFolder.historyComplete = false;
        }
      }
    }

    // Phase A: Delta Head Sync (ONLY messages newer than cached.lastMessageId!)
    if (cached.lastMessageId > 0 && topInfo.topId > cached.lastMessageId) {
      let deltaOffset = 0;
      const deltaBatch: any[] = [];
      const maxDeltaPages = cached.lazyMode ? 5 : 50;
      for (let g = 0; g < maxDeltaPages; g++) {
        const { messages } = await fetchSingleHistoryPage(client, peer, {
          offsetId: deltaOffset,
          minId: cached.lastMessageId,
          limit: HISTORY_PAGE,
        });
        if (!messages || messages.length === 0) break;
        for (const m of messages) deltaBatch.push(m);
        if (messages.length < HISTORY_PAGE) break;
        deltaOffset = messages[messages.length - 1].id;
      }
      if (deltaBatch.length > 0) {
        if (cached.lazyMode) {
          if (!cached.foldersList) cached.foldersList = [];
          const deltaFiles: VirtualFile[] = [];
          const { hasNewFiles, hasNewFolders, maxMsgId } = parseMessagesIntoFilesAndFolders(
            channelIdStr,
            channelFolder.id,
            cached.foldersList,
            deltaFiles,
            deltaBatch,
          );
          if (maxMsgId > cached.lastMessageId) cached.lastMessageId = maxMsgId;
          // Keep root delta files in channel cache, route subfolder delta files straight to their folder_items buckets!
          const rootDelta = deltaFiles.filter(f => !f.pId || f.pId === 'root');
          if (rootDelta.length > 0) {
            cached.files = dedupeCachedFiles([...cached.files, ...rootDelta]).slice(-300);
          }
          if (deltaFiles.length > 0) {
            await mergeDeltaFilesIntoLazyBuckets(channelIdStr, deltaFiles);
            for (const f of deltaFiles) {
              globalFilesMap[f.id] = f;
              globalFilesMap[f.path] = f;
              insertFileIntoFolderTree(channelFolder, f);
            }
          }
          if (hasNewFiles || hasNewFolders) {
            await flushToUiAndCache();
          }
        } else if (ingestMessagesBatch(deltaBatch)) {
          await flushToUiAndCache();
        }
      }
    }

    // Phase B (LAZY CLOUD MODE for 1,500 – 500,000+ item channels):
    // Ultra-fast 3-layer Directory discovery (< 1s) + guaranteed non-empty root, ZERO 20-minute backfill crawl!
    if (cached.lazyMode) {
      let lazyDirty = false;
      const needDirDiscovery =
        opts?.refreshDirectories ||
        (cached.foldersList?.length || 0) === 0;

      if (needDirDiscovery) {
        try {
          if (!cached.foldersList) cached.foldersList = [];
          const dummyFiles: VirtualFile[] = [];

          // Layer 1: Telegram server-side search for 'Directory' captions (up to 8,000 dirs)
          let dirMsgs = await searchChannelMessages(client, peer, 'Directory', DIR_SEARCH_MAX_PAGES);
          // Layer 2: Fallback search for '"t": "dir"' or 'dir' if Layer 1 returned 0
          if (dirMsgs.length === 0) {
            dirMsgs = await searchChannelMessages(client, peer, 'dir', 30);
          }
          if (dirMsgs.length > 0) {
            const { hasNewFolders, maxMsgId } = parseMessagesIntoFilesAndFolders(
              channelIdStr,
              channelFolder.id,
              cached.foldersList,
              dummyFiles,
              dirMsgs,
            );
            if (maxMsgId > cached.lastMessageId) cached.lastMessageId = maxMsgId;
            if (hasNewFolders) lazyDirty = true;
          }

          // Layer 3: Always probe the BEGINNING of the channel (oldest 200 msgs, IDs 1..200) if
          // foldersList is still empty OR if any discovered folder has a missing ancestor pId!
          const folderIdSet = new Set(cached.foldersList.map(f => String(f.id)));
          const missingParents = new Set<string>();
          for (const f of cached.foldersList) {
            if (f.pId && f.pId !== 'root' && f.pId !== '0' && !folderIdSet.has(String(f.pId))) {
              missingParents.add(String(f.pId));
            }
          }

          if (cached.foldersList.length === 0 || missingParents.size > 0) {
            const oldestMsgs = await fetchOldestHistoryPages(client, peer, 2);
            if (oldestMsgs.length > 0) {
              const { hasNewFolders, maxMsgId } = parseMessagesIntoFilesAndFolders(
                channelIdStr,
                channelFolder.id,
                cached.foldersList,
                dummyFiles,
                oldestMsgs,
              );
              if (maxMsgId > cached.lastMessageId) cached.lastMessageId = maxMsgId;
              if (hasNewFolders) lazyDirty = true;
            }
          }

          // Resolve any still-missing parent folder definitions directly by ID (max 8 targeted searches)
          const updatedIdSet = new Set(cached.foldersList.map(f => String(f.id)));
          const stillMissing = Array.from(missingParents).filter(id => !updatedIdSet.has(id)).slice(0, 8);
          for (const parentId of stillMissing) {
            try {
              const parentMsgs = await searchChannelMessages(client, peer, parentId, 1);
              if (parentMsgs.length > 0) {
                const { hasNewFolders } = parseMessagesIntoFilesAndFolders(
                  channelIdStr,
                  channelFolder.id,
                  cached.foldersList,
                  dummyFiles,
                  parentMsgs,
                );
                if (hasNewFolders) lazyDirty = true;
              }
            } catch {}
          }

          console.info(
            `[VFS LazySync] channel=${channelIdStr} total=${topInfo.totalCount} dirMsgs=${dirMsgs.length} folders=${cached.foldersList.length} missingParents=${missingParents.size}`,
          );
        } catch (dirErr) {
          console.warn(`Lazy directory discovery skipped for channel ${channelIdStr}:`, dirErr);
        }
      }

      // Guaranteed non-empty root: if channel has NO folders AND NO files locally (or hasn't been initialized yet),
      // fetch the latest 200 messages so a 124,000-item channel NEVER displays "This folder is empty"!
      const hasAnyLocalContent = (cached.foldersList?.length || 0) > 0 || cached.files.length > 0;
      if (cached.lastMessageId === 0 || !hasAnyLocalContent) {
        let offsetId = 0;
        const burstBatch: any[] = [];
        for (let b = 0; b < INITIAL_BURST_PAGES; b++) {
          const { messages } = await fetchSingleHistoryPage(client, peer, { offsetId, limit: HISTORY_PAGE });
          if (!messages || messages.length === 0) break;
          for (const m of messages) burstBatch.push(m);
          if (messages.length < HISTORY_PAGE) break;
          offsetId = messages[messages.length - 1].id;
        }
        if (burstBatch.length > 0) {
          if (!cached.foldersList) cached.foldersList = [];
          const parsedFiles: VirtualFile[] = [];
          const { hasNewFiles, hasNewFolders, maxMsgId } = parseMessagesIntoFilesAndFolders(
            channelIdStr,
            channelFolder.id,
            cached.foldersList,
            parsedFiles,
            burstBatch,
          );
          if (maxMsgId > cached.lastMessageId) cached.lastMessageId = maxMsgId;
          const rootFiles = parsedFiles.filter(f => !f.pId || f.pId === 'root');
          if (rootFiles.length > 0) {
            cached.files = dedupeCachedFiles([...cached.files, ...rootFiles]).slice(-300);
          } else if ((cached.foldersList?.length || 0) === 0 && parsedFiles.length > 0) {
            // Flat 124k photo channel or unindexed dir search: show latest 200 photos directly at root!
            cached.files = dedupeCachedFiles([...cached.files, ...parsedFiles]).slice(-300);
          }
          if (parsedFiles.length > 0) {
            await mergeDeltaFilesIntoLazyBuckets(channelIdStr, parsedFiles);
          }
          if (hasNewFiles || hasNewFolders || cached.files.length > 0) lazyDirty = true;
        }
      }

      // Sample average file byte size ONCE for lazyMode channels so total storage size includes all 126,000+ items!
      if (!cached.avgFileBytes || cached.avgFileBytes <= 0) {
        let sampleSum = 0;
        let sampleCount = 0;
        for (const f of cached.files) {
          if (f.size > 0) {
            sampleSum += f.size;
            sampleCount++;
          }
        }
        if (sampleCount < 10) {
          try {
            const { messages: sampleMsgs } = await fetchSingleHistoryPage(client, peer, { limit: 60 });
            for (const m of sampleMsgs || []) {
              const doc = m?.media?.className === 'MessageMediaDocument' ? m.media.document : null;
              const ph = m?.media?.className === 'MessageMediaPhoto' ? m.media.photo : null;
              const meta = parseMetadata(m?.message);
              const bytes = (doc ? parseDocSize(doc.size) : 0) || (ph ? parsePhotoSize(ph) : 0) || Number(meta?.s || 0);
              if (bytes > 0) {
                sampleSum += bytes;
                sampleCount++;
              }
            }
          } catch {}
        }
        if (sampleCount > 0) {
          cached.avgFileBytes = Math.round(sampleSum / sampleCount);
          if (cached.serverTotalCount && cached.serverTotalCount > 0) {
            channelFolder.estimatedTotalBytes = Math.round(cached.avgFileBytes * cached.serverTotalCount);
          }
          lazyDirty = true;
        }
      }

      if (topInfo.topId > cached.lastMessageId) {
        cached.lastMessageId = topInfo.topId;
        lazyDirty = true;
      }

      if (lazyDirty || !cached.lastSyncedAt || (Object.keys(channelFolder.folders).length === 0 && channelFolder.files.length === 0)) {
        cached.lastValidation = Date.now();
        await flushToUiAndCache();
      }
    } else if (!cached.historyComplete) {
      // Phase B (NORMAL MODE for <= 1,500 item channels): Instant burst + fast full sync
      if ((cached.serverTotalCount || 0) > 300 || (cached.foldersList?.length || 0) === 0) {
        try {
          let dirMsgs = await searchChannelMessages(client, peer, 'Directory', 20);
          if (dirMsgs.length === 0) {
            dirMsgs = await searchChannelMessages(client, peer, 'dir', 10);
          }
          if (dirMsgs.length > 0 && ingestMessagesBatch(dirMsgs)) {
            await flushToUiAndCache();
          }
        } catch (dirErr) {
          console.warn(`Directory search pre-pass skipped for channel ${channelIdStr}:`, dirErr);
        }
      }

      let offsetId = cached.minSyncedId && cached.minSyncedId > 0 ? cached.minSyncedId : 0;
      let burstPages = 0;
      let dirty = false;

      while (burstPages < INITIAL_BURST_PAGES) {
        const { messages, totalCount } = await fetchSingleHistoryPage(client, peer, {
          offsetId,
          limit: HISTORY_PAGE,
        });
        if (totalCount && totalCount > 0) {
          cached.serverTotalCount = totalCount;
          channelFolder.serverTotalCount = totalCount;
        }
        if (!messages || messages.length === 0) {
          cached.historyComplete = true;
          dirty = true;
          break;
        }
        if (ingestMessagesBatch(messages)) dirty = true;
        burstPages++;
        const oldestId = messages[messages.length - 1].id;
        offsetId = oldestId;
        if (!cached.minSyncedId || oldestId < cached.minSyncedId) {
          cached.minSyncedId = oldestId;
        }
        if (messages.length < HISTORY_PAGE) {
          cached.historyComplete = true;
          dirty = true;
          break;
        }
      }

      if (dirty || cached.files.length > 0) {
        cached.lastValidation = Date.now();
        await flushToUiAndCache();
      }

      if (!cached.historyComplete && !activeBackfillJobs.has(channelIdStr)) {
        activeBackfillJobs.add(channelIdStr);
        const runBackfill = async () => {
          try {
            let pagesSinceCheckpoint = 0;
            let backfillDirty = false;
            for (let guard = 0; guard < MAX_HISTORY_PAGES; guard++) {
              await waitForThumbIdle();
              const { messages } = await fetchSingleHistoryPage(client, peer, {
                offsetId,
                limit: HISTORY_PAGE,
              });
              if (!messages || messages.length === 0) {
                cached!.historyComplete = true;
                backfillDirty = true;
                break;
              }
              if (ingestMessagesBatch(messages)) backfillDirty = true;
              const oldestId = messages[messages.length - 1].id;
              offsetId = oldestId;
              if (!cached!.minSyncedId || oldestId < cached!.minSyncedId) {
                cached!.minSyncedId = oldestId;
              }
              pagesSinceCheckpoint++;
              if (messages.length < HISTORY_PAGE) {
                cached!.historyComplete = true;
                backfillDirty = true;
                break;
              }
              if (pagesSinceCheckpoint >= BACKFILL_CHECKPOINT_PAGES) {
                pagesSinceCheckpoint = 0;
                backfillDirty = false;
                await flushToUiAndCache();
              }
            }
            if (backfillDirty || cached!.historyComplete) {
              await flushToUiAndCache();
            }
          } catch (bfErr) {
            console.warn(`Background backfill paused for channel ${channelIdStr}:`, bfErr);
            await saveChannelCache(channelIdStr, cached!).catch(() => {});
          } finally {
            activeBackfillJobs.delete(channelIdStr);
          }
        };
        void runBackfill();
      }
    }
  } catch (error) {
    console.error(`Failed to fetch messages for channel ${channelFolder.channelId}:`, error);
  }

  // 3. Background Validation (ONLY for normal non-lazy channels! Lazy channels validate per-subfolder on open!)
  const validateCache = async () => {
    try {
      if (cached?.lazyMode) return;
      const now = Date.now();
      if (cached?.lastValidation && now - cached.lastValidation < VALIDATE_INTERVAL_MS) {
        return;
      }

      const allMsgIdsToVerify: number[] = [];
      const fileByMsgId = new Map<number, VirtualFile>();

      if (cached?.foldersList) {
        for (const f of cached.foldersList) {
          if (f.msgId) allMsgIdsToVerify.push(f.msgId);
        }
      }
      if (cached?.files) {
        for (const f of cached.files) {
          for (const p of f.parts || []) {
            allMsgIdsToVerify.push(p.messageId);
            fileByMsgId.set(p.messageId, f);
          }
        }
      }

      if (allMsgIdsToVerify.length === 0) return;

      const peer = channelIdStr === 'me' ? 'me' : await resolveTelegramEntity(client, channelIdStr);
      const validMsgIds = new Set<number>();
      const verifiedSet = new Set<number>(allMsgIdsToVerify);
      const versionByMsgId = new Map<number, number>();
      const FRESH_MS = 55000;

      const idsToFetch: number[] = [];
      for (const id of allMsgIdsToVerify) {
        const entry = getCachedEntry(channelIdStr, id);
        if (entry && Date.now() - entry.ts < FRESH_MS) {
          validMsgIds.add(id);
          const v = Number(entry.msg.editDate || entry.msg.date || 0);
          if (v) versionByMsgId.set(id, v);
        } else {
          idsToFetch.push(id);
        }
      }

      let datesChanged = false;
      const chunkSize = 100;
      for (let i = 0; i < idsToFetch.length; i += chunkSize) {
        await waitForThumbIdle();
        const chunk = idsToFetch.slice(i, i + chunkSize);
        const msgs: any[] = (await gate(2, () => client.getMessages(peer, { ids: chunk }) as any)) || [];
        msgs.forEach((msg: any) => {
          if (msg && msg.className === 'Message') {
            validMsgIds.add(msg.id);
            const v = Number(msg.editDate || msg.date || 0);
            if (v) versionByMsgId.set(msg.id, v);
            putMessages(channelIdStr, [msg]);

            const document = msg.media?.className === 'MessageMediaDocument' ? (msg.media.document as any) : null;
            const telegramDocSize = document?.className === 'Document' ? parseDocSize(document.size) : 0;
            const meta = parseMetadata(msg.message);
            const partSize = telegramDocSize || (meta ? Number(meta.s || 0) : 0);

            if (meta && meta.t !== 'dir') {
              const targetFile = fileByMsgId.get(msg.id);
              if (targetFile) {
                const targetPart = targetFile.parts.find(p => p.messageId === msg.id);
                if (targetPart && partSize > 0 && targetPart.size !== partSize) {
                  targetPart.size = partSize;
                  targetFile.size = targetFile.parts.reduce((sum, p) => sum + (p.size || 0), 0);
                  datesChanged = true;
                }
                const maxTp = meta.tp;
                if (maxTp && maxTp < targetFile.parts.length) {
                  targetFile.parts = targetFile.parts.filter(p => p.partNum <= maxTp);
                  targetFile.size = targetFile.parts.reduce((sum, p) => sum + (p.size || 0), 0);
                  targetFile.isComplete = true;
                  datesChanged = true;
                }
                if (targetFile.isUncaptioned) {
                  targetFile.isUncaptioned = false;
                  datesChanged = true;
                }
                if (meta.n && meta.n !== targetFile.name) {
                  targetFile.name = meta.n;
                  datesChanged = true;
                }
              }
            }
          }
        });
      }

      if (cached?.files) {
        for (const f of cached.files) {
          let maxV = 0;
          for (const p of f.parts) {
            const v = versionByMsgId.get(p.messageId);
            if (v && v > maxV) maxV = v;
          }
          if (maxV > (f.date || 0)) {
            f.date = maxV;
            datesChanged = true;
          }
        }
      }

      let hasDeletions = false;
      if (cached?.foldersList) {
        const initialLen = cached.foldersList.length;
        cached.foldersList = cached.foldersList.filter(
          f => !f.msgId || !verifiedSet.has(f.msgId) || validMsgIds.has(f.msgId),
        );
        if (cached.foldersList.length !== initialLen) hasDeletions = true;
      }

      if (cached?.files) {
        const nextFiles: VirtualFile[] = [];
        for (const f of cached.files) {
          const survivingParts = f.parts.filter(p => !verifiedSet.has(p.messageId) || validMsgIds.has(p.messageId));
          if (survivingParts.length === 0) {
            hasDeletions = true;
            continue;
          }
          if (survivingParts.length !== f.parts.length) {
            f.parts = sanitizeFileParts(survivingParts);
            f.size = f.parts.reduce((sum, p) => sum + (p.size || 0), 0);
            f.isComplete = f.parts.length > 0;
            hasDeletions = true;
          }
          nextFiles.push(f);
        }
        if (nextFiles.length !== cached.files.length) hasDeletions = true;
        cached.files = nextFiles;
      }

      if (cached) {
        cached.lastValidation = now;
        await saveChannelCache(channelIdStr, cached);
      }

      if (datesChanged && !hasDeletions) {
        onUpdate();
      }
      if (hasDeletions && cached) {
        hydrateChannelFromCache(channelFolder, cached, globalFilesMap);
        onUpdate();
      }
    } catch (e) {
      console.error('Background validation failed:', e);
    }
  };

  channelFolder.isLoaded = true;
  markFoldersLoaded(channelFolder);
  onUpdate();

  if (opts?.validate !== false && !cached.lazyMode) {
    void validateCache();
  }
};

/**
 * Normalize any channelId (BigInt, Telegram Integer, string) to canonical string key.
 */
const normChanId = (id: any): string => {
  if (id && typeof id === 'object' && id.value !== undefined) return String(id.value);
  return String(id ?? '');
};

/**
 * Recursively remove files (by messageId or file.id) and folders (by folderId or msgId)
 * from an in-memory VirtualFolder tree and globalFilesMap in O(N).
 */
const pruneTreeInMemory = (
  root: VirtualFolder,
  deletedMsgIds: Set<number>,
  deletedFolderIds: Set<string>,
  deletedFileIds: Set<string>,
  globalFilesMap?: { [path: string]: VirtualFile },
) => {
  const stack: VirtualFolder[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.files && node.files.length > 0) {
      node.files = node.files.filter((f) => {
        const hit = deletedFileIds.has(f.id) || (f.parts || []).some((p) => deletedMsgIds.has(Number(p.messageId)));
        if (hit && globalFilesMap) {
          delete globalFilesMap[f.id];
          delete globalFilesMap[f.path];
        }
        return !hit;
      });
    }
    if (node.folders) {
      for (const key of Object.keys(node.folders)) {
        const child = node.folders[key];
        const isDeletedFolder =
          (child.folderId && deletedFolderIds.has(String(child.folderId))) ||
          (child.msgId && deletedMsgIds.has(Number(child.msgId))) ||
          deletedFolderIds.has(String(child.id));
        if (isDeletedFolder) {
          // Also purge nested files from globalFilesMap
          const subStack: VirtualFolder[] = [child];
          while (subStack.length > 0) {
            const s = subStack.pop()!;
            if (globalFilesMap) {
              for (const f of s.files || []) {
                delete globalFilesMap[f.id];
                delete globalFilesMap[f.path];
              }
            }
            for (const c of Object.values(s.folders || {})) subStack.push(c);
          }
          delete node.folders[key];
        } else {
          stack.push(child);
        }
      }
    }
  }
};

/**
 * ATOMIC INSTANT DELETE (< 5ms):
 * Immediately removes deleted files & folders from in-memory tree, globalFilesMap,
 * IndexedDB `channels`, and all affected `folder_items` buckets — zero stale ghosts!
 */
export const applyCacheDelete = async (
  channelId: any,
  channelFolder: VirtualFolder | undefined,
  items: { type: 'file' | 'folder'; item: any }[],
  globalFilesMap?: { [path: string]: VirtualFile },
) => {
  const chanId = normChanId(channelId);
  if (!chanId || chanId === 'root') return;

  const deletedMsgIds = new Set<number>();
  const deletedFolderIds = new Set<string>();
  const deletedFileIds = new Set<string>();
  const touchedBucketIds = new Set<string>();

  const collect = (entry: { type: 'file' | 'folder'; item: any }) => {
    if (entry.type === 'file') {
      const f: VirtualFile = entry.item;
      if (f?.id) deletedFileIds.add(String(f.id));
      if (f?.pId) touchedBucketIds.add(String(f.pId));
      for (const p of f?.parts || []) {
        if (p?.messageId) deletedMsgIds.add(Number(p.messageId));
      }
    } else if (entry.type === 'folder') {
      const fld: VirtualFolder = entry.item;
      if (fld?.id) deletedFolderIds.add(String(fld.id));
      if (fld?.folderId) {
        deletedFolderIds.add(String(fld.folderId));
        touchedBucketIds.add(String(fld.folderId));
      }
      if (fld?.msgId) deletedMsgIds.add(Number(fld.msgId));
      for (const sub of Object.values(fld?.folders || {})) collect({ type: 'folder', item: sub });
      for (const f of fld?.files || []) collect({ type: 'file', item: f });
    }
  };
  for (const it of items) collect(it);

  // 1. Update in-memory tree immediately (0ms UI!)
  if (channelFolder) {
    pruneTreeInMemory(channelFolder, deletedMsgIds, deletedFolderIds, deletedFileIds, globalFilesMap);
    if (channelFolder.serverTotalCount && deletedMsgIds.size > 0) {
      channelFolder.serverTotalCount = Math.max(0, channelFolder.serverTotalCount - deletedMsgIds.size);
    }
  }

  // 2. Update IndexedDB `channels` record + all affected `folder_items` buckets atomically
  try {
    const cached = await loadChannelCache(chanId);
    if (cached) {
      cached.files = (cached.files || []).filter(
        (f) => !deletedFileIds.has(f.id) && !(f.parts || []).some((p) => deletedMsgIds.has(Number(p.messageId))),
      );
      if (cached.foldersList) {
        // Also cascade-delete any child folders whose pId was deleted
        let removedAny = true;
        while (removedAny) {
          removedAny = false;
          for (const f of cached.foldersList) {
            if (deletedFolderIds.has(String(f.pId)) && !deletedFolderIds.has(String(f.id))) {
              deletedFolderIds.add(String(f.id));
              touchedBucketIds.add(String(f.id));
              removedAny = true;
            }
          }
        }
        cached.foldersList = cached.foldersList.filter(
          (f) => !deletedFolderIds.has(String(f.id)) && (!f.msgId || !deletedMsgIds.has(Number(f.msgId))),
        );
      }
      if (cached.serverTotalCount && deletedMsgIds.size > 0) {
        cached.serverTotalCount = Math.max(0, cached.serverTotalCount - deletedMsgIds.size);
      }
      await saveChannelCache(chanId, cached);
    }

    const db = await getDb();
    for (const fid of touchedBucketIds) {
      const key = folderBucketKey(chanId, fid);
      if (deletedFolderIds.has(fid)) {
        await db.delete(FOLDER_STORE_NAME, key);
      } else {
        const bucket = await loadFolderBucket(chanId, fid);
        if (bucket) {
          const nextFiles = bucket.files.filter(
            (f) => !deletedFileIds.has(f.id) && !(f.parts || []).some((p) => deletedMsgIds.has(Number(p.messageId))),
          );
          await saveFolderBucket(chanId, fid, nextFiles, bucket.complete);
        }
      }
    }
  } catch (e) {
    console.warn('Atomic cache delete failed:', e);
  }
};

/**
 * ATOMIC INSTANT MOVE / COPY (< 5ms):
 * Updates BOTH source and destination in-memory trees + IndexedDB `channels` + `folder_items`
 * immediately after Telegram accepts the move/copy — eliminating stale items in old folders
 * and eliminating race conditions with Telegram's 2-second search index lag!
 */
export const applyCacheMoveOrCopy = async (opts: {
  action: 'move' | 'copy';
  sourceChannelId: any;
  sourceChannelFolder?: VirtualFolder;
  targetChannelId: any;
  targetChannelFolder?: VirtualFolder;
  targetFolderId: string; // 'root' or subfolder folderId
  movedOrCopiedFiles: {
    file: VirtualFile;
    oldPId: string;
    newPId: string;
    newParts?: VirtualFile['parts'];
  }[];
  movedOrCopiedFolders: {
    folder: VirtualFolder;
    oldId: string;
    newId: string;
    oldPId: string;
    newPId: string;
    newMsgId?: number;
  }[];
  globalFilesMap?: { [path: string]: VirtualFile };
}) => {
  const srcChanId = normChanId(opts.sourceChannelId);
  const dstChanId = normChanId(opts.targetChannelId);
  const sameChannel = srcChanId === dstChanId;

  // 1. If MOVE: remove from source buckets + source tree
  if (opts.action === 'move' && srcChanId && srcChanId !== 'root') {
    const movedMsgIds = new Set<number>();
    const movedFileIds = new Set<string>();
    const movedFolderIds = new Set<string>();
    const srcBucketIds = new Set<string>();

    for (const entry of opts.movedOrCopiedFiles) {
      movedFileIds.add(entry.file.id);
      if (entry.oldPId && entry.oldPId !== 'root') srcBucketIds.add(String(entry.oldPId));
      for (const p of entry.file.parts || []) {
        if (p.messageId) movedMsgIds.add(Number(p.messageId));
      }
    }
    for (const entry of opts.movedOrCopiedFolders) {
      movedFolderIds.add(String(entry.oldId));
      if (entry.folder.id) movedFolderIds.add(String(entry.folder.id));
      if (entry.folder.msgId) movedMsgIds.add(Number(entry.folder.msgId));
    }

    if (opts.sourceChannelFolder) {
      pruneTreeInMemory(opts.sourceChannelFolder, movedMsgIds, movedFolderIds, movedFileIds, opts.globalFilesMap);
    }

    try {
      const srcCache = await loadChannelCache(srcChanId);
      if (srcCache) {
        srcCache.files = (srcCache.files || []).filter(
          (f) => !movedFileIds.has(f.id) && !(f.parts || []).some((p) => movedMsgIds.has(Number(p.messageId))),
        );
        if (!sameChannel && srcCache.foldersList) {
          srcCache.foldersList = srcCache.foldersList.filter((f) => !movedFolderIds.has(String(f.id)));
        }
        if (!sameChannel && srcCache.serverTotalCount && movedMsgIds.size > 0) {
          srcCache.serverTotalCount = Math.max(0, srcCache.serverTotalCount - movedMsgIds.size);
        }
        await saveChannelCache(srcChanId, srcCache);
      }

      for (const fid of srcBucketIds) {
        const bucket = await loadFolderBucket(srcChanId, fid);
        if (bucket) {
          const nextFiles = bucket.files.filter(
            (f) => !movedFileIds.has(f.id) && !(f.parts || []).some((p) => movedMsgIds.has(Number(p.messageId))),
          );
          await saveFolderBucket(srcChanId, fid, nextFiles, bucket.complete);
        }
      }
    } catch (e) {
      console.warn('Atomic cache move source cleanup failed:', e);
    }
  }

  // 2. Insert into destination channel metadata + folder_items buckets + in-memory tree
  if (dstChanId && dstChanId !== 'root') {
    try {
      let dstCache = await loadChannelCache(dstChanId);
      if (!dstCache) {
        dstCache = {
          channelId: dstChanId,
          lastMessageId: 0,
          minSyncedId: 0,
          historyComplete: true,
          lazyMode: Boolean(opts.targetChannelFolder?.isLazyChannel),
          files: [],
          foldersList: [],
        };
      }
      if (!dstCache.foldersList) dstCache.foldersList = [];

      // Upsert moved/copied folders into destination foldersList
      const folderById = new Map(dstCache.foldersList.map((f) => [String(f.id), f]));
      for (const entry of opts.movedOrCopiedFolders) {
        const existing = folderById.get(String(entry.newId));
        if (existing) {
          existing.name = entry.folder.name;
          existing.pId = String(entry.newPId || 'root');
          if (entry.newMsgId) existing.msgId = entry.newMsgId;
        } else {
          const nf: FolderEntry = {
            id: String(entry.newId),
            name: entry.folder.name,
            pId: String(entry.newPId || 'root'),
            msgId: entry.newMsgId ?? entry.folder.msgId,
          };
          dstCache.foldersList.push(nf);
          folderById.set(nf.id, nf);
        }
        if (entry.newMsgId && entry.newMsgId > dstCache.lastMessageId) {
          dstCache.lastMessageId = entry.newMsgId;
        }
      }

      const lookup = createFolderLookup(dstCache.foldersList);
      const dstChanFolderId = opts.targetChannelFolder?.id || dstChanId;

      // Ensure destination folders exist in memory tree
      if (opts.targetChannelFolder) {
        for (const entry of opts.movedOrCopiedFolders) {
          const fullPath = resolveFolderPathFast(entry.newId, lookup);
          if (fullPath) {
            const node = insertFolderIntoTree(
              opts.targetChannelFolder,
              fullPath,
              entry.newMsgId ?? entry.folder.msgId,
              entry.newId,
            );
            if (node && dstCache.lazyMode) node.isLazyChannel = true;
          }
        }
      }

      // Build updated VirtualFile objects and group by destination bucket pId
      const filesByDstBucket = new Map<string, VirtualFile[]>();
      const dstRootFiles: VirtualFile[] = [];

      for (const entry of opts.movedOrCopiedFiles) {
        const newPId = String(entry.newPId || 'root');
        const resolvedDir = newPId !== 'root' ? resolveFolderPathFast(newPId, lookup) : '';
        const dirPath = resolvedDir && resolvedDir !== 'Root' ? resolvedDir : '';
        const fullPath = dirPath ? `${dirPath}/${entry.file.name}` : entry.file.name;
        const nextParts = (entry.newParts || entry.file.parts || []).map((p) => ({
          ...p,
          channelId: dstChanId,
        }));
        for (const p of nextParts) {
          if (p.messageId > dstCache.lastMessageId) dstCache.lastMessageId = p.messageId;
        }

        const updatedFile: VirtualFile = {
          ...entry.file,
          id: `${dstChanFolderId}/${fullPath}`,
          path: fullPath,
          pId: newPId,
          parts: nextParts,
          date: Math.floor(Date.now() / 1000),
        };

        if (opts.globalFilesMap) {
          opts.globalFilesMap[updatedFile.id] = updatedFile;
          opts.globalFilesMap[updatedFile.path] = updatedFile;
        }
        if (opts.targetChannelFolder) {
          insertFileIntoFolderTree(opts.targetChannelFolder, updatedFile);
        }

        if (newPId === 'root') {
          dstRootFiles.push(updatedFile);
        } else {
          let list = filesByDstBucket.get(newPId);
          if (!list) {
            list = [];
            filesByDstBucket.set(newPId, list);
          }
          list.push(updatedFile);
        }
      }

      if (dstCache.lazyMode) {
        if (dstRootFiles.length > 0) {
          dstCache.files = dedupeCachedFiles([...dstCache.files, ...dstRootFiles]).slice(-300);
        }
      } else {
        const allIncoming = [...dstRootFiles, ...Array.from(filesByDstBucket.values()).flat()];
        if (allIncoming.length > 0) {
          dstCache.files = dedupeCachedFiles([...dstCache.files, ...allIncoming]);
        }
      }

      if ((opts.action === 'copy' || !sameChannel) && dstCache.serverTotalCount !== undefined) {
        const addedCount = opts.movedOrCopiedFiles.length + opts.movedOrCopiedFolders.length;
        dstCache.serverTotalCount += addedCount;
        if (opts.targetChannelFolder) {
          opts.targetChannelFolder.serverTotalCount = dstCache.serverTotalCount;
        }
      }

      await saveChannelCache(dstChanId, dstCache);

      // Persist destination per-folder buckets immediately
      for (const [fid, incoming] of filesByDstBucket.entries()) {
        const existing = await loadFolderBucket(dstChanId, fid);
        const merged = dedupeCachedFiles([...(existing?.files || []), ...incoming]);
        await saveFolderBucket(dstChanId, fid, merged, existing?.complete ?? true);
      }

      // For normal (non-lazy) channels, re-hydrate cleanly from updated cache
      if (!dstCache.lazyMode && opts.targetChannelFolder) {
        hydrateChannelFromCache(opts.targetChannelFolder, dstCache, opts.globalFilesMap);
      }
    } catch (e) {
      console.warn('Atomic cache move/copy destination update failed:', e);
    }
  }
};

/**
 * ATOMIC INSTANT RENAME (< 5ms):
 * Updates renamed file or folder in memory, IndexedDB `channels`, and `folder_items` immediately!
 */
export const applyCacheRename = async (
  channelId: any,
  channelFolder: VirtualFolder | undefined,
  item: { type: 'file' | 'folder'; item: any },
  newName: string,
  globalFilesMap?: { [path: string]: VirtualFile },
) => {
  const chanId = normChanId(channelId);
  if (!chanId || chanId === 'root' || !newName.trim()) return;

  try {
    const cached = await loadChannelCache(chanId);
    if (item.type === 'file') {
      const file: VirtualFile = item.item;
      const oldId = file.id;
      const oldPath = file.path;
      const dirPart = oldPath.includes('/') ? oldPath.slice(0, oldPath.lastIndexOf('/')) : '';
      const nextPath = dirPart ? `${dirPart}/${newName}` : newName;
      const chanPrefix = channelFolder?.id || chanId;
      const nextId = `${chanPrefix}/${nextPath}`;

      file.name = newName;
      file.path = nextPath;
      file.id = nextId;
      if (globalFilesMap) {
        delete globalFilesMap[oldId];
        delete globalFilesMap[oldPath];
        globalFilesMap[nextId] = file;
        globalFilesMap[nextPath] = file;
      }

      if (cached) {
        for (const f of cached.files || []) {
          if (f.id === oldId || f.parts?.[0]?.messageId === file.parts?.[0]?.messageId) {
            f.name = newName;
            f.path = nextPath;
            f.id = nextId;
          }
        }
        await saveChannelCache(chanId, cached);
      }
      if (file.pId && file.pId !== 'root') {
        const bucket = await loadFolderBucket(chanId, String(file.pId));
        if (bucket) {
          for (const f of bucket.files) {
            if (f.id === oldId || f.parts?.[0]?.messageId === file.parts?.[0]?.messageId) {
              f.name = newName;
              f.path = nextPath;
              f.id = nextId;
            }
          }
          await saveFolderBucket(chanId, String(file.pId), bucket.files, bucket.complete);
        }
      }
    } else if (item.type === 'folder') {
      const folder: VirtualFolder = item.item;
      if (cached?.foldersList && folder.folderId) {
        const entry = cached.foldersList.find((f) => String(f.id) === String(folder.folderId));
        if (entry) {
          entry.name = newName;
          await saveChannelCache(chanId, cached);
          if (channelFolder) {
            hydrateChannelFromCache(channelFolder, cached, globalFilesMap);
          }
        }
      }
    }
  } catch (e) {
    console.warn('Atomic cache rename failed:', e);
  }
};
