import type { VirtualFile } from './vfs';

export interface ParsedTrackInfo {
  title: string;
  artist: string;
  album: string;
  durationFormatted: string;
  dateFormatted: string;
}

export const AUDIO_EXTENSIONS = new Set([
  'mp3', 'aac', 'm4a', 'ogg', 'oga', 'opus', 'wav', 'wave', 'flac',
  'alac', 'aiff', 'aif', 'wma', 'amr', '3ga', 'm4b', 'dsd', 'mid', 'midi', 'weba', 'ape'
]);

export const isAudioFile = (file?: { name?: string; mimeType?: string } | null): boolean => {
  if (!file) return false;
  if (file.mimeType && (file.mimeType.startsWith('audio/') || file.mimeType === 'audio/mpeg' || file.mimeType === 'audio/mp4' || file.mimeType === 'audio/ogg' || file.mimeType === 'audio/flac' || file.mimeType === 'audio/wav')) {
    return true;
  }
  const ext = file.name ? file.name.split('.').pop()?.toLowerCase() : '';
  if (ext && AUDIO_EXTENSIONS.has(ext)) {
    return true;
  }
  return false;
};

export const getAudioMimeType = (filename: string, existingMime?: string): string => {
  if (existingMime && existingMime.startsWith('audio/') && existingMime !== 'audio/mp3') {
    return existingMime;
  }
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  switch (ext) {
    case 'mp3':
      return 'audio/mpeg';
    case 'm4a':
    case 'aac':
    case 'm4b':
      return 'audio/mp4';
    case 'flac':
      return 'audio/flac';
    case 'wav':
    case 'wave':
      return 'audio/wav';
    case 'ogg':
    case 'oga':
      return 'audio/ogg';
    case 'opus':
      return 'audio/opus';
    case 'weba':
      return 'audio/webm';
    case 'aiff':
    case 'aif':
      return 'audio/aiff';
    case 'wma':
      return 'audio/x-ms-wma';
    default:
      return 'audio/mpeg';
  }
};

export const formatDuration = (seconds?: number): string => {
  if (!seconds || isNaN(seconds) || seconds <= 0) return '--:--';
  const total = Math.floor(seconds);
  const hrs = Math.floor(total / 3600);
  const mins = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const secsStr = secs < 10 ? `0${secs}` : `${secs}`;

  if (hrs > 0) {
    const minsStr = mins < 10 ? `0${mins}` : `${mins}`;
    return `${hrs}:${minsStr}:${secsStr}`;
  }
  return `${mins}:${secsStr}`;
};

export const formatDateAdded = (timestamp?: number): string => {
  if (!timestamp) return 'Unknown';
  const ms = timestamp > 10000000000 ? timestamp : timestamp * 1000;
  const date = new Date(ms);
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  });
};

export const cleanAudioString = (str: string): string => {
  if (!str) return '';
  return str
    // Remove file extension
    .replace(/\.[a-zA-Z0-9]{2,5}$/, '')
    // Remove bot tags
    .replace(/@\w+/g, '')
    // Remove common promotional / video suffixes
    .replace(/\s*[\(\[]\s*(?:official\s*(?:music\s*)?video|official\s*audio|official|audio|lyrics?|lyric\s*video|visualizer|remastered|hq|hd|320\s*kbps|128\s*kbps|flac|explicit|clean|clip\s*officiel)\s*[\)\]]/gi, '')
    .trim();
};

export const parseTrackInfo = (file: VirtualFile): ParsedTrackInfo => {
  let title = '';
  let artist = '';
  let album = 'Single';

  if (file.performer && file.performer.trim() && file.performer.toLowerCase() !== 'unknown') {
    artist = file.performer.trim();
  }
  if (file.title && file.title.trim() && !/^track_\d+$/i.test(file.title)) {
    title = file.title.trim();
  }

  if (artist && title) {
    title = title.replace(/^(\d{1,3})[\s._-]+/, '').trim();
    return {
      title: cleanAudioString(title) || title,
      artist,
      album,
      durationFormatted: formatDuration(file.duration),
      dateFormatted: formatDateAdded(file.date)
    };
  }

  let raw = cleanAudioString(file.name);

  if (raw.includes('_')) {
    raw = raw.replace(/[_\s]*-[_\s]*/g, ' - ');
    raw = raw.replace(/_+/g, ' ');
  }

  raw = raw.replace(/\s+/g, ' ').trim();

  const leadingTrackMatch = raw.match(/^\[?\(?(\d{1,3})\)?\]?[\s._-]+(.+)$/);
  if (leadingTrackMatch && leadingTrackMatch[2]) {
    raw = leadingTrackMatch[2].trim();
  }

  const separatorMatch = raw.match(/\s+[-—–~]\s+/);
  if (separatorMatch) {
    const parts = raw.split(separatorMatch[0]).map(p => p.trim()).filter(Boolean);
    if (parts.length === 2) {
      if (!artist) artist = parts[0];
      if (!title) title = parts[1];
    } else if (parts.length >= 3) {
      if (/^\d{1,3}$/.test(parts[1])) {
        if (!artist) artist = parts[0];
        if (!title) title = parts.slice(2).join(' - ');
      } else {
        if (!artist) artist = parts[0];
        album = parts[1];
        if (!title) title = parts.slice(2).join(' - ');
      }
    }
  } else {
    const byMatch = raw.match(/^(.+?)\s+by\s+(.+)$/i);
    if (byMatch) {
      if (!title) title = byMatch[1].trim();
      if (!artist) artist = byMatch[2].trim();
    } else {
      if (!title) title = raw;
    }
  }

  if (album === 'Single') {
    const albumMatch = title.match(/\[(.*?)\]|\((.*?)\)/);
    if (albumMatch) {
      const potentialAlbum = (albumMatch[1] || albumMatch[2] || '').trim();
      if (potentialAlbum && !/feat|ft|remix|live|mix|acoustic|version|edit/i.test(potentialAlbum)) {
        album = potentialAlbum;
      }
    }
  }

  title = title.replace(/^(\d{1,3})[\s._-]+/, '').trim();
  if (!title) title = 'Untitled Track';
  if (!artist) artist = 'Unknown Artist';

  return {
    title,
    artist,
    album,
    durationFormatted: formatDuration(file.duration),
    dateFormatted: formatDateAdded(file.date)
  };
};

