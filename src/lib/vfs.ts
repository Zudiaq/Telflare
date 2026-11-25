import { TelegramClient } from 'telegram';
import { openDB } from 'idb';
import type { IDBPDatabase } from 'idb';
import { putMessages, getCachedEntry, waitForThumbIdle } from './msgCache';
import { gate } from './tgGate';
import { resolveTelegramEntity, saveChannelAccessHash } from './telegramEntity';
import { ensureTelegramConnected } from './dcSenderPool';

const VALIDATE_INTERVAL_MS = 15000;
const HISTORY_PAGE = 100;

const fetchHistoryPaged = async (client: TelegramClient, peer: any, minId: number): Promise<any[]> => {
  const out: any[] = [];
  let offsetId = 0;
  for (let guard = 0; guard < 400; guard++) {
    const opts: any = { limit: HISTORY_PAGE };
    if (offsetId > 0) opts.offsetId = offsetId;
    if (minId > 0) opts.minId = minId;
    const page: any[] = await gate(1, async () => {
      await ensureTelegramConnected(client);
      return client.getMessages(peer, opts) as any;
    });
    if (!page || page.length === 0) break;
    for (const m of page) out.push(m);
    if (page.length < HISTORY_PAGE) break;
    offsetId = page[page.length - 1].id;
  }
  return out;
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
}

const DB_NAME = 'ZudCloud_VFS';
const STORE_NAME = 'channels';

let dbPromise: Promise<IDBPDatabase> | null = null;
export const getDb = () => {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, 1, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME);
        }
      },
    });
  }
  return dbPromise;
};

export interface CachedChannel {
  channelId: string;
  lastMessageId: number;
  files: VirtualFile[];
  foldersList?: { id: string; name: string; pId: string; msgId?: number }[];
  counts?: Record<string, {
    directFileCount: number;
    directFolderCount: number;
    recursiveFileCount: number;
    recursiveFolderCount: number;
  }>;
  cacheVersion?: number;
  lastSyncedAt?: number;
}

const buildChannelCounts = (cache: CachedChannel) => {
  const counts: NonNullable<CachedChannel['counts']> = {};
  const folders = cache.foldersList || [];
  const foldersById = new Map(folders.map(folder => [folder.id, folder]));
  const pathsById = new Map<string, string>();
  const getFolderPath = (folderId: string): string => {
    const cachedPath = pathsById.get(folderId);
    if (cachedPath !== undefined) return cachedPath;
    const folder = foldersById.get(folderId);
    if (!folder) return '';
    const parentPath = folder.pId && folder.pId !== 'root' ? getFolderPath(folder.pId) : '';
    const path = parentPath ? `${parentPath}/${folder.name}` : folder.name;
    pathsById.set(folderId, path);
    return path;
  };
  const fileCounts = new Map<string, number>();
  const folderIdByPath = new Map(folders.map(folder => [getFolderPath(folder.id), folder.id]));
  for (const file of cache.files || []) {
    const parent = file.path.includes('/')
      ? file.path.slice(0, file.path.lastIndexOf('/'))
      : '';
    const key = folderIdByPath.get(parent) || 'root';
    fileCounts.set(key, (fileCounts.get(key) || 0) + 1);
  }
  for (const folder of folders) {
    counts[folder.id] ||= {
      directFileCount: fileCounts.get(folder.id) || 0,
      directFolderCount: 0,
      recursiveFileCount: fileCounts.get(folder.id) || 0,
      recursiveFolderCount: 0
    };
    const parent = folder.pId || 'root';
    counts[parent] ||= { directFileCount: 0, directFolderCount: 0, recursiveFileCount: 0, recursiveFolderCount: 0 };
    counts[parent].directFolderCount += 1;
  }
  const children = new Map<string, string[]>();
  for (const folder of folders) {
    const parent = folder.pId || 'root';
    const list = children.get(parent) || [];
    list.push(folder.id);
    children.set(parent, list);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): NonNullable<CachedChannel['counts']>[string] => {
    const entry = counts[id] ||= { directFileCount: fileCounts.get(id) || 0, directFolderCount: 0, recursiveFileCount: fileCounts.get(id) || 0, recursiveFolderCount: 0 };
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
  // Deduplicate by partNum, keeping the highest messageId (most recent upload)
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

  // In authentic multipart uploads, parts are sent sequentially (part 1 < part 2 < part 3).
  // If Part 1 has a higher messageId than Part 2 or subsequent parts, Part 1 was re-uploaded
  // as a newer generation (e.g. single-part encode from Kaggle), and older parts are stale remnants.
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
    cache.cacheVersion = 2;
    cache.lastSyncedAt = Date.now();
    cache.counts = buildChannelCounts(cache);
    const db = await getDb();
    await db.put(STORE_NAME, cache, channelId);
  } catch (e) {
    console.warn("Failed to save channel cache:", e);
  }
};