type FileRegistryListener = (file: VirtualFile) => void;
const registryListeners: Set<FileRegistryListener> = new Set();
const registeredFiles = new Map<string, VirtualFile>();

export const registerPlayableFile = (file: VirtualFile) => {
  if (!file || !file.id) return;
  registeredFiles.set(file.id, file);
  if (file.name) registeredFiles.set(file.name, file);
  registryListeners.forEach(fn => {
    try { fn(file); } catch {}
  });
};

export const onPlayableFileRegistered = (listener: FileRegistryListener): (() => void) => {
  registryListeners.add(listener);
  registeredFiles.forEach(file => listener(file));
  return () => registryListeners.delete(listener);
};

export const getRegisteredPlayableFile = (idOrName: string): VirtualFile | undefined => {
  return registeredFiles.get(idOrName);
};

const COVER_CACHE_KEY_PREFIX = 'zud_album_cover_';
const memoryCoverCache = new Map<string, string>();

export const getSafeCoverUrl = (url: string | null | undefined): string => {
  if (!url) return '';
  if (url.startsWith('/') || url.startsWith('blob:') || url.startsWith('data:')) return url;
  if (url.startsWith('http://') || url.startsWith('https://')) {
    return `/api/cover?url=${encodeURIComponent(url)}`;
  }
  return url;
};

const normalizeCoverKey = (key: string): string => {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '_').slice(0, 80);
};

export const saveTrackCover = (trackKey: string, coverUrl: string) => {
  if (!trackKey || !coverUrl) return;
  const safeUrl = getSafeCoverUrl(coverUrl);
  const normKey = normalizeCoverKey(trackKey);
  memoryCoverCache.set(normKey, safeUrl);
  try {
    localStorage.setItem(`${COVER_CACHE_KEY_PREFIX}${normKey}`, safeUrl);
  } catch {}
};

export const getCachedTrackCover = (trackKey: string): string | null => {
  if (!trackKey) return null;
  const normKey = normalizeCoverKey(trackKey);
  if (memoryCoverCache.has(normKey)) {
    return getSafeCoverUrl(memoryCoverCache.get(normKey)!);
  }
  try {
    const saved = localStorage.getItem(`${COVER_CACHE_KEY_PREFIX}${normKey}`);
    if (saved) {
      const safe = getSafeCoverUrl(saved);
      memoryCoverCache.set(normKey, safe);
      return safe;
    }
  } catch {}
  return null;
};

const inflightArtworks = new Map<string, Promise<string | null>>();

export const fetchHighResArtwork = async (artist: string, title: string): Promise<string | null> => {
  const cleanArtist = artist.replace(/feat\..*|ft\..*/i, '').trim();
  const cleanTitle = title.replace(/\(.*?\)|\[.*?\]/g, '').trim();
  const query = `${cleanArtist} ${cleanTitle}`.trim();
  if (!query || query === 'Unknown Artist') return null;

  const cacheKey = `${cleanArtist}_${cleanTitle}`;
  const existing = getCachedTrackCover(cacheKey);
  if (existing) return existing;

  if (inflightArtworks.has(cacheKey)) {
    return inflightArtworks.get(cacheKey)!;
  }

  const promise = (async () => {
    try {
      const q = encodeURIComponent(query);
      let res: Response | null = null;
      try {
        res = await fetch(`/api/itunes?query=${q}`);
      } catch {}
      if (!res || !res.ok) {
        try {
          res = await fetch(`https://itunes.apple.com/search?term=${q}&entity=song&limit=1`);
        } catch {}
      }
      if (!res || !res.ok) return null;
      const data = await res.json();
      if (data.results && data.results.length > 0 && data.results[0].artworkUrl100) {
        const highRes = data.results[0].artworkUrl100.replace('100x100bb.jpg', '1000x1000bb.jpg');
        const safeUrl = getSafeCoverUrl(highRes);
        saveTrackCover(cacheKey, safeUrl);
        saveTrackCover(title, safeUrl);
        return safeUrl;
      }
    } catch {}
    return null;
  })();

  inflightArtworks.set(cacheKey, promise);
  try {
    return await promise;
  } finally {
    inflightArtworks.delete(cacheKey);
  }
};