export const clearChannelCache = async (channelId: string) => {
  try {
    const db = await getDb();
    await db.delete(STORE_NAME, channelId);
  } catch (e) {
    console.warn("Failed to clear channel cache:", e);
  }
};

export const loadChannelCache = async (channelId: string): Promise<CachedChannel | null> => {
  try {
    const db = await getDb();
    const data = await db.get(STORE_NAME, channelId);
    if (data) {
      if (!Array.isArray(data.files) || typeof data.lastMessageId !== 'number') {
        console.warn("Cache corruption detected! Rebuilding cache for", channelId);
        await clearChannelCache(channelId);
        return null;
      }
      
      // Self-healing: automatically sanitize any cached files that have stale/inverted parts
      // from older multipart uploads or re-encoded files
      let hasHealed = false;
      for (const file of data.files) {
        if (file.parts && file.parts.length > 0) {
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

      if (!data.counts || data.cacheVersion !== 2 || hasHealed) {
        data.counts = buildChannelCounts(data);
        data.cacheVersion = 2;
        await db.put(STORE_NAME, data, channelId);
      }
      
      // Strict type check for legacy corruptions (BigInts or Objects in IndexedDB)
      for (const file of data.files) {
         if (file.parts && file.parts.length > 0) {
            const firstPart = file.parts[0];
            if (typeof firstPart.messageId !== 'number' || typeof firstPart.channelId !== 'string') {
               console.warn("Cache legacy corruption detected (BigInts/Objects)! Rebuilding...", channelId);
               await clearChannelCache(channelId);
               return null;
            }
         }
      }
    }
    return data || null;
  } catch (e) {
    console.warn("Failed to load channel cache, assuming corrupt:", e);
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
  } catch (e) {
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
      pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
    };
    return documentTypes[ext || ''] || 'text/plain';
  }
  
  return 'application/octet-stream';
};

export const insertFileIntoFolderTree = (channelFolder: VirtualFolder, file: VirtualFile) => {
  const pathParts = file.path.split('/');
  let currentFolder = channelFolder;
  for (let i = 0; i < pathParts.length - 1; i++) {
    const folderName = pathParts[i];
    if (!currentFolder.folders[folderName]) {
      currentFolder.folders[folderName] = {
        id: `${currentFolder.id}/${folderName}`,
        name: folderName, path: `${currentFolder.id}/${folderName}`,
        files: [], folders: {}, channelId: channelFolder.channelId, isLoaded: channelFolder.isLoaded ?? true
      };
    }
    currentFolder = currentFolder.folders[folderName];
  }
  if (!currentFolder.files.some(f => f.id === file.id)) {
    currentFolder.files.push(file);
  }
};

export const insertFolderIntoTree = (channelFolder: VirtualFolder, path: string, msgId?: number, folderId?: string) => {
  if (!path) return;
  const pathParts = path.split('/');
  let currentFolder = channelFolder;
  for (let i = 0; i < pathParts.length; i++) {
    const folderName = pathParts[i];
    if (!currentFolder.folders[folderName]) {
      currentFolder.folders[folderName] = {
        id: `${currentFolder.id}/${folderName}`,
        name: folderName, path: `${currentFolder.id}/${folderName}`,
        files: [], folders: {}, msgId: undefined, channelId: channelFolder.channelId, isLoaded: channelFolder.isLoaded ?? true
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
};

export const markFoldersLoaded = (folder: VirtualFolder) => {
  folder.isLoaded = true;
  if (folder.folders) {
    for (const sub of Object.values(folder.folders)) {
      markFoldersLoaded(sub);
    }
  }
};

export const resolveFolderPath = (
  pId: string,
  foldersList?: { id: string; name: string; pId: string }[],
  visiting = new Set<string>()
): string | null => {
  if (!pId || pId === 'root') return '';
  if (visiting.has(pId)) return null;
  const folder = foldersList?.find(f => String(f.id) === String(pId));
  if (!folder) return null;
  visiting.add(pId);
  const parentPath = resolveFolderPath(folder.pId, foldersList, visiting);
  visiting.delete(pId);
  if (parentPath === null) return null;
  return parentPath ? `${parentPath}/${folder.name}` : folder.name;
};

export const hydrateChannelFromCache = (
  channelFolder: VirtualFolder,
  cached: CachedChannel,
  globalFilesMap?: { [path: string]: VirtualFile }
) => {
  if (!cached) return;
  cached.files = dedupeCachedFiles(cached.files || []);
  channelFolder.files = [];
  channelFolder.folders = {};

  // 1. Rebuild subfolders from foldersList first
  if (cached.foldersList && cached.foldersList.length > 0) {
    let pending = [...cached.foldersList];
    let inserted = true;
    while (pending.length > 0 && inserted) {
      inserted = false;
      const unresolved: typeof pending = [];
      for (const folder of pending) {
        const fullPath = resolveFolderPath(folder.id, cached.foldersList);
        if (fullPath === null || !fullPath) {
          unresolved.push(folder);
          continue;
        }
        insertFolderIntoTree(channelFolder, fullPath, folder.msgId, folder.id);
        inserted = true;
      }
      pending = unresolved;
    }
  }

  // 2. Insert cached files into tree
  if (cached.files) {
    for (const file of cached.files) {
      if (globalFilesMap) {
        globalFilesMap[file.id] = file;
        globalFilesMap[file.path] = file;
      }
      insertFileIntoFolderTree(channelFolder, file);
    }
  }

  markFoldersLoaded(channelFolder);
};

const dedupeCachedFiles = (files: VirtualFile[]): VirtualFile[] => {
  const byId = new Map<string, VirtualFile>();
  for (const file of files) {
    const existing = byId.get(file.id);
    if (!existing) {
      const cleanParts = sanitizeFileParts(file.parts || []);
      byId.set(file.id, {
        ...file,
        parts: cleanParts,
        size: cleanParts.reduce((sum, p) => sum + (p.size || 0), 0)
      });
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

export const syncChannelFiles = async (
  client: TelegramClient, 
  channelFolder: VirtualFolder, 
  globalFilesMap: { [path: string]: VirtualFile },
  onUpdate: () => void,
  opts?: { validate?: boolean }
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
  
  // 1. Load from cache first for instant UI response
  let cached = await loadChannelCache(channelIdStr);
  if (cached) {
    const hasStaleUnknownFolderPaths = cached.files.some(file =>
      String(file.path || '').split('/').includes('UnknownFolder')
    );
    if (hasStaleUnknownFolderPaths) {
      // Older builds could persist an unresolved parent as a literal path.
      // Re-read the channel once so the corrected parent graph can rebuild
      // files without carrying that placeholder into the new cache.
      await clearChannelCache(channelIdStr);
      cached = {
        channelId: channelIdStr,
        lastMessageId: 0,
        files: [],
        foldersList: []
      };
    }
    const originalFileCount = cached.files.length;
    hydrateChannelFromCache(channelFolder, cached, globalFilesMap);
    onUpdate();
    if (cached.files.length !== originalFileCount) {
      await saveChannelCache(channelIdStr, cached);
    }
  } else {
    cached = { channelId: channelIdStr, lastMessageId: 0, files: [], foldersList: [] };
    channelFolder.files = [];
    channelFolder.folders = {};
  }

  // Helper to resolve full path from pId
  const resolvePath = (pId: string, visiting = new Set<string>()): string | null => {
    return resolveFolderPath(pId, cached.foldersList, visiting);
  };

  const rebuildFolderTree = () => {
    hydrateChannelFromCache(channelFolder, cached, globalFilesMap);
  };

  rebuildFolderTree();

  // 2. Fetch new messages from Telegram incrementally
  try {
    const wasEmptyCache = cached.lastMessageId === 0;
    
    const peerEntity = channelFolder.accessHash
      ? { id: channelFolder.channelId, accessHash: channelFolder.accessHash }
      : (channelFolder.channelId || channelFolder.id);
    const peer = await resolveTelegramEntity(client, peerEntity);
    let newMessages: any[] = await fetchHistoryPaged(client, peer, cached.lastMessageId);
    if (cached.lastMessageId > 0) {
      const recentMessages: any[] = await gate(1, () => client.getMessages(peer, { limit: 100 }) as any);
      const seen = new Set(newMessages.map((m) => m.id));
      for (const msg of recentMessages) {
        if (!seen.has(msg.id)) {
          newMessages.push(msg);
        }
      }
      const uniqueMessages = new Map<number, any>();
      for (const message of newMessages) {
        if (message && typeof message.id === 'number') uniqueMessages.set(message.id, message);
      }
      newMessages = Array.from(uniqueMessages.values());
    }
    newMessages.sort((a, b) => a.id - b.id);
    // These messages already carry media/thumbnail locations + fresh file references.
    // Remember them so thumbnails and streams never need a second GetMessages round-trip.
    putMessages(channelIdStr, newMessages as any[]);
    if (wasEmptyCache && newMessages.length > 0) {
      // Everything was just downloaded: nothing to re-verify yet
      // @ts-ignore
      cached.lastValidation = Date.now();
    }
    
    if (newMessages && newMessages.length > 0) {
      let hasNewFiles = false;
      const localFilesMap: { [path: string]: VirtualFile } = {};
      
      if (!cached.foldersList) cached.foldersList = [];
      
      // First pass: extract all folders
      for (const msg of newMessages) {
        if (msg.id > cached.lastMessageId) cached.lastMessageId = msg.id;
        const metadataList = parseMetadataList(msg.message);
        for (const meta of metadataList) {
          if (meta.t !== 'dir' || !meta.id) continue;
          const existingFolder = cached.foldersList.find(f => String(f.id) === String(meta.id));
          if (existingFolder) {
            existingFolder.name = meta.n || existingFolder.name;
            existingFolder.pId = meta.pId || existingFolder.pId || 'root';
            existingFolder.msgId = msg.id;
            hasNewFiles = true;
          } else {
            cached.foldersList.push({ id: String(meta.id), name: meta.n || 'Unnamed', pId: String(meta.pId || 'root'), msgId: msg.id });
            hasNewFiles = true; // trigger update
          }
        }
      }

      // Re-insert all folders only after their parent chain is resolvable.
      rebuildFolderTree();

      for (const msg of newMessages) {
        let meta = parseMetadata(msg.message);
        const document = msg.media?.className === 'MessageMediaDocument' ? msg.media.document as any : null;
        const photo = msg.media?.className === 'MessageMediaPhoto' ? msg.media.photo as any : null;

        const isUncaptionedMsg = !meta && !!(document || photo);

        // Support direct Telegram documents / bot tracks without ZUD caption
        if (!meta && (document || photo)) {
          const filenameAttr = document?.attributes?.find((a: any) => a.className === 'DocumentAttributeFilename');
          if (filenameAttr?.fileName === 'playlist_order.txt' || msg.message?.includes('#ZUD_PLAYLIST_ORDER') || msg.message?.startsWith('ZUD_ORDER:')) {
            continue;
          }

          const audioAttr = document?.attributes?.find((a: any) => a.className === 'DocumentAttributeAudio');
          const videoAttr = document?.attributes?.find((a: any) => a.className === 'DocumentAttributeVideo');
          const isDocAudio = document?.mimeType?.startsWith('audio/') || !!audioAttr;
          const isDocVideo = document?.mimeType?.startsWith('video/') || !!videoAttr;
          const isDocImage = document?.mimeType?.startsWith('image/') || !!photo;

          let fn = filenameAttr?.fileName;
          if (!fn) {
            // Check if user provided a plain text caption with the file in Telegram
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

          const docSize = document ? parseDocSize(document.size) : 0;

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
            h: videoAttr?.h
          };
        }

        if (meta && meta.t !== 'dir') {
          // Only support NEW schema (must have pId or path)
          if (!meta.pId && !meta.path) continue;
          
          let fileName = meta.n || meta.f || 'UnknownFile';
          let dirPath = meta.path || resolvePath(meta.pId || 'root');
          if (dirPath === null) continue;
          
          let fullPath = fileName;
          if (dirPath !== 'Root' && dirPath !== '') fullPath = `${dirPath}/${fileName}`;
          
          const uniquePath = `${channelFolder.id}/${fullPath}`;

          let fileEntry = localFilesMap[uniquePath];
          if (!fileEntry) {
            const existingFileIdx = cached.files.findIndex(f => f.parts?.some(p => p.messageId === msg.id) || f.id === uniquePath);
            if (existingFileIdx !== -1) {
              const existingFile = cached.files[existingFileIdx];
              fileEntry = existingFile;
              fileEntry.id = uniquePath;
              fileEntry.name = fileName;
              fileEntry.path = fullPath;
              fileEntry.isUncaptioned = Boolean(isUncaptionedMsg);
              if (meta.mime) fileEntry.mimeType = getMimeType(meta.t, fileName, meta.mime);
              if (meta.performer) fileEntry.performer = meta.performer;
              if (meta.title) fileEntry.title = meta.title;
            } else {
              fileEntry = {
                id: uniquePath, name: fileName, path: fullPath,
                mimeType: getMimeType(meta.t, fileName, meta.mime), size: 0, duration: 0, parts: [], isComplete: false,
                performer: meta.performer, title: meta.title,
                isUncaptioned: isUncaptionedMsg
              };
              cached.files.push(fileEntry);
            }
            localFilesMap[uniquePath] = fileEntry;
          } else {
            fileEntry.isUncaptioned = Boolean(isUncaptionedMsg);
          }
          
          const document = msg.media?.className === 'MessageMediaDocument' ? msg.media.document as any : null;
          const telegramPartSize = document?.className === 'Document'
            ? parseDocSize(document.size)
            : 0;
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
          const msgId = Number(msg.id);

          // 1. Detect newer generation upload of this file (e.g. re-encoded file from Kaggle):
          // If incoming message ID is newer than all existing parts, and it is part 1 or single-part:
          const maxExistingMsgId = fileEntry.parts && fileEntry.parts.length > 0
            ? Math.max(...fileEntry.parts.map(p => p.messageId))
            : 0;

          if (fileEntry.parts && fileEntry.parts.length > 0 && msgId > maxExistingMsgId && (incomingPartNum === 1 || totalParts === 1 || totalParts < fileEntry.parts.length)) {
            // New upload / single-part encode: purge stale parts from previous multipart generation
            fileEntry.parts = [];
            fileEntry.size = 0;
            fileEntry.duration = 0;
            fileEntry.isComplete = false;
            hasNewFiles = true;
          }

          // 2. Add or update part in fileEntry.parts
          const existingPart = fileEntry.parts.find(p => p.partNum === incomingPartNum || p.messageId === msgId);
          if (!existingPart) {
            fileEntry.parts.push({
              partNum: incomingPartNum,
              messageId: msgId,
              channelId: channelIdStr,
              size: Number(partSize),
              duration: partDuration
            });
            hasNewFiles = true;
          } else {
            let updatedPart = false;
            if (existingPart.messageId !== msgId) {
              existingPart.messageId = msgId;
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
            if (updatedPart) hasNewFiles = true;
          }

          // 3. Prune orphan parts exceeding totalParts
          if (totalParts >= 1 && fileEntry.parts.some(p => p.partNum > totalParts)) {
            fileEntry.parts = fileEntry.parts.filter(p => p.partNum <= totalParts);
            hasNewFiles = true;
          }

          // 4. Sanitize and recalculate size and duration
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

      if (hasNewFiles) {
        hydrateChannelFromCache(channelFolder, cached, globalFilesMap);
        await saveChannelCache(channelIdStr, cached);
        onUpdate();
      }
    }
  } catch (error) {
    console.error(`Failed to fetch messages for channel ${channelFolder.channelId}:`, error);
  }

  // 3. Background Validation of existing cache to catch external deletions
  const validateCache = async () => {
    try {
      const now = Date.now();
      // @ts-ignore - allow lastValidation property
      if (cached.lastValidation && (now - cached.lastValidation < VALIDATE_INTERVAL_MS)) {
        return; // Only validate every VALIDATE_INTERVAL_MS per channel
      }

      let hasDeletions = false;
      const validMsgIds = new Set<number>();
      const allMsgIdsToVerify: number[] = [];
      
      if (cached.foldersList) {
         cached.foldersList.forEach(f => { if (f.msgId) allMsgIdsToVerify.push(f.msgId); });
      }
      if (cached.files) {
         cached.files.forEach(f => {
            f.parts.forEach(p => allMsgIdsToVerify.push(p.messageId));
         });
      }

      if (allMsgIdsToVerify.length === 0) return;

      const peer = channelIdStr === 'me' ? 'me' : await resolveTelegramEntity(client, channelIdStr);

      // Version (editDate || date) of every message we have seen, used to detect edited covers
      const versionByMsgId = new Map<number, number>();
      const FRESH_MS = 55000;

      // Messages fetched in the last minute (sync / thumbnails) are already verified: skip them.
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

      const chunkSize = 100; // Telegram's per-call limit for GetMessages
      for (let i = 0; i < idsToFetch.length; i += chunkSize) {
        // Thumbnails are user-visible; this is background housekeeping, so let them go first.
        await waitForThumbIdle();
        const chunk = idsToFetch.slice(i, i + chunkSize);
        const msgs: any[] = await gate(2, () => client.getMessages(peer, { ids: chunk }) as any);
        msgs.forEach((msg: any) => {
           if (msg && msg.className === 'Message') {
             validMsgIds.add(msg.id);
             const v = Number(msg.editDate || msg.date || 0);
             if (v) versionByMsgId.set(msg.id, v);
             putMessages(channelIdStr, [msg]);

             // Detect if message now has metadata / caption so mobile clears unindexed badge
             const document = msg.media?.className === 'MessageMediaDocument' ? msg.media.document as any : null;
             const telegramDocSize = document?.className === 'Document' ? parseDocSize(document.size) : 0;
             const meta = parseMetadata(msg.message);
             const partSize = telegramDocSize || (meta ? Number(meta.s || 0) : 0);

             if (meta && meta.t !== 'dir') {
               const targetFile = cached.files?.find(f => f.parts?.some(p => p.messageId === msg.id));
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

      // Edited messages (new cover/media) => bump file.date so thumbnail URLs change
      let datesChanged = false;
      if (cached.files) {
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

      if (cached.foldersList) {
        const initialLen = cached.foldersList.length;
        cached.foldersList = cached.foldersList.filter(f => !f.msgId || validMsgIds.has(f.msgId));
        if (cached.foldersList.length !== initialLen) hasDeletions = true;
      }

      if (cached.files) {
        const nextFiles: VirtualFile[] = [];
        for (const f of cached.files) {
          const survivingParts = f.parts.filter(p => validMsgIds.has(p.messageId));
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

      // @ts-ignore
      cached.lastValidation = now;
      await saveChannelCache(channelIdStr, cached);

      if (datesChanged && !hasDeletions) {
         onUpdate();
      }

      if (hasDeletions) {
         hydrateChannelFromCache(channelFolder, cached, globalFilesMap);
         onUpdate();
      }
    } catch (e) {
      console.error("Background validation failed:", e);
    }
  };
  
  channelFolder.isLoaded = true;
  markFoldersLoaded(channelFolder);
  onUpdate();

  // Run non-blocking validation (skipped for bulk background sync; done when the channel is opened)
  if (opts?.validate !== false) validateCache();
};
