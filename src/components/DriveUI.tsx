import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useTelegram } from '../context/TelegramContext';
import type { StoredTelegramAccount } from '../lib/telegram';
import { Login } from './Login';
import { syncChannelFiles, clearChannelCache, parseMetadata, parseDocSize, hydrateChannelFromCache, loadChannelCache, getMimeType } from '../lib/vfs';
import type { VirtualFolder, VirtualFile } from '../lib/vfs';
import { Folder, File, Download, Smartphone, UploadCloud, ChevronRight, ChevronDown, LayoutGrid, List, LayoutDashboard, Loader2, X, Settings, LogOut, Play, Pause, Volume2, VolumeX, Maximize, Search, ArrowLeft, ArrowRight, Rewind, FastForward, Copy, Scissors, Trash2, Check, MoreVertical, ClipboardPaste, Edit2, FileAudio, CheckCircle2, Subtitles, Upload, Clock, Layers, AlertCircle, ShieldAlert, AlertTriangle, Sparkles, ListMusic, RotateCw, Database, ArrowUpDown, ArrowUp, ArrowDown } from 'lucide-react';
import { buildTelegramCaption } from '../lib/caption';
import { getFileIcon } from './FileIconMapper';
import { logger } from '../lib/logger';
import { getFloodWaitSeconds } from '../lib/tgGate';
import {
  fetchMessageBatched, fetchMessageUrgent, invalidateMessage, createLimiter, dedupeInflight,
  thumbActivityStart, thumbActivityEnd
} from '../lib/msgCache';
import { registerThumb, setThumbPrefetcher, getThumbMemoryUrl } from '../lib/thumbQueue';
import { useDriveOperations } from '../hooks/useDriveOperations';
import { UploadManager } from './UploadManager';
import { DownloadManager } from './DownloadManager';
import { BrandLogo } from './BrandLogo';
import { VoxelLogoLoader } from './VoxelLogoLoader';
import { MediaLoadingText } from './MediaLoadingText';
import { TransferCenter } from './TransferCenter';
import { DeleteProgressModal, type DeleteModalItem } from './DeleteProgressModal';
import { resolveTelegramEntity, saveChannelAccessHash, channelNumericId } from '../lib/telegramEntity';
import { Api, utils as tgUtils } from 'telegram';
import { Buffer } from 'buffer';
import bigInt from 'big-integer';
import { ImageViewer } from './ImageViewer';
import { PdfViewer } from './PdfViewer';
import { usePWAInstall } from '../hooks/usePWAInstall';
import { PWAInstallModal } from './PWAInstallModal';
import { MusicPlayer } from './MusicPlayer';
import { useMusicPlayer } from '../context/MusicPlayerContext';
import { isAudioFile, getAudioMimeType, parseTrackInfo, getCachedTrackCover, fetchHighResArtwork, onPlayableFileRegistered, getRegisteredPlayableFile } from '../lib/musicUtils';
import { getDcSender, invalidateDcSender, acquireDcDownloadSlot, sendWithDcSender, ensureTelegramConnected, warmDcSenderLanes } from '../lib/dcSenderPool';

const VIEWABLE_MEDIA = (file: VirtualFile) =>
  file.mimeType.startsWith('image/') || file.mimeType === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');

const STREAM_CACHE_MAX_BYTES = 80 * 1024 * 1024;
const streamChunkCache = new Map<string, Uint8Array>();
let currentStreamCacheBytes = 0;

export const getCachedStreamChunk = (key: string): Uint8Array | undefined => {
  const chunk = streamChunkCache.get(key);
  if (chunk) {
    streamChunkCache.delete(key);
    streamChunkCache.set(key, chunk);
  }
  return chunk;
};

export const setCachedStreamChunk = (key: string, chunk: Uint8Array): void => {
  if (streamChunkCache.has(key)) {
    const existing = streamChunkCache.get(key)!;
    currentStreamCacheBytes -= existing.byteLength;
    streamChunkCache.delete(key);
  }
  while (currentStreamCacheBytes + chunk.byteLength > STREAM_CACHE_MAX_BYTES && streamChunkCache.size > 0) {
    const firstKey = streamChunkCache.keys().next().value;
    if (!firstKey) break;
    const old = streamChunkCache.get(firstKey);
    if (old) {
      currentStreamCacheBytes -= old.byteLength;
    }
    streamChunkCache.delete(firstKey);
  }
  streamChunkCache.set(key, chunk);
  currentStreamCacheBytes += chunk.byteLength;
};

interface InflightStreamChunkEntry {
  promise: Promise<{ bytes: Buffer | Uint8Array } | null>;
  subscribers: number;
  cancelled: boolean;
}
const inflightStreamChunks = new Map<string, InflightStreamChunkEntry>();

/* ============================================================================
 * COMPONENT: NativeThumbnail
 * Thumbnail rendering, scrub preview, and cover art resolution.
 * ============================================================================ */
const NativeThumbnail: React.FC<{ file: VirtualFile, iconClassName?: string, isGrid?: boolean, order?: number, showPartsBadge?: boolean }> = ({ file, iconClassName = "w-16 h-16", isGrid = false, order = 0, showPartsBadge = true }) => {
  const getPartThumbUrl = (idx: number) => {
    const p = file.parts[idx];
    if (!p || p.messageId === undefined) return '';
    return `/thumb/${encodeURIComponent(p.channelId ? `${p.channelId}_${p.messageId}` : p.messageId)}?v=${file.date || 0}`;
  };

  const thumbUrl0 = getPartThumbUrl(0);
  const initialMemThumb = thumbUrl0 ? getThumbMemoryUrl(thumbUrl0) : undefined;

  const [hasError, setHasError] = useState(false);
  const [hasThumb, setHasThumb] = useState(() =>
    isAudioFile(file) || file.mimeType.startsWith('video/') || file.mimeType.startsWith('image/')
  );
  const [isHovered, setIsHovered] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [readyPartUrls, setReadyPartUrls] = useState<Record<number, string>>(() =>
    initialMemThumb ? { 0: initialMemThumb } : ({} as Record<number, string>)
  );
  const [wrapEl, setWrapEl] = useState<HTMLElement | null>(null);
  const [nearView, setNearView] = useState<boolean>(Boolean(initialMemThumb) || typeof IntersectionObserver === 'undefined');
  const [audioCoverUrl, setAudioCoverUrl] = useState<string | null>(null);
  const [isImgLoaded, setIsImgLoaded] = useState<boolean>(Boolean(initialMemThumb));

  useEffect(() => {
    const isAudio = isAudioFile(file);
    if (isAudio) {
      const { artist, title } = parseTrackInfo(file);
      const cached = getCachedTrackCover(file.name) ||
        getCachedTrackCover(file.id) ||
        getCachedTrackCover(title) ||
        getCachedTrackCover(`${artist}_${title}`);
      if (cached) {
        setAudioCoverUrl(cached);
        setHasThumb(true);
        setHasError(false);
        return;
      }
      fetchHighResArtwork(artist, title).then(url => {
        if (url) {
          setAudioCoverUrl(url);
          setHasThumb(true);
        }
      });
      setHasThumb(true);
      setHasError(false);
      return;
    }
    const memHit = thumbUrl0 ? getThumbMemoryUrl(thumbUrl0) : undefined;
    if (memHit) {
      setReadyPartUrls(prev => (prev[0] === memHit ? prev : { ...prev, 0: memHit }));
      setIsImgLoaded(true);
      setNearView(true);
    }
    if (file.mimeType.startsWith('video/') || file.mimeType.startsWith('image/')) {
      setHasThumb(true);
      setHasError(false);
    } else {
      setHasThumb(false);
    }
  }, [file, thumbUrl0]);

  const FallbackIcon = () => {
    return getFileIcon(file.name, file.mimeType, iconClassName);
  };

  useEffect(() => {
    if (nearView || !wrapEl) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some(e => e.isIntersecting)) {
        setNearView(true);
        io.disconnect();
      }
    }, { root: wrapEl.closest('main') as Element | null, rootMargin: '1400px 0px' });
    io.observe(wrapEl);
    return () => io.disconnect();
  }, [wrapEl, nearView]);

  // Load Part 0 thumbnail
  useEffect(() => {
    if (!hasThumb || !thumbUrl0 || !nearView) return;
    if (readyPartUrls[0]) return;
    const cancel = registerThumb(thumbUrl0, order, (outcome, resolvedUrl) => {
      if (outcome === 'ok') {
        setReadyPartUrls(prev => ({ ...prev, 0: resolvedUrl || thumbUrl0 }));
        setHasError(false);
      } else {
        setHasError(true);
      }
    });
    return cancel;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasThumb, thumbUrl0, order, nearView]);

  // If part 0 is loaded and this file has multiple parts with thumbnails, register the other parts too
  useEffect(() => {
    if (!hasThumb || hasError || !nearView || file.parts.length <= 1 || !readyPartUrls[0]) return;
    const cancels: (() => void)[] = [];
    for (let i = 1; i < file.parts.length; i++) {
      const url = getPartThumbUrl(i);
      if (!url || readyPartUrls[i]) continue;
      const partIdx = i;
      const cancel = registerThumb(url, order + 500 + partIdx, (outcome, resolvedUrl) => {
        if (outcome === 'ok') {
          setReadyPartUrls(prev => ({ ...prev, [partIdx]: resolvedUrl || url }));
        }
      });
      cancels.push(cancel);
    }
    return () => {
      cancels.forEach(c => c());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasThumb, hasError, nearView, readyPartUrls[0], file.parts.length, order]);

  // All thumbnails are loaded only if we have thumbnails, no error, multiple parts, and all parts have ready URLs
  const allThumbsLoaded = Boolean(
    hasThumb &&
    !hasError &&
    file.parts.length > 1 &&
    Object.keys(readyPartUrls).length === file.parts.length
  );

  // Cycling only when hovered AND all thumbnails are fully downloaded
  useEffect(() => {
    let interval: any;
    if (isHovered && allThumbsLoaded) {
      interval = setInterval(() => {
        setActiveIndex(prev => (prev + 1) % file.parts.length);
      }, 1500);
    } else {
      setActiveIndex(0);
    }
    return () => clearInterval(interval);
  }, [isHovered, allThumbsLoaded, file.parts.length]);

  const toggleHover = (state: boolean) => {
    if (state) {
      if (hasThumb && !hasError && file.parts.length > 1 && allThumbsLoaded) {
        setIsHovered(true);
      }
    } else {
      setIsHovered(false);
    }
  };

  const currentDisplayUrl = audioCoverUrl || readyPartUrls[activeIndex] || readyPartUrls[0] || null;

  const imageElement = (hasThumb && !hasError) ? (
    <div ref={setWrapEl} className={`relative flex items-center justify-center ${isGrid ? 'w-full h-full' : 'w-5 h-5'}`}>
      {!isImgLoaded && <Loader2 className={`w-full h-full ${isGrid ? 'max-w-[24px] max-h-[24px]' : 'max-w-[16px] max-h-[16px]'} text-gray-400 animate-spin absolute`} />}
      {currentDisplayUrl && <img 
        src={currentDisplayUrl} 
        decoding="async"
        loading="eager"
        className={`${isGrid ? "w-full h-full" : "w-5 h-5 rounded-sm"} object-cover ${isImgLoaded ? 'opacity-100' : 'opacity-0'} transition-opacity duration-150 relative z-10 transform-gpu`} 
        alt="" 
        onLoad={() => setIsImgLoaded(true)}
        onError={() => setHasError(true)}
      />}
    </div>
  ) : <FallbackIcon />;

  if (!isGrid) return imageElement;

  return (
    <div 
      className="w-full h-full z-10 flex items-center justify-center relative"
      onMouseEnter={() => toggleHover(true)}
      onMouseLeave={() => toggleHover(false)}
    >
      {imageElement}
      {showPartsBadge && file.parts.length > 1 && (
         <div className="absolute top-2 left-2 z-20 bg-black/60 text-white text-[10px] font-medium px-2 py-0.5 rounded-full backdrop-blur-md shadow-lg pointer-events-none flex items-center gap-1 border border-white/10">
           <span>{isHovered && allThumbsLoaded ? `Part ${activeIndex + 1} / ${file.parts.length}` : `${file.parts.length} Parts`}</span>
         </div>
      )}
    </div>
  );
};

interface SubtitleCue {
  id: number;
  start: number;
  end: number;
  text: string;
}

interface EmbeddedSubtitleTrack {
  index: number;
  label: string;
  language: string;
  kind: string;
}

const parseSRT = (data: string): SubtitleCue[] => {
  if (!data) return [];
  // Strip UTF-8 BOM if present
  let text = data.replace(/^\uFEFF/, '');
  // Normalize all line breaks to \n
  text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  // Convert Persian and Arabic digits to ASCII
  text = text.replace(/[۰-۹]/g, d => String.fromCharCode(d.charCodeAt(0) - 1728));
  text = text.replace(/[٠-٩]/g, d => String.fromCharCode(d.charCodeAt(0) - 1584));
  // Strip WebVTT headers & comments
  text = text.replace(/^WEBVTT[^\n]*\n+/i, '');
  text = text.replace(/NOTE[ \t][^\n]*\n+/gi, '');

  const blocks = text.split(/\n\s*\n+/);
  const cues: SubtitleCue[] = [];
  
  const parseTime = (tStr: string): number => {
    if (!tStr) return 0;
    const clean = tStr.trim().replace(',', '.');
    // Match hh:mm:ss.mmm or mm:ss.mmm
    const m = clean.match(/(?:(?:(\d+):)?(\d{1,2}):)?(\d{1,2})(?:\.(\d+))?/);
    if (!m) return 0;
    const hours = m[1] ? parseInt(m[1], 10) : 0;
    const minutes = m[2] ? parseInt(m[2], 10) : 0;
    const seconds = m[3] ? parseInt(m[3], 10) : 0;
    const msStr = m[4] || '0';
    const ms = parseFloat('0.' + msStr.padEnd(3, '0').slice(0, 3));
    return hours * 3600 + minutes * 60 + seconds + ms;
  };

  for (const block of blocks) {
    const lines = block.trim().split('\n');
    if (lines.length < 2) continue;
    
    let timeLineIndex = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes('-->')) {
        timeLineIndex = i;
        break;
      }
    }
    if (timeLineIndex === -1) continue;
    
    const parts = lines[timeLineIndex].split('-->');
    if (parts.length < 2) continue;
    
    const start = parseTime(parts[0].trim());
    // In WebVTT, end time may have cue settings attached e.g. "00:05.000 line:0% position:50%"
    const endRaw = parts[1].trim().split(/\s+/)[0];
    const end = parseTime(endRaw);
    
    let rawText = lines.slice(timeLineIndex + 1).join('\n').trim();
    // Strip HTML and ASS formatting tags like <i>, <b>, <font ...>, {\an8}
    rawText = rawText.replace(/<[^>]+>/g, '').replace(/\{\\[^}]+\}/g, '').trim();

    if (end > start && rawText) {
      cues.push({ id: cues.length + 1, start, end, text: rawText });
    }
  }
  cues.sort((a, b) => a.start - b.start);
  return cues;
};

const srtToWebVtt = (srt: string): string => {
  if (!srt) return 'WEBVTT\n\n';
  let cleaned = srt.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  cleaned = cleaned.replace(/^WEBVTT[^\n]*\n+/i, '');
  return 'WEBVTT\n\n' + cleaned.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
};

const getBufferedAheadSeconds = (video: HTMLVideoElement | null, atTime?: number): number => {
  if (!video || !video.buffered || video.buffered.length === 0) return 0;
  const t = atTime ?? video.currentTime;
  let maxAhead = 0;
  for (let i = 0; i < video.buffered.length; i++) {
    const start = video.buffered.start(i);
    const end = video.buffered.end(i);
    if (start <= t + 0.2 && end > t) {
      maxAhead = Math.max(maxAhead, end - t);
    }
  }
  return maxAhead;
};

/* ============================================================================
 * COMPONENT: CustomVideoPlayer
 * Custom video player supporting multi-part seamless playback, seeking, and tracks.
 * ============================================================================ */
const CustomVideoPlayer = ({ file, src, onClose, onDownload }: { file: VirtualFile, src: string, onClose: () => void, onDownload?: () => void }) => {
  const videoRef = React.useRef<HTMLVideoElement>(null);
  const { client } = useTelegram();
  
  const [activePartIndex, setActivePartIndex] = useState(0);
  // Independent part mode: Each part is streamed with its native MP4 container and duration.
  // Cross-part seeking updates the global timeline and seamlessly transitions without resetting to 0.
  const [isContinuousMode] = useState(false);
  const [activePartUrl, setActivePartUrl] = useState(
    file.parts.length > 1 ? `${src}?part=0` : src
  );
  const [partDurations, setPartDurations] = useState<number[]>(() => {
    const durations = file.parts.map(p => p.duration || 0);
    return durations.length ? durations : [0];
  });
  const [metadataTotalDuration, setMetadataTotalDuration] = useState<number | null>(null);
  
  const [isPlaying, setIsPlaying] = useState(true);
  const isPlayingRef = React.useRef(true);
  isPlayingRef.current = isPlaying;
  const userWantsPlayRef = React.useRef(true);
  const [freezeFrameUrl, setFreezeFrameUrl] = useState<string | null>(null);
  const [localCurrentTime, setLocalCurrentTime] = useState(0);
  const [volume, setVolume] = useState(1);
  const [isMuted, setIsMuted] = useState(false);
  const [isWaiting, setIsWaiting] = useState(true);
  const isWaitingRef = React.useRef(true);
  const waitingTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const [, setHasStartedPlayback] = useState(false);
  const isTornDownRef = React.useRef(false);
  const isCompletingReadyRef = React.useRef(false);
  const pendingFrameTargetRef = React.useRef<number | null>(null);
  const resumeAfterPartChangeRef = React.useRef(false);
  const [downloadProgress, setDownloadProgress] = useState(0);
  const targetProgressRef = React.useRef(3);
  const shownProgressRef = React.useRef(0);
  const requestProgressRef = React.useRef<Map<string, number>>(new Map());
  const requestLastReceivedRef = React.useRef<Map<string, number>>(new Map());
  const seekDeliveredBytesRef = React.useRef(0);
  const playbackAdvanceBaselineRef = React.useRef<{ time: number; ts: number } | null>(null);
  const lastSeekCommitAtRef = React.useRef<number>(Date.now());
  const partDurationInfoRef = React.useRef({ totalDuration: 0, currentPartDuration: 0 });

  const resetLoadingProgress = useCallback((initial = 0) => {
    isCompletingReadyRef.current = false;
    requestProgressRef.current.clear();
    requestLastReceivedRef.current.clear();
    seekDeliveredBytesRef.current = 0;
    targetProgressRef.current = Math.max(initial, 3);
    shownProgressRef.current = initial;
    setDownloadProgress(initial);
  }, []);

  const releasePlaybackGateAndStart = useCallback(() => {
    if (isTornDownRef.current) return;
    isCompletingReadyRef.current = false;
    shownProgressRef.current = 100;
    setDownloadProgress(100);
    isWaitingRef.current = false;
    setIsWaiting(false);
    setFreezeFrameUrl(null);
    setHasStartedPlayback(true);
    const v = videoRef.current;
    if (v && userWantsPlayRef.current && v.paused && !v.ended) {
      v.play().catch(() => {});
    }
  }, []);

  const setWaitingState = useCallback((waiting: boolean, immediate = false) => {
    if (isTornDownRef.current) return;
    if (waitingTimeoutRef.current) {
      clearTimeout(waitingTimeoutRef.current);
      waitingTimeoutRef.current = null;
    }
    if (!waiting) {
      isCompletingReadyRef.current = false;
      isWaitingRef.current = false;
      setIsWaiting(false);
      const v = videoRef.current;
      if (v && userWantsPlayRef.current && v.paused && !v.ended) {
        v.play().catch(() => {});
      }
    } else if (immediate) {
      isCompletingReadyRef.current = false;
      if (!isWaitingRef.current || targetProgressRef.current >= 100) {
        resetLoadingProgress(0);
        const v = videoRef.current;
        if (v) {
          playbackAdvanceBaselineRef.current = { time: v.currentTime, ts: performance.now() };
        }
      }
      isWaitingRef.current = true;
      setIsWaiting(true);
      const v = videoRef.current;
      if (v && !v.paused) {
        try { v.pause(); } catch {}
      }
    } else {
      waitingTimeoutRef.current = setTimeout(() => {
        if (isTornDownRef.current) return;
        isCompletingReadyRef.current = false;
        if (!isWaitingRef.current || targetProgressRef.current >= 100) {
          resetLoadingProgress(0);
          const v = videoRef.current;
          if (v) {
            playbackAdvanceBaselineRef.current = { time: v.currentTime, ts: performance.now() };
          }
        }
        isWaitingRef.current = true;
        setIsWaiting(true);
        const v = videoRef.current;
        if (v && !v.paused) {
          try { v.pause(); } catch {}
        }
      }, 320);
    }
  }, [resetLoadingProgress]);

  const markPlaybackReady = useCallback(() => {
    if (isTornDownRef.current) return;
    if (waitingTimeoutRef.current) {
      clearTimeout(waitingTimeoutRef.current);
      waitingTimeoutRef.current = null;
    }
    if (!isWaitingRef.current) {
      setFreezeFrameUrl(null);
      setHasStartedPlayback(true);
      setIsWaiting(false);
      return;
    }
    targetProgressRef.current = 100;
    // Strict 100% gate: only start playback at the exact instant progress reaches 100%!
    if (shownProgressRef.current >= 96) {
      releasePlaybackGateAndStart();
    } else {
      isCompletingReadyRef.current = true;
    }
  }, [releasePlaybackGateAndStart]);

  // Subtitle state. Audio track switching is intentionally not supported.
  const [embeddedSubtitles, setEmbeddedSubtitles] = useState<EmbeddedSubtitleTrack[]>([]);
  const [uploadedSubtitles, setUploadedSubtitles] = useState<{ id: string, name: string, cues: SubtitleCue[], vttUrl?: string }[]>([]);
  const [selectedSubtitleTrack, setSelectedSubtitleTrack] = useState<string>('off');
  const lastSubtitleTrackRef = useRef<string | null>(null);
  const [activeSubtitleCueText, setActiveSubtitleCueText] = useState<string | null>(null);
  const [isSubtitlesMenuOpen, setIsSubtitlesMenuOpen] = useState(false);
  const subtitleFileInputRef = useRef<HTMLInputElement>(null);

  // Subtitle Drag & Drop & Sync Offset
  const [isDraggingSubtitle, setIsDraggingSubtitle] = useState(false);
  const [subtitleToast, setSubtitleToast] = useState<string | null>(null);
  const [subtitleOffset, setSubtitleOffset] = useState<number>(0);
  const [subtitleBackground, setSubtitleBackground] = useState(true);
  const [subtitleFontSize, setSubtitleFontSize] = useState(24);
  const dragCounterRef = useRef(0);

  // Persistence ref for subtitle selection across parts
  const preferredSubRef = useRef<{ type: 'embedded' | 'uploaded' | 'off', id?: string, language?: string, label?: string, index?: number } | null>(null);

  // Playback Error state
  const [videoPlaybackError, setVideoPlaybackError] = useState<{ message: string; isMkv: boolean } | null>(null);

  // Initialize audio and subtitle tracks from file entry or probe stream header
  useEffect(() => {
    if (file.subtitleTracks && file.subtitleTracks.length > 0) {
      setEmbeddedSubtitles(file.subtitleTracks.map((s: any, i: number) => ({
        index: i,
        label: s.label || `Subtitle ${i + 1}`,
        language: s.language || 'und',
        kind: 'subtitles'
      })));
    }

    // If tracks are not yet present on file, probe stream header via preview range
    const probeAbort = new AbortController();
    if (!file.subtitleTracks?.length) {
      const isMkv = file.name.toLowerCase().endsWith('.mkv') || file.mimeType.includes('matroska');
      if (isMkv) {
        const probeStream = async () => {
          try {
            const res = await fetch(`/stream/${encodeURIComponent(file.id)}?preview=true`, {
              headers: { Range: 'bytes=0-1048576' },
              signal: probeAbort.signal,
            });
            if (res.ok && !probeAbort.signal.aborted) {
              const buf = await res.arrayBuffer();
              if (probeAbort.signal.aborted) return;
              const { probeEbmlMetadata } = await import('../lib/videoProbe');
              const probed = probeEbmlMetadata(buf);
              if (probed && !probeAbort.signal.aborted) {
                if (probed.subtitleTracks.length > 0) {
                  setEmbeddedSubtitles(probed.subtitleTracks.map((s, i) => ({
                    index: i,
                    label: s.label,
                    language: s.language,
                    kind: 'subtitles'
                  })));
                }
              }
            }
          } catch (e: any) {
            if (e?.name !== 'AbortError') {
              console.warn("Probe stream header failed:", e);
            }
          }
        };
        probeStream();
      }
    }
    return () => probeAbort.abort();
  }, [file]);

  // Immediate stream teardown on viewer close event (before 220ms fade-out!) AND on unmount
  useEffect(() => {
    isTornDownRef.current = false;

    const detachAllMediaElements = (captureFrame: boolean) => {
      if (isTornDownRef.current) return;
      isTornDownRef.current = true;
      isCompletingReadyRef.current = false;
      if (waitingTimeoutRef.current) {
        clearTimeout(waitingTimeoutRef.current);
        waitingTimeoutRef.current = null;
      }
      const v = videoRef.current;
      if (v) {
        if (captureFrame && v.videoWidth > 0 && v.readyState >= 2) {
          try {
            const canvas = document.createElement('canvas');
            canvas.width = v.videoWidth;
            canvas.height = v.videoHeight;
            const ctx = canvas.getContext('2d');
            if (ctx) {
              ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
              setFreezeFrameUrl(canvas.toDataURL('image/jpeg', 0.8));
            }
          } catch (_) {}
        }
        try {
          v.pause();
          v.removeAttribute('src');
          v.load();
        } catch (_) {}
      }
      const pv = previewVideoRef.current;
      if (pv) {
        try {
          pv.pause();
          pv.removeAttribute('src');
          pv.load();
        } catch (_) {}
      }
    };

    const handleExternalCancel = (e: any) => {
      const d = e.detail;
      if (!d || d.reason) return;
      if (d.fileId === file.id || decodeURIComponent(String(d.fileId || '')) === file.id) {
        detachAllMediaElements(true);
      }
    };

    window.addEventListener('cancelStream', handleExternalCancel);
    return () => {
      window.removeEventListener('cancelStream', handleExternalCancel);
      detachAllMediaElements(false);
      window.dispatchEvent(new CustomEvent('cancelStream', { detail: { fileId: file.id } }));
    };
  }, [file.id]);

  // Un-stall watchdog: immediately resume playback ONLY after 100% loading gate has cleared
  useEffect(() => {
    const interval = setInterval(() => {
      if (isTornDownRef.current || isWaitingRef.current) return;
      const v = videoRef.current;
      if (v && v.paused && userWantsPlayRef.current && !v.ended) {
        if (v.readyState >= 2) {
          v.play().catch(() => {});
        }
      }
    }, 350);
    return () => clearInterval(interval);
  }, [isPlaying, isWaiting]);

  // Proactively warm DC WebSocket lanes on player mount for instant seek & preview response
  useEffect(() => {
    if (client) {
      void warmDcSenderLanes(client);
    }
  }, [client, file.id]);

  // Real progress of startup / seek buffering: adaptive bitrate bytes + 1.25s decoder buffer runway.
  // Playback stays strictly gated until progress reaches 100%, then starts cleanly with zero stall.
  const TARGET_RUNWAY_SEC = 1.25;

  const checkPlaybackReadiness = useCallback((v: HTMLVideoElement): { ready: boolean; bufferedAhead: number } => {
    if (!v || v.seeking || isTornDownRef.current) {
      return { ready: false, bufferedAhead: 0 };
    }
    const target = pendingFrameTargetRef.current;
    if (target !== null && target > 1.5 && v.currentTime < 0.5) {
      return { ready: false, bufferedAhead: 0 };
    }
    if (target !== null && target > 2.0 && v.currentTime < 1.0 && Math.abs(v.currentTime - target) > 3.5) {
      return { ready: false, bufferedAhead: 0 };
    }

    const bufferedAhead = getBufferedAheadSeconds(v);
    const { totalDuration: knownTotalDur, currentPartDuration: knownPartDur } = partDurationInfoRef.current;
    const rawDur = (isContinuousMode || file.parts.length <= 1) ? knownTotalDur : knownPartDur;
    const realDur = (Number.isFinite(v.duration) && v.duration > 0) ? v.duration : rawDur;
    const remainingSec = realDur > 0 ? Math.max(0, realDur - v.currentTime) : Infinity;
    const nearEnd = realDur > 0 && remainingSec <= 2.2;
    const waitedMs = lastSeekCommitAtRef.current ? (Date.now() - lastSeekCommitAtRef.current) : 0;

    if (!userWantsPlayRef.current) {
      const pausedReady =
        v.ended ||
        (v.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA && (bufferedAhead >= 0.7 || nearEnd)) ||
        (v.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && (bufferedAhead >= 0.9 || nearEnd || (waitedMs > 900 && bufferedAhead >= 0.12)));
      return { ready: pausedReady, bufferedAhead };
    }

    const highVolumeRunwayMet =
      v.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA &&
      seekDeliveredBytesRef.current >= 2.5 * 1024 * 1024 &&
      bufferedAhead >= 0.95;

    const steadyFallbackReady =
      waitedMs > 1300 &&
      v.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
      bufferedAhead >= 0.4;

    const ready =
      v.ended ||
      (nearEnd && v.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && (bufferedAhead >= Math.min(0.3, remainingSec * 0.5) || remainingSec <= 0.35)) ||
      (v.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA && bufferedAhead >= TARGET_RUNWAY_SEC) ||
      highVolumeRunwayMet ||
      steadyFallbackReady;

    return { ready, bufferedAhead };
  }, [file.parts.length, isContinuousMode]);

  const tryMarkPlaybackReady = useCallback(() => {
    const v = videoRef.current;
    if (!v) return false;
    const { ready } = checkPlaybackReadiness(v);
    if (ready) {
      pendingFrameTargetRef.current = null;
      markPlaybackReady();
      return true;
    }
    return false;
  }, [checkPlaybackReadiness, markPlaybackReady]);

  useEffect(() => {
    const handleStreamProgress = (e: any) => {
      if (isTornDownRef.current || isCompletingReadyRef.current) return;
      const d = e.detail;
      if (!d) return;
      const isSameFile = d.fileId === file.id || decodeURIComponent(d.fileId) === file.id || d.fileName === file.name;
      if (!isSameFile || d.preview) return;
      if (!isContinuousMode && file.parts.length > 1 && d.partIndex !== undefined && d.partIndex !== activePartIndex) return;

      // Ignore stale progress events from streams started prior to the latest seek commit
      if (
        !d.isHeader &&
        typeof d.sessionCreatedAt === 'number' &&
        lastSeekCommitAtRef.current > 0 &&
        d.sessionCreatedAt < lastSeekCommitAtRef.current - 60
      ) {
        return;
      }

      if (d.stage === 'connecting') {
        if (targetProgressRef.current < 7) targetProgressRef.current = 7;
        return;
      }
      if (d.stage === 'fetching') {
        if (targetProgressRef.current < 14) targetProgressRef.current = 14;
        return;
      }

      const partSize = file.parts[activePartIndex]?.size || file.size || d.totalSize || 0;
      const { currentPartDuration, totalDuration: knownTotal } = partDurationInfoRef.current;
      const partDur = (isContinuousMode || file.parts.length <= 1) ? knownTotal : currentPartDuration;
      const bytesPerSec = (partSize > 0 && partDur > 0) ? (partSize / partDur) : (1.2 * 1024 * 1024);
      const SEEK_BYTES = Math.min(7 * 1024 * 1024, Math.max(1.5 * 1024 * 1024, bytesPerSec * (TARGET_RUNWAY_SEC + 0.5)));

      const prevForReq = requestLastReceivedRef.current.get(d.reqId);
      const curReceived = Number(d.received || 0);
      if (prevForReq === undefined) {
        seekDeliveredBytesRef.current += Number(d.chunkLen || curReceived || 0);
        requestLastReceivedRef.current.set(d.reqId, curReceived);
      } else if (curReceived > prevForReq) {
        seekDeliveredBytesRef.current += (curReceived - prevForReq);
        requestLastReceivedRef.current.set(d.reqId, curReceived);
      }

      const v = videoRef.current;
      const target = pendingFrameTargetRef.current;
      const isMetadataDiscovery =
        target !== null &&
        target > 2.0 &&
        (d.start || 0) === 0 &&
        (!v || v.readyState < HTMLMediaElement.HAVE_METADATA);

      let pct = 14;
      if (isMetadataDiscovery) {
        pct = 14 + Math.min(12, Math.floor((seekDeliveredBytesRef.current / (1.0 * 1024 * 1024)) * 12));
      } else {
        const effectiveSize = partSize || 1;
        const need = Math.max(512 * 1024, Math.min(SEEK_BYTES, Math.max(512 * 1024, effectiveSize - (d.start || 0))));
        const delivered = seekDeliveredBytesRef.current;
        if (delivered <= need) {
          pct = 14 + Math.floor((delivered / need) * 70);
        } else {
          const extra = delivered - need;
          pct = 84 + Math.min(11, Math.floor((1 - Math.exp(-extra / Math.max(need * 0.5, 512 * 1024))) * 11));
        }
      }

      if (pct > targetProgressRef.current && targetProgressRef.current < 100) {
        targetProgressRef.current = pct;
      }
    };
    window.addEventListener('streamProgress', handleStreamProgress);
    return () => window.removeEventListener('streamProgress', handleStreamProgress);
  }, [file.id, file.name, file.size, file.parts, activePartIndex, isContinuousMode]);

  // Smooth 60fps progress animator: climbs naturally through intermediate numbers and glides cleanly to 100%
  useEffect(() => {
    if (!isWaiting) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      if (isTornDownRef.current) return;
      const dt = Math.min(80, Math.max(4, now - last));
      last = now;
      const target = targetProgressRef.current;
      let shown = shownProgressRef.current;

      if (isCompletingReadyRef.current || target >= 100) {
        const step = Math.max(dt * 0.9, (100 - shown) * Math.min(1, dt / 32));
        shown = Math.min(100, shown + step);
        shownProgressRef.current = shown;
        const rounded = Math.min(100, Math.floor(shown));
        setDownloadProgress(prev => (prev === rounded ? prev : rounded));
        if (shown >= 99.6) {
          releasePlaybackGateAndStart();
          return;
        }
      } else {
        if (target > shown) {
          const gap = target - shown;
          const step = Math.max(dt * 0.022, gap * Math.min(1, dt / 95));
          shown = Math.min(target, shown + step);
        } else if (shown < 92) {
          // Subtle network-activity micro-creep between 256KB arrivals so number never looks dead
          shown = Math.min(92, shown + dt * 0.004);
          if (shown > targetProgressRef.current) {
            targetProgressRef.current = shown;
          }
        }
        shownProgressRef.current = shown;
        const rounded = Math.min(99, Math.floor(shown));
        setDownloadProgress(prev => (prev === rounded ? prev : rounded));
      }

      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [isWaiting, activePartIndex, releasePlaybackGateAndStart]);

  // Monitor buffer runway at 60ms cadence; playback stays strictly gated until 100% is reached
  useEffect(() => {
    if (!isWaiting) return;
    const interval = setInterval(() => {
      if (isTornDownRef.current || isCompletingReadyRef.current) return;
      const v = videoRef.current;
      if (!v || v.seeking) return;

      const { ready, bufferedAhead } = checkPlaybackReadiness(v);
      if (ready) {
        pendingFrameTargetRef.current = null;
        markPlaybackReady();
        return;
      }

      if (targetProgressRef.current < 100) {
        const target = pendingFrameTargetRef.current;
        const aligned = target === null || target <= 1.5 || v.currentTime > 0.5;
        if (aligned) {
          const runwayRatio = Math.max(0, Math.min(1, bufferedAhead / TARGET_RUNWAY_SEC));
          if (v.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) {
            const runwayPct = Math.min(99, Math.round(78 + runwayRatio * 21));
            if (runwayPct > targetProgressRef.current) {
              targetProgressRef.current = runwayPct;
            }
          } else if (v.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
            const currentPct = Math.min(86, Math.round(64 + runwayRatio * 22));
            if (currentPct > targetProgressRef.current) {
              targetProgressRef.current = currentPct;
            }
          }
        }
      }
    }, 60);
    return () => clearInterval(interval);
  }, [isWaiting, checkPlaybackReadiness, markPlaybackReady]);

  const [isHovered, setIsHovered] = useState(true);
  const [isProgressHovered, setIsProgressHovered] = useState(false);

  useEffect(() => {
    let timeout: NodeJS.Timeout;
    const reset = () => {
      setIsHovered(true);
      clearTimeout(timeout);
      timeout = setTimeout(() => setIsHovered(false), 2500);
    };
    window.addEventListener('mousemove', reset);
    window.addEventListener('touchstart', reset, { passive: true });
    window.addEventListener('keydown', reset);
    reset();
    return () => {
      window.removeEventListener('mousemove', reset);
      window.removeEventListener('touchstart', reset);
      window.removeEventListener('keydown', reset);
      clearTimeout(timeout);
    };
  }, []);

  const [pendingSeek, setPendingSeek] = useState<number | null>(null);

  const previewVideoRef = React.useRef<HTMLVideoElement>(null);
  const progressTrackRef = React.useRef<HTMLDivElement>(null);
  const previewCanvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const lastPreviewDispatchRef = React.useRef<number>(0);
  const previewTargetRef = React.useRef({ part: 0, time: 0, left: 84, globalTime: 0 });
  const previewFrameRef = React.useRef<number | null>(null);
  const [previewState, setPreviewState] = useState({ opacity: 0, left: 84, time: 0, show: false });
  const previewSnapshotCache = React.useRef<Map<string, string>>(new Map());
  const [activeSnapshotUrl, setActiveSnapshotUrl] = useState<string | null>(null);
  const [hasDecodedPreviewFrame, setHasDecodedPreviewFrame] = useState(false);
  const pendingPreviewSeekRef = React.useRef<number | null>(null);
  const swipeStartRef = React.useRef<{ x: number; y: number; time: number; startGlobalTime: number; isHorizontal?: boolean } | null>(null);

  const currentVideoDuration = videoRef.current?.duration;
  const completePartDurations = file.parts.length > 0
    && partDurations.length === file.parts.length
    && partDurations.every(duration => Number.isFinite(duration) && duration > 0);
  const partDurationTotal = completePartDurations
    ? partDurations.reduce((total, duration) => total + duration, 0)
    : 0;
  const totalDuration = metadataTotalDuration
    || (completePartDurations ? partDurationTotal : 0)
    || (file.parts.length > 1 && file.duration && file.duration > Math.max(...partDurations, 0)
      ? file.duration
      : 0)
    || (partDurations.reduce((a, b) => a + b, 0) || file.duration || (Number.isFinite(currentVideoDuration) ? currentVideoDuration : 0) || 0);
  const partWeights = completePartDurations
    ? partDurations
    : file.parts.map(part => part.size || 0);
  const partWeightTotal = partWeights.reduce((total, weight) => total + weight, 0);
  const timelinePartDurations = file.parts.map((_, index) => (
    totalDuration > 0
      ? totalDuration * ((partWeights[index] || (partWeightTotal === 0 ? 1 : 0)) / (partWeightTotal || file.parts.length))
      : 0
  ));

  const partStartTime = (isContinuousMode || file.parts.length <= 1) ? 0 : timelinePartDurations.slice(0, activePartIndex).reduce((a, b) => a + b, 0);
  const globalCurrentTime = (isContinuousMode || file.parts.length <= 1) ? localCurrentTime : (partStartTime + localCurrentTime);
  partDurationInfoRef.current = {
    totalDuration,
    currentPartDuration: timelinePartDurations[activePartIndex] || file.duration || 0,
  };

  useEffect(() => {
    if (!client || file.parts.length <= 1) return;
    const firstPart = file.parts[0];
    if (!firstPart) return;

    let cancelled = false;
    const recoverPartMetadata = async () => {
      try {
        const recoveredDurations = file.parts.map(part => part.duration || 0);
        let fullDuration: number | null = null;
        for (let i = 0; i < file.parts.length; i++) {
          const part = file.parts[i];
          if (i > 0 && recoveredDurations[i] > 0 && fullDuration !== null) continue;
          const rawChannel = part.channelId ? String(part.channelId) : 'me';
          const entity = await resolveTelegramEntity(client, rawChannel);
          const message = await fetchMessageUrgent(client, entity, rawChannel, part.messageId);
          if (!message || cancelled) continue;
          const metadata = parseMetadata(message.message);
          const document = message.media?.className === 'MessageMediaDocument' ? message.media.document as any : null;
          const videoAttribute = document?.attributes?.find((attribute: any) => attribute.className === 'DocumentAttributeVideo');
          recoveredDurations[i] = Number(metadata?.dur || videoAttribute?.duration || recoveredDurations[i] || 0);
          const candidateTotal = Number(metadata?.totalDur || 0);
          if (
            candidateTotal > 0
            && (file.parts.length <= 1 || candidateTotal > recoveredDurations[i] * 1.05)
          ) {
            fullDuration = candidateTotal;
          }
        }
        if (cancelled) return;
        const largestKnownPartDuration = Math.max(...recoveredDurations, 0);
        if (
          !fullDuration
          && typeof file.duration === 'number'
          && file.duration > 0
          && (file.parts.length <= 1 || largestKnownPartDuration === 0 || file.duration > largestKnownPartDuration * 1.05)
        ) {
          fullDuration = file.duration;
        }
        if (fullDuration && recoveredDurations.some(duration => duration <= 0)) {
          const totalBytes = file.parts.reduce((sum, part) => sum + (part.size || 0), 0);
          if (totalBytes > 0) {
            for (let i = 0; i < recoveredDurations.length; i++) {
              if (recoveredDurations[i] <= 0) {
                recoveredDurations[i] = fullDuration * ((file.parts[i].size || 0) / totalBytes);
              }
            }
          }
        }
        if (fullDuration) setMetadataTotalDuration(fullDuration);
        if (recoveredDurations.some(duration => duration > 0)) setPartDurations(recoveredDurations);
      } catch (error) {
        if (!cancelled) {
          logger.warn('Video part duration metadata recovery failed', error);
        }
      }
    };

    void recoverPartMetadata();
    return () => {
      cancelled = true;
    };
  }, [client, file.id, file.parts, file.duration]);

  const captureVideoToPreviewUrl = (sourceVideo: HTMLVideoElement): string | null => {
    try {
      if (sourceVideo.videoWidth <= 0 || sourceVideo.videoHeight <= 0) return null;
      let canvas = previewCanvasRef.current;
      if (!canvas) {
        canvas = document.createElement('canvas');
        canvas.width = 160;
        canvas.height = 90;
        previewCanvasRef.current = canvas;
      }
      const ctx = canvas.getContext('2d', { alpha: false });
      if (!ctx) return null;
      ctx.drawImage(sourceVideo, 0, 0, 160, 90);
      return canvas.toDataURL('image/jpeg', 0.68);
    } catch {
      return null;
    }
  };

  const rememberPreviewSnapshot = (partIdx: number | string, timeSec: number, dataUrl: string) => {
    const bucket = Math.round(timeSec);
    const key = `${file.id}_${partIdx}_${bucket}`;
    previewSnapshotCache.current.delete(key);
    previewSnapshotCache.current.set(key, dataUrl);
    while (previewSnapshotCache.current.size > 600) {
      const oldestKey = previewSnapshotCache.current.keys().next().value;
      if (oldestKey === undefined) break;
      previewSnapshotCache.current.delete(oldestKey);
    }
  };

  const isPreviewTimeBuffered = (video: HTMLVideoElement, timeSec: number): boolean => {
    try {
      const b = video.buffered;
      for (let i = 0; i < b.length; i++) {
        if (timeSec >= b.start(i) - 0.08 && timeSec <= b.end(i) + 0.08) {
          return true;
        }
      }
    } catch {}
    return false;
  };

  const applyFastPreviewSeek = (video: HTMLVideoElement, targetTime: number) => {
    const clamped = Math.max(0, targetTime);
    lastPreviewDispatchRef.current = performance.now();
    // If target frame is already in RAM buffer, exact currentTime decodes in ~4ms (silky mini-video scrub!)
    if (isPreviewTimeBuffered(video, clamped)) {
      try {
        video.currentTime = clamped;
        return;
      } catch {}
    }
    // Otherwise snap straight to nearest keyframe via fastSeek (1 chunk instead of decoding 20 P-frames!)
    try {
      if (typeof (video as any).fastSeek === 'function' && Math.abs(video.currentTime - clamped) > 0.35) {
        (video as any).fastSeek(clamped);
        return;
      }
    } catch {}
    try {
      video.currentTime = clamped;
    } catch {}
  };

  const seekPreviewVideo = () => {
    const video = previewVideoRef.current;
    if (!video || isTornDownRef.current) return;
    if (!isContinuousMode && video.dataset.part !== String(previewTargetRef.current.part)) return;
    if (video.readyState < HTMLMediaElement.HAVE_METADATA) return;

    const targetTime = isContinuousMode ? previewTargetRef.current.globalTime : previewTargetRef.current.time;
    if (Math.abs(video.currentTime - targetTime) <= 0.06) return;

    if (video.seeking) {
      pendingPreviewSeekRef.current = targetTime;
      return;
    }
    applyFastPreviewSeek(video, targetTime);
  };

  const handlePreviewSeeked = () => {
    const video = previewVideoRef.current;
    if (!video || isTornDownRef.current) return;

    setHasDecodedPreviewFrame(true);

    // Only JPEG-encode into LRU cache when this 1s bucket isn't cached yet (keeps main thread 60fps during scrubbing!)
    const partIdx = video.dataset.part || '0';
    const bucket = Math.round(video.currentTime);
    const cacheKey = `${file.id}_${partIdx}_${bucket}`;
    if (!previewSnapshotCache.current.has(cacheKey)) {
      const dataUrl = captureVideoToPreviewUrl(video);
      if (dataUrl) {
        rememberPreviewSnapshot(partIdx, video.currentTime, dataUrl);
      }
    }

    if (pendingPreviewSeekRef.current !== null) {
      const nextTime = pendingPreviewSeekRef.current;
      pendingPreviewSeekRef.current = null;
      if (Math.abs(video.currentTime - nextTime) > 0.06) {
        applyFastPreviewSeek(video, nextTime);
      }
    }
  };

  const previewSeekTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const ensurePreviewSourceAndSeek = () => {
    const video = previewVideoRef.current;
    if (!video || isTornDownRef.current) return;
    const target = previewTargetRef.current;
    if (isContinuousMode) {
      const previewSrc = `${src}?preview=true`;
      if (video.dataset.previewSrc !== previewSrc) {
        video.dataset.previewSrc = previewSrc;
        setHasDecodedPreviewFrame(false);
        video.src = previewSrc;
        video.load();
        return;
      }
    } else if (video.dataset.part !== String(target.part) || !video.src) {
      video.dataset.part = String(target.part);
      setHasDecodedPreviewFrame(false);
      video.src = `${src}?part=${target.part}&preview=true`;
      video.load();
      return;
    }
    seekPreviewVideo();
  };

  const schedulePreviewFrame = () => {
    if (previewFrameRef.current !== null) return;
    previewFrameRef.current = requestAnimationFrame(() => {
      previewFrameRef.current = null;
      if (isTornDownRef.current) return;
      const target = previewTargetRef.current;

      // Update tooltip position immediately at 60fps
      setPreviewState({
        opacity: 1,
        left: target.left,
        time: target.globalTime,
        show: true,
      });

      // Zero-debounce 60Hz leading dispatch for fluid frame-by-frame scrubbing on mouse & touch
      const elapsed = performance.now() - lastPreviewDispatchRef.current;
      if (elapsed >= 16) {
        if (previewSeekTimeoutRef.current) {
          clearTimeout(previewSeekTimeoutRef.current);
          previewSeekTimeoutRef.current = null;
        }
        ensurePreviewSourceAndSeek();
      } else if (!previewSeekTimeoutRef.current) {
        previewSeekTimeoutRef.current = setTimeout(() => {
          previewSeekTimeoutRef.current = null;
          ensurePreviewSourceAndSeek();
        }, Math.max(4, 16 - elapsed));
      }
    });
  };

  // Warm up preview metadata right after player mount (reuses main video's cached chunk 0 at zero network cost!)
  useEffect(() => {
    const timer = setTimeout(() => {
      const v = previewVideoRef.current;
      if (v && !v.src && !isTornDownRef.current) {
        v.dataset.part = String(activePartIndex);
        v.src = `${src}?part=${activePartIndex}&preview=true`;
        v.load();
      }
    }, 120);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src]);

  useEffect(() => () => {
    if (previewFrameRef.current !== null) cancelAnimationFrame(previewFrameRef.current);
    if (previewSeekTimeoutRef.current !== null) clearTimeout(previewSeekTimeoutRef.current);
  }, []);

  const togglePlay = () => {
    if (videoRef.current) {
      const nextPlaying = !isPlaying;
      userWantsPlayRef.current = nextPlaying;
      setIsPlaying(nextPlaying);
      if (!nextPlaying) {
        videoRef.current.pause();
      } else {
        setIsSubtitlesMenuOpen(false);
        // Only start playing immediately if the 100% loading gate is already clear
        if (!isWaitingRef.current) {
          videoRef.current.play().catch(() => {});
        }
      }
    }
  };

  const handleTimeUpdate = () => {
    const v = videoRef.current;
    if (!v) return;
    if (v.seeking) return;
    // CRITICAL MOBILE FIX: Never let periodic 250ms timeupdate snap the progress indicator
    // back to the old playback position while the user's finger or mouse is actively scrubbing!
    if (isScrubbingRef.current || swipeStartRef.current?.isHorizontal) return;

    const cur = v.currentTime;
    // Guard: ignore transient 0s while seeking across parts or waiting for initial seek frame
    if (pendingSeek !== null && Math.abs(cur - pendingSeek) > 1.0 && cur < 0.5) {
      return;
    }
    if (pendingFrameTargetRef.current !== null && pendingFrameTargetRef.current > 1.5 && cur < 0.5) {
      return;
    }
    setLocalCurrentTime(cur);
    if (isWaitingRef.current) {
      tryMarkPlaybackReady();
    } else {
      setWaitingState(false);
    }

    // In continuous mode, update activePartIndex dynamically based on playback position
    if (isContinuousMode && file.parts.length > 1) {
      let accumulated = 0;
      let curPart = 0;
      const total = totalDuration || 1;
      for (let i = 0; i < file.parts.length; i++) {
        const pDuration = timelinePartDurations[i] || (total * (file.parts[i].size / (file.size || 1)));
        if (cur >= accumulated && cur < accumulated + pDuration) {
          curPart = i;
          break;
        }
        accumulated += pDuration;
        if (i === file.parts.length - 1) curPart = i;
      }
      if (curPart !== activePartIndex) {
        setActivePartIndex(curPart);
      }
    }

    // Match subtitle cue for uploaded subtitles with millisecond precision
    if (selectedSubtitleTrack.startsWith('uploaded-')) {
      const uploadId = selectedSubtitleTrack.replace('uploaded-', '');
      const currentUpload = uploadedSubtitles.find(u => u.id === uploadId);
      if (currentUpload) {
        const currentMovieTime = ((isContinuousMode || file.parts.length <= 1) ? cur : (partStartTime + cur)) + subtitleOffset;
        const active = currentUpload.cues.find(c => currentMovieTime >= c.start && currentMovieTime <= c.end);
        setActiveSubtitleCueText(active ? active.text : null);
      } else {
        setActiveSubtitleCueText(null);
      }
    } else {
      setActiveSubtitleCueText(null);
    }
  };

  const seekToGlobalTime = (targetGlobalTime: number, isScrubbingUpdate = false) => {
    if (isContinuousMode) {
      const v = videoRef.current;
      if (v) {
        if (!isScrubbingUpdate) {
          const realDur = (Number.isFinite(v.duration) && v.duration > 0) ? v.duration : totalDuration;
          const ahead = getBufferedAheadSeconds(v, targetGlobalTime);
          const nearEnd = realDur > 0 && targetGlobalTime >= Math.max(0, realDur - 2.2);
          if (ahead >= 1.35 || (nearEnd && ahead >= 0.25)) {
            pendingFrameTargetRef.current = null;
            v.currentTime = targetGlobalTime;
            setWaitingState(false);
          } else {
            resetLoadingProgress(0);
            playbackAdvanceBaselineRef.current = null;
            lastSeekCommitAtRef.current = Date.now();
            pendingFrameTargetRef.current = targetGlobalTime;
            setWaitingState(true, true);
            v.currentTime = targetGlobalTime;
          }
        }
        setLocalCurrentTime(targetGlobalTime);
      }
      return;
    }

    let accumulated = 0;
    let targetPart = 0;
    for (let i = 0; i < timelinePartDurations.length; i++) {
      if (accumulated + timelinePartDurations[i] >= targetGlobalTime || i === timelinePartDurations.length - 1) {
        targetPart = i;
        break;
      }
      accumulated += timelinePartDurations[i];
    }
    const targetLocalTime = Math.max(0, targetGlobalTime - accumulated);

    if (targetPart !== activePartIndex) {
      if (isScrubbingUpdate) {
        const currentPartStart = timelinePartDurations.slice(0, activePartIndex).reduce((a, b) => a + b, 0);
        setLocalCurrentTime(targetGlobalTime - currentPartStart);
        return;
      }

      // Freeze current frame so transition to the next part never flashes frame 0
      if (videoRef.current && videoRef.current.videoWidth > 0 && videoRef.current.readyState >= 2) {
        try {
          const canvas = document.createElement('canvas');
          canvas.width = videoRef.current.videoWidth;
          canvas.height = videoRef.current.videoHeight;
          const ctx = canvas.getContext('2d');
          if (ctx) {
            ctx.drawImage(videoRef.current, 0, 0, canvas.width, canvas.height);
            setFreezeFrameUrl(canvas.toDataURL('image/jpeg', 0.85));
          }
        } catch (_) {}
      }

      // Preempt any in-flight downloads from previous parts without killing the upcoming part
      window.dispatchEvent(new CustomEvent('cancelStream', {
        detail: { fileId: file.id, reason: 'part-switch', excludePart: targetPart }
      }));

      resetLoadingProgress(0);
      playbackAdvanceBaselineRef.current = null;
      lastSeekCommitAtRef.current = Date.now();
      setWaitingState(true, true);
      pendingFrameTargetRef.current = targetLocalTime;
      setActivePartIndex(targetPart);
      setActivePartUrl(`${src}?part=${targetPart}#t=${targetLocalTime}`);
      setPendingSeek(targetLocalTime);
      setLocalCurrentTime(targetLocalTime);
    } else {
      const v = videoRef.current;
      if (v) {
        if (!isScrubbingUpdate) {
          const realDur = (Number.isFinite(v.duration) && v.duration > 0)
            ? v.duration
            : (timelinePartDurations[activePartIndex] || file.duration || 0);
          const ahead = getBufferedAheadSeconds(v, targetLocalTime);
          const nearEnd = realDur > 0 && targetLocalTime >= Math.max(0, realDur - 2.2);
          if (ahead >= 1.35 || (nearEnd && ahead >= 0.25)) {
            pendingFrameTargetRef.current = null;
            v.currentTime = targetLocalTime;
            setWaitingState(false); // Already buffered: zero loader flash or 0% reset
          } else {
            resetLoadingProgress(0);
            playbackAdvanceBaselineRef.current = null;
            lastSeekCommitAtRef.current = Date.now();
            pendingFrameTargetRef.current = targetLocalTime;
            setWaitingState(true, true);
            v.currentTime = targetLocalTime;
          }
        }
        setLocalCurrentTime(targetLocalTime);
      }
    }
  };

  const skipTime = (amount: number) => {
    if (!totalDuration) return;
    seekToGlobalTime(Math.max(0, Math.min(totalDuration, globalCurrentTime + amount)));
  };

  const isScrubbingRef = React.useRef(false);
  const [isScrubbing, setIsScrubbing] = useState(false);

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!totalDuration) return;
    e.preventDefault();
    isScrubbingRef.current = true;
    setIsScrubbing(true);
    setIsHovered(true);
    setIsProgressHovered(true);
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch (_) {}
    const bounds = e.currentTarget.getBoundingClientRect();
    const percent = Math.max(0, Math.min(1, (e.clientX - bounds.left) / bounds.width));
    showPreviewAt(e.clientX, bounds);
    seekToGlobalTime(percent * totalDuration, true);
  };

  const handlePointerMoveProgress = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!totalDuration) return;
    if (isScrubbingRef.current) {
      e.preventDefault();
      setIsHovered(true);
    }
    const bounds = e.currentTarget.getBoundingClientRect();
    const percent = Math.max(0, Math.min(1, (e.clientX - bounds.left) / bounds.width));
    
    showPreviewAt(e.clientX, bounds);
    
    if (isScrubbingRef.current) {
      seekToGlobalTime(percent * totalDuration, true);
    }
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const wasScrubbing = isScrubbingRef.current;
    isScrubbingRef.current = false;
    setIsScrubbing(false);
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch (_) {}
    if (e.pointerType !== 'mouse') {
      setIsProgressHovered(false);
    }
    handleMouseLeaveProgress();
    
    if (!totalDuration || !wasScrubbing) return;
    // On mobile pointercancel, clientX can be 0 — commit the last valid preview target instead of snapping to 0!
    if (e.type === 'pointercancel') {
      seekToGlobalTime(previewTargetRef.current.globalTime, false);
      return;
    }
    const bounds = e.currentTarget.getBoundingClientRect();
    const percent = Math.max(0, Math.min(1, (e.clientX - bounds.left) / bounds.width));
    seekToGlobalTime(percent * totalDuration, false);
  };

  const showPreviewForGlobalTime = (targetGlobalTime: number, rawLeftPx: number, barWidth: number) => {
    if (!totalDuration) return;
    const clampedGlobal = Math.max(0, Math.min(totalDuration, targetGlobalTime));
    const safeLeft = barWidth > 168
      ? Math.max(84, Math.min(barWidth - 84, rawLeftPx))
      : Math.max(0, barWidth / 2);

    let accumulated = 0;
    let targetPart = 0;
    for (let i = 0; i < timelinePartDurations.length; i++) {
      if (accumulated + timelinePartDurations[i] >= clampedGlobal || i === timelinePartDurations.length - 1) {
        targetPart = i;
        break;
      }
      accumulated += timelinePartDurations[i];
    }
    const targetLocalTime = Math.max(0, clampedGlobal - accumulated);

    const bucket = Math.round(targetLocalTime);
    const exactKey = `${file.id}_${targetPart}_${bucket}`;
    let hitUrl = previewSnapshotCache.current.get(exactKey) || null;

    // Tier 0B: Instant live capture from main <video> if hovering right around current playback frame!
    if (!hitUrl && targetPart === activePartIndex && videoRef.current && videoRef.current.readyState >= 2) {
      if (Math.abs(videoRef.current.currentTime - targetLocalTime) <= 0.8) {
        const liveDataUrl = captureVideoToPreviewUrl(videoRef.current);
        if (liveDataUrl) {
          rememberPreviewSnapshot(targetPart, targetLocalTime, liveDataUrl);
          hitUrl = liveDataUrl;
        }
      }
    }

    // Never blink/hide <video ref={previewVideoRef}> once decoded! Only update the fallback backdrop image
    // when we have a better cached frame or before the part's first frame has decoded.
    if (hitUrl) {
      setActiveSnapshotUrl(hitUrl);
    } else if (!hasDecodedPreviewFrame) {
      let neighborUrl: string | null = null;
      for (const delta of [1, -1, 2, -2, 3, -3, 5, -5, 8, -8]) {
        const nb = previewSnapshotCache.current.get(`${file.id}_${targetPart}_${bucket + delta}`);
        if (nb) {
          neighborUrl = nb;
          break;
        }
      }
      if (neighborUrl) {
        setActiveSnapshotUrl(neighborUrl);
      } else {
        const part = file.parts[targetPart] || file.parts[0];
        if (part) {
          const channel = part.channelId ? `${part.channelId}_` : '';
          const thumbPath = `/thumb/${encodeURIComponent(`${channel}${part.messageId}`)}?v=${file.date || 0}`;
          setActiveSnapshotUrl(getThumbMemoryUrl(thumbPath) || thumbPath);
        }
      }
    }

    previewTargetRef.current = {
      part: targetPart,
      time: targetLocalTime,
      left: safeLeft,
      globalTime: clampedGlobal,
    };
    schedulePreviewFrame();
  };

  const showPreviewAt = (clientX: number, bounds: DOMRect) => {
    if (!totalDuration || bounds.width <= 0) return;
    const percent = Math.max(0, Math.min(1, (clientX - bounds.left) / bounds.width));
    showPreviewForGlobalTime(percent * totalDuration, percent * bounds.width, bounds.width);
  };

  const handleVideoTouchStart = (e: React.TouchEvent<HTMLVideoElement>) => {
    if (e.touches.length !== 1) return;
    swipeStartRef.current = {
      x: e.touches[0].clientX,
      y: e.touches[0].clientY,
      time: Date.now(),
      startGlobalTime: globalCurrentTime
    };
  };

  const handleVideoTouchMove = (e: React.TouchEvent<HTMLVideoElement>) => {
    if (!swipeStartRef.current || !totalDuration || e.touches.length !== 1) return;
    const dx = e.touches[0].clientX - swipeStartRef.current.x;
    const dy = e.touches[0].clientY - swipeStartRef.current.y;

    if (swipeStartRef.current.isHorizontal === undefined) {
      if (Math.abs(dx) > 10 || Math.abs(dy) > 10) {
        swipeStartRef.current.isHorizontal = Math.abs(dx) > Math.abs(dy);
      }
    }

    if (!swipeStartRef.current.isHorizontal) return;

    setIsHovered(true);
    setIsProgressHovered(true);
    const width = window.innerWidth || 360;
    const scrubSpan = Math.min(totalDuration, Math.max(60, totalDuration * 0.25));
    const skipAmount = (dx / width) * scrubSpan;
    const targetGlobal = Math.max(0, Math.min(totalDuration, swipeStartRef.current.startGlobalTime + skipAmount));
    const trackBounds = progressTrackRef.current?.getBoundingClientRect();
    const barWidth = trackBounds?.width || Math.max(200, width - 24);
    const pct = totalDuration > 0 ? targetGlobal / totalDuration : 0;
    showPreviewForGlobalTime(targetGlobal, pct * barWidth, barWidth);
    seekToGlobalTime(targetGlobal, true);
  };

  const handleVideoTouchEnd = (e: React.TouchEvent<HTMLVideoElement>) => {
    if (!swipeStartRef.current) return;
    const dx = e.changedTouches[0].clientX - swipeStartRef.current.x;
    const isHorizontal = swipeStartRef.current.isHorizontal;
    const startGlobalTime = swipeStartRef.current.startGlobalTime;
    swipeStartRef.current = null;
    setIsProgressHovered(false);
    handleMouseLeaveProgress();

    if (!isHorizontal) {
      if (Math.abs(dx) < 10) {
        togglePlay();
      }
      return;
    }

    if (totalDuration) {
      const width = window.innerWidth || 360;
      const scrubSpan = Math.min(totalDuration, Math.max(60, totalDuration * 0.25));
      const skipAmount = (dx / width) * scrubSpan;
      seekToGlobalTime(Math.max(0, Math.min(totalDuration, startGlobalTime + skipAmount)), false);
    }
  };

  const handleMouseLeaveProgress = () => {
    if (previewFrameRef.current !== null) {
      cancelAnimationFrame(previewFrameRef.current);
      previewFrameRef.current = null;
    }
    if (previewSeekTimeoutRef.current !== null) {
      clearTimeout(previewSeekTimeoutRef.current);
      previewSeekTimeoutRef.current = null;
    }
    setPreviewState(prev => ({ ...prev, opacity: 0, show: false }));
  };

  const handleLoadedMetadata = (e: React.SyntheticEvent<HTMLVideoElement>) => {
    const d = e.currentTarget.duration;
    const playbackDuration = Number.isFinite(d) && d > 0 ? d : (file.duration || 0);
    if (!isContinuousMode || file.parts.length <= 1) {
      const currentPartSize = file.parts[activePartIndex]?.size || 1;
      const bytesPerSecond = currentPartSize / (playbackDuration || 1);
      setPartDurations(previous => {
        const next = [...previous];
        next[activePartIndex] = playbackDuration;
        for (let i = 0; i < file.parts.length; i++) {
          if (i !== activePartIndex && next[i] === 0) {
            next[i] = file.parts[i].size / bytesPerSecond;
          }
        }
        return next;
      });
    } else if (isContinuousMode && file.parts.length > 1 && playbackDuration > 0) {
      const totalBytes = file.parts.reduce((sum, part) => sum + (part.size || 0), 0) || 1;
      setPartDurations(file.parts.map(p => (p.size / totalBytes) * playbackDuration));
    }

    if (pendingSeek !== null) {
      // If the browser natively handled `#t=`, currentTime will already be set.
      // We only manually seek if it's way off, preventing a double-seek interrupt.
      if (Math.abs(e.currentTarget.currentTime - pendingSeek) > 0.5) {
        e.currentTarget.currentTime = pendingSeek;
      }
      pendingFrameTargetRef.current = pendingSeek;
      setPendingSeek(null);
      if (isPlaying || resumeAfterPartChangeRef.current) {
        resumeAfterPartChangeRef.current = true;
      }
    }

    // Detect embedded subtitle tracks and restore selection
    const video = e.currentTarget;
    if (video.textTracks && video.textTracks.length > 0) {
      const embedded: EmbeddedSubtitleTrack[] = [];
      for (let i = 0; i < video.textTracks.length; i++) {
        const track = video.textTracks[i];
        if (!track.label.startsWith('__custom_')) {
          embedded.push({
            index: i,
            label: track.label || track.language || `Subtitle Track ${i + 1}`,
            language: track.language || 'und',
            kind: track.kind || 'subtitles'
          });
        }
      }
      setEmbeddedSubtitles(embedded);

      // Restore user's preferred embedded subtitle if one was selected
      const prefSub = preferredSubRef.current;
      if (prefSub && prefSub.type === 'embedded') {
        let matchIdx = -1;
        if (prefSub.language && prefSub.language !== 'und') {
          matchIdx = embedded.findIndex(t => t.language === prefSub.language);
        }
        if (matchIdx === -1 && prefSub.label) {
          matchIdx = embedded.findIndex(t => t.label === prefSub.label);
        }
        if (matchIdx === -1 && prefSub.index !== undefined && prefSub.index < embedded.length) {
          matchIdx = prefSub.index;
        }
        if (matchIdx !== -1) {
          for (let i = 0; i < video.textTracks.length; i++) {
            video.textTracks[i].mode = (i === matchIdx) ? 'showing' : 'disabled';
          }
          setSelectedSubtitleTrack(`embedded-${matchIdx}`);
        }
      }
    }

  };

  const selectSubtitleTrack = (trackId: string) => {
    const video = videoRef.current;
    if (trackId.startsWith('embedded-') && (!video?.textTracks || video.textTracks.length === 0)) {
      setSubtitleToast('This browser cannot expose embedded MKV subtitles directly. Load an SRT or VTT subtitle file.');
      setTimeout(() => setSubtitleToast(null), 3500);
      setIsSubtitlesMenuOpen(false);
      return;
    }
    setSelectedSubtitleTrack(trackId);
    if (trackId !== 'off') {
      lastSubtitleTrackRef.current = trackId;
    }
    if (video && video.textTracks) {
      for (let i = 0; i < video.textTracks.length; i++) {
        const t = video.textTracks[i];
        if (trackId === `embedded-${i}`) {
          t.mode = 'showing';
        } else {
          t.mode = 'disabled';
        }
      }
    }
    if (trackId.startsWith('embedded-')) {
      const idx = parseInt(trackId.replace('embedded-', ''), 10);
      const track = embeddedSubtitles[idx];
      preferredSubRef.current = {
        type: 'embedded',
        language: track?.language || '',
        label: track?.label || '',
        index: idx
      };
    } else if (trackId.startsWith('uploaded-')) {
      preferredSubRef.current = {
        type: 'uploaded',
        id: trackId.replace('uploaded-', '')
      };
    } else {
      preferredSubRef.current = { type: 'off' };
    }

    if (!trackId.startsWith('uploaded-')) {
      setActiveSubtitleCueText(null);
    }
    setIsSubtitlesMenuOpen(false);
  };

  const loadSubtitleContent = (content: string, name: string) => {
    const cues = parseSRT(content);
    if (!cues.length) return;
    const id = Math.random().toString(36).substring(2, 9);
    let vttUrl: string | undefined;
    try {
      const vttData = srtToWebVtt(content);
      const vttBlob = new Blob([vttData], { type: 'text/vtt' });
      vttUrl = URL.createObjectURL(vttBlob);
    } catch (err) {
      console.warn("Could not create WebVTT blob url", err);
    }

    const newSub = {
      id,
      name,
      cues,
      vttUrl
    };

    setUploadedSubtitles(prev => [...prev, newSub]);
    selectSubtitleTrack(`uploaded-${id}`);
    setSubtitleToast(`Subtitle "${name}" loaded successfully`);
    setTimeout(() => setSubtitleToast(null), 3500);
  };

  const handleSubtitleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const uploadedFile = e.target.files?.[0];
    if (!uploadedFile) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      const content = event.target?.result as string;
      if (content) {
        loadSubtitleContent(content, uploadedFile.name);
      }
    };
    reader.readAsText(uploadedFile);
    e.target.value = '';
  };

  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current++;
    if (e.dataTransfer.items && e.dataTransfer.items.length > 0) {
      setIsDraggingSubtitle(true);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current--;
    if (dragCounterRef.current <= 0) {
      dragCounterRef.current = 0;
      setIsDraggingSubtitle(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current = 0;
    setIsDraggingSubtitle(false);

    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      const droppedFiles = Array.from(e.dataTransfer.files);
      const subFile = droppedFiles.find(f => {
        const lower = f.name.toLowerCase();
        return lower.endsWith('.srt') || lower.endsWith('.vtt') || lower.endsWith('.txt');
      });
      if (subFile) {
        const reader = new FileReader();
        reader.onload = (event) => {
          const content = event.target?.result as string;
          if (content) {
            loadSubtitleContent(content, subFile.name);
          }
        };
        reader.readAsText(subFile);
      }
    }
  };

  const handleEnded = () => {
    if (isContinuousMode) {
      userWantsPlayRef.current = false;
      setIsPlaying(false);
      return;
    }
    if (activePartIndex < file.parts.length - 1) {
      resumeAfterPartChangeRef.current = true;
      userWantsPlayRef.current = true;
      resetLoadingProgress(0);
      playbackAdvanceBaselineRef.current = null;
      lastSeekCommitAtRef.current = Date.now();
      pendingFrameTargetRef.current = 0;
      setActivePartIndex(activePartIndex + 1);
      setActivePartUrl(`${src}?part=${activePartIndex + 1}`);
      setPendingSeek(0);
      setWaitingState(true, true);
      setLocalCurrentTime(0);
    } else {
      userWantsPlayRef.current = false;
      setIsPlaying(false);
    }
  };

  const toggleMute = () => {
    if (videoRef.current) {
      videoRef.current.muted = !isMuted;
      setIsMuted(!isMuted);
    }
  };

  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.volume = volume;
      videoRef.current.muted = isMuted;
    }
  }, [activePartIndex, volume, isMuted]);

  const toggleFullscreen = () => {
    if (videoRef.current) {
      const container = videoRef.current.parentElement;
      if (document.fullscreenElement) {
        document.exitFullscreen();
      } else {
        if (container?.requestFullscreen) {
          container.requestFullscreen();
        } else if ((videoRef.current as any).webkitEnterFullscreen) {
          (videoRef.current as any).webkitEnterFullscreen(); // iOS fallback
        }
      }
    }
  };

  const formatTime = (time: number) => {
    if (!time || isNaN(time)) return '0:00';
    const mins = Math.floor(time / 60);
    const secs = Math.floor(time % 60);
    return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
  };

  return (
    <div 
      className="relative w-full h-full sm:h-auto sm:aspect-video sm:max-w-6xl sm:rounded-2xl overflow-hidden shadow-2xl bg-black group flex justify-center items-center transform-gpu will-change-transform"
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <video
        key={file.id}
        ref={videoRef}
        src={activePartUrl}
        className="w-full h-full object-contain bg-black outline-none"
        onTimeUpdate={handleTimeUpdate}
        onLoadedMetadata={handleLoadedMetadata}
        onLoadedData={() => {
          const target = pendingFrameTargetRef.current;
          if (target !== null && target > 0.5) {
            setWaitingState(true, true);
          } else {
            tryMarkPlaybackReady();
          }
        }}
        onSeeked={() => {
          const v = videoRef.current;
          if (!v) return;
          const target = pendingFrameTargetRef.current;
          if (target !== null && target > 1.0 && v.currentTime < 0.5) {
            return;
          }
          playbackAdvanceBaselineRef.current = { time: v.currentTime, ts: performance.now() };
          if (resumeAfterPartChangeRef.current) {
            resumeAfterPartChangeRef.current = false;
            userWantsPlayRef.current = true;
          }
          // Strict 100% gate: only start playing once readiness + 100% progress are reached
          tryMarkPlaybackReady();
        }}
        onCanPlayThrough={() => {
          if (isWaitingRef.current) {
            tryMarkPlaybackReady();
          } else if (userWantsPlayRef.current && videoRef.current?.paused && !videoRef.current.ended) {
            videoRef.current.play().catch(() => {});
          }
        }}
        onEnded={handleEnded}
        onPlay={(e) => {
          // Enforce strict 100% gate: never allow premature playback while progress is < 100%
          if (isWaitingRef.current && !isTornDownRef.current) {
            try { e.currentTarget.pause(); } catch {}
            return;
          }
          userWantsPlayRef.current = true;
          setIsPlaying(true);
        }}
        onPause={() => {
          // Ignore internal buffer-gate pauses so the Play/Pause button never flickers while loading
          if (!isWaitingRef.current && !isTornDownRef.current) {
            setIsPlaying(false);
          }
        }}
        onSeeking={(e) => {
          const v = e.currentTarget;
          playbackAdvanceBaselineRef.current = null;
          const realDur = (Number.isFinite(v.duration) && v.duration > 0)
            ? v.duration
            : (partDurationInfoRef.current.currentPartDuration || partDurationInfoRef.current.totalDuration || 0);
          const ahead = getBufferedAheadSeconds(v);
          const nearEnd = realDur > 0 && v.currentTime >= Math.max(0, realDur - 1.8);
          if (ahead >= 0.6 || (nearEnd && ahead >= 0.15)) {
            setWaitingState(true, false);
          } else {
            setWaitingState(true, true);
          }
        }}
        onPlaying={() => {
          const target = pendingFrameTargetRef.current;
          const v = videoRef.current;
          if (target !== null && target > 1.5 && v && v.currentTime < 0.5) {
            return;
          }
          tryMarkPlaybackReady();
        }}
        onWaiting={() => setWaitingState(true, false)}
        onCanPlay={() => {
          if (pendingSeek !== null && videoRef.current) {
            try {
              if (Math.abs(videoRef.current.currentTime - pendingSeek) > 0.5) {
                videoRef.current.currentTime = pendingSeek;
              }
            } catch (_) {}
            setPendingSeek(null);
          }
          if (isWaitingRef.current) {
            tryMarkPlaybackReady();
          } else if (userWantsPlayRef.current && videoRef.current?.paused && !videoRef.current.ended) {
            videoRef.current.play().catch(() => {});
          }
        }}
        onClick={togglePlay}
        onTouchStart={handleVideoTouchStart}
        onTouchMove={handleVideoTouchMove}
        onTouchEnd={handleVideoTouchEnd}
        playsInline
        preload="auto"
        onError={(e) => {
          console.error("Video playback error:", e);
          const isMkv = file.name.toLowerCase().endsWith('.mkv') || file.mimeType.includes('matroska');
          setVideoPlaybackError({
            message: isMkv 
              ? 'This MKV cannot be played directly in this browser. The container or one of its codecs is unsupported.'
              : 'The video could not be loaded or decoded by this browser.',
            isMkv
          });
        }}
      >
      </video>

      {/* Seamless cross-part freeze frame */}
      {freezeFrameUrl && (
        <img 
          src={freezeFrameUrl} 
          alt="" 
          className="absolute inset-0 w-full h-full object-contain pointer-events-none z-10" 
        />
      )}

      {/* Video Playback Error Overlay */}
      {videoPlaybackError && (
        <div className="absolute inset-0 z-40 flex flex-col items-center justify-center bg-black/90 backdrop-blur-md p-6 text-center text-white animate-in fade-in duration-200">
          <div className="w-16 h-16 rounded-2xl bg-amber-500/20 text-amber-400 flex items-center justify-center mb-4 ring-8 ring-amber-500/10">
            <AlertCircle className="w-8 h-8" />
          </div>
          <h3 className="text-lg sm:text-xl font-bold mb-2">
            Direct browser playback is unavailable
          </h3>
          <p className="text-sm text-gray-300 max-w-md mb-6 leading-relaxed">
            {videoPlaybackError.message}
          </p>
          <div className="flex flex-wrap items-center justify-center gap-3">
            {onDownload && (
              <button
                type="button"
                onClick={onDownload}
                className="px-5 py-2.5 bg-blue-600 hover:bg-blue-500 active:scale-95 text-white font-medium rounded-xl transition-all shadow-lg shadow-blue-600/30 flex items-center gap-2 text-sm"
              >
                <Download className="w-4 h-4" />
                Download & Play in External Player (VLC / KMPlayer)
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              className="px-5 py-2.5 bg-white/10 hover:bg-white/20 active:scale-95 text-gray-200 font-medium rounded-xl transition-all border border-white/10 text-sm"
            >
              Close
            </button>
          </div>
        </div>
      )}

      {/* Subtitle Cue Overlay (Vazirmatn Persian styling + crisp backdrop) */}
      {activeSubtitleCueText && (
        <div 
          className={`absolute bottom-16 sm:bottom-20 left-1/2 -translate-x-1/2 px-4 py-2 text-white font-['Vazirmatn'] font-semibold rounded-xl text-center max-w-[90%] sm:max-w-[80%] pointer-events-none drop-shadow-2xl z-25 whitespace-pre-line dir-auto leading-relaxed select-none ${subtitleBackground ? 'bg-black/85 backdrop-blur-sm border border-white/15' : ''}`}
          style={{ fontSize: `${subtitleFontSize}px`, textShadow: '0 2px 4px rgba(0,0,0,0.9)' }}
        >
          {activeSubtitleCueText}
        </div>
      )}

      {/* Subtitle Drag & Drop Overlay */}
      {isDraggingSubtitle && (
        <div className="absolute inset-0 z-50 flex flex-col items-center justify-center bg-black/85 backdrop-blur-md border-2 border-dashed border-blue-500 rounded-2xl animate-in fade-in duration-200 pointer-events-none p-6 text-center">
          <div className="w-16 h-16 sm:w-20 sm:h-20 rounded-2xl bg-blue-500/20 text-blue-400 flex items-center justify-center mb-4 ring-8 ring-blue-500/10 animate-bounce">
            <Subtitles className="w-8 h-8 sm:w-10 sm:h-10" />
          </div>
          <h3 className="text-lg sm:text-xl font-bold text-white mb-1">
            Drop Subtitle File
          </h3>
          <p className="text-xs sm:text-sm text-gray-300">
            Drop an SRT or VTT file here to add it to this video
          </p>
          <div className="mt-3 inline-flex items-center gap-2 px-3 py-1 rounded-full bg-blue-500/20 border border-blue-500/30 text-blue-300 text-xs font-mono">
            <span>.srt</span>
            <span>•</span>
            <span>.vtt</span>
          </div>
        </div>
      )}

      {/* Toast Notification */}
      {subtitleToast && (
        <div className="absolute top-16 left-1/2 -translate-x-1/2 bg-blue-600/95 text-white text-xs sm:text-sm font-medium px-4 py-2 rounded-full shadow-2xl backdrop-blur-md flex items-center gap-2 animate-in fade-in slide-in-from-top-3 duration-250 z-50 border border-white/20 select-none">
          <Check className="w-4 h-4 text-white shrink-0" />
          <span>{subtitleToast}</span>
        </div>
      )}
      
      {/* Top Controls Overlay */}
      <div className={`absolute top-0 left-0 right-0 p-4 sm:p-6 pt-[max(1rem,env(safe-area-inset-top,0px))] pl-[max(1rem,env(safe-area-inset-left,0px))] pr-[max(1rem,env(safe-area-inset-right,0px))] bg-gradient-to-b from-black/80 to-transparent transition-opacity duration-300 flex items-center justify-between ${isHovered || isProgressHovered || !isPlaying || isWaiting ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'} z-20`}>
        <button
          onClick={onClose} 
          className="flex items-center gap-2 text-white/90 hover:text-white hover:bg-white/10 px-3 py-2 rounded-xl transition-colors backdrop-blur-sm active:scale-95"
          aria-label="Back to folder"
        >
          <ArrowLeft className="w-6 h-6" />
          <span className="font-medium text-sm hidden sm:block">Back to folder</span>
        </button>

        <div className="flex items-center gap-2 max-w-[60%] justify-end">
          <span className="font-medium text-white/90 text-xs sm:text-sm truncate drop-shadow">{file.name}</span>
          {file.parts && file.parts.length > 1 && (
            <span className="px-2 py-0.5 rounded-full bg-blue-500/20 text-blue-400 border border-blue-500/30 text-[11px] font-mono shrink-0">
              Part {activePartIndex + 1}/{file.parts.length}
            </span>
          )}
        </div>
      </div>
      
      {/* Percentage Loading Text with sleek subtle pill */}
      {isWaiting && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 pointer-events-none z-30 animate-in fade-in duration-150 select-none">
          <MediaLoadingText />
          <div className="px-3 py-0.5 rounded-full bg-black/60 backdrop-blur-md border border-white/10 shadow-lg flex items-center justify-center">
            <span className="text-white font-mono text-xs sm:text-sm font-bold tracking-wider">
              {Math.floor(downloadProgress)}%
            </span>
          </div>
        </div>
      )}
      
      {/* Controls Overlay */}
      <div className={`absolute bottom-0 left-0 right-0 p-3 sm:p-6 pb-[max(1.25rem,calc(0.75rem+env(safe-area-inset-bottom,0px)))] pl-[max(0.75rem,env(safe-area-inset-left,0px))] pr-[max(0.75rem,env(safe-area-inset-right,0px))] bg-gradient-to-t from-black/95 via-black/70 to-transparent transition-opacity duration-300 flex flex-col gap-2 sm:gap-4 ${isHovered || isProgressHovered || !isPlaying || isWaiting ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'} z-20`}>
        
        {/* Preview Tooltip (60fps GPU translate3d + live frame-by-frame mini-video scrub) */}
        <div 
          className="absolute bottom-[88px] sm:bottom-[80px] left-0 w-[160px] flex flex-col items-center pointer-events-none transition-opacity duration-150 will-change-transform"
          style={{ transform: `translate3d(${Math.round(previewState.left - 80)}px, 0, 0)`, opacity: previewState.opacity }}
        >
          <div className={`w-full aspect-video bg-black/90 rounded-lg overflow-hidden border border-white/25 shadow-2xl relative mb-2 ${previewState.show ? '' : 'invisible'}`}>
            {activeSnapshotUrl && !hasDecodedPreviewFrame && (
              <img 
                src={activeSnapshotUrl} 
                alt="" 
                className="absolute inset-0 w-full h-full object-cover z-0 filter brightness-95" 
              />
            )}
            <video
              ref={previewVideoRef}
              className={`w-full h-full object-cover relative z-10 ${hasDecodedPreviewFrame ? 'opacity-100' : 'opacity-0'}`}
              muted
              playsInline
              preload="auto"
              onLoadedMetadata={seekPreviewVideo}
              onSeeked={handlePreviewSeeked}
            />
            <div className="absolute bottom-1 left-0 right-0 text-center text-xs font-bold text-white drop-shadow-md bg-black/55 py-0.5 z-20">
              {formatTime(previewState.time)}
            </div>
          </div>
        </div>

        {/* Segmented Progress Bar (generous mobile touch hit-area + zero-snap-back scrubbing) */}
        <div 
          ref={progressTrackRef}
          className="relative w-full py-4 -my-4 sm:py-2.5 sm:-my-2.5 cursor-pointer flex items-center group/progress touch-none select-none"
          onPointerEnter={() => setIsProgressHovered(true)}
          onPointerLeave={() => {
            if (isScrubbingRef.current) return;
            setIsProgressHovered(false);
            handleMouseLeaveProgress();
          }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMoveProgress}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
        >
          {/* Progress Bar Track */}
          <div className={`relative w-full ${isScrubbing ? 'h-2 sm:h-2.5' : 'h-1.5 group-hover/progress:h-2 sm:h-1.5 sm:group-hover/progress:h-2.5'} transition-all bg-white/20 rounded-full flex gap-1`}>
            {/* Segments Container */}
            <div className="absolute inset-0 flex gap-1 overflow-hidden rounded-full">
              {file.parts.map((_, i) => {
                const partStartPercent = totalDuration > 0 ? (timelinePartDurations.slice(0, i).reduce((a, b) => a + b, 0) / totalDuration) : (i / file.parts.length);
                const partEndPercent = totalDuration > 0 ? (partStartPercent + (timelinePartDurations[i] / totalDuration)) : ((i + 1) / file.parts.length);
                const currentPercent = totalDuration > 0 ? (globalCurrentTime / totalDuration) : 0;
                
                let fillPercent = 0;
                if (currentPercent >= partEndPercent) fillPercent = 100;
                else if (currentPercent > partStartPercent) fillPercent = ((currentPercent - partStartPercent) / (partEndPercent - partStartPercent)) * 100;

                return (
                  <div key={i} style={{ flex: timelinePartDurations[i] || 1 }} className="h-full bg-white/20 relative">
                    <div 
                      className={`absolute top-0 left-0 h-full bg-[#9A2227] ${isScrubbing ? '' : 'transition-all duration-75'}`}
                      style={{ width: `${fillPercent}%` }}
                    />
                  </div>
                );
              })}
            </div>
            
            {/* Knob */}
            <div 
              className={`absolute top-1/2 -translate-y-1/2 w-4 h-4 sm:w-3.5 sm:h-3.5 bg-white rounded-full shadow-lg ${isScrubbing || isProgressHovered ? 'opacity-100 scale-110' : 'opacity-0 group-hover/progress:opacity-100'} transition-opacity pointer-events-none z-10`}
              style={{ left: `max(0%, min(calc(${totalDuration > 0 ? (globalCurrentTime / totalDuration) * 100 : 0}% - 8px), calc(100% - 16px)))` }}
            />
          </div>
        </div>

        {/* Buttons */}
        <div className="flex items-center justify-between text-white w-full">
          <div className="flex items-center gap-3 sm:gap-6">
            <div className="hidden sm:flex items-center gap-2">
              <button onClick={() => skipTime(-10)} className="hover:text-[#9A2227] transition-colors shrink-0">
                <Rewind className="w-5 h-5" />
              </button>
            </div>
            <button onClick={togglePlay} className="hover:text-[#9A2227] transition-colors shrink-0">
              {isPlaying ? <Pause className="w-6 h-6 sm:w-7 sm:h-7" /> : <Play className="w-6 h-6 sm:w-7 sm:h-7 ml-0.5 sm:ml-1" />}
            </button>
            <div className="hidden sm:flex items-center gap-2">
              <button onClick={() => skipTime(10)} className="hover:text-[#9A2227] transition-colors shrink-0">
                <FastForward className="w-5 h-5" />
              </button>
            </div>
            
            <div className="hidden sm:flex items-center gap-3 shrink-0">
              <button onClick={toggleMute} className="hover:text-[#9A2227] transition-colors">
                {isMuted ? <VolumeX size={24} /> : <Volume2 size={24} />}
              </button>
              <input 
                type="range" 
                min="0" max="1" step="0.05" 
                value={isMuted ? 0 : volume}
                onChange={(e) => {
                  const val = parseFloat(e.target.value);
                  setVolume(val);
                  if (videoRef.current) videoRef.current.volume = val;
                  if (val > 0 && isMuted) setIsMuted(false);
                }}
                className="w-24 h-1.5 accent-[#9A2227] rounded-full bg-white/30"
              />
            </div>

            <span className="text-xs sm:text-sm font-medium tabular-nums opacity-80 shrink-0">
              {formatTime(globalCurrentTime)} / {formatTime(totalDuration)}
            </span>
          </div>

          <div className="flex items-center gap-2 sm:gap-4 max-w-[50%] justify-end">
            <h3 className="hidden sm:block text-sm font-medium opacity-80 truncate" title={file.name}>{file.name} {file.parts.length > 1 ? `(Part ${activePartIndex + 1}/${file.parts.length})` : ''}</h3>

            {/* Subtitles Button & Popover */}
            <div className="relative">
              <button
                type="button"
                onClick={() => setIsSubtitlesMenuOpen(prev => !prev)}
                className={`p-1.5 rounded-lg transition-colors shrink-0 ${
                  selectedSubtitleTrack !== 'off'
                    ? 'text-blue-400 bg-blue-500/20'
                    : 'text-white hover:text-[#9A2227]'
                }`}
                title="Subtitles"
                aria-label="Subtitles"
              >
                <Subtitles className="w-5 h-5 sm:w-6 sm:h-6" />
              </button>

              {isSubtitlesMenuOpen && (
                <div 
                  className="subtitle-settings-menu absolute bottom-full right-0 mb-3 w-[min(20rem,calc(100vw-2rem))] bg-[#141416]/95 border border-white/10 rounded-2xl p-2.5 shadow-[0_16px_40px_rgba(0,0,0,0.7)] backdrop-blur-xl z-50 text-white select-none transition-all"
                  onClick={e => e.stopPropagation()}
                >
                  {/* Header with Title & Master Toggle */}
                  <div className="flex items-center justify-between px-3 py-2 rounded-xl bg-gradient-to-r from-blue-600/15 via-indigo-600/10 to-transparent border border-blue-500/20 mb-2">
                    <div className="flex items-center gap-2">
                      <Subtitles className={`w-4 h-4 transition-colors ${selectedSubtitleTrack !== 'off' ? 'text-blue-400' : 'text-gray-400'}`} />
                      <span className="text-xs font-bold tracking-wide uppercase text-gray-200">Subtitles</span>
                      <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-bold transition-all ${
                        selectedSubtitleTrack !== 'off' 
                          ? 'bg-blue-500/20 text-blue-300 border border-blue-500/30' 
                          : 'bg-white/10 text-gray-400'
                      }`}>
                        {selectedSubtitleTrack !== 'off' ? 'ON' : 'OFF'}
                      </span>
                    </div>
                    
                    {/* Modern Switch Toggle */}
                    <button
                      type="button"
                      role="switch"
                      aria-checked={selectedSubtitleTrack !== 'off'}
                      onClick={() => {
                        if (selectedSubtitleTrack !== 'off') {
                          selectSubtitleTrack('off');
                        } else {
                          const fallback = lastSubtitleTrackRef.current
                            || (uploadedSubtitles[0] ? `uploaded-${uploadedSubtitles[0].id}` : embeddedSubtitles[0] ? `embedded-${embeddedSubtitles[0].index}` : null);
                          if (fallback) {
                            selectSubtitleTrack(fallback);
                          } else {
                            subtitleFileInputRef.current?.click();
                          }
                        }
                      }}
                      className={`relative inline-flex items-center h-5 w-9 shrink-0 cursor-pointer rounded-full p-0.5 border-0 transition-colors duration-250 ease-in-out focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 ${
                        selectedSubtitleTrack !== 'off'
                          ? 'bg-blue-600 shadow-[0_0_12px_rgba(37,99,235,0.6)]'
                          : 'bg-white/20 hover:bg-white/30 ring-1 ring-inset ring-white/15'
                      }`}
                      title={selectedSubtitleTrack !== 'off' ? 'Turn Off Subtitles' : 'Turn On Subtitles'}
                    >
                      <span
                        className={`pointer-events-none block h-4 w-4 rounded-full bg-white shadow-[0_1px_3px_rgba(0,0,0,0.4),0_1px_2px_rgba(0,0,0,0.2)] transition-transform duration-250 ease-[cubic-bezier(0.34,1.56,0.64,1)] ${
                          selectedSubtitleTrack !== 'off' ? 'translate-x-4' : 'translate-x-0'
                        }`}
                      />
                    </button>
                  </div>

                  {/* Tracks Scrollable List */}
                  <div className="max-h-48 overflow-y-auto space-y-1 pr-0.5 custom-scrollbar">
                    {/* Off Option */}
                    <button
                      type="button"
                      onClick={() => selectSubtitleTrack('off')}
                      className={`w-full flex items-center justify-between px-3 py-2 rounded-xl text-xs sm:text-sm transition-all ${
                        selectedSubtitleTrack === 'off'
                          ? 'bg-blue-600/25 border border-blue-500/40 text-blue-300 font-semibold shadow-sm'
                          : 'text-gray-300 hover:bg-white/10 hover:text-white'
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <span className="w-1.5 h-1.5 rounded-full bg-gray-500" />
                        <span>Off (No subtitles)</span>
                      </div>
                      {selectedSubtitleTrack === 'off' && <Check className="w-4 h-4 text-blue-400 shrink-0" />}
                    </button>

                    {/* Embedded Subtitles */}
                    {embeddedSubtitles.length > 0 && (
                      <div className="pt-1.5">
                        <div className="px-2 py-1 text-[10px] font-bold text-gray-400 uppercase tracking-wider flex items-center gap-1.5">
                          <Layers className="w-3 h-3 text-blue-400" />
                          <span>Embedded Tracks</span>
                        </div>
                        {embeddedSubtitles.map(sub => {
                          const isSelected = selectedSubtitleTrack === `embedded-${sub.index}`;
                          return (
                            <button
                              key={sub.index}
                              type="button"
                              onClick={() => selectSubtitleTrack(`embedded-${sub.index}`)}
                              className={`w-full flex items-center justify-between px-3 py-1.5 rounded-xl text-xs sm:text-sm transition-all ${
                                isSelected
                                  ? 'bg-blue-600/25 border border-blue-500/40 text-blue-300 font-semibold shadow-sm'
                                  : 'text-gray-300 hover:bg-white/10 hover:text-white'
                              }`}
                            >
                              <span className="truncate pr-2">{sub.label}</span>
                              {isSelected && <Check className="w-4 h-4 text-blue-400 shrink-0" />}
                            </button>
                          );
                        })}
                      </div>
                    )}

                    {/* Uploaded Subtitles */}
                    {uploadedSubtitles.length > 0 && (
                      <div className="pt-1.5">
                        <div className="px-2 py-1 text-[10px] font-bold text-gray-400 uppercase tracking-wider flex items-center gap-1.5">
                          <Upload className="w-3 h-3 text-emerald-400" />
                          <span>External Subtitles</span>
                        </div>
                        {uploadedSubtitles.map(sub => {
                          const isSelected = selectedSubtitleTrack === `uploaded-${sub.id}`;
                          return (
                            <button
                              key={sub.id}
                              type="button"
                              onClick={() => selectSubtitleTrack(`uploaded-${sub.id}`)}
                              className={`w-full flex items-center justify-between px-3 py-1.5 rounded-xl text-xs sm:text-sm transition-all ${
                                isSelected
                                  ? 'bg-blue-600/25 border border-blue-500/40 text-blue-300 font-semibold shadow-sm'
                                  : 'text-gray-300 hover:bg-white/10 hover:text-white'
                              }`}
                            >
                              <span className="truncate pr-2">{sub.name}</span>
                              {isSelected && <Check className="w-4 h-4 text-blue-400 shrink-0" />}
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>

                  {/* Subtitle Sync Offset Tuner */}
                  {selectedSubtitleTrack.startsWith('uploaded-') && (
                    <div className="pt-2 mt-2 border-t border-white/10 px-1">
                      <div className="flex items-center justify-between text-[11px] text-gray-300 mb-1.5 font-medium">
                        <span className="flex items-center gap-1.5">
                          <Clock className="w-3.5 h-3.5 text-blue-400" />
                          <span>Timing Offset</span>
                        </span>
                        <span className="font-mono text-blue-300 text-xs px-2 py-0.5 rounded-md bg-blue-500/20 border border-blue-500/30">
                          {subtitleOffset > 0 ? `+${subtitleOffset.toFixed(1)}s` : `${subtitleOffset.toFixed(1)}s`}
                        </span>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => setSubtitleOffset(prev => Math.round((prev - 0.5) * 10) / 10)}
                          className="flex-1 py-1 rounded-lg bg-white/10 hover:bg-white/20 active:scale-95 text-xs font-mono text-gray-200 transition-all text-center border border-white/5"
                          title="Delay 0.5s"
                        >
                          -0.5s
                        </button>
                        <button
                          type="button"
                          onClick={() => setSubtitleOffset(0)}
                          className="px-2.5 py-1 rounded-lg bg-white/10 hover:bg-white/20 active:scale-95 text-xs font-mono text-gray-400 hover:text-white transition-all border border-white/5"
                          title="Reset to 0s"
                        >
                          Reset
                        </button>
                        <button
                          type="button"
                          onClick={() => setSubtitleOffset(prev => Math.round((prev + 0.5) * 10) / 10)}
                          className="flex-1 py-1 rounded-lg bg-white/10 hover:bg-white/20 active:scale-95 text-xs font-mono text-gray-200 transition-all text-center border border-white/5"
                          title="Advance 0.5s"
                        >
                          +0.5s
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Appearance Controls */}
                  <div className="pt-2 mt-2 border-t border-white/10 px-1 space-y-2">
                    <div className="flex items-center justify-between text-[11px] text-gray-300 font-medium">
                      <span>Dark background badge</span>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={subtitleBackground}
                        onClick={() => setSubtitleBackground(prev => !prev)}
                        className={`relative inline-flex items-center h-5 w-9 shrink-0 cursor-pointer rounded-full p-0.5 border-0 transition-colors duration-250 ease-in-out focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 ${
                          subtitleBackground
                            ? 'bg-blue-600 shadow-[0_0_12px_rgba(37,99,235,0.6)]'
                            : 'bg-white/20 hover:bg-white/30 ring-1 ring-inset ring-white/15'
                        }`}
                        title={subtitleBackground ? 'Disable background badge' : 'Enable background badge'}
                      >
                        <span
                          className={`pointer-events-none block h-4 w-4 rounded-full bg-white shadow-[0_1px_3px_rgba(0,0,0,0.4),0_1px_2px_rgba(0,0,0,0.2)] transition-transform duration-250 ease-[cubic-bezier(0.34,1.56,0.64,1)] ${
                            subtitleBackground ? 'translate-x-4' : 'translate-x-0'
                          }`}
                        />
                      </button>
                    </div>

                    <div className="flex items-center justify-between text-[11px] text-gray-300 font-medium">
                      <span>Font size</span>
                      <select
                        value={subtitleFontSize}
                        onChange={e => setSubtitleFontSize(Number(e.target.value))}
                        className="rounded-lg border border-white/15 bg-neutral-800/90 px-2.5 py-1 text-xs text-white outline-none cursor-pointer hover:border-blue-500/50 transition-colors"
                      >
                        <option value="18">Small (18px)</option>
                        <option value="24">Medium (24px)</option>
                        <option value="30">Large (30px)</option>
                        <option value="36">Extra Large (36px)</option>
                        <option value="44">Cinema (44px)</option>
                      </select>
                    </div>
                  </div>

                  {/* Upload Subtitle Button */}
                  <div className="pt-2 mt-2 border-t border-white/10">
                    <button
                      type="button"
                      onClick={() => subtitleFileInputRef.current?.click()}
                      className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-xl text-xs font-semibold text-white bg-gradient-to-r from-blue-600/30 to-indigo-600/30 hover:from-blue-600/50 hover:to-indigo-600/50 border border-blue-500/30 active:scale-95 transition-all shadow-sm"
                    >
                      <Upload className="w-3.5 h-3.5 text-blue-400" />
                      <span>Upload Subtitle (.srt, .vtt)</span>
                    </button>
                    <input
                      ref={subtitleFileInputRef}
                      type="file"
                      accept=".srt,.vtt"
                      className="hidden"
                      onChange={handleSubtitleFileChange}
                    />
                  </div>
                </div>              )}
            </div>
            <button
              type="button"
              onClick={onDownload}
              className="hover:text-[#9A2227] transition-colors shrink-0"
              title="Download video"
              aria-label="Download video"
            >
              <Download className="w-5 h-5 sm:w-6 sm:h-6" />
            </button>
            <button onClick={toggleFullscreen} className="hover:text-[#9A2227] transition-colors shrink-0">
              <Maximize className="w-5 h-5 sm:w-6 sm:h-6" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export { getDcSender };

/* ============================================================================
 * COMPONENT: DriveUI
 * Cloud storage main interface: folder navigation, file operations, viewer modals.
 * ============================================================================ */
export const DriveUI: React.FC = () => {
  const { client, botClient, botId, botUsername, setupBot, removeBot, logout, accounts, activeAccountId, switchAccount, terminateAccount, handleSessionRevoked, sessionNotice, clearSessionNotice } = useTelegram();
  const { isStandalone, isIOS, isAndroid, isFirefox, isSamsung, isChrome, isSafari, canInstall, hasNativePrompt, showIOSGuide, setShowIOSGuide, isInstallModalOpen, setIsInstallModalOpen, triggerInstall, promptNativeInstall } = usePWAInstall();
  const [isRefreshing, setIsRefreshing] = useState(false);
  const filesMapRef = useRef<{ [path: string]: VirtualFile }>({});

  const [accountToTerminate, setAccountToTerminate] = useState<StoredTelegramAccount | null>(null);
  const [isTerminatingAccount, setIsTerminatingAccount] = useState(false);
  const [restrictionModal, setRestrictionModal] = useState<{ title: string; message: string; suggestions?: string[] } | null>(null);

  useEffect(() => {
    return onPlayableFileRegistered((file) => {
      if (file && file.id) {
        filesMapRef.current[file.id] = file;
        if (file.name) filesMapRef.current[file.name] = file;
      }
    });
  }, []);
  const [currentFolder, setCurrentFolder] = useState<VirtualFolder | null>(null);
  const [pathStack, setPathStack] = useState<VirtualFolder[]>([]);
  const [loading, setLoading] = useState(false);
  type ItemSize = 'small' | 'medium' | 'large';
  const [viewMode, setViewMode] = useState<'grid' | 'list' | 'gallery'>(() => (localStorage.getItem('drive_view_mode') as any) || 'grid');
  const [itemSize, setItemSize] = useState<ItemSize>(() => (localStorage.getItem('drive_item_size') as ItemSize) || 'medium');
  const [sortMode, setSortMode] = useState<'name' | 'date' | 'size' | 'duration'>(() => (localStorage.getItem('drive_sort_mode') as any) || 'date');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>(() => (localStorage.getItem('drive_sort_order') as any) || 'desc');
  const [activeFile, setActiveFile] = useState<VirtualFile | null>(null);
  const [isClosingMediaViewer, setIsClosingMediaViewer] = useState(false);
  const mediaViewerClosingRef = useRef(false);

  const closeMediaViewer = useCallback(() => {
    if (!activeFile || mediaViewerClosingRef.current) return;
    mediaViewerClosingRef.current = true;
    setIsClosingMediaViewer(true);
    window.dispatchEvent(new CustomEvent('cancelStream', { detail: { fileId: activeFile.id } }));
    setTimeout(() => {
      setActiveFile(null);
      setIsClosingMediaViewer(false);
      mediaViewerClosingRef.current = false;
      window.location.hash = `#/folder/${encodeURIComponent(currentFolder?.id || 'root')}`;
    }, 220);
  }, [activeFile, currentFolder]);

  const [isMobileViewSheetOpen, setIsMobileViewSheetOpen] = useState(false);
  const [isMobileViewSheetMounted, setIsMobileViewSheetMounted] = useState(false);
  const [mobileViewSheetPhase, setMobileViewSheetPhase] = useState<'closed' | 'opening' | 'open' | 'closing'>('closed');
  const mobileViewSheetPhaseRef = useRef<'closed' | 'opening' | 'open' | 'closing'>('closed');
  const mobileViewSheetTimerRef = useRef<number | null>(null);
  const mobileViewSheetFrameRef = useRef<number | null>(null);
  const [isDesktopViewMenuOpen, setIsDesktopViewMenuOpen] = useState(false);
  const [isDesktopViewMenuMounted, setIsDesktopViewMenuMounted] = useState(false);
  const [isDesktopViewMenuClosing, setIsDesktopViewMenuClosing] = useState(false);
  const [desktopViewMenuPhase, setDesktopViewMenuPhase] = useState<'closed' | 'opening' | 'open' | 'closing'>('closed');
  const desktopViewMenuTimerRef = useRef<number | null>(null);
  const desktopViewMenuRef = useRef<HTMLDivElement>(null);
  const [isFolderSortOpen, setIsFolderSortOpen] = useState(false);
  const folderSortMenuRef = useRef<HTMLDivElement>(null);

  const closeDesktopViewMenu = () => {
    if (desktopViewMenuPhase === 'closed' || desktopViewMenuPhase === 'closing') return;
    if (desktopViewMenuTimerRef.current !== null) {
      window.clearTimeout(desktopViewMenuTimerRef.current);
    }
    setIsDesktopViewMenuOpen(false);
    setIsDesktopViewMenuClosing(true);
    setDesktopViewMenuPhase('closing');
    desktopViewMenuTimerRef.current = window.setTimeout(() => {
      setIsDesktopViewMenuMounted(false);
      setIsDesktopViewMenuClosing(false);
      setDesktopViewMenuPhase('closed');
      desktopViewMenuTimerRef.current = null;
    }, 240);
  };

  const toggleDesktopViewMenu = () => {
    if (desktopViewMenuPhase === 'open' || desktopViewMenuPhase === 'opening') {
      closeDesktopViewMenu();
      return;
    }
    if (desktopViewMenuTimerRef.current !== null) {
      window.clearTimeout(desktopViewMenuTimerRef.current);
      desktopViewMenuTimerRef.current = null;
    }
    setIsDesktopViewMenuMounted(true);
    setIsDesktopViewMenuClosing(false);
    setDesktopViewMenuPhase('opening');
    window.requestAnimationFrame(() => {
      setIsDesktopViewMenuOpen(true);
      setDesktopViewMenuPhase('open');
    });
  };

  const closeMobileViewSheet = () => {
    if (mobileViewSheetPhase === 'closed' || mobileViewSheetPhase === 'closing') return;
    if (mobileViewSheetFrameRef.current !== null) {
      window.cancelAnimationFrame(mobileViewSheetFrameRef.current);
      mobileViewSheetFrameRef.current = null;
    }
    if (mobileViewSheetTimerRef.current !== null) {
      window.clearTimeout(mobileViewSheetTimerRef.current);
      mobileViewSheetTimerRef.current = null;
    }
    setIsMobileViewSheetOpen(false);
    mobileViewSheetPhaseRef.current = 'closing';
    setMobileViewSheetPhase('closing');
    mobileViewSheetTimerRef.current = window.setTimeout(() => {
      setIsMobileViewSheetMounted(false);
      mobileViewSheetPhaseRef.current = 'closed';
      setMobileViewSheetPhase('closed');
      mobileViewSheetTimerRef.current = null;
    }, 360);
  };

  const toggleMobileViewSheet = () => {
    if (mobileViewSheetPhase === 'open' || mobileViewSheetPhase === 'opening') {
      closeMobileViewSheet();
      return;
    }
    if (mobileViewSheetTimerRef.current !== null) {
      window.clearTimeout(mobileViewSheetTimerRef.current);
      mobileViewSheetTimerRef.current = null;
    }
    if (mobileViewSheetFrameRef.current !== null) {
      window.cancelAnimationFrame(mobileViewSheetFrameRef.current);
    }
    setIsMobileViewSheetMounted(true);
    mobileViewSheetPhaseRef.current = 'opening';
    setMobileViewSheetPhase('opening');
    mobileViewSheetFrameRef.current = window.requestAnimationFrame(() => {
      mobileViewSheetFrameRef.current = null;
      if (mobileViewSheetPhaseRef.current !== 'opening') return;
      setIsMobileViewSheetOpen(true);
      mobileViewSheetPhaseRef.current = 'open';
      setMobileViewSheetPhase('open');
    });
  };

  const changeViewMode = (mode: 'grid' | 'list' | 'gallery') => {
    setViewMode(mode);
    localStorage.setItem('drive_view_mode', mode);
  };

  const changeItemSize = (size: ItemSize) => {
    setItemSize(size);
    localStorage.setItem('drive_item_size', size);
  };

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent | TouchEvent) => {
      if (desktopViewMenuRef.current && !desktopViewMenuRef.current.contains(e.target as Node)) {
        closeDesktopViewMenu();
      }
      if (folderSortMenuRef.current && !folderSortMenuRef.current.contains(e.target as Node)) {
        setIsFolderSortOpen(false);
      }
    };
    if (isDesktopViewMenuOpen || isFolderSortOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      document.addEventListener('touchstart', handleClickOutside);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('touchstart', handleClickOutside);
    };
  }, [isDesktopViewMenuOpen, isFolderSortOpen]);

  useEffect(() => { localStorage.setItem('drive_view_mode', viewMode); }, [viewMode]);
  useEffect(() => { localStorage.setItem('drive_sort_mode', sortMode); }, [sortMode]);
  useEffect(() => { localStorage.setItem('drive_sort_order', sortOrder); }, [sortOrder]);

  // Search State
  const [isSearchMounted, setIsSearchMounted] = useState(false);
  const [searchPhase, setSearchPhase] = useState<'closed' | 'opening' | 'open' | 'closing'>('closed');
  const searchTimerRef = useRef<number | null>(null);
  const [syncProgress, setSyncProgress] = useState<{loaded: number, total: number} | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<{type: 'file'|'folder', item: any, path: VirtualFolder[]}[]>([]);

  const openSearchModal = () => {
    if (searchTimerRef.current !== null) {
      window.clearTimeout(searchTimerRef.current);
      searchTimerRef.current = null;
    }
    setIsSearchMounted(true);
    setSearchPhase('opening');
    window.requestAnimationFrame(() => {
      setSearchPhase('open');
    });
  };

  const closeSearchModal = () => {
    if (searchPhase === 'closed' || searchPhase === 'closing') return;
    setSearchPhase('closing');
    searchTimerRef.current = window.setTimeout(() => {
      setIsSearchMounted(false);
      setSearchPhase('closed');
      searchTimerRef.current = null;
    }, 280);
  };
  const [contextMenu, setContextMenu] = useState<{x: number, y: number, result: any} | null>(null);
  const [highlightFileId, setHighlightFileId] = useState<string | null>(null);
  const touchTimer = React.useRef<NodeJS.Timeout | null>(null);
  const [isCreateFolderModalOpen, setIsCreateFolderModalOpen] = useState(false);
  const [isClosingFolderModal, setIsClosingFolderModal] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const { playTrack, addToQueue } = useMusicPlayer();

  // If any audio file is opened into activeFile, automatically route it to the sleek MusicPlayer
  useEffect(() => {
    if (activeFile && isAudioFile(activeFile)) {
      playTrack(activeFile);
      setActiveFile(null);
    }
  }, [activeFile, playTrack]);
  const [renameModal, setRenameModal] = useState<{ item: any, newName: string } | null>(null);
  const [isClosingRenameModal, setIsClosingRenameModal] = useState(false);
  const openSettingsModal = () => {
    if (settingsCloseTimerRef.current !== null) {
      window.clearTimeout(settingsCloseTimerRef.current);
      settingsCloseTimerRef.current = null;
    }
    setIsClosingSettings(false);
    setIsSettingsOpen(true);
  };

  const closeSettingsModal = () => {
    if (!isSettingsOpen || isClosingSettings) return;
    setIsClosingSettings(true);
    settingsCloseTimerRef.current = window.setTimeout(() => {
      setIsSettingsOpen(false);
      setIsClosingSettings(false);
      settingsCloseTimerRef.current = null;
    }, 280);
  };

  const closeCreateFolderModal = () => {
    setIsClosingFolderModal(true);
    setTimeout(() => {
      setIsCreateFolderModalOpen(false);
      setIsClosingFolderModal(false);
      setNewFolderName('');
    }, 200);
  };

  const closeRenameModal = () => {
    setIsClosingRenameModal(true);
    setTimeout(() => {
      setRenameModal(null);
      setIsClosingRenameModal(false);
    }, 200);
  };

  // Selection & Clipboard
  const [selectedItems, setSelectedItems] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (selectedItems.size > 0) {
      closeDesktopViewMenu();
      closeMobileViewSheet();
    }
  }, [selectedItems.size]);

  const renderSelectCheckbox = (isSelected: boolean, onClick: (e: React.MouseEvent) => void, absoluteClasses = '') => {
    const isSelectionActive = selectedItems.size > 0;
    return (
      <button 
        type="button"
        onClick={(e) => {
          onClick(e);
        }}
        className={`${absoluteClasses} z-40 p-1 rounded-full gpu-fast transition-all duration-200 ease-out flex items-center justify-center shrink-0 ${
          isSelected 
            ? 'opacity-100 scale-100 pointer-events-auto' 
            : isSelectionActive 
              ? 'opacity-85 hover:opacity-100 scale-95 hover:scale-100 pointer-events-auto' 
              : 'hidden sm:flex opacity-0 group-hover:opacity-100 scale-95 hover:scale-100 pointer-events-none sm:group-hover:pointer-events-auto'
        }`}
        title={isSelected ? "Deselect" : "Select"}
        aria-label={isSelected ? "Deselect" : "Select"}
      >
        <div className={`w-5 h-5 rounded-full flex items-center justify-center gpu-fast transition-all duration-200 ease-out ${
          isSelected
            ? 'bg-emerald-500 ring-2 ring-emerald-400/80 shadow-md shadow-emerald-500/30 scale-100 active:scale-90'
            : 'border-2 border-gray-400/80 dark:border-gray-500/80 bg-white/60 dark:bg-black/50 backdrop-blur-sm hover:border-emerald-400 hover:scale-105 active:scale-95'
        }`}>
          {isSelected && (
            <Check className="w-3.5 h-3.5 stroke-[3] text-white animate-in zoom-in-50 duration-150" />
          )}
        </div>
      </button>
    );
  };
  const [deleteModalItems, setDeleteModalItems] = useState<DeleteModalItem[] | null>(null);
  const [clipboard, setClipboard] = useState<{ action: 'copy'|'move', items: { type: 'file'|'folder', item: any }[] } | null>(null);
  const pasteItemsRef = useRef<((action: 'copy' | 'move', items: { type: 'file' | 'folder'; item: any }[], targetFolder: VirtualFolder, options?: { onProgress?: (progress: number, total: number) => void }) => Promise<boolean>) | null>(null);
  const [toastMessage, setToastMessage] = useState<{title: string, message: string, type: 'error' | 'success'} | null>(null);

  useEffect(() => {
      if (toastMessage) {
          const timer = setTimeout(() => setToastMessage(null), 5000);
          return () => clearTimeout(timer);
      }
  }, [toastMessage]);

  // Settings State
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isClosingSettings, setIsClosingSettings] = useState(false);
  const settingsCloseTimerRef = useRef<number | null>(null);
  const [isAddingAccount, setIsAddingAccount] = useState(false);
  const [accountAction, setAccountAction] = useState<string | null>(null);
  const [accountError, setAccountError] = useState('');
  const [switchingTargetAccount, setSwitchingTargetAccount] = useState<any | null>(null);
  const [unindexedFileTarget, setUnindexedFileTarget] = useState<VirtualFile | null>(null);
  const [indexingFileName, setIndexingFileName] = useState('');
  const [isIndexingDriveFile, setIsIndexingDriveFile] = useState(false);

  const rootStorageKey = `zud_root_channel_id_${activeAccountId || 'default'}`;
  const channelsStorageKey = `zud_available_channels_${activeAccountId || 'default'}`;
  const [availableChannels, setAvailableChannels] = useState<{id: string, name: string, rawId?: any, accessHash?: string, isCreator?: boolean}[]>(() => {
    try {
      const key = `zud_available_channels_${activeAccountId || 'default'}`;
      const saved = localStorage.getItem(key);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed)) {
          for (const item of parsed) {
            if (item?.id && item?.accessHash) {
              saveChannelAccessHash(item.id, item.accessHash);
            }
          }
          return parsed;
        }
      }
    } catch {}
    return [];
  });
  const [autoArchive, setAutoArchive] = useState<boolean>(() => {
    const saved = localStorage.getItem('drive_auto_archive');
    return saved ? JSON.parse(saved) : true;
  });

  const [botTokenInput, setBotTokenInput] = useState('');
  const [isBotSaving, setIsBotSaving] = useState(false);
  const [botSaveError, setBotSaveError] = useState('');
  const [syncingChannelIds, setSyncingChannelIds] = useState<Set<string>>(new Set());

  // Background Operations
  const savedRootId = localStorage.getItem(rootStorageKey);
  const zudRootChannelId = availableChannels.find(c => c.id === savedRootId)?.id || availableChannels.find(c => c.name === 'Cloud Root')?.id || null;

  const syncFolderStack = useCallback(() => {
    setPathStack(prevStack => {
      if (!prevStack || prevStack.length === 0) return prevStack;
      const root = prevStack[0];
      if (!root) return prevStack;

      // If active folder is a virtual search results folder, preserve it!
      if (prevStack[prevStack.length - 1]?.id?.startsWith('search:')) {
        return prevStack;
      }

      if (prevStack.length <= 1) {
        setCurrentFolder({ ...root });
        return [root];
      }

      const newStack: VirtualFolder[] = [root];
      let curr = root;

      for (let i = 1; i < prevStack.length; i++) {
        const targetId = prevStack[i].id;
        const targetName = prevStack[i].name;

        if (targetId.startsWith('search:')) {
          newStack.push(prevStack[i]);
          break;
        }

        let matched = Object.values(curr.folders).find(f => f.id === targetId || f.name === targetName);

        // If not found in curr.folders and curr is root, look inside hoisted root storage channel (Cloud Root)
        if (!matched && curr.id === 'root' && zudRootChannelId) {
          const rootNumId = channelNumericId(String(zudRootChannelId));
          const rootChannel = curr.folders[zudRootChannelId] ||
            Object.values(curr.folders).find(f => {
              const fNum = channelNumericId(String(f.id));
              return (fNum && rootNumId && fNum === rootNumId) || f.name === 'Cloud Root';
            });
          if (rootChannel) {
            matched = Object.values(rootChannel.folders).find(f => f.id === targetId || f.name === targetName);
          }
        }

        if (matched) {
          curr = matched;
          newStack.push(curr);
        } else {
          break;
        }
      }

      const active = newStack[newStack.length - 1];
      setCurrentFolder({ ...active });
      return newStack;
    });
  }, [zudRootChannelId]);

  const refreshChannel = useCallback((chanId: string) => {
    if (!client) return;
    const rootFolder = pathStack[0];
    if (!rootFolder) return;
    
    const targetNumId = channelNumericId(String(chanId));
    let targetChanFolder = Object.values(rootFolder.folders).find(f => {
      const fNumId = channelNumericId(String(f.channelId || ''));
      if (targetNumId && fNumId) return targetNumId === fNumId;
      return String(f.channelId || '') === String(chanId);
    });
    if (!targetChanFolder && zudRootChannelId) {
      const rootNumId = channelNumericId(String(zudRootChannelId));
      if ((targetNumId && rootNumId && targetNumId === rootNumId) || String(chanId) === String(zudRootChannelId)) {
        targetChanFolder = rootFolder.folders[zudRootChannelId] || Object.values(rootFolder.folders).find(f => f.id === zudRootChannelId);
      }
    }
    
    if (targetChanFolder) {
        clearChannelCache(String(chanId)).then(() => {
           syncChannelFiles(client, targetChanFolder!, filesMapRef.current, () => {
              syncFolderStack();
           });
        });
    }
  }, [client, pathStack, zudRootChannelId]);

  // Keep the folder you are looking at in sync with changes made from other devices
  // (new / deleted videos, replaced covers). Incremental: only new/edited messages are fetched
  // and existing messages are re-verified at most once a minute per channel.
  const pathStackRef = useRef<VirtualFolder[]>([]);
  pathStackRef.current = pathStack;
  const softSyncBusyRef = useRef(false);
  const softSyncFnRef = useRef<((force?: boolean) => void) | null>(null);
  const activeChannelKey = pathStack.length > 1 ? String(pathStack[1]?.id || '') : (zudRootChannelId || '');
  const lastSoftSyncRef = useRef(0);

  const handleIndexDriveFile = async (file: VirtualFile, customName?: string) => {
    if (!client || isIndexingDriveFile) return;
    setIsIndexingDriveFile(true);
    try {
      const targetName = (customName || indexingFileName || file.name).trim();
      const msgId = file.parts?.[0]?.messageId;
      const targetChannelId = file.parts?.[0]?.channelId || activeChannelKey || currentFolder?.channelId || currentFolder?.id;
      if (!msgId || !targetChannelId) throw new Error('File message details not found');

      const isVideo = file.mimeType?.startsWith('video/') || ['mp4', 'mkv', 'webm', 'mov', 'avi', 'flv'].includes(targetName.split('.').pop()?.toLowerCase() || '');
      const isAudio = isAudioFile({ ...file, name: targetName });
      const type = isVideo ? 'video' : (isAudio ? 'audio' : 'file');

      const newCaption = buildTelegramCaption(targetName, {
        n: targetName,
        t: type,
        p: 1,
        tp: 1,
        pId: currentFolder?.folderId || 'root',
        s: file.size,
        mime: file.mimeType,
        dur: file.duration,
        w: file.width,
        h: file.height
      });

      const peer = await resolveTelegramEntity(client, targetChannelId);

      let editSuccess = false;

      // 1. If a bot is connected, try editing via botClient first
      if (botClient) {
        try {
          const botPeer = await resolveTelegramEntity(botClient, targetChannelId);
          await botClient.invoke(
            new Api.messages.EditMessage({
              peer: botPeer,
              id: msgId,
              message: newCaption
            })
          );
          editSuccess = true;
        } catch (botErr: any) {
          console.warn('Bot editMessage attempt failed, falling back to client/SendMedia:', botErr);
        }
      }

      // 2. Try user client messages.EditMessage
      if (!editSuccess) {
        try {
          await client.invoke(
            new Api.messages.EditMessage({
              peer: peer,
              id: msgId,
              message: newCaption
            })
          );
          editSuccess = true;
        } catch (userErr: any) {
          const userErrMsg = String(userErr?.errorMessage || userErr?.message || userErr);
          console.warn('User editMessage failed:', userErrMsg);

          // If message was sent via an inline bot (INLINE_BOT_REQUIRED) or edit permission restricted,
          // execute instant server-side copy via SendMedia with new caption & remove old unindexed message!
          if (userErrMsg.includes('INLINE_BOT_REQUIRED') || userErrMsg.includes('CHAT_ADMIN_REQUIRED') || userErrMsg.includes('MESSAGE_EDIT_TIME_EXPIRED')) {
            console.log('Falling back to server-side media copy with indexed caption...');
            
            const msgs: any[] = await client.getMessages(peer, { ids: [msgId] }) as any;
            const originalMsg = msgs?.[0];
            if (!originalMsg || !originalMsg.media) {
              throw new Error(`Cannot index file: ${userErrMsg}`);
            }

            const randomId = bigInt(Math.floor(Math.random() * Number.MAX_SAFE_INTEGER)) as any;
            const sentResult: any = await client.invoke(
              new Api.messages.SendMedia({
                peer: peer,
                media: originalMsg.media,
                message: newCaption,
                randomId: randomId
              })
            );

            const newMsgId = sentResult?.updates?.find((u: any) => u.className === 'UpdateNewMessage' || u.className === 'UpdateNewChannelMessage')?.message?.id
              || sentResult?.id
              || sentResult?.messages?.[0]?.id;

            try {
              if (String(targetChannelId) === 'me' || String(targetChannelId) === 'saved_messages') {
                await client.invoke(new Api.messages.DeleteMessages({ id: [msgId], revoke: true }));
              } else {
                await client.invoke(new Api.channels.DeleteMessages({ channel: peer, id: [msgId] }));
              }
            } catch (delErr) {
              console.warn('Could not delete old unindexed message after re-sending:', delErr);
            }

            if (newMsgId && file.parts?.[0]) {
              file.parts[0].messageId = Number(newMsgId);
            }
            editSuccess = true;
          } else {
            throw userErr;
          }
        }
      }

      file.isUncaptioned = false;
      file.isUnindexed = false;
      file.name = targetName;

      if (currentFolder) {
        const updatedFiles = currentFolder.files ? currentFolder.files.map(f => {
          if (f.id === file.id || f.parts?.some(p => p.messageId === msgId)) {
            return { ...f, name: targetName, isUncaptioned: false, isUnindexed: false };
          }
          return f;
        }) : [];
        const updatedFolder = { ...currentFolder, files: updatedFiles };
        setCurrentFolder(updatedFolder);
        setPathStack(prev => {
          if (!prev || prev.length === 0) return prev;
          const next = [...prev];
          next[next.length - 1] = updatedFolder;
          return next;
        });
      }

      setUnindexedFileTarget(null);
      invalidateMessage(String(targetChannelId), msgId);
      refreshChannel(String(targetChannelId));
    } catch (err: any) {
      console.error('Failed to index drive file:', err);
      alert(`Could not index file: ${err?.message || 'Unknown error'}`);
    } finally {
      setIsIndexingDriveFile(false);
    }
  };

  useEffect(() => {
    if (!client) return;

    const softSync = async (force = false) => {
      if (softSyncBusyRef.current) return;
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      if (!force && Date.now() - lastSoftSyncRef.current < 20000) return;
      const stack = pathStackRef.current;
      const rootFolder = stack[0];
      if (!rootFolder) return;

      const channelFolder = stack.length > 1
        ? stack[1]
        : (zudRootChannelId ? rootFolder.folders[zudRootChannelId] : undefined);
      if (!channelFolder || !channelFolder.channelId || channelFolder.isLoaded === false) return;

      softSyncBusyRef.current = true;
      lastSoftSyncRef.current = Date.now();
      try {
        await syncChannelFiles(client, channelFolder, filesMapRef.current, () => {
          syncFolderStack();
        });
      } catch (e) {
        console.warn('Background folder sync failed:', e);
      } finally {
        softSyncBusyRef.current = false;
      }
    };

    softSyncFnRef.current = softSync;
    const onFocus = () => { softSync(); };
    const onVisible = () => { if (document.visibilityState === 'visible') softSync(); };
    const interval = setInterval(() => { softSync(); }, 45000);
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(interval);
      softSyncFnRef.current = null;
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [client, zudRootChannelId]);

  // Opening / switching to a channel: verify it against Telegram shortly after it is shown
  useEffect(() => {
    if (!client || !activeChannelKey) return;
    const t = setTimeout(() => softSyncFnRef.current?.(true), 2500);
    return () => clearTimeout(t);
  }, [client, activeChannelKey]);

  const { operations, pasteItems, renameItem, clearDoneOperations } = useDriveOperations(client, zudRootChannelId, (affectedChannels: Set<string>, deletedChannels?: Set<string>) => {
    if (client) {
       const rootFolder = pathStack[0];
       if (rootFolder) {
         if (deletedChannels && deletedChannels.size > 0) {
            deletedChannels.forEach(chanId => {
                const targetKey = Object.keys(rootFolder.folders).find(k => String(rootFolder.folders[k].channelId) === String(chanId));
                if (targetKey) delete rootFolder.folders[targetKey];
            });
            setPathStack(prev => [...prev]);
         }
         
         affectedChannels.forEach(chanId => {
           if (deletedChannels && deletedChannels.has(chanId)) return;
           refreshChannel(String(chanId));
         });
       }
    }
  });
  pasteItemsRef.current = pasteItems;
  useEffect(() => {
    if (!searchQuery || !pathStack[0]) {
      setSearchResults([]);
      return;
    }
    
    const results: {type: 'file'|'folder', item: any, path: VirtualFolder[]}[] = [];
    const resultKeys = new Set<string>();
    const queryParts = searchQuery.toLowerCase().split(/\s+/).filter(Boolean);
    const isMatch = (name: string) => {
      const n = name.toLowerCase().replace(/_/g, ' '); // Replace underscores with spaces for matching
      return queryParts.every(part => n.includes(part));
    };
    
    const addResult = (type: 'file'|'folder', item: any, path: VirtualFolder[]) => {
      const key = `${type}:${String(item.id)}`;
      if (resultKeys.has(key)) return;
      resultKeys.add(key);
      results.push({ type, item, path });
    };

    const collectFolderContents = (folder: VirtualFolder, currentPath: VirtualFolder[]) => {
      addResult('folder', folder, currentPath);
      for (const file of folder.files) {
        addResult('file', file, [...currentPath, folder]);
      }
      for (const childId in folder.folders) {
        const child = folder.folders[childId];
        if (child.isLoaded === false) continue;
        collectFolderContents(child, [...currentPath, folder]);
      }
    };

    const searchFolder = (folder: VirtualFolder, currentPath: VirtualFolder[]) => {
       if (folder.id !== 'root' && isMatch(folder.name)) {
         collectFolderContents(folder, currentPath);
       }
       for (const file of folder.files) {
         if (isMatch(file.name)) {
           addResult('file', file, [...currentPath, folder]);
         }
       }
       for (const childId in folder.folders) {
         const child = folder.folders[childId];
         // Only skip explicitly unloaded channel folders
         if (child.isLoaded === false) continue;
         searchFolder(child, [...currentPath, folder]);
       }
    };
    
    searchFolder(pathStack[0], []);
    setSearchResults(results);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQuery, pathStack]); // removed filesMap dependency

  useEffect(() => {
    const closeMenu = () => setContextMenu(null);
    window.addEventListener('click', closeMenu);
    return () => window.removeEventListener('click', closeMenu);
  }, []);

  useEffect(() => {
    if (highlightFileId) {
      setTimeout(() => {
        const el = document.getElementById(`file-${highlightFileId}`);
        if (el) {
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      }, 300);
      const timer = setTimeout(() => setHighlightFileId(null), 3000);
      return () => clearTimeout(timer);
    }
  }, [highlightFileId, currentFolder, sortMode, sortOrder, viewMode]);

  const touchStartPosRef = useRef<{ x: number, y: number } | null>(null);
  const isTouchRef = useRef(false);
  const longPressHandledRef = useRef(false);

  const handleItemTouchStart = (e: React.TouchEvent, id: string) => {
    isTouchRef.current = true;
    longPressHandledRef.current = false;
    const touch = e.touches[0];
    touchStartPosRef.current = { x: touch.clientX, y: touch.clientY };
    if (typeof window !== 'undefined' && window.getSelection) {
      try { window.getSelection()?.removeAllRanges(); } catch {}
    }
    if (touchTimer.current) clearTimeout(touchTimer.current);
    touchTimer.current = setTimeout(() => {
      longPressHandledRef.current = true;
      if (typeof window !== 'undefined' && window.getSelection) {
        try { window.getSelection()?.removeAllRanges(); } catch {}
      }
      toggleSelection(null as any, id);
      if (navigator.vibrate) {
        try { navigator.vibrate(40); } catch {}
      }
    }, 420);
  };

  const handleItemTouchMove = (e: React.TouchEvent) => {
    if (!touchStartPosRef.current || !touchTimer.current) return;
    const touch = e.touches[0];
    const dx = touch.clientX - touchStartPosRef.current.x;
    const dy = touch.clientY - touchStartPosRef.current.y;
    if (dx * dx + dy * dy > 100) {
      clearTimeout(touchTimer.current);
      touchTimer.current = null;
    }
  };

  const handleItemTouchEnd = () => {
    if (touchTimer.current) {
      clearTimeout(touchTimer.current);
      touchTimer.current = null;
    }
    if (longPressHandledRef.current && typeof window !== 'undefined' && window.getSelection) {
      try { window.getSelection()?.removeAllRanges(); } catch {}
    }
    touchStartPosRef.current = null;
    setTimeout(() => {
      isTouchRef.current = false;
    }, 350);
  };

  const handleContextMenu = (e: React.MouseEvent, result: any) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.nativeEvent) {
      e.nativeEvent.preventDefault();
      e.nativeEvent.stopPropagation();
    }
    // On mobile / touch holding, do NOT show right-click menu!
    const isTouchDevice = typeof window !== 'undefined' && ('ontouchstart' in window || (navigator.maxTouchPoints && navigator.maxTouchPoints > 0));
    const isTouchPointer = (e.nativeEvent as any)?.pointerType === 'touch';
    if (isTouchRef.current || isTouchPointer || longPressHandledRef.current || (isTouchDevice && !window.matchMedia('(hover: hover)').matches)) {
      return;
    }
    setContextMenu({ x: e.clientX, y: e.clientY, result });
  };

  const openItemMenu = (e: React.MouseEvent | React.TouchEvent, result: any) => {
    e.stopPropagation();
    e.preventDefault();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const menuWidth = 180;
    const menuHeight = 240;
    let x = rect.left;
    if (x + menuWidth > window.innerWidth) {
      x = Math.max(8, window.innerWidth - menuWidth - 12);
    }
    let y = rect.bottom + 4;
    if (y + menuHeight > window.innerHeight) {
      y = Math.max(8, rect.top - menuHeight - 4);
    }
    setContextMenu({ x, y, result });
  };
  
  const handleTouchStartMenu = (e: React.TouchEvent, result: any) => {
    const id = result.type === 'folder' ? result.item.id : result.item.id;
    handleItemTouchStart(e, id);
  };
  
  const handleTouchEndMenu = () => {
    handleItemTouchEnd();
  };

  const goToFolder = (result: any) => {
    const folder = result.type === 'folder' ? result.item : result.path[result.path.length - 1];
    
    const newStack = [...result.path];
    if (result.type === 'folder') {
      newStack.push(result.item);
    } else if (folder && folder.id !== 'root') {
      newStack.push(folder);
    }
    
    if (folder) {
        setCurrentFolder(folder);
        setPathStack(newStack);
    }
    closeSearchModal();
    setContextMenu(null);
    setSearchQuery('');
    
    if (result.type === 'file') {
      setHighlightFileId(result.item.id);
      window.location.hash = `#/folder/${encodeURIComponent(folder ? folder.id : 'root')}`;
    } else {
      window.location.hash = `#/folder/${encodeURIComponent(folder ? folder.id : 'root')}`;
    }
  };

  useEffect(() => {
    if (client) {
      loadChannels();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client]);

  // Synchronously switch account state when activeAccountId changes
  useEffect(() => {
    if (!activeAccountId) return;
    try {
      const key = `zud_available_channels_${activeAccountId}`;
      const saved = localStorage.getItem(key);
      const parsed = saved ? JSON.parse(saved) : [];
      setAvailableChannels(parsed);
    } catch {
      setAvailableChannels([]);
    }
    filesMapRef.current = {};
    setCurrentFolder(null);
    setPathStack([]);
    if (client) {
      loadChannels();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeAccountId]);

  // Reload root folder and background sync channels
  useEffect(() => {
    if (!client || availableChannels.length === 0) return;
    
    let isMounted = true;
    const initAndSync = async () => {
      await rebuildRoot();
      if (!isMounted) return;

      // Classify channels into uncached (need initial sync & progress) vs cached (already ready to search)
      const uncachedChannels: typeof availableChannels = [];
      const cachedChannels: { ch: typeof availableChannels[0]; lastMessageId: number }[] = [];

      for (const ch of availableChannels) {
        try {
          const c = await loadChannelCache(String(ch.id));
          if (!c || !c.lastMessageId || c.lastMessageId === 0) {
            uncachedChannels.push(ch);
          } else {
            cachedChannels.push({ ch, lastMessageId: c.lastMessageId });
          }
        } catch (_) {
          uncachedChannels.push(ch);
        }
      }

      // ONLY if there are truly uncached channels, show the initial sync progress bar
      if (uncachedChannels.length > 0) {
        setSyncProgress({ loaded: 0, total: uncachedChannels.length });
        let loadedCount = 0;
        
        for (const ch of uncachedChannels) {
          if (!isMounted) return;
          const rootFolder = pathStackRef.current[0] || currentFolder;
          const channelFolder = rootFolder?.folders[ch.id];
          if (!channelFolder) {
            loadedCount++;
            setSyncProgress(prev => prev ? { ...prev, loaded: loadedCount } : null);
            continue;
          }

          setSyncingChannelIds(prev => new Set(prev).add(String(ch.id)));
          try {
            await syncChannelFiles(client, channelFolder, filesMapRef.current, () => {
              if (!isMounted) return;
              syncFolderStack();
            }, { validate: false });
          } catch (err) {
            console.error(`Initial sync failed for channel ${ch.id}:`, err);
          } finally {
            if (isMounted) {
              setSyncingChannelIds(prev => {
                const next = new Set(prev);
                next.delete(String(ch.id));
                return next;
              });
              loadedCount++;
              setSyncProgress(prev => prev ? { ...prev, loaded: loadedCount } : null);
            }
          }
        }
        if (isMounted) setSyncProgress(null);
      }

      // For cached channels: they are already hydrated in memory & searchable instantly!
      // In the background, check if any NEW item was added to the cloud since last sync
      for (const item of cachedChannels) {
        if (!isMounted) return;
        try {
          const rootFolder = pathStackRef.current[0] || currentFolder;
          const channelFolder = rootFolder?.folders[item.ch.id];
          if (!channelFolder) continue;

          const peerEntity = channelFolder.accessHash
            ? { id: channelFolder.channelId, accessHash: channelFolder.accessHash }
            : (channelFolder.channelId || channelFolder.id);
          const peer = await resolveTelegramEntity(client, peerEntity);
          const topMsgs: any[] = await client.getMessages(peer, { limit: 1 }) as any;
          const topId = topMsgs?.[0]?.id || 0;

          // If topId !== item.lastMessageId, an item was added, deleted, or updated! Sync it incrementally.
          if (topId !== item.lastMessageId) {
            await syncChannelFiles(client, channelFolder, filesMapRef.current, () => {
              if (!isMounted) return;
              syncFolderStack();
            });
          }
        } catch (e) {
          // Non-blocking delta check failure
        }
      }
    };
    
    initAndSync();
    return () => { isMounted = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [availableChannels]);

  const loadChannels = async () => {
    if (!client) return;
    const hasCached = availableChannels.length > 0;
    if (!hasCached) {
      setLoading(true);
    }
    try {
      const dialogs = await client.getDialogs({});
      const channels: { id: string; name: string; rawId?: any; accessHash?: string; isCreator?: boolean }[] = [];
      const savedRootId = localStorage.getItem(rootStorageKey);
      let rootChannel: any = dialogs.find((dialog: any) => dialog.entity?.className === 'Channel' && dialog.entity.id.toString() === savedRootId)?.entity;
      if (!rootChannel) rootChannel = dialogs.find((dialog: any) => dialog.title === 'Cloud Root')?.entity;
      if (!rootChannel) {
        const result = await client.invoke(new Api.channels.CreateChannel({
          title: 'Cloud Root', about: 'Cloud storage for Cloud Root', broadcast: true, megagroup: false
        })) as any;
        rootChannel = result.chats[0];
        const shouldArchive = JSON.parse(localStorage.getItem('drive_auto_archive') ?? 'true');
        if (shouldArchive) {
          await client.invoke(new Api.folders.EditPeerFolders({
            folderPeers: [new Api.InputFolderPeer({ peer: rootChannel, folderId: 1 })]
          }));
        }
      }
      if (rootChannel.accessHash) {
        saveChannelAccessHash(rootChannel.id, rootChannel.accessHash);
      }
      localStorage.setItem(rootStorageKey, rootChannel.id.toString());
      channels.push({
        id: rootChannel.id.toString(),
        name: 'Cloud Root',
        rawId: rootChannel.id,
        accessHash: rootChannel.accessHash ? rootChannel.accessHash.toString() : undefined,
        isCreator: true
      });

      const aboutCacheKey = `zud_channel_about_cache_${activeAccountId || 'default'}`;
      let aboutCache: { [id: string]: string } = {};
      try {
        const saved = localStorage.getItem(aboutCacheKey);
        if (saved) aboutCache = JSON.parse(saved);
      } catch {}

      const knownIds = new Set(availableChannels.map(c => c.id));

      // Filter dialogs to relevant channels only (skip normal public channels user only follows)
      const candidateDialogs = dialogs.filter((dialog: any) => {
        const entity = dialog.entity;
        if (entity?.className !== 'Channel' || entity.id.toString() === rootChannel.id.toString()) return false;
        const idStr = entity.id.toString();
        if (knownIds.has(idStr) || aboutCache[idStr] !== undefined) return true;
        if (entity.creator || entity.adminRights?.postMessages || entity.adminRights) return true;
        return false;
      });

      // Concurrency pool to fetch channel descriptions in parallel
      const poolLimit = 6;
      const fetchCandidate = async (dialog: any) => {
        const entity = dialog.entity;
        const idStr = entity.id.toString();
        const name = dialog.title || `Channel ${idStr}`;
        let about = aboutCache[idStr];
        if (about === undefined) {
          try {
            const full: any = await client.invoke(new Api.channels.GetFullChannel({ channel: entity }));
            about = String(full?.fullChat?.about || '');
            aboutCache[idStr] = about;
          } catch (error) {
            console.warn(`Could not read description for channel ${entity.id}:`, error);
            return null;
          }
        }
        if (about === 'ZUD_CLOUD_DIR') about = `Cloud storage for ${name}`;
        const isMatched = about === `Cloud playlist for ${name}` || about === `Cloud storage for ${name} [playlist]` || about.startsWith(`Cloud playlist for ${name}`) || about === `Cloud storage for ${name}`;
        if (!isMatched) return null;
        if (entity.accessHash) {
          saveChannelAccessHash(idStr, entity.accessHash);
        }
        return {
          id: idStr,
          name,
          rawId: entity.id,
          accessHash: entity.accessHash ? entity.accessHash.toString() : undefined,
          isCreator: Boolean(entity.creator || entity.adminRights)
        };
      };

      for (let i = 0; i < candidateDialogs.length; i += poolLimit) {
        const chunk = candidateDialogs.slice(i, i + poolLimit);
        const chunkResults = await Promise.all(chunk.map(fetchCandidate));
        for (const item of chunkResults) {
          if (item) channels.push(item);
        }
      }

      try {
        localStorage.setItem(aboutCacheKey, JSON.stringify(aboutCache));
        localStorage.setItem(channelsStorageKey, JSON.stringify(channels));
      } catch {}

      setAvailableChannels(channels);
    } catch (err: any) {
      console.error('Failed to load channels:', err);
      const errMsg = String(err?.message || err);
      if (errMsg.includes('AUTH_KEY_UNREGISTERED') || errMsg.includes('SESSION_REVOKED') || errMsg.includes('401')) {
        handleSessionRevoked(activeAccountId || undefined);
        return;
      }
    } finally {
      setLoading(false);
    }
  };
  const rebuildRoot = async () => {
    const newRoot: VirtualFolder = {
      id: 'root',
      name: 'ZUD Cloud',
      path: 'root',
      files: [],
      folders: {}
    };

    for (const ch of availableChannels) {
      newRoot.folders[ch.id] = {
        id: ch.id,
        name: ch.name,
        path: ch.id,
        files: [],
        folders: {},
        isLoaded: false,
        channelId: (ch as any).rawId || ch.id,
        accessHash: (ch as any).accessHash
      };
    }

    // Immediately hydrate all available channels from IndexedDB in parallel!
    await Promise.all(
      availableChannels.map(async (ch) => {
        try {
          const cached = await loadChannelCache(String(ch.id));
          if (cached && newRoot.folders[ch.id]) {
            hydrateChannelFromCache(newRoot.folders[ch.id], cached, filesMapRef.current);
          }
        } catch (e) {
          console.warn('Failed to hydrate channel from cache:', ch.id, e);
        }
      })
    );

    // If currently at root, update it. Otherwise don't break navigation
    let newStack = pathStack.length <= 1 ? [newRoot] : [...pathStack];
    if (newStack.length > 1) {
      newStack[0] = newRoot;
    }

    const hash = window.location.hash;
    if (pathStack.length <= 1 && hash.startsWith('#/')) {
      await restoreFromHash(hash, newRoot);
    } else {
      setCurrentFolder(newStack[newStack.length - 1]);
      setPathStack(newStack);
    }
  };

  const restoreFromHash = async (hash: string, rootFolder: VirtualFolder) => {
    try {
      let isFile = false;
      let targetId = '';
      if (hash.startsWith('#/folder/')) {
        targetId = decodeURIComponent(hash.substring(9));
      } else if (hash.startsWith('#/file/')) {
        targetId = decodeURIComponent(hash.substring(7));
        isFile = true;
      }
      
      if (!targetId || targetId === 'root') {
        setCurrentFolder(rootFolder);
        setPathStack([rootFolder]);
        return;
      }

      const parts = targetId.split('/');
      const channelId = parts[0];
      let channelFolder = rootFolder.folders[channelId];
      if (!channelFolder && zudRootChannelId) {
        channelFolder = rootFolder.folders[zudRootChannelId];
      }
      if (!channelFolder) {
         setCurrentFolder(rootFolder);
         setPathStack([rootFolder]);
         return;
      }

      if (!channelFolder.isLoaded && client) {
        setLoading(true);
        try {
          await syncChannelFiles(client, channelFolder, filesMapRef.current, () => {
            syncFolderStack();
          });
        } finally {
          setLoading(false);
        }
      }

      const newStack = [rootFolder];
      let current = channelFolder;
      newStack.push(current);

      if (!isFile) {
         // It's a folder, traverse down
         for (let i = 1; i < parts.length; i++) {
           const sub = current.folders[parts[i]];
           if (sub) {
             current = sub;
             newStack.push(current);
           } else break;
         }
         setCurrentFolder(current);
         setPathStack(newStack);
      } else {
         // It's a file. Traverse down to the parent folder
         for (let i = 1; i < parts.length - 1; i++) {
           const sub = current.folders[parts[i]];
           if (sub) {
             current = sub;
             newStack.push(current);
           } else break;
         }
         setCurrentFolder(current);
         setPathStack(newStack);
         const targetFile = current.files.find(f => f.id === targetId);
         if (targetFile) {
           if (isAudioFile(targetFile)) {
             const audioQueue = current.files.filter(isAudioFile);
             playTrack(targetFile, audioQueue);
           } else {
             setActiveFile(targetFile);
           }
         }
      }
    } catch (e) {
      console.error("Failed to restore from hash:", e);
      setCurrentFolder(rootFolder);
      setPathStack([rootFolder]);
    }
  };

  useEffect(() => {
    if (!client) return;

    const handleSWMessage = (event: MessageEvent) => {
      if (event.data && event.data.type === 'FETCH_CHUNK') {
        handleRequestSync(event).catch(console.error);
      } else if (event.data && event.data.type === 'FETCH_THUMB') {
        handleFetchThumb(event).catch(console.error);
      }
    };
    
    // One resolved InputPeer per channel (avoids repeated entity lookups)
    const entityCache = new Map<string, Promise<any>>();
    const resolveEntity = (rawChannel: string) => {
      const ck = (!rawChannel || rawChannel === 'me') ? 'me' : rawChannel;
      let p = entityCache.get(ck);
      if (!p) {
        p = resolveTelegramEntity(client, ck).catch((e: any) => {
          entityCache.delete(ck);
          throw e;
        });
        entityCache.set(ck, p);
      }
      return p;
    };

    interface StreamSessionHandle {
      id: string;
      cancel: (keepPortOpenMs?: number) => void;
      onCancel: (cb: () => void) => () => void;
      isHeader: boolean;
      partIndex: number;
      lastPullAt: number;
      demoted: boolean;
      isCancelled: () => boolean;
      createdAt: number;
    }

    // Track active streaming sessions so seeks preempt stale ranges without poisoning active browser fetches
    const activeStreamSessions = new Map<string, Set<StreamSessionHandle>>();
    const activePreviewSessions = new Map<string, Set<StreamSessionHandle>>();
    const knownMediaDcCache = new Map<string, number>();
    const rememberMediaDc = (mediaKey: string, dcId: number) => {
      if (!dcId) return;
      if (knownMediaDcCache.size > 500) {
        const oldest = knownMediaDcCache.keys().next().value;
        if (oldest !== undefined) knownMediaDcCache.delete(oldest);
      }
      knownMediaDcCache.set(mediaKey, dcId);
    };

    const cancelAllSessionsForFile = (fid: string, opts?: { excludePart?: number; keepPortOpenMs?: number }) => {
      const keepPortOpenMs = opts?.keepPortOpenMs ?? 0;
      const excludePart = opts?.excludePart;

      const previewSet = activePreviewSessions.get(fid);
      if (previewSet) {
        for (const pv of Array.from(previewSet)) {
          if (excludePart !== undefined && pv.partIndex === excludePart) continue;
          try { pv.cancel(keepPortOpenMs); } catch (_) {}
          previewSet.delete(pv);
        }
        if (previewSet.size === 0) activePreviewSessions.delete(fid);
      }
      const sessions = activeStreamSessions.get(fid);
      if (sessions) {
        for (const s of Array.from(sessions)) {
          if (excludePart !== undefined && s.partIndex === excludePart) {
            continue;
          }
          try { s.cancel(keepPortOpenMs); } catch (_) {}
          sessions.delete(s);
        }
        if (sessions.size === 0) {
          activeStreamSessions.delete(fid);
        }
      }
    };

    // Direct single-RPC thumbnail loader across dual-lane Cloudflare DC pool (14 concurrent)
    const thumbLimiter = createLimiter(14);

    const loadThumbBlob = async (messageId: string): Promise<Blob> => {
      thumbActivityStart();
      try {
        const [channelIdStr, msgIdStr] = messageId.split('_');
        const parsedChannelId = msgIdStr ? channelIdStr : undefined;
        const parsedMsgId = msgIdStr ? parseInt(msgIdStr) : parseInt(channelIdStr);
        const rawChannel = (!parsedChannelId || parsedChannelId === 'me' || parsedChannelId === '[object Object]') ? 'me' : parsedChannelId;
        const mediaKey = `${rawChannel}_${parsedMsgId}`;
        const homeDcId = Number((client.session as any)?.dcId || 4);
        const entity = await resolveEntity(rawChannel);

        for (let attempt = 0; attempt < 2; attempt++) {
          const msg = await fetchMessageBatched(client, entity, rawChannel, parsedMsgId);
          if (!msg || !msg.media) throw new Error(`Message not found: ${messageId}`);

          let docObj: any = null;
          let photoObj: any = null;

          if ((msg.media as any)?.videoCover) {
            photoObj = (msg.media as any).videoCover;
          } else if (msg.media.className === 'MessageMediaDocument' && msg.media.document) {
            docObj = msg.media.document;
          } else if (msg.media.className === 'MessageMediaPhoto' && msg.media.photo) {
            photoObj = msg.media.photo;
          }

          const rawThumbs: any[] = docObj?.thumbs || photoObj?.sizes || [];
          const validThumbs = rawThumbs.filter(
            (t: any) => t && t.className !== 'PhotoPathSize' && t.className !== 'PhotoSizeEmpty' && t.className !== 'VideoSize'
          );

          if (validThumbs.length === 0) {
            throw new Error('No thumbnail found in media: ' + messageId);
          }

          // Prefer crisp card-sized JPEGs (<= 800px, ~20-65KB) over multi-megabyte full 2560px 'w' photos!
          const downloadableThumbs = validThumbs.filter(
            (t: any) => t.className !== 'PhotoStrippedSize' && t.className !== 'PhotoCachedSize'
          );

          let chosenThumb: any = null;
          if (downloadableThumbs.length > 0) {
            const rankThumb = (t: any) => {
              const maxDim = Math.max(Number(t?.w || 0), Number(t?.h || 0));
              if (maxDim > 0 && maxDim <= 850) return 10000 + maxDim;
              if (maxDim > 850) return 5000 - Math.min(4000, maxDim);
              const typeScore: Record<string, number> = { x: 900, m: 800, y: 700, c: 650, b: 600, s: 500, d: 450, w: 300, a: 200 };
              return typeScore[String(t?.type || '')] || 100;
            };
            chosenThumb = [...downloadableThumbs].sort((a, b) => rankThumb(b) - rankThumb(a))[0];
          } else {
            // Instant 0-network fallback using inline cached/stripped bytes inside the Message!
            const inlineThumb = validThumbs.find((t: any) => t.className === 'PhotoCachedSize') || validThumbs[0];
            if (inlineThumb?.bytes) {
              const jpgBytes = inlineThumb.className === 'PhotoStrippedSize' && typeof (tgUtils as any)?.strippedPhotoToJpg === 'function'
                ? (tgUtils as any).strippedPhotoToJpg(inlineThumb.bytes)
                : inlineThumb.bytes;
              if (jpgBytes && jpgBytes.length > 0) {
                return new Blob([new Uint8Array(jpgBytes)], { type: 'image/jpeg' });
              }
            }
            throw new Error('No downloadable thumbnail in media: ' + messageId);
          }

          const location = docObj
            ? new Api.InputDocumentFileLocation({
                id: docObj.id,
                accessHash: docObj.accessHash,
                fileReference: docObj.fileReference,
                thumbSize: String(chosenThumb.type || ''),
              })
            : new Api.InputPhotoFileLocation({
                id: photoObj.id,
                accessHash: photoObj.accessHash,
                fileReference: photoObj.fileReference,
                thumbSize: String(chosenThumb.type || 'x'),
              });

          let thumbDcId = knownMediaDcCache.get(mediaKey)
            ?? Number(docObj?.dcId || photoObj?.dcId || homeDcId);
          rememberMediaDc(mediaKey, thumbDcId);

          try {
            const bytes = await thumbLimiter(async () => {
              const parts: Uint8Array[] = [];
              let offset = 0;
              const STEP = 512 * 1024;
              for (let chunkIdx = 0; chunkIdx < 6; chunkIdx++) {
                const req = new Api.upload.GetFile({
                  location,
                  offset: bigInt(offset) as any,
                  limit: STEP,
                });
                let res: any = null;
                for (let dcTry = 0; dcTry < 2; dcTry++) {
                  try {
                    const sent = await sendWithDcSender<any>(client, thumbDcId, req, 10000);
                    res = sent.result;
                    break;
                  } catch (rpcErr: any) {
                    const em = String(rpcErr?.message || rpcErr?.errorMessage || rpcErr || '');
                    const mig = rpcErr?.newDc || Number((em.match(/stored in DC (\d+)|FILE_MIGRATE_(\d+)/i) || [])[1] || (em.match(/FILE_MIGRATE_(\d+)/i) || [])[1] || 0);
                    if (mig && dcTry === 0) {
                      thumbDcId = mig;
                      rememberMediaDc(mediaKey, mig);
                      continue;
                    }
                    throw rpcErr;
                  }
                }
                const chunkBuf = res?.bytes;
                if (!chunkBuf || chunkBuf.length === 0) break;
                parts.push(new Uint8Array(chunkBuf));
                offset += chunkBuf.length;
                if (chunkBuf.length < STEP) break;
              }
              return parts;
            });

            if (!bytes || bytes.length === 0) throw new Error('Empty thumbnail response');
            return new Blob(bytes as any, { type: 'image/jpeg' });
          } catch (e: any) {
            const errMsg = String(e?.message || e?.errorMessage || e || '');
            const floodSec = getFloodWaitSeconds(e);
            if (floodSec > 0 && attempt < 1) {
              await new Promise(r => setTimeout(r, Math.min(floodSec, 12) * 1000));
              continue;
            }
            if (attempt === 0 && /FILE_REFERENCE/i.test(errMsg)) {
              invalidateMessage(rawChannel, parsedMsgId);
              continue;
            }
            if (attempt === 0 && /disconnected|reconnect|closed|timeout|not connected/i.test(errMsg)) {
              await invalidateDcSender(client, thumbDcId);
              continue;
            }
            throw e;
          }
        }
        throw new Error(`Thumbnail unavailable: ${messageId}`);
      } finally {
        thumbActivityEnd();
      }
    };

    const handleFetchThumb = async (event: MessageEvent) => {
      const { messageId } = event.data; // messageId is now the compound key
      const port = event.ports[0];
      if (!port) return;

      try {
        // Identical concurrent requests share a single Telegram round-trip
        const blob = await dedupeInflight(`thumb:${messageId}`, () => loadThumbBlob(String(messageId)));
        port.postMessage({ type: 'DATA', blob });
      } catch (err: any) {
        logger.error(`[SW FETCH_THUMB ERROR] for ${messageId}: ${err.message}`, err);
        port.postMessage({ type: 'ERROR', error: err.message });
      }
    };

    const handleRequestSync = async (event: MessageEvent) => {
      const { fileId, range, url } = event.data;
      const port = event.ports[0];
      if (!port) return;

      const getErrMsg = (e: any): string => String(e?.message || e?.errorMessage || e || 'Unknown error');

      const parsedUrl = new URL(url);
      const partParam = parsedUrl.searchParams.get('part');
      const isPreviewRequest = parsedUrl.searchParams.get('preview') === 'true';

      let isCancelled = false;
      let portClosed = false;
      let terminalPosted = false;
      let pullQueue: (() => void)[] = [];
      let cancelWaitTimer: any = null;
      const cancelCallbacks = new Set<() => void>();
      let resolveSessionCancel!: (v: null) => void;
      const sessionCancelPromise = new Promise<null>((resolve) => {
        resolveSessionCancel = resolve;
      });
      const onSessionCancel = (cb: () => void) => {
        if (isCancelled) {
          try { cb(); } catch (_) {}
          return () => {};
        }
        cancelCallbacks.add(cb);
        return () => cancelCallbacks.delete(cb);
      };

      const closePortWithCancel = () => {
        if (portClosed) return;
        portClosed = true;
        if (!terminalPosted) {
          terminalPosted = true;
          try { port.postMessage({ type: 'CANCEL', error: 'Stream cancelled' }); } catch (_) {}
        }
        try { port.onmessage = null; } catch (_) {}
        try { port.close(); } catch (_) {}
      };

      const postTerminal = (payload: any) => {
        if (portClosed || terminalPosted) return;
        terminalPosted = true;
        try { port.postMessage(payload); } catch (_) {}
        try { port.onmessage = null; } catch (_) {}
      };

      // High-throughput streaming runway (256KB chunks): 16 initial tokens (4MB, max 32 = 8MB), preview: 6 initial tokens (1.5MB, max 8)
      let pullTokens = isPreviewRequest ? 6 : 16;
      const maxPullTokens = isPreviewRequest ? 8 : 32;
      let swPullCount = 0;

      const cancelSession = (keepPortOpenMs = 0) => {
        if (!isCancelled) {
          isCancelled = true;
          try { resolveSessionCancel(null); } catch (_) {}
          while (pullQueue.length) {
            const r = pullQueue.shift();
            if (r) r();
          }
          for (const cb of Array.from(cancelCallbacks)) {
            try { cb(); } catch (_) {}
          }
          cancelCallbacks.clear();
          if (keepPortOpenMs > 0) {
            cancelWaitTimer = setTimeout(closePortWithCancel, keepPortOpenMs);
          } else {
            closePortWithCancel();
          }
        } else if (keepPortOpenMs === 0 && !portClosed) {
          if (cancelWaitTimer) {
            clearTimeout(cancelWaitTimer);
            cancelWaitTimer = null;
          }
          closePortWithCancel();
        }
      };

      const rangeMatch = range ? range.match(/bytes=(\d+)-(\d*)/) : null;
      const reqStartByte = rangeMatch ? parseInt(rangeMatch[1], 10) : 0;
      const hasExplicitEnd = Boolean(rangeMatch && rangeMatch[2]);
      const reqExplicitEnd = hasExplicitEnd ? parseInt(rangeMatch![2], 10) : -1;
      const partParamNum = partParam !== null ? parseInt(partParam, 10) : -1;

      const resolveSyncFile = (): VirtualFile | undefined => {
        let f: VirtualFile | undefined = filesMapRef.current[fileId];
        if (!f) {
          const decoded = decodeURIComponent(fileId);
          f = filesMapRef.current[decoded];
        }
        if (!f) {
          f = getRegisteredPlayableFile(fileId) || getRegisteredPlayableFile(decodeURIComponent(fileId));
        }
        if (!f && currentFolder) {
          f = currentFolder.files?.find(
            x => x.id === fileId || x.name === fileId || x.id === decodeURIComponent(fileId) || x.name === decodeURIComponent(fileId)
          );
        }
        if (!f) {
          f = Object.values(filesMapRef.current).find(x => x.id === fileId || x.name === fileId);
        }
        return f;
      };

      const computeIsMetadataProbe = (vSize: number): boolean => {
        const len = hasExplicitEnd && reqExplicitEnd >= reqStartByte ? (reqExplicitEnd - reqStartByte + 1) : 0;
        const isSmallHead = reqStartByte === 0 && hasExplicitEnd && len <= 4 * 1024 * 1024;
        const isNearTail = vSize > 0 && reqStartByte >= Math.max(0, vSize - 8 * 1024 * 1024) && (!hasExplicitEnd || len <= 4 * 1024 * 1024);
        const isSmallBounded = hasExplicitEnd && len > 0 && len <= 1.5 * 1024 * 1024;
        return isSmallHead || isNearTail || isSmallBounded;
      };

      const syncFile = resolveSyncFile();
      let tentativeVirtualSize = 0;
      let initialPartIdx = partParamNum >= 0 ? partParamNum : 0;
      if (syncFile) {
        if (partParamNum >= 0 && partParamNum < syncFile.parts.length) {
          tentativeVirtualSize = syncFile.parts[partParamNum].size || 0;
        } else {
          tentativeVirtualSize = syncFile.parts.reduce((t, p) => t + Math.max(0, p.size || 0), 0) || syncFile.size || 0;
          if (syncFile.parts.length > 1) {
            let off = reqStartByte;
            for (let i = 0; i < syncFile.parts.length; i++) {
              if (off < (syncFile.parts[i].size || 0)) {
                initialPartIdx = i;
                break;
              }
              off -= (syncFile.parts[i].size || 0);
            }
          }
        }
      }

      const isHeaderRequest = computeIsMetadataProbe(tentativeVirtualSize);
      const reqId = Math.random().toString(36).slice(2);
      const sessionObj: StreamSessionHandle = {
        id: reqId,
        cancel: cancelSession,
        onCancel: onSessionCancel,
        isHeader: isHeaderRequest,
        partIndex: initialPartIdx,
        lastPullAt: Date.now(),
        demoted: false,
        isCancelled: () => isCancelled,
        createdAt: Date.now(),
      };

      let sessionSet = activeStreamSessions.get(fileId);
      if (!sessionSet) {
        sessionSet = new Set();
        activeStreamSessions.set(fileId, sessionSet);
      }

      if (isPreviewRequest) {
        let previewSet = activePreviewSessions.get(fileId);
        if (!previewSet) {
          previewSet = new Set();
          activePreviewSessions.set(fileId, previewSet);
        }
        // Never kill an active moov/header probe on previewVideo! Only preempt older non-header seek ranges
        if (!isHeaderRequest) {
          for (const prev of Array.from(previewSet)) {
            if (!prev.isHeader) {
              try { prev.cancel(60); } catch (_) {}
              previewSet.delete(prev);
            }
          }
        }
        previewSet.add(sessionObj);
      } else {
        // If opening a new video/document file, sweep any orphaned non-audio stream sessions left by closed viewers
        if (!syncFile || !isAudioFile(syncFile)) {
          for (const [otherFid, otherSet] of Array.from(activeStreamSessions.entries())) {
            if (otherFid === fileId || decodeURIComponent(otherFid) === decodeURIComponent(fileId)) continue;
            const otherFile = filesMapRef.current[otherFid] || filesMapRef.current[decodeURIComponent(otherFid)] || getRegisteredPlayableFile(otherFid);
            if (otherFile && isAudioFile(otherFile)) continue;
            for (const staleSession of Array.from(otherSet)) {
              try { staleSession.cancel(0); } catch (_) {}
            }
            activeStreamSessions.delete(otherFid);
          }
          for (const [otherPreviewFid, stalePreviewSet] of Array.from(activePreviewSessions.entries())) {
            if (otherPreviewFid === fileId || decodeURIComponent(otherPreviewFid) === decodeURIComponent(fileId)) continue;
            for (const sp of Array.from(stalePreviewSet)) {
              try { sp.cancel(0); } catch (_) {}
            }
            activePreviewSessions.delete(otherPreviewFid);
          }
        }

        if (!isHeaderRequest) {
          const nowTs = Date.now();
          const demotedKeepers: StreamSessionHandle[] = [];
          for (const prev of Array.from(sessionSet)) {
            if (prev.isHeader) continue;
            if (prev.partIndex !== sessionObj.partIndex || prev.demoted || nowTs - prev.lastPullAt > 1200) {
              try { prev.cancel(150); } catch (_) {}
              sessionSet.delete(prev);
            } else {
              prev.demoted = true;
              demotedKeepers.push(prev);
            }
          }
          // Keep at most 1 demoted overlapping range so 1,000+ rapid seeks never pile up
          while (demotedKeepers.length > 1) {
            const oldest = demotedKeepers.shift()!;
            try { oldest.cancel(150); } catch (_) {}
            sessionSet.delete(oldest);
          }
        }
        sessionSet.add(sessionObj);
      }

      port.onmessage = (e) => {
        if (!e.data) return;
        if (e.data.type === 'CANCEL') {
          if (cancelWaitTimer) {
            clearTimeout(cancelWaitTimer);
            cancelWaitTimer = null;
          }
          cancelSession(0);
          logger.info(`Stream cancelled for file ${fileId}`);
        } else if (e.data.type === 'PULL') {
          swPullCount++;
          sessionObj.lastPullAt = Date.now();
          if (pullQueue.length > 0) {
            pullQueue.shift()!();
          } else {
            pullTokens = Math.min(pullTokens + 1, maxPullTokens);
          }
        }
      };

      const waitForPull = async (chunksDelivered: number) => {
        if (isCancelled) return;
        if (sessionObj.demoted && Date.now() - sessionObj.lastPullAt > 1200) {
          cancelSession(150);
          return;
        }
        if (pullTokens > 0) {
          pullTokens--;
          return;
        }
        return new Promise<void>(resolve => {
          let resolved = false;
          let fallbackTimer: any = null;
          const done = () => {
            if (!resolved) {
              resolved = true;
              if (fallbackTimer) {
                clearTimeout(fallbackTimer);
                fallbackTimer = null;
              }
              resolve();
            }
          };
          pullQueue.push(done);
          if (sessionObj.demoted) {
            fallbackTimer = setTimeout(() => {
              if (!resolved && sessionObj.demoted && Date.now() - sessionObj.lastPullAt > 1200) {
                cancelSession(150);
              }
              done();
            }, 1250);
          } else if (swPullCount < 2 && chunksDelivered < 12) {
            // Startup safety fallback only before SW pull loop settles; paused streams wait quietly without bloating RAM
            fallbackTimer = setTimeout(done, 1000);
          }
        });
      };

      try {
        const file = syncFile || resolveSyncFile();
        if (!file) {
          logger.error(`File not found in VFS: ${fileId}. Current map keys: ${Object.keys(filesMapRef.current).length}`);
          throw new Error("File not found in VFS");
        }

        const targetPartIndex = partParamNum;

        let aggregatePartSize = file.parts.reduce((total, part) => total + Math.max(0, part.size || 0), 0);
        let virtualSize = aggregatePartSize || file.size || 0;

        // Self-heal: If virtualSize is 0 or first part size is 0, pre-fetch first part message to discover real size
        if ((virtualSize <= 0 || file.parts[0]?.size <= 0) && file.parts.length > 0) {
          try {
            const firstPart = file.parts[0];
            const rawChan = firstPart.channelId ? String(firstPart.channelId) : 'me';
            const ent = await resolveEntity(rawChan);
            const firstMsg = await fetchMessageUrgent(client, ent, rawChan, firstPart.messageId);
            if (firstMsg?.media?.document) {
              const actualDocSize = parseDocSize(firstMsg.media.document.size);
              if (actualDocSize > 0) {
                firstPart.size = actualDocSize;
                file.size = actualDocSize;
                aggregatePartSize = actualDocSize;
                virtualSize = actualDocSize;
              }
            }
          } catch (e) {
            logger.warn('Failed to pre-resolve file size from message:', e);
          }
        }

        if (isCancelled) return;

        if (targetPartIndex >= 0 && targetPartIndex < file.parts.length) {
          virtualSize = file.parts[targetPartIndex].size;
        }

        sessionObj.isHeader = computeIsMetadataProbe(virtualSize);

        const startByte = reqStartByte;
        let endByte = hasExplicitEnd ? reqExplicitEnd : (virtualSize > 0 ? virtualSize - 1 : 0);
        // Never truncate byte-0 / moov metadata probes (otherwise >1MB moov atoms split into 3 slow HTTP retries!);
        // for mid-file preview scrubbing, cap at 2.5MB (~5-10s forward window) so smooth mouse/finger glides decode from RAM!
        if (isPreviewRequest && !hasExplicitEnd && !sessionObj.isHeader && startByte > 0) {
          endByte = Math.min(endByte, startByte + 2.5 * 1024 * 1024 - 1);
        }

        const effectiveMime = isAudioFile(file) ? getAudioMimeType(file.name, file.mimeType) : getMimeType('video', file.name, file.mimeType);
        logger.info(`Requested range for ${file.name}: bytes=${startByte}-${endByte} (part: ${targetPartIndex}, mime: ${effectiveMime})`);

        if (virtualSize > 0 && startByte >= virtualSize) {
          if (!isCancelled && !portClosed) {
            try { port.postMessage({ type: 'HEADERS', start: startByte, end: startByte, total: virtualSize, mimeType: effectiveMime, preview: isPreviewRequest }); } catch (_) {}
            postTerminal({ type: 'END' });
          }
          logger.warn(`Requested start byte ${startByte} is out of bounds for size ${virtualSize}`);
          return;
        }

        if (endByte >= virtualSize) endByte = virtualSize - 1;

        let currentOffset = startByte;
        let partIndex = -1;
        let localOffset = 0;

        if (targetPartIndex >= 0) {
          partIndex = targetPartIndex;
          localOffset = startByte;
        } else if (file.parts.length <= 1) {
          partIndex = 0;
          localOffset = startByte;
        } else {
          for (let i = 0; i < file.parts.length; i++) {
            const pSize = file.parts[i].size;
            if (currentOffset < pSize) {
              partIndex = i;
              localOffset = currentOffset;
              break;
            }
            currentOffset -= pSize;
          }
          if (partIndex < 0 && file.parts.length > 0) {
            partIndex = 0;
            localOffset = startByte;
          }
        }
        if (partIndex < 0) {
          throw new Error(`Range start ${startByte} does not map to any part of ${file.name} (${aggregatePartSize} bytes).`);
        }

        sessionObj.partIndex = partIndex;

        const limit = endByte - startByte + 1;
        if (isCancelled || portClosed) return;
        try {
          port.postMessage({ type: 'HEADERS', start: startByte, end: endByte, total: virtualSize, mimeType: effectiveMime, preview: isPreviewRequest });
        } catch (_) {
          cancelSession(0);
          return;
        }

        let bytesSent = 0;
        let chunksDelivered = 0;
        let previewAborted = false;
        let currentPartIndex = partIndex;
        let currentLocalOffset = localOffset;
        const homeDcId = Number((client.session as any)?.dcId || 4);

        while (bytesSent < limit && currentPartIndex < file.parts.length && !isCancelled && !previewAborted) {
          if (targetPartIndex >= 0 && currentPartIndex !== targetPartIndex) break;
          const partInfo = file.parts[currentPartIndex];
          if (!partInfo) throw new Error("File part missing");

          logger.info(`[SW FETCH_SYNC] partInfo: partNum=${partInfo.partNum}, msgId=${partInfo.messageId}, channelId=${partInfo.channelId}`);

          const rawChannel = partInfo.channelId ? String(partInfo.channelId) : 'me';
          const mediaKey = `${rawChannel}_${partInfo.messageId}`;
          if (!sessionObj.demoted && !isPreviewRequest && !isCancelled) {
            window.dispatchEvent(new CustomEvent('streamProgress', {
              detail: {
                fileId,
                partIndex: currentPartIndex,
                reqId,
                preview: false,
                stage: 'connecting',
                fileName: file.name,
                sessionCreatedAt: sessionObj.createdAt,
                isHeader: sessionObj.isHeader,
              }
            }));
          }
          await ensureTelegramConnected(client);
          const entity = await resolveEntity(rawChannel);
          if (isCancelled) return;

          let msg: any = null;
          let messageError: any = null;
          for (let messageAttempt = 0; messageAttempt < 3 && !isCancelled; messageAttempt++) {
            try {
              msg = await fetchMessageUrgent(client, entity, rawChannel, partInfo.messageId);
              messageError = null;
              break;
            } catch (error: any) {
              messageError = error;
              if (/FILE_REFERENCE/i.test(getErrMsg(error))) {
                invalidateMessage(rawChannel, partInfo.messageId);
                continue;
              }
              await Promise.race([
                new Promise(resolve => setTimeout(resolve, 400 * (messageAttempt + 1))),
                sessionCancelPromise,
              ]);
            }
          }
          if (isCancelled) return;
          if (!msg || !msg.media) {
            throw messageError || new Error(`Telegram message/media not found for key: ${partInfo.channelId}_${partInfo.messageId}`);
          }

          if (msg && msg.media && msg.media.document) {
            const actualDocSize = parseDocSize(msg.media.document.size);
            if (actualDocSize > 0) {
              if (partInfo.size <= 0) partInfo.size = actualDocSize;
              if (file.size <= 0 || file.parts.length === 1) file.size = actualDocSize;
              if (virtualSize <= 0) virtualSize = actualDocSize;
            }
          }

          const pLimit = Math.min(limit - bytesSent, Math.max(0, partInfo.size - currentLocalOffset));
          const progressBase = currentLocalOffset;
          let partBytesSent = 0;
          const maxRetries = 5;
          let retryCount = 0;

          // Acquire persistent pooled MTProtoSender for BOTH home and foreign DCs and warm both lanes!
          let effectiveDcId: number = knownMediaDcCache.get(mediaKey)
            ?? Number((msg.media?.document as any)?.dcId || (msg.media?.photo as any)?.dcId || homeDcId);
          rememberMediaDc(mediaKey, effectiveDcId);
          void warmDcSenderLanes(client, effectiveDcId);

          if (!sessionObj.demoted && !isPreviewRequest && !isCancelled) {
            window.dispatchEvent(new CustomEvent('streamProgress', {
              detail: {
                fileId,
                partIndex: currentPartIndex,
                reqId,
                preview: false,
                stage: 'fetching',
                fileName: file.name,
                sessionCreatedAt: sessionObj.createdAt,
                isHeader: sessionObj.isHeader,
              }
            }));
          }

          while (partBytesSent < pLimit && !isCancelled && !previewAborted && retryCount < maxRetries) {
            try {
              const isAudio = isAudioFile(file);
              // 256KB MTProto chunks: 2x faster first-byte seek latency, 2x smoother progress steps,
              // exact 1MB divisor (zero boundary crossing), and half the cancelled bandwidth waste.
              const CHUNK_SIZE = 256 * 1024;

              let location: any;
              if (msg.media.className === 'MessageMediaDocument' && msg.media.document) {
                const doc = msg.media.document as Api.Document;
                location = new Api.InputDocumentFileLocation({
                  id: doc.id,
                  accessHash: doc.accessHash,
                  fileReference: doc.fileReference,
                  thumbSize: ''
                });
              } else if (msg.media.className === 'MessageMediaPhoto' && msg.media.photo) {
                const photo = msg.media.photo as Api.Photo;
                const sizes = photo.sizes as any[];
                location = new Api.InputPhotoFileLocation({
                  id: photo.id,
                  accessHash: photo.accessHash,
                  fileReference: photo.fileReference,
                  thumbSize: sizes[sizes.length - 1].type
                });
              } else {
                throw new Error("Unsupported media type for streaming");
              }

              const invokeGetFile = async (fetchOffset: number) => {
                if (isCancelled) return null;
                const chunkKey = `${rawChannel}_${partInfo.messageId}_${fetchOffset}_${CHUNK_SIZE}`;

                // 1. Instant cache hit: zero network overhead, zero latency
                const cached = getCachedStreamChunk(chunkKey);
                if (cached) {
                  return { bytes: Buffer.from(cached) };
                }

                // 2. Coalesce concurrent requests with ref-counted cancellation & instant slot detachment
                let entry = inflightStreamChunks.get(chunkKey);
                if (!entry) {
                  const entryWaiterWakeups = new Set<() => void>();
                  const newEntry: InflightStreamChunkEntry = {
                    subscribers: 0,
                    cancelled: false,
                    promise: Promise.resolve(null),
                    onEmptyCancel: entryWaiterWakeups,
                  } as any;

                  newEntry.promise = (async () => {
                    try {
                      const req = new Api.upload.GetFile({
                        location,
                        offset: bigInt(fetchOffset) as any,
                        limit: CHUNK_SIZE
                      });

                      for (let attempt = 0; attempt < 4; attempt++) {
                        if (newEntry.cancelled) return null;

                        // Priority -1: first 2 keyframe chunks of an active seek OR live hover preview!
                        // Priority  0: active playback runway (< 6 chunks)
                        // Priority  1: steady background lookahead (>= 6 chunks)
                        // Priority  2: demoted superseded range
                        const prio = sessionObj.demoted
                          ? 2
                          : isPreviewRequest
                            ? (chunksDelivered < 2 ? -1 : 0)
                            : (chunksDelivered < 2 ? -1 : (chunksDelivered < 6 ? 0 : 1));
                        let wakeRef: (() => void) | null = null;
                        const dcSlot = await acquireDcDownloadSlot(
                          effectiveDcId,
                          prio,
                          () => newEntry.cancelled,
                          (wake) => {
                            wakeRef = wake;
                            entryWaiterWakeups.add(wake);
                          },
                        );
                        if (wakeRef) entryWaiterWakeups.delete(wakeRef);

                        if (!dcSlot.acquired || newEntry.cancelled) {
                          dcSlot.release();
                          return null;
                        }

                        // If cancelled mid-RPC on the wire, free the logical slot immediately so new seeks never wait
                        const detachOnCancel = () => dcSlot.detachLogicalSlot();
                        entryWaiterWakeups.add(detachOnCancel);

                        let senderUsed: any = null;
                        try {
                          const sent = await sendWithDcSender<any>(client, effectiveDcId, req, 14000);
                          senderUsed = sent.sender;
                          const res = sent.result;

                          if (res && res.bytes && res.bytes.length > 0) {
                            setCachedStreamChunk(chunkKey, new Uint8Array(res.bytes));
                          }
                          if (newEntry.cancelled) return null;
                          return res;
                        } catch (err: any) {
                          senderUsed = err?._zudSenderUsed || senderUsed;
                          if (newEntry.cancelled) return null;
                          const errMsg = getErrMsg(err);

                          const migrateMatch = errMsg.match(/stored in DC (\d+)/i) || errMsg.match(/FILE_MIGRATE_(\d+)/i);
                          const migrateDc = err?.newDc || (migrateMatch ? parseInt(migrateMatch[1], 10) : null);
                          if (migrateDc && attempt < 3) {
                            logger.info(`Migrating GetFile to DC ${migrateDc}...`);
                            effectiveDcId = migrateDc;
                            rememberMediaDc(mediaKey, migrateDc);
                            continue;
                          }

                          if (/AUTH_KEY_UNREGISTERED|SESSION_REVOKED/i.test(errMsg)) {
                            await invalidateDcSender(client, effectiveDcId, senderUsed, { clearAuth: true });
                            if (attempt < 3) {
                              await new Promise(r => setTimeout(r, 150 * (attempt + 1)));
                              continue;
                            }
                          }

                          const floodSec = getFloodWaitSeconds(err);
                          if (floodSec > 0 && attempt < 3) {
                            await new Promise(r => setTimeout(r, Math.min(floodSec, 10) * 1000));
                            continue;
                          }

                          if (/disconnected|reconnect|closed|not connected|was closed|unsuccessful|timeout|usable|recycled|maximum reconnection|aborting|connection_not_inited/i.test(errMsg)) {
                            await invalidateDcSender(client, effectiveDcId, senderUsed);
                            if (attempt < 3) {
                              await new Promise(r => setTimeout(r, 160 * (attempt + 1)));
                              continue;
                            }
                          }

                          throw err;
                        } finally {
                          entryWaiterWakeups.delete(detachOnCancel);
                          dcSlot.release();
                        }
                      }
                      return null;
                    } finally {
                      if (inflightStreamChunks.get(chunkKey) === newEntry) {
                        inflightStreamChunks.delete(chunkKey);
                      }
                    }
                  })();

                  entry = newEntry;
                  inflightStreamChunks.set(chunkKey, entry);
                }

                entry.subscribers++;
                let releasedSub = false;
                const entryRef = entry as InflightStreamChunkEntry & { onEmptyCancel?: Set<() => void> };
                const releaseSub = () => {
                  if (releasedSub) return;
                  releasedSub = true;
                  entryRef.subscribers = Math.max(0, entryRef.subscribers - 1);
                  if (entryRef.subscribers === 0) {
                    entryRef.cancelled = true;
                    if (inflightStreamChunks.get(chunkKey) === entryRef) {
                      inflightStreamChunks.delete(chunkKey);
                    }
                    if (entryRef.onEmptyCancel) {
                      for (const wake of Array.from(entryRef.onEmptyCancel)) {
                        try { wake(); } catch (_) {}
                      }
                      entryRef.onEmptyCancel.clear();
                    }
                  }
                };
                const unsubCancel = onSessionCancel(releaseSub);
                try {
                  const res = await Promise.race([entryRef.promise, sessionCancelPromise]);
                  if (isCancelled) return null;
                  return res;
                } finally {
                  unsubCancel();
                  releaseSub();
                }
              };

              // Progressive 256KB runway across 3 DC lanes: 6 chunks (1.5MB) instant first-wave burst -> 16 chunks (4MB) steady
              let currentWindowSize = isPreviewRequest ? 4 : (isAudio ? 3 : 6);
              const MAX_WINDOW_SIZE = isPreviewRequest ? 6 : (isAudio ? 6 : 16);
              const slots: { promise: Promise<any>, prefixToDiscard: number }[] = [];
              let scheduled = partBytesSent;

              const fillWindow = () => {
                while (slots.length < currentWindowSize && scheduled < pLimit && !isCancelled) {
                  const absoluteOffset = currentLocalOffset + scheduled;
                  const fetchOffset = Math.floor(absoluteOffset / CHUNK_SIZE) * CHUNK_SIZE;
                  const prefixToDiscard = absoluteOffset - fetchOffset;
                  let timer: any;
                  const timeoutPromise = new Promise<null>((resolve, reject) => {
                    timer = setTimeout(() => {
                      if (isPreviewRequest) {
                        resolve(null);
                      } else {
                        reject(new Error('TIMEOUT'));
                      }
                    }, isPreviewRequest ? 12000 : 35000);
                  });
                  const promise: Promise<any> = Promise.race([
                    invokeGetFile(fetchOffset),
                    sessionCancelPromise,
                    timeoutPromise,
                  ]).finally(() => {
                    if (timer) clearTimeout(timer);
                  });
                  promise.catch(() => {}); // errors surface when the slot is consumed
                  slots.push({ promise, prefixToDiscard });
                  scheduled += Math.min(pLimit - scheduled, CHUNK_SIZE - prefixToDiscard);
                }
              };
              fillWindow();

              let naturalEof = false;
              while (partBytesSent < pLimit && !isCancelled && slots.length > 0) {
                const slot = slots.shift()!;
                const result: any = await slot.promise;
                if (isCancelled) {
                  slots.length = 0;
                  break;
                }
                if (!result) {
                  slots.length = 0;
                  if (isPreviewRequest) {
                    previewAborted = true;
                    break;
                  }
                  throw new Error('Chunk fetch returned empty result');
                }

                if (currentWindowSize < MAX_WINDOW_SIZE) {
                  currentWindowSize = Math.min(currentWindowSize + 3, MAX_WINDOW_SIZE);
                }

                fillWindow();

                const rawChunkBuffer = result.bytes as Buffer;
                if (!rawChunkBuffer || rawChunkBuffer.length === 0) {
                  slots.length = 0;
                  if (partBytesSent < pLimit && currentLocalOffset + partBytesSent < partInfo.size) {
                    throw new Error('Received empty 0-byte chunk before part EOF');
                  }
                  naturalEof = true;
                  break;
                }

                let chunkBuffer = rawChunkBuffer;
                if (slot.prefixToDiscard > 0) {
                  chunkBuffer = chunkBuffer.slice(slot.prefixToDiscard);
                }

                const bytesNeeded = pLimit - partBytesSent;
                if (chunkBuffer.length > bytesNeeded) {
                  chunkBuffer = chunkBuffer.slice(0, bytesNeeded);
                }

                if (chunkBuffer.length > 0) {
                  await waitForPull(chunksDelivered);
                  if (isCancelled || portClosed) {
                    slots.length = 0;
                    break;
                  }
                  const transferableChunk = new Uint8Array(chunkBuffer);
                  port.postMessage({ type: 'DATA', chunk: transferableChunk }, [transferableChunk.buffer]);
                  chunksDelivered++;
                  partBytesSent += chunkBuffer.length;
                  bytesSent += chunkBuffer.length;

                  window.dispatchEvent(new CustomEvent('downloadProgress', { detail: chunkBuffer.length }));
                  if (!sessionObj.demoted && !isCancelled) {
                    window.dispatchEvent(new CustomEvent('streamProgress', {
                      detail: {
                        fileId,
                        partIndex: currentPartIndex,
                        start: progressBase,
                        received: partBytesSent,
                        chunkLen: chunkBuffer.length,
                        reqId,
                        preview: isPreviewRequest,
                        fileName: file.name,
                        totalSize: file.size,
                        totalParts: file.parts.length,
                        mimeType: file.mimeType,
                        sessionCreatedAt: sessionObj.createdAt,
                        isHeader: sessionObj.isHeader,
                      }
                    }));
                  }
                }

                retryCount = 0; // Reset retries after every successful chunk
                if (rawChunkBuffer.length < CHUNK_SIZE) {
                  naturalEof = true;
                  break;
                }
              }

              if (isCancelled || previewAborted || partBytesSent >= pLimit || naturalEof) {
                break;
              }
            } catch (err: any) {
              if (isCancelled) return;
              const errMsg = getErrMsg(err);
              logger.error(`Stream error (retry ${retryCount + 1}/${maxRetries}): ${errMsg}`, { part: currentPartIndex, bytesSent, partBytesSent });

              const migrateMatch = errMsg.match(/stored in DC (\d+)/i) || errMsg.match(/FILE_MIGRATE_(\d+)/i);
              const migrateDc = err?.newDc || (migrateMatch ? parseInt(migrateMatch[1], 10) : null);
              if (migrateDc) {
                logger.info(`Migrating stream to DC ${migrateDc} on retry...`);
                effectiveDcId = migrateDc;
                rememberMediaDc(mediaKey, migrateDc);
              }

              if (/AUTH_KEY_UNREGISTERED|SESSION_REVOKED/i.test(errMsg)) {
                await invalidateDcSender(client, effectiveDcId, undefined, { clearAuth: true });
              } else if (/disconnected|reconnect|closed|not connected|was closed|unsuccessful|timeout|usable|recycled|maximum reconnection|aborting|connection_not_inited/i.test(errMsg)) {
                await invalidateDcSender(client, effectiveDcId);
              }

              if (/FILE_REFERENCE/i.test(errMsg)) {
                invalidateMessage(rawChannel, partInfo.messageId);
                const fresh = await fetchMessageUrgent(client, entity, rawChannel, partInfo.messageId).catch(() => null);
                if (fresh && fresh.media) msg = fresh;
              }

              retryCount++;
              if (retryCount >= maxRetries) {
                throw err instanceof Error ? err : new Error(errMsg);
              }

              const floodSec = getFloodWaitSeconds(err);
              const backoffMs = floodSec > 0 ? Math.min(floodSec, 10) * 1000 : 350 * retryCount;
              await Promise.race([
                new Promise(res => setTimeout(res, backoffMs)),
                sessionCancelPromise,
              ]);
            }
          }

          if (previewAborted) break;
          if (!isCancelled && partBytesSent < pLimit) {
            throw new Error(`Part ${partInfo.partNum} ended after ${partBytesSent} of ${pLimit} requested bytes.`);
          }

          currentPartIndex++;
          currentLocalOffset = 0;
        }

        if (previewAborted) {
          if (!isCancelled) {
            postTerminal({ type: 'END' });
          }
          return;
        }

        if (!isCancelled && bytesSent !== limit) {
          throw new Error(`Incomplete range for ${file.name}: sent ${bytesSent} of ${limit} requested bytes.`);
        }

        if (!isCancelled) {
          logger.info(`Stream completed for ${file.name}, sent ${bytesSent} bytes`);
          postTerminal({ type: 'END' });
        }

      } catch (error: any) {
        if (!isCancelled) {
          const errMsg = getErrMsg(error);
          logger.error(`[SW FETCH_SYNC ERROR] for fileId: ${fileId}: ${errMsg}`, error);
          postTerminal({ type: 'ERROR', error: errMsg });
        }
      } finally {
        if (isPreviewRequest) {
          const previewSet = activePreviewSessions.get(fileId);
          if (previewSet) {
            previewSet.delete(sessionObj);
            if (previewSet.size === 0) activePreviewSessions.delete(fileId);
          }
        } else {
          const setForFile = activeStreamSessions.get(fileId);
          if (setForFile) {
            setForFile.delete(sessionObj);
            if (setForFile.size === 0) {
              activeStreamSessions.delete(fileId);
            }
          }
        }
      }
    };

    // The ordered thumbnail queue tells us which thumbnails are coming (in order): resolve their
    // messages together (<=100 ids per GetMessages) so each thumbnail then only needs a GetFile.
    setThumbPrefetcher((keys: string[]) => {
      for (const key of keys) {
        const [chan, id] = key.includes('_') ? key.split('_') : ['me', key];
        const msgId = parseInt(id, 10);
        if (!msgId) continue;
        const raw = (!chan || chan === '[object Object]') ? 'me' : chan;
        resolveEntity(raw)
          .then((entity: any) => fetchMessageBatched(client, entity, raw, msgId))
          .catch(() => {});
      }
    });

    const handleCancelStreamEvent = (e: any) => {
      const fid = e.detail?.fileId;
      if (fid) {
        const isPartSwitch = e.detail?.reason === 'part-switch';
        const cancelOpts = {
          excludePart: e.detail?.excludePart,
          keepPortOpenMs: isPartSwitch ? 200 : 0,
        };
        cancelAllSessionsForFile(fid, cancelOpts);
        cancelAllSessionsForFile(decodeURIComponent(fid), cancelOpts);
      }
    };
    window.addEventListener('cancelStream', handleCancelStreamEvent);

    navigator.serviceWorker?.addEventListener('message', handleSWMessage);
    return () => {
      setThumbPrefetcher(null);
      window.removeEventListener('cancelStream', handleCancelStreamEvent);
      navigator.serviceWorker?.removeEventListener('message', handleSWMessage);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client]); // removed filesMap dependency

  const navigateToFolder = async (folder: VirtualFolder) => {
    const rootFolder = pathStackRef.current[0] || pathStack[0];
    const chanId = folder.id.split('/')[0];
    let chanFolder: VirtualFolder | undefined = rootFolder?.folders[chanId];
    if (!chanFolder && zudRootChannelId) {
      chanFolder = rootFolder?.folders[zudRootChannelId];
    }
    if (!chanFolder && folder.channelId) {
      chanFolder = Object.values(rootFolder?.folders || {}).find(
        f => String(f.id) === String(folder.channelId) || String(f.channelId) === String(folder.channelId)
      );
    }

    setCurrentFolder(folder);
    setPathStack(prev => [...prev, folder]);
    window.location.hash = `#/folder/${encodeURIComponent(folder.id)}`;

    const targetToSync = chanFolder || (folder.channelId ? folder : null);
    if (targetToSync && targetToSync.isLoaded === false && client) {
      setLoading(true);
      try {
        await syncChannelFiles(client, targetToSync, filesMapRef.current, () => {
          syncFolderStack();
        });
      } catch (err) {
        console.error("Failed to fetch messages for channel", err);
      } finally {
        setLoading(false);
      }
    }
  };

  const navigateUp = async (index: number) => {
    const newStack = pathStack.slice(0, index + 1);
    setPathStack(newStack);
    const targetFolder = newStack[newStack.length - 1];
    setCurrentFolder(targetFolder);
    window.location.hash = `#/folder/${encodeURIComponent(targetFolder.id)}`;

    // If navigating to root, ensure root channel is synced and loaded!
    if (targetFolder.id === 'root' && client && zudRootChannelId) {
      const rootNumId = channelNumericId(String(zudRootChannelId));
      const rootChanFolder = targetFolder.folders[zudRootChannelId] ||
        Object.values(targetFolder.folders).find(f => {
          const fNum = channelNumericId(String(f.id));
          return (fNum && rootNumId && fNum === rootNumId) || f.name === 'Cloud Root';
        });
      if (rootChanFolder && !rootChanFolder.isLoaded) {
        setLoading(true);
        try {
          await syncChannelFiles(client, rootChanFolder, filesMapRef.current, () => {
            syncFolderStack();
          });
        } catch (e) {
          console.warn('Could not sync root channel on navigateUp:', e);
        } finally {
          setLoading(false);
        }
      }
    }
  };

  const formatSize = (bytes: number) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  const formatDuration = (time?: number) => {
    if (!time || isNaN(time) || time <= 0) return '';
    const hrs = Math.floor(time / 3600);
    const mins = Math.floor((time % 3600) / 60);
    const secs = Math.floor(time % 60);
    if (hrs > 0) {
      return `${hrs}:${mins < 10 ? '0' : ''}${mins}:${secs < 10 ? '0' : ''}${secs}`;
    }
    return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
  };

  const getFolderItemStats = useCallback((folder: VirtualFolder) => {
    const directFolderCount = Object.keys(folder.folders || {}).length;
    const directFileCount = (folder.files || []).length;

    let recursiveFileCount = directFileCount;
    let recursiveFolderCount = directFolderCount;

    const stack = Object.values(folder.folders || {});
    while (stack.length > 0) {
      const current = stack.pop()!;
      recursiveFileCount += (current.files || []).length;
      const subChildren = Object.values(current.folders || {});
      recursiveFolderCount += subChildren.length;
      for (const child of subChildren) {
        stack.push(child);
      }
    }

    const chanId = folder.id.split('/')[0];
    const isChannelSyncing = syncingChannelIds.has(chanId);
    const isLoaded = folder.isLoaded !== false;

    return {
      directFolderCount,
      directFileCount,
      recursiveFileCount,
      recursiveFolderCount,
      totalDirectItems: directFolderCount + directFileCount,
      totalRecursiveItems: recursiveFolderCount + recursiveFileCount,
      isLoaded: isLoaded && (!isChannelSyncing || (directFolderCount + directFileCount > 0))
    };
  }, [syncingChannelIds]);

  const storageStats = useMemo(() => {
    const root = pathStackRef.current[0] || pathStack[0];
    const uniqueFiles = new Map<string, VirtualFile>();

    const traverse = (f: VirtualFolder) => {
      if (!f) return;
      if (f.files && Array.isArray(f.files)) {
        for (const file of f.files) {
          if (file && file.id) uniqueFiles.set(file.id, file);
        }
      }
      if (f.folders) {
        for (const childId of Object.keys(f.folders)) {
          traverse(f.folders[childId]);
        }
      }
    };

    if (root) {
      traverse(root);
    }

    if (filesMapRef.current) {
      for (const k in filesMapRef.current) {
        const file = filesMapRef.current[k];
        if (file && file.id && !uniqueFiles.has(file.id)) {
          uniqueFiles.set(file.id, file);
        }
      }
    }

    let totalBytes = 0;
    for (const file of uniqueFiles.values()) {
      totalBytes += (file.size || 0);
    }

    return {
      bytes: totalBytes,
      formatted: formatSize(totalBytes),
      fileCount: uniqueFiles.size,
    };
  }, [pathStack, currentFolder, isRefreshing]);

  const getFileTimestamp = useCallback((file: VirtualFile): number => {
    if (file.date && file.date > 0) return file.date;
    if (file.parts && file.parts.length > 0 && file.parts[0].messageId) {
      return file.parts[0].messageId;
    }
    return 0;
  }, []);

  const getFolderTimestamp = useCallback((folder: VirtualFolder): number => {
    if (folder.msgId && folder.msgId > 0) return folder.msgId;
    let maxTime = 0;
    if (folder.files) {
      for (const f of folder.files) {
        const t = getFileTimestamp(f);
        if (t > maxTime) maxTime = t;
      }
    }
    if (folder.folders) {
      for (const sub of Object.values(folder.folders)) {
        const t = getFolderTimestamp(sub);
        if (t > maxTime) maxTime = t;
      }
    }
    return maxTime;
  }, [getFileTimestamp]);

  const renderFolderItemCount = (folder: VirtualFolder) => {
    const stats = getFolderItemStats(folder);
    if (!stats.isLoaded) {
      return <span className="animate-pulse text-blue-500 dark:text-blue-400">Loading...</span>;
    }
    if (stats.directFolderCount > 0 && stats.recursiveFileCount > 0) {
      return <span>{stats.directFolderCount} {stats.directFolderCount === 1 ? 'folder' : 'folders'} • {stats.recursiveFileCount} {stats.recursiveFileCount === 1 ? 'file' : 'files'}</span>;
    }
    if (stats.directFolderCount > 0) {
      return <span>{stats.directFolderCount} {stats.directFolderCount === 1 ? 'folder' : 'folders'}</span>;
    }
    if (stats.recursiveFileCount > 0) {
      return <span>{stats.recursiveFileCount} {stats.recursiveFileCount === 1 ? 'file' : 'files'}</span>;
    }
    return <span>0 items</span>;
  };

  const renderFolderSection = (foldersList: VirtualFolder[]) => {
    if (foldersList.length === 0) return null;
    return (
      <section className="mb-8">
        <h2 className="text-sm font-bold uppercase tracking-wider mb-4 text-gray-500 dark:text-gray-400">
          Folders
        </h2>
        
        {/* Grid View */}
        {viewMode === 'grid' && (
          <div className={
            itemSize === 'small' 
              ? "grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-8 gap-2 sm:gap-3" 
              : itemSize === 'large' 
              ? "grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-4 gap-4 sm:gap-6" 
              : "grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3 sm:gap-4"
          }>
            {foldersList.map(folder => {
              const isSelected = selectedItems.has(folder.id);
              const isCut = clipboard?.action === 'move' && clipboard.items.some(i => i.type === 'folder' && i.item.id === folder.id);

              return (
                <div 
                  key={folder.id} 
                  onClick={(e) => {
                    if (longPressHandledRef.current) {
                      longPressHandledRef.current = false;
                      return;
                    }
                    if (selectedItems.size > 0) toggleSelection(e, folder.id);
                    else navigateToFolder(folder);
                  }}
                  onTouchStart={(e) => handleItemTouchStart(e, folder.id)}
                  onTouchMove={handleItemTouchMove}
                  onTouchEnd={handleItemTouchEnd}
                  onTouchCancel={handleItemTouchEnd}
                  onContextMenu={(e) => handleContextMenu(e, { type: 'folder', item: folder })}
                  className={`folder-selection-card group relative flex flex-col border rounded-xl overflow-hidden cursor-pointer select-none touch-no-select gpu-fast transition-[transform,border-color,background-color] duration-150 ease-out active:scale-[0.98] ${isCut ? 'opacity-50' : ''} ${
                    isSelected 
                      ? 'folder-selection-card--selected border-emerald-500/50 ring-2 ring-emerald-500 bg-emerald-500/10 dark:bg-emerald-500/15' 
                      : 'border-gray-200 dark:border-gray-800 bg-drive-surface dark:bg-drive-darksurface hover:bg-drive-hover dark:hover:bg-drive-darkhover hover:-translate-y-0.5 hover:shadow-md'
                  }`}
                >
                  {renderSelectCheckbox(isSelected, (e) => toggleSelection(e, folder.id), "absolute top-2 right-2 z-30 bg-white/40 dark:bg-black/40 backdrop-blur-md")}
                  
                  {/* Visual card header */}
                  <div className={`${itemSize === 'small' ? 'h-16 sm:h-20' : itemSize === 'large' ? 'h-32 sm:h-40' : 'h-24 sm:h-28'} bg-blue-500/[0.04] dark:bg-blue-500/[0.08] border-gray-100 dark:border-gray-800 group-hover:bg-blue-500/[0.07] dark:group-hover:bg-blue-500/[0.12] flex items-center justify-center relative overflow-hidden border-b transition-colors`}>
                    <Folder className={`${itemSize === 'small' ? 'w-8 h-8' : itemSize === 'large' ? 'w-16 h-16' : 'w-11 h-11'} text-blue-500 dark:text-blue-400 group-hover:scale-105 transition-transform duration-200 drop-shadow-xs`} fill="currentColor" fillOpacity={0.25} />
                  </div>

                  {/* Card info area */}
                  <div className={itemSize === 'small' ? 'p-2' : itemSize === 'large' ? 'p-3.5' : 'p-2.5 sm:p-3'}>
                    <div className="flex items-start justify-between gap-1">
                      <span className={`font-semibold ${itemSize === 'small' ? 'text-xs truncate' : itemSize === 'large' ? 'text-base truncate' : 'text-sm truncate'} text-gray-800 dark:text-gray-100 flex-1 min-w-0 dir-auto font-sans`} title={folder.name}>
                        {folder.name}
                      </span>
                      <button
                        type="button"
                        onClick={(e) => openItemMenu(e, { type: 'folder', item: folder })}
                        className="p-1 -mr-1 -mt-0.5 text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg transition-colors shrink-0"
                        title="More options"
                        aria-label="More options"
                      >
                        <MoreVertical className="w-4 h-4" />
                      </button>
                    </div>
                    <div className="flex items-center gap-1.5 mt-1 text-[11px] sm:text-xs text-gray-400 dark:text-gray-500">
                      <span className="font-medium text-gray-500 dark:text-gray-400">
                        Folder
                      </span>
                      <span>•</span>
                      {renderFolderItemCount(folder)}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Gallery View */}
        {viewMode === 'gallery' && (
          <div className={
            itemSize === 'small'
              ? "grid grid-cols-2 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3 sm:gap-4"
              : itemSize === 'large'
              ? "grid grid-cols-1 sm:grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6 sm:gap-8"
              : "grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 sm:gap-6"
          }>
            {foldersList.map(folder => {
              const isSelected = selectedItems.has(folder.id);
              const isCut = clipboard?.action === 'move' && clipboard.items.some(i => i.type === 'folder' && i.item.id === folder.id);
              return (
                <div 
                  key={folder.id} 
                  onClick={(e) => {
                    if (longPressHandledRef.current) {
                      longPressHandledRef.current = false;
                      return;
                    }
                    if (selectedItems.size > 0) toggleSelection(e, folder.id);
                    else navigateToFolder(folder);
                  }}
                  onTouchStart={(e) => handleItemTouchStart(e, folder.id)}
                  onTouchMove={handleItemTouchMove}
                  onTouchEnd={handleItemTouchEnd}
                  onTouchCancel={handleItemTouchEnd}
                  onContextMenu={(e) => handleContextMenu(e, { type: 'folder', item: folder })}
                  className={`folder-selection-card group relative flex flex-col p-4 border rounded-2xl cursor-pointer select-none touch-no-select gpu-fast transition-[transform,border-color,background-color] duration-150 ease-out active:scale-[0.98] ${isCut ? 'opacity-50' : ''} ${
                    isSelected 
                      ? 'folder-selection-card--selected bg-emerald-500/10 dark:bg-emerald-500/15 border-emerald-500/50 ring-2 ring-emerald-500' 
                      : 'bg-drive-surface dark:bg-drive-darksurface border-gray-200 dark:border-gray-800 hover:bg-drive-hover dark:hover:bg-drive-darkhover hover:-translate-y-0.5 hover:shadow-md'
                  }`}
                >
                  <div className="flex items-start justify-between mb-3">
                    <div className={`${itemSize === 'small' ? 'w-10 h-10' : itemSize === 'large' ? 'w-16 h-16' : 'w-12 h-12'} rounded-xl overflow-hidden bg-blue-500/10 dark:bg-blue-500/20 text-blue-500 flex items-center justify-center`}>
                      <Folder className={`${itemSize === 'small' ? 'w-6 h-6' : itemSize === 'large' ? 'w-9 h-9' : 'w-7 h-7'}`} fill="currentColor" fillOpacity={0.25} />
                    </div>
                    <div className="flex items-center gap-1">
                      {renderSelectCheckbox(isSelected, (e) => toggleSelection(e, folder.id))}
                      <button
                        type="button"
                        onClick={(e) => openItemMenu(e, { type: 'folder', item: folder })}
                        className="p-1.5 text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg transition-colors"
                        title="More options"
                        aria-label="More options"
                      >
                        <MoreVertical className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 min-w-0">
                    <span className={`font-semibold ${itemSize === 'large' ? 'text-lg' : itemSize === 'small' ? 'text-sm' : 'text-base'} text-gray-800 dark:text-gray-100 truncate dir-auto font-sans`} title={folder.name}>{folder.name}</span>
                  </div>
                  <div className="text-xs text-gray-400 mt-1 flex items-center gap-1">
                    {renderFolderItemCount(folder)}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* List View */}
        {viewMode === 'list' && (
          <div className="flex flex-col gap-2">
            {foldersList.map(folder => {
              const isSelected = selectedItems.has(folder.id);
              const isCut = clipboard?.action === 'move' && clipboard.items.some(i => i.type === 'folder' && i.item.id === folder.id);
              return (
                <div 
                  key={folder.id} 
                  onClick={(e) => {
                    if (longPressHandledRef.current) {
                      longPressHandledRef.current = false;
                      return;
                    }
                    if (selectedItems.size > 0) toggleSelection(e, folder.id);
                    else navigateToFolder(folder);
                  }}
                  onTouchStart={(e) => handleItemTouchStart(e, folder.id)}
                  onTouchMove={handleItemTouchMove}
                  onTouchEnd={handleItemTouchEnd}
                  onTouchCancel={handleItemTouchEnd}
                  onContextMenu={(e) => handleContextMenu(e, { type: 'folder', item: folder })}
                  className={`folder-selection-card group flex items-center ${itemSize === 'small' ? 'gap-2.5 p-2' : itemSize === 'large' ? 'gap-4 p-3.5 sm:p-4' : 'gap-3 sm:gap-4 p-2.5 sm:p-3'} border rounded-xl cursor-pointer select-none touch-no-select gpu-fast transition-[transform,border-color,background-color] duration-150 ease-out active:scale-[0.99] ${isCut ? 'opacity-50' : ''} ${
                    isSelected 
                      ? 'folder-selection-card--selected bg-emerald-500/10 dark:bg-emerald-500/15 border-emerald-500/50 ring-2 ring-emerald-500' 
                      : 'bg-drive-surface dark:bg-drive-darksurface border-gray-200/80 dark:border-gray-800/80 hover:bg-drive-hover dark:hover:bg-drive-darkhover hover:shadow-sm'
                  }`}
                >
                  {renderSelectCheckbox(isSelected, (e) => toggleSelection(e, folder.id), "-ml-0.5 sm:-ml-1")}
                  <div className={`${itemSize === 'small' ? 'w-9 h-9 sm:w-10 sm:h-10' : itemSize === 'large' ? 'w-14 h-14 sm:w-16 sm:h-16' : 'w-10 h-10 sm:w-12 sm:h-12'} rounded-xl overflow-hidden bg-blue-500/10 dark:bg-blue-500/20 text-blue-500 flex items-center justify-center shrink-0`}>
                    <Folder className={`${itemSize === 'small' ? 'w-5 h-5' : itemSize === 'large' ? 'w-8 h-8' : 'w-6 h-6'}`} fill="currentColor" fillOpacity={0.25} />
                  </div>
                  <div className="flex-1 min-w-0 flex flex-col justify-center">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className={`font-semibold ${itemSize === 'small' ? 'text-xs sm:text-sm' : itemSize === 'large' ? 'text-base sm:text-lg' : 'text-sm sm:text-base'} text-gray-800 dark:text-gray-100 truncate dir-auto font-sans`} title={folder.name}>{folder.name}</span>
                    </div>
                    <div className="flex items-center gap-2 text-xs text-gray-400 mt-0.5">
                      <span className="font-medium text-gray-500 dark:text-gray-400">
                        Folder
                      </span>
                      <span>•</span>
                      {renderFolderItemCount(folder)}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={(e) => openItemMenu(e, { type: 'folder', item: folder })}
                    className="p-1.5 text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg transition-colors shrink-0"
                    title="More options"
                    aria-label="More options"
                  >
                    <MoreVertical className="w-4 h-4" />
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </section>
    );
  };

  let displayFolder = currentFolder;
  if (currentFolder && currentFolder.id === 'root') {
      const hoistedFiles: any[] = [];
      const hoistedFolders: any = { ...currentFolder.folders };
      
      const rootNumId = zudRootChannelId ? channelNumericId(String(zudRootChannelId)) : '';

      Object.values(currentFolder.folders).forEach((channelFolder: any) => {
          const chanNumId = channelNumericId(String(channelFolder.id));
          const isRootMatch = channelFolder.id === zudRootChannelId ||
            (rootNumId && chanNumId && rootNumId === chanNumId) ||
            channelFolder.name === 'Cloud Root';

          if (isRootMatch) {
              if (channelFolder.files) {
                  hoistedFiles.push(...channelFolder.files);
              }
              if (channelFolder.folders) {
                  Object.values(channelFolder.folders).forEach((subFolder: any) => {
                      hoistedFolders[subFolder.id] = subFolder;
                  });
              }
              delete hoistedFolders[channelFolder.id];
          }
      });
      
      displayFolder = {
          ...currentFolder,
          files: hoistedFiles,
          folders: hoistedFolders
      } as any;
  } else if (currentFolder && currentFolder.id.startsWith('search:')) {
    const parts = currentFolder.id.split(':');
    const scope = parts[1];
    const baseId = parts[2];
    const q = parts.slice(3).join(':');
    
    const liveResults: any[] = [];
    const queryParts = q.toLowerCase().split(/\s+/).filter(Boolean);
    const isMatch = (name: string) => {
      const n = name.toLowerCase().replace(/_/g, ' ');
      return queryParts.every(part => n.includes(part));
    };
    
    const searchLiveFolder = (folder: VirtualFolder, currentPath: VirtualFolder[]) => {
      if (folder.id !== 'root' && isMatch(folder.name)) {
        liveResults.push({ type: 'folder', item: folder, path: currentPath });
      }
      for (const file of folder.files) {
        if (isMatch(file.name)) {
          liveResults.push({ type: 'file', item: file, path: [...currentPath, folder] });
        }
      }
      for (const childId in folder.folders) {
        if (folder.folders[childId].isLoaded === false) continue;
        searchLiveFolder(folder.folders[childId], [...currentPath, folder]);
      }
    };
    
    if (pathStack[0]) searchLiveFolder(pathStack[0], []);
    
    let finalResults = liveResults;
    if (scope === 'folder') {
      finalResults = liveResults.filter(r => r.path.some((p:any) => p.id === baseId) || (r.type === 'folder' && r.item.id === baseId));
    } else if (scope === 'cloud') {
      const cfResults = liveResults.filter(r => r.path.some((p:any) => p.id === baseId) || (r.type === 'folder' && r.item.id === baseId));
      finalResults = liveResults.filter(r => !cfResults.includes(r));
    }
    
    displayFolder = {
      ...currentFolder,
      files: finalResults.filter(r => r.type === 'file').map(r => r.item),
      folders: {}
    };
    finalResults.filter(r => r.type === 'folder').forEach(r => {
      displayFolder!.folders[r.item.id] = r.item;
    });
  }

  const handleCreateFolder = () => {
    setNewFolderName('');
    setIsCreateFolderModalOpen(true);
  };

  const submitCreateFolder = async () => {
    const folderName = newFolderName.trim();
    closeCreateFolderModal();
    if (!folderName) return;

    if (currentFolder?.id === 'root') {
      if (!client) return;
      setLoading(true);
      try {
        const result = await client.invoke(new Api.channels.CreateChannel({
          title: folderName,
          about: `Cloud storage for ${folderName}`,
          broadcast: true,
          megagroup: false
        })) as any;
        const newChannel = result.chats[0];
        
        if (autoArchive) {
          try {
            await client.invoke(new Api.folders.EditPeerFolders({
              folderPeers: [new Api.InputFolderPeer({
                peer: newChannel,
                folderId: 1
              })]
            }));
          } catch (e) {
            console.error("Failed to archive new channel folder:", e);
          }
        }
        
        if (newChannel.accessHash) {
          saveChannelAccessHash(newChannel.id, newChannel.accessHash);
        }

        // Add to UI
        const newAvailable = [
          ...availableChannels,
          {
            id: newChannel.id.toString(),
            name: folderName,
            rawId: newChannel.id,
            accessHash: newChannel.accessHash ? newChannel.accessHash.toString() : undefined
          }
        ];
        setAvailableChannels(newAvailable);
        try {
          localStorage.setItem(channelsStorageKey, JSON.stringify(newAvailable));
          const aboutCacheKey = `zud_channel_about_cache_${activeAccountId || 'default'}`;
          const currentAbout = JSON.parse(localStorage.getItem(aboutCacheKey) || '{}');
          currentAbout[newChannel.id.toString()] = `Cloud storage for ${folderName}`;
          localStorage.setItem(aboutCacheKey, JSON.stringify(currentAbout));
        } catch {}
      } catch (e: any) {
        console.error("Failed to create root folder:", e);
        const errMsg = e?.errorMessage || e?.message || '';
        if (errMsg.includes('USER_RESTRICTED')) {
          setRestrictionModal({
            title: 'Telegram Channel Creation Limit (USER_RESTRICTED)',
            message: 'Your Telegram account is currently restricted from creating new public or private channels by Telegram servers.',
            suggestions: [
              'Flood Limit: You may have created several channels recently. Telegram temporarily blocks creating new channels for a few hours.',
              'Spam Restriction: Check @SpamBot on Telegram to verify if your account has any temporary limitations.',
              'Quick Workaround: Create a channel manually in your official Telegram app and put "ZUD_CLOUD_DIR" in its Description (Bio). ZUD Cloud will automatically detect and link it!'
            ]
          });
        } else {
          setRestrictionModal({
            title: 'Failed to Create Folder',
            message: `Could not create root folder channel on Telegram: ${errMsg || 'Unknown error'}`
          });
        }
      } finally {
        setLoading(false);
      }
    } else if (currentFolder) {
      if (!client) return;
      setLoading(true);
      
      const chanFolder = pathStack[1] || currentFolder;
      const chanId = chanFolder.channelId || 'me';
      
      const folderIdStr = Math.random().toString(36).substring(2, 10);
      const newId = `${currentFolder.id}/${folderName}`;
      
      // Create empty virtual subfolder
      setPathStack(currentStack => {
        const newRoot = JSON.parse(JSON.stringify(currentStack[0])); // Deep copy
        
        let target = newRoot;
        for (let i = 1; i < currentStack.length; i++) {
          const folderNameOfStack = currentStack[i].name;
          if (folderNameOfStack && target.folders[folderNameOfStack]) {
              target = target.folders[folderNameOfStack];
          }
        }
        
        const newPath = target.id === 'root' ? folderName : `${target.id}/${folderName}`;
        
        if (!target.folders[folderName]) {
          target.folders[folderName] = {
            id: newId,
            name: folderName,
            path: newPath,
            files: [],
            folders: {},
            isLoaded: true
          };
          
          if (currentFolder.id === target.id) {
             setCurrentFolder(target);
          }
        }
        
        currentStack[0] = newRoot;
        if (currentFolder.id === target.id) setCurrentFolder(target);
        
        return [...currentStack];
      });
      
      // Persist the folder creation to Telegram!
      try {
        const pIdStr = currentFolder.folderId || 'root';
        const meta = {
          t: 'dir',
          n: folderName,
          id: folderIdStr,
          pId: pIdStr
        };
        const messageText = `📁 Directory: ${folderName}\n\n${JSON.stringify(meta)}`;
        await client.sendMessage(chanId, { message: messageText });
        refreshChannel(String(chanId));
      } catch (e) {
        console.error("Failed to persist folder creation to telegram:", e);
      }
      setLoading(false);
    }
  };

  const displayFolderRef = useRef(displayFolder);
  useEffect(() => { displayFolderRef.current = displayFolder; });

  const currentChanId = useMemo(() => {
    if (!displayFolder || displayFolder.id === 'root') return null;
    const parts = displayFolder.id.split('/');
    return parts[0] || null;
  }, [displayFolder]);

  const currentChanFolder = useMemo(() => {
    if (!currentChanId) return null;
    const rootFolder = pathStackRef.current[0] || pathStack[0];
    return rootFolder?.folders[currentChanId] || null;
  }, [currentChanId, pathStack]);

  const isFolderLoading = useMemo(() => {
    if (loading) return true;
    if (!displayFolder || displayFolder.id === 'root') return false;
    if (displayFolder.isLoaded === false) return true;
    if (currentChanFolder && currentChanFolder.isLoaded === false) return true;
    if (currentChanId && syncingChannelIds.has(currentChanId) && displayFolder.files.length === 0 && Object.keys(displayFolder.folders).length === 0) {
      return true;
    }
    return false;
  }, [loading, displayFolder, currentChanFolder, currentChanId, syncingChannelIds]);

  const viewerFiles = useMemo(() => (currentFolder?.files || []).filter(VIEWABLE_MEDIA), [currentFolder]);
  const activeViewerIndex = activeFile ? viewerFiles.findIndex(file => file.id === activeFile.id) : -1;
  const moveViewer = useCallback((direction: -1 | 1) => {
    if (activeViewerIndex < 0 || viewerFiles.length < 2) return;
    const nextIndex = (activeViewerIndex + direction + viewerFiles.length) % viewerFiles.length;
    setActiveFile(viewerFiles[nextIndex]);
  }, [activeViewerIndex, viewerFiles]);

  useEffect(() => {
    if (!activeFile || !VIEWABLE_MEDIA(activeFile)) return;
    const handleViewerKey = (event: KeyboardEvent) => {
      if (event.key === 'ArrowLeft') moveViewer(-1);
      if (event.key === 'ArrowRight') moveViewer(1);
      if (event.key === 'Escape') closeMediaViewer();
    };
    window.addEventListener('keydown', handleViewerKey);
    return () => window.removeEventListener('keydown', handleViewerKey);
  }, [activeFile, moveViewer, closeMediaViewer]);

  const handleSelectAll = useCallback(() => {
    const df = displayFolderRef.current;
    if (!df) return;
    const allIds = new Set<string>();
    
    const allFolderIds = Object.keys(df.folders);
    const allFileIds = df.files.map(f => f.id);
    const totalCount = allFolderIds.length + allFileIds.length;
    
    if (selectedItems.size === totalCount && totalCount > 0) {
      setSelectedItems(new Set());
    } else {
      allFolderIds.forEach(id => allIds.add(id));
      allFileIds.forEach(id => allIds.add(id));
      setSelectedItems(allIds);
    }
  }, [selectedItems.size]);

  const toggleSelection = (e: React.MouseEvent | React.TouchEvent, id: string) => {
    if (e) e.stopPropagation();
    const newSel = new Set(selectedItems);
    if (newSel.has(id)) newSel.delete(id);
    else newSel.add(id);
    setSelectedItems(newSel);
    setContextMenu(null);
  };

  const getSelectedItemsData = useCallback(() => {
    const df = displayFolderRef.current;
    if (!df) return [];
    const items: { type: 'file'|'folder', item: any }[] = [];
    selectedItems.forEach(id => {
      const folderMatch = Object.values(df.folders).find((f: any) => f.id === id);
      if (folderMatch) items.push({ type: 'folder', item: folderMatch });
      else {
        const file = df.files.find((f: any) => f.id === id);
        if (file) items.push({ type: 'file', item: file });
      }
    });
    return items;
  }, [selectedItems]);

  const downloadFile = useCallback((file: VirtualFile) => {
    window.dispatchEvent(new CustomEvent('startBackgroundDownload', { detail: file }));
  }, []);

  const downloadFolder = useCallback((folder: VirtualFolder) => {
    window.dispatchEvent(new CustomEvent('startFolderZipDownload', { detail: folder }));
  }, []);

  const handleDownloadSelected = useCallback(() => {
    const selected = getSelectedItemsData();
    selected.forEach((item, index) => {
      window.setTimeout(() => {
        if (item.type === 'folder') {
          downloadFolder(item.item as VirtualFolder);
        } else {
          downloadFile(item.item as VirtualFile);
        }
      }, index * 150);
    });
    setSelectedItems(new Set());
  }, [downloadFile, downloadFolder, getSelectedItemsData]);

  const handleCopySelected = useCallback(() => {
    const items = getSelectedItemsData();
    if (items.length > 0) {
      setClipboard({ action: 'copy', items });
      setSelectedItems(new Set());
    }
  }, [getSelectedItemsData]);

  const handleCutSelected = useCallback(() => {
    const items = getSelectedItemsData();
    if (items.length > 0) {
      setClipboard({ action: 'move', items });
      setSelectedItems(new Set());
    }
  }, [getSelectedItemsData]);

  const handleDeleteSelected = useCallback(async () => {
    const items = getSelectedItemsData();
    if (items.length === 0) return;
    setDeleteModalItems(items);
    setSelectedItems(new Set());
  }, [getSelectedItemsData]);

  const handlePaste = useCallback(async () => {
    if (!clipboard) return;
    const currentClipboard = clipboard;
    // Dismiss clipboard pill immediately so it never lingers under the operation bar
    setClipboard(null);

    if (currentFolder) {
      // Find current displayed items to check for conflicts
      let currentFiles: any[] = currentFolder.files || [];
      let currentFoldersList: any[] = Object.values(currentFolder.folders || {});
      
      if (currentFolder.id === 'root') {
          // If at root, we need to check the zudRootChannelId which acts as the root storage
          const zudRootChannelId = availableChannels.find(c => c.id === localStorage.getItem(rootStorageKey))?.id || availableChannels.find(c => c.name === 'Cloud Root')?.id;
          const rootChannel = Object.values(currentFolder.folders).find((f: any) => f.id === zudRootChannelId) as any;
          if (rootChannel) {
              currentFiles = [...currentFiles, ...(rootChannel.files || [])];
              currentFoldersList = [...currentFoldersList, ...Object.values(rootChannel.folders || {})];
          }
      }

      const targetItems = [...currentFiles, ...currentFoldersList];
      
      const conflicts = currentClipboard.items.filter(clipboardItem => {
          return targetItems.some(existingItem => {
              if (existingItem.name !== clipboardItem.item.name) return false;
              if (clipboardItem.type === 'folder') return true; 
              return existingItem.size === clipboardItem.item.size;
          });
      });
      
      if (conflicts.length > 0) {
          setToastMessage({
              title: "Duplicate Detected",
              message: `An item named "${conflicts[0].item.name}" already exists in the destination. Please rename or delete it first.`,
              type: "error"
          });
          // Restore clipboard so user doesn't lose their selection
          setClipboard(currentClipboard);
          return;
      }

      const completed = await pasteItems(currentClipboard.action, currentClipboard.items, currentFolder);
      if (!completed && currentClipboard.action === 'move') {
        // If move failed, restore clipboard
        setClipboard(currentClipboard);
      }
    }
  }, [clipboard, pasteItems, currentFolder, availableChannels]);
  const handleAutoArchiveToggle = async (checked: boolean) => {
    setAutoArchive(checked);
    localStorage.setItem('drive_auto_archive', String(checked));
    
    if (!client || !availableChannels) return;
    
    // We shouldn't block the UI while doing this
    const folderId = checked ? 1 : 0;
    try {
       const peersToArchive = [];
       for (const ch of availableChannels) {
          if (ch.id === 'saved_messages') continue; // Do not archive saved_messages
          const peerId = ch.rawId || ch.id;
          try {
             const peer = await client.getInputEntity(peerId);
             peersToArchive.push(new Api.InputFolderPeer({
                 peer: peer,
                 folderId: folderId
             }));
          } catch (e) { console.error("Error getting input entity for", ch.id, e); }
       }
       
       if (peersToArchive.length > 0) {
          await client.invoke(new Api.folders.EditPeerFolders({
             folderPeers: peersToArchive
          }));
          logger.info(`Successfully set ${peersToArchive.length} channels to archive status: ${checked}`);
       }
    } catch (e) {
       console.error("Failed to archive/unarchive folders", e);
    }
  };

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (['INPUT', 'TEXTAREA'].includes(target.tagName) || target.isContentEditable) return;

      // Escape to close context menu or exit selection mode
      if (e.key === 'Escape' || e.code === 'Escape') {
        if (contextMenu) {
          e.preventDefault();
          setContextMenu(null);
          return;
        }
        if (selectedItems.size > 0) {
          e.preventDefault();
          setSelectedItems(new Set());
          return;
        }
      }

      if (e.ctrlKey || e.metaKey) {
        const key = e.key.toLowerCase();
        if (key === 'a') {
          e.preventDefault();
          handleSelectAll();
        } else if (key === 'c' && selectedItems.size > 0) {
          e.preventDefault();
          const count = selectedItems.size;
          handleCopySelected();
          setToastMessage({
            title: "Copied to Clipboard",
            message: `${count} item(s) copied. Navigate to destination and press Ctrl+V to paste.`,
            type: "success"
          });
        } else if (key === 'x' && selectedItems.size > 0) {
          e.preventDefault();
          const count = selectedItems.size;
          handleCutSelected();
          setToastMessage({
            title: "Cut to Clipboard",
            message: `${count} item(s) ready to move. Navigate to destination and press Ctrl+V to paste.`,
            type: "success"
          });
        } else if (key === 'v' && clipboard) {
          e.preventDefault();
          handlePaste();
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleSelectAll, selectedItems.size, handleCopySelected, handleCutSelected, handlePaste, clipboard, contextMenu]);

  return (
    <div className="flex-1 flex flex-col h-full h-[100dvh] overflow-hidden relative">
      <TransferCenter hidden={!!activeFile} />
      <DownloadManager client={client} botClient={botClient} botId={botId} botUsername={botUsername} />
      <UploadManager
        client={client}
        botClient={botClient}
        botId={botId}
        botUsername={botUsername}
        currentFolderId={currentFolder?.folderId || 'root'}
        currentFolderPath={pathStack.map(f => f.name).join('/') || 'root'}
        currentChannelId={pathStack[1]?.channelId || currentFolder?.channelId || zudRootChannelId || 'me'}
        hideMobileTrigger
        onUploadComplete={(chanId) => {
          refreshChannel(String(chanId));
        }}
      />
      {/* Sliding Header Drawer Container */}
      <header className="sticky top-0 z-30 shrink-0 h-[calc(4rem+env(safe-area-inset-top,0px))] min-h-[calc(4rem+env(safe-area-inset-top,0px))] relative bg-drive-surface/90 dark:bg-drive-darksurface/90 border-b border-gray-200 dark:border-gray-800 backdrop-blur-md shadow-sm">
        {/* Normal Header Drawer Layer */}
        <div 
          className={`absolute inset-0 pt-[env(safe-area-inset-top,0px)] pl-[max(0.5rem,env(safe-area-inset-left,0px))] pr-[max(0.5rem,env(safe-area-inset-right,0px))] flex items-center justify-between px-2 sm:px-6 gpu-fast transition-all duration-200 ease-out ${
            selectedItems.size > 0 
              ? '-translate-y-full opacity-0 pointer-events-none' 
              : 'translate-y-0 opacity-100'
          }`}
        >
          <button onClick={() => navigateUp(0)} className="min-w-0 flex items-center gap-1.5 sm:gap-2 px-1 sm:px-2 py-1 rounded transition-transform focus:outline-none focus:ring-0 active:scale-[0.99] group shrink" aria-label="Telflare — ZUD Cloud">
            <BrandLogo imageClassName="w-9 h-9 sm:w-14 sm:h-14 drop-shadow-md shrink-0" alt="Telflare" />
            <span className="brand-wordmark brand-wordmark-morph hidden text-lg sm:inline-grid sm:text-xl">
              <span className="brand-wordmark-layer brand-wordmark-primary">
                <span className="text-[#64748b]">Tel</span><span className="text-[#b91c2b]">f</span><span className="text-[#3f3f46] dark:text-[#94a3b8]">lare</span>
              </span>
              <span className="brand-wordmark-layer brand-wordmark-alt" aria-hidden="true">
                <span className="text-[#64748b]">Z</span><span className="text-[#b91c2b]">U</span><span className="text-[#3f3f46] dark:text-[#94a3b8]">D</span><span className="ml-1 text-[#64748b]">Cloud</span>
              </span>
            </span>
          </button>
          <div className="shrink-0 flex items-center gap-1 sm:gap-3">
            {!activeFile?.mimeType.startsWith('video/') && (
              <button
                type="button"
                onClick={() => window.dispatchEvent(new Event('zud:open-upload-picker'))}
                disabled={!client}
                className="sm:hidden p-2 bg-blue-500 hover:bg-blue-600 text-white rounded-lg text-sm font-medium transition-colors shadow-sm disabled:cursor-not-allowed disabled:opacity-50"
                aria-label="Upload files"
                title="Upload files"
              >
                <UploadCloud className="w-4 h-4" />
              </button>
            )}
            <button
                onClick={handleCreateFolder}
                className="p-2 sm:px-3 sm:py-1.5 bg-blue-500 hover:bg-blue-600 text-white rounded-lg text-sm font-medium transition-colors shadow-sm flex items-center gap-1.5"
                title="New Folder"
                aria-label="New Folder"
              >
                <Folder className="w-4 h-4" />
                <span className="hidden sm:inline">New Folder</span>
              </button>

            
            {/* Desktop & Mobile View Switchers */}
            {/* Desktop Creative View & Size Dropdown Menu */}
                <div className="relative hidden sm:block" ref={desktopViewMenuRef}>
                  <button
                    type="button"
                    onClick={toggleDesktopViewMenu}
                    className={`drive-view-trigger flex items-center gap-2 px-3 py-1.5 rounded-xl border text-sm font-medium transition-all ${
                      isDesktopViewMenuOpen
                        ? 'drive-view-trigger--active text-blue-700 dark:text-blue-300'
                        : 'text-gray-700 dark:text-gray-200'
                    }`}
                    title="View & Size options"
                    aria-label="View & Size options"
                  >
                    {viewMode === 'grid' && <LayoutGrid className="w-4 h-4 text-blue-500" />}
                    {viewMode === 'list' && <List className="w-4 h-4 text-blue-500" />}
                    {viewMode === 'gallery' && <LayoutDashboard className="w-4 h-4 text-blue-500" />}
                    
                    <span className="capitalize">{viewMode === 'list' ? 'Content' : viewMode}</span>
                    <span className="text-[11px] px-1.5 py-0.5 rounded-md bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300 font-mono font-bold uppercase border border-black/5 dark:border-white/5">
                      {itemSize[0]}
                    </span>
                    <ChevronDown className={`w-3.5 h-3.5 text-gray-400 transition-transform duration-200 ${isDesktopViewMenuOpen ? 'rotate-180' : ''}`} />
                  </button>

                  {/* Dropdown Popover */}
                  {isDesktopViewMenuMounted && (
                    <div className={`drive-view-menu absolute right-0 mt-2 w-64 rounded-2xl border z-50 p-2.5 backdrop-blur-xl ${
                      isDesktopViewMenuClosing ? 'drive-view-menu--closing' : 'drive-view-menu--open'
                    }`}>
                      <div className="px-2 py-1 text-[11px] font-bold text-gray-400 dark:text-gray-500 uppercase tracking-wider">
                        Layout
                      </div>
                      <div className="space-y-1 mt-1">
                        {[
                          { id: 'grid', label: 'Grid', desc: 'Cards with thumbnails', icon: LayoutGrid },
                          { id: 'list', label: 'Content', desc: 'Detailed rows with metadata', icon: List },
                          { id: 'gallery', label: 'Gallery', desc: 'Large widescreen preview', icon: LayoutDashboard },
                        ].map(item => {
                          const Icon = item.icon;
                          const isActive = viewMode === item.id;
                          return (
                            <button
                              key={item.id}
                              type="button"
                              onClick={() => {
                                changeViewMode(item.id as any);
                                closeDesktopViewMenu();
                              }}
                              className={`w-full flex items-center justify-between px-2.5 py-2 rounded-xl text-left transition-all ${
                                isActive 
                                  ? 'bg-blue-50 dark:bg-blue-950/50 text-blue-600 dark:text-blue-400 font-semibold' 
                                  : 'text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800/70'
                              }`}
                            >
                              <div className="flex items-center gap-2.5">
                                <Icon className={`w-4 h-4 ${isActive ? 'text-blue-500' : 'text-gray-400'}`} />
                                <div>
                                  <div className="text-xs leading-none">{item.label}</div>
                                  <div className="text-[10px] text-gray-400 font-normal mt-0.5">{item.desc}</div>
                                </div>
                              </div>
                              {isActive && <Check className="w-4 h-4 text-blue-500 stroke-[2.5]" />}
                            </button>
                          );
                        })}
                      </div>

                      <div className="my-2 border-t border-gray-100 dark:border-gray-800/80" />

                      <div className="px-2 py-1 text-[11px] font-bold text-gray-400 dark:text-gray-500 uppercase tracking-wider">
                        Item Size
                      </div>
                      <div className="grid grid-cols-3 gap-1.5 mt-1 p-1 bg-gray-100 dark:bg-gray-800/60 rounded-xl">
                        {[
                          { id: 'small', label: 'Small', tag: 'S' },
                          { id: 'medium', label: 'Medium', tag: 'M' },
                          { id: 'large', label: 'Large', tag: 'L' },
                        ].map(size => {
                          const isActive = itemSize === size.id;
                          return (
                            <button
                              key={size.id}
                              type="button"
                              onClick={() => {
                                changeItemSize(size.id as any);
                                closeDesktopViewMenu();
                              }}
                              className={`py-1.5 px-2 rounded-lg text-xs font-medium transition-all flex flex-col items-center justify-center gap-0.5 ${
                                isActive
                                  ? 'bg-white dark:bg-gray-700 text-blue-600 dark:text-blue-400 shadow-sm font-semibold'
                                  : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100'
                              }`}
                            >
                              <span className="font-bold text-[11px]">{size.tag}</span>
                              <span className="text-[9px] opacity-80">{size.label}</span>
                            </button>
                          );
                        })}
                      </div>

                      <div className="my-2 border-t border-gray-100 dark:border-gray-800/80" />

                      <div className="flex items-center justify-between px-2 py-1 text-[11px] font-bold text-gray-400 dark:text-gray-500 uppercase tracking-wider">
                        <span>Sort By</span>
                        <button
                          type="button"
                          onClick={() => setSortOrder(prev => prev === 'asc' ? 'desc' : 'asc')}
                          className="text-[10px] text-rose-500 hover:text-rose-400 font-mono font-bold transition-colors flex items-center gap-0.5 active:scale-95"
                          title="Toggle direction"
                        >
                          {sortOrder === 'asc' ? '↑ Asc' : '↓ Desc'}
                        </button>
                      </div>
                      <div className="grid grid-cols-4 gap-1 mt-1 p-1 bg-gray-100 dark:bg-gray-800/60 rounded-xl">
                        {[
                          { id: 'date', label: 'Date' },
                          { id: 'name', label: 'Name' },
                          { id: 'size', label: 'Size' },
                          { id: 'duration', label: 'Time' },
                        ].map(item => {
                          const isActive = sortMode === item.id;
                          return (
                            <button
                              key={item.id}
                              type="button"
                              onClick={() => {
                                setSortMode(item.id as any);
                                closeDesktopViewMenu();
                              }}
                              className={`py-1.5 px-1 rounded-lg text-xs font-medium transition-all text-center truncate ${
                                isActive 
                                  ? 'bg-white dark:bg-gray-700 text-rose-600 dark:text-rose-400 shadow-sm font-bold' 
                                  : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100'
                              }`}
                            >
                              {item.label}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>

                {/* Mobile Compressed View & Size Mode Toggle Button with Down Arrow */}
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleMobileViewSheet();
                  }}
                  className="sm:hidden flex items-center gap-1.5 px-2.5 py-1.5 bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 rounded-xl transition-colors active:scale-95 text-gray-700 dark:text-gray-200 shadow-sm border border-gray-200/50 dark:border-gray-700/50"
                  title="Change View & Size"
                  aria-label="Change View & Size"
                >
                  {viewMode === 'grid' && <LayoutGrid className="w-4 h-4 text-blue-500" />}
                  {viewMode === 'list' && <List className="w-4 h-4 text-blue-500" />}
                  {viewMode === 'gallery' && <LayoutDashboard className="w-4 h-4 text-blue-500" />}
                  <span className="text-[10px] px-1.5 py-0.5 bg-white dark:bg-gray-700 rounded font-mono font-bold text-gray-600 dark:text-gray-300 uppercase">
                    {itemSize[0]}
                  </span>
                  <ChevronDown className={`w-3 h-3 text-gray-400 transition-transform duration-150 ${isMobileViewSheetOpen ? 'rotate-180' : ''}`} />
                </button>

            {/* ZUD Vault Cyber Storage HUD - Desktop */}
            <div 
              className="hidden md:flex items-center gap-2.5 px-3 py-1.5 rounded-xl bg-gradient-to-r from-[#18181b]/90 via-[#231719]/80 to-[#18181b]/90 hover:from-[#20181a] hover:to-[#28171b] border border-white/10 hover:border-red-500/35 shadow-[inset_0_1px_1px_rgba(255,255,255,0.06),0_4px_16px_rgba(0,0,0,0.5)] backdrop-blur-xl transition-all duration-300 group cursor-default select-none relative overflow-hidden"
              title={`ZUD Cloud Vault: ${storageStats.formatted} across ${storageStats.fileCount} files`}
            >
              {/* Micro Crimson Laser Accent Border */}
              <div className="absolute left-0 top-1/2 -translate-y-1/2 w-[3px] h-4/5 bg-gradient-to-b from-[#9A2227] via-rose-500 to-transparent rounded-r-full opacity-90 group-hover:opacity-100 transition-opacity" />

              {/* Holographic Storage Icon with Beacon */}
              <div className="relative flex items-center justify-center pl-1">
                <div className="w-6 h-6 rounded-lg bg-red-950/40 border border-red-500/25 flex items-center justify-center text-rose-400 group-hover:text-rose-300 group-hover:border-red-500/40 transition-all shadow-inner">
                  <Database className="w-3.5 h-3.5 group-hover:scale-105 transition-transform" />
                </div>
                <span className="absolute -top-0.5 -right-0.5 flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-rose-400 opacity-60"></span>
                  <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-rose-500 shadow-[0_0_6px_#f43f5e]"></span>
                </span>
              </div>

              {/* Dual-line Cyber Metric Layout */}
              <div className="flex flex-col justify-center min-w-[70px]">
                <div className="flex items-center gap-1.5">
                  <span className="text-[9px] font-black uppercase tracking-widest text-zinc-400">VAULT</span>
                  <span className="text-[9px] font-mono text-zinc-400">• {storageStats.fileCount}</span>
                </div>
                <span className="text-xs font-mono font-bold tracking-tight bg-gradient-to-r from-white via-zinc-100 to-rose-200 bg-clip-text text-transparent group-hover:to-white transition-all">
                  {storageStats.formatted}
                </span>
              </div>
            </div>

            <button onClick={openSearchModal} className="p-1.5 sm:p-2 text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-full transition-colors" title="Search" aria-label="Search"><Search className="w-5 h-5" /></button>
            {isStandalone ? (
              <button
                type="button"
                onClick={() => {
                  setIsRefreshing(true);
                  window.location.reload();
                }}
                className="p-1.5 sm:p-2 text-zinc-400 hover:text-white hover:bg-zinc-800/80 active:bg-zinc-700/80 rounded-full transition-all duration-200 group relative border border-white/5 shadow-inner"
                title="Refresh WebUI"
                aria-label="Refresh WebUI"
              >
                <RotateCw className={`w-5 h-5 transition-transform duration-500 group-hover:rotate-180 ${isRefreshing ? 'animate-spin text-blue-400' : ''}`} />
              </button>
            ) : (
              canInstall && (
                <button
                  type="button"
                  onClick={triggerInstall}
                  className="p-1.5 sm:p-2 text-red-500 hover:bg-red-50 dark:hover:bg-red-950/30 rounded-full transition-colors relative"
                  title="Install ZUD Cloud App (PWA)"
                  aria-label="Install App"
                >
                  <Smartphone className="w-5 h-5" />
                  <span className="absolute -top-0.5 -right-0.5 flex h-2 w-2">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75"></span>
                    <span className="relative inline-flex rounded-full h-2 w-2 bg-red-500"></span>
                  </span>
                </button>
              )
            )}
            <button onClick={openSettingsModal} className="p-1.5 sm:p-2 text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-full transition-colors" title="Settings" aria-label="Settings">
              <Settings className="w-5 h-5" />
            </button>
            <button onClick={logout} className="p-1.5 sm:p-2 text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-lg transition-colors" aria-label="Logout" title="Logout">
              <LogOut className="w-5 h-5 sm:hidden" />
              <span className="hidden sm:inline text-sm font-medium">Logout</span>
            </button>
          </div>
        </div>

        {/* Selection Header Drawer Layer */}
        <div className="absolute inset-0 overflow-hidden pointer-events-none">
          <div 
            className={`w-full h-full pt-[env(safe-area-inset-top,0px)] pl-[max(0.5rem,env(safe-area-inset-left,0px))] pr-[max(0.5rem,env(safe-area-inset-right,0px))] flex items-center justify-between px-2 sm:px-6 bg-emerald-50 dark:bg-emerald-950/80 gpu-fast transition-all duration-200 ease-out ${
              selectedItems.size > 0 
                ? 'translate-y-0 opacity-100 pointer-events-auto' 
                : 'translate-y-full opacity-0 pointer-events-none'
            }`}
          >
          {/* Left Selection Info & Controls */}
          <div className="flex items-center gap-1.5 sm:gap-3 shrink-0">
            <button 
              onClick={() => setSelectedItems(new Set())} 
              className="p-1.5 sm:p-2 text-gray-500 hover:text-gray-800 dark:hover:text-gray-200 rounded-full hover:bg-emerald-100/60 dark:hover:bg-emerald-900/40 transition-colors active:scale-95"
              title="Close selection"
              aria-label="Close selection"
            >
              <X className="w-5 h-5" />
            </button>
            <div className="flex items-center gap-1 sm:gap-2">
              <span className="w-6 h-6 rounded-full bg-emerald-500 text-white text-xs font-bold flex items-center justify-center shadow-sm shadow-emerald-500/30 gpu-fast animate-in zoom-in-75 duration-150">
                {selectedItems.size}
              </span>
              <span className="hidden xs:inline text-xs sm:text-base font-semibold text-emerald-900 dark:text-emerald-200">
                selected
              </span>
            </div>
            <button 
              onClick={handleSelectAll} 
              className="p-1 sm:px-2.5 sm:py-1 text-xs font-semibold text-emerald-700 dark:text-emerald-300 hover:bg-emerald-100/80 dark:hover:bg-emerald-900/40 rounded-full transition-colors active:scale-95 flex items-center gap-1.5" 
              title="Select All"
              aria-label="Select All"
            >
              <div className="w-4 h-4 rounded-full border-2 border-emerald-500 flex items-center justify-center">
                {selectedItems.size === ((displayFolderRef.current?.files.length || 0) + Object.keys(displayFolderRef.current?.folders || {}).length) && (
                  <div className="w-2 h-2 rounded-full bg-emerald-500" />
                )}
              </div>
              <span className="hidden sm:inline">Select All</span>
            </button>
          </div>
          
          {/* Right Action Buttons */}
          <div className="flex items-center gap-1 sm:gap-3 shrink-0">
            <button
              onClick={handleCopySelected}
              className="p-1.5 sm:px-3 sm:py-1.5 text-gray-700 dark:text-gray-300 hover:bg-emerald-100/60 dark:hover:bg-emerald-900/40 rounded-lg transition-colors active:scale-95 flex items-center gap-1.5"
              title="Copy"
              aria-label="Copy"
            >
              <Copy className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
              <span className="hidden sm:inline text-xs sm:text-sm font-medium">Copy</span>
            </button>
            <button
              onClick={handleCutSelected}
              className="p-1.5 sm:px-3 sm:py-1.5 text-gray-700 dark:text-gray-300 hover:bg-emerald-100/60 dark:hover:bg-emerald-900/40 rounded-lg transition-colors active:scale-95 flex items-center gap-1.5"
              title="Move"
              aria-label="Move"
            >
              <Scissors className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
              <span className="hidden sm:inline text-xs sm:text-sm font-medium">Move</span>
            </button>
            {selectedItems.size === 1 && (
              <button
                onClick={() => {
                   const id = Array.from(selectedItems)[0];
                   const item = displayFolder?.folders[id] 
                      ? { type: 'folder' as const, item: displayFolder.folders[id] } 
                      : { type: 'file' as const, item: displayFolder?.files.find(f => f.id === id)! };
                   if (item.item) setRenameModal({ item, newName: item.item.name });
                   setSelectedItems(new Set());
                }} 
                className="p-1.5 sm:px-3 sm:py-1.5 text-gray-700 dark:text-gray-300 hover:bg-emerald-100/60 dark:hover:bg-emerald-900/40 rounded-lg transition-colors active:scale-95 flex items-center gap-1.5"
                title="Rename"
                aria-label="Rename"
              >
                <Edit2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
                <span className="hidden sm:inline text-xs sm:text-sm font-medium">Rename</span>
              </button>
            )}
            {Array.from(selectedItems).some(id => {
              const f = displayFolder?.files.find(item => item.id === id);
              return f && isAudioFile(f);
            }) && (
              <>
                <button
                  onClick={() => {
                    const audioFiles = Array.from(selectedItems)
                      .map(id => displayFolder?.files.find(f => f.id === id))
                      .filter((f): f is VirtualFile => Boolean(f && isAudioFile(f)));
                    if (audioFiles.length > 0) {
                      playTrack(audioFiles[0], audioFiles);
                      setSelectedItems(new Set());
                    }
                  }}
                  className="p-1.5 sm:px-3 sm:py-1.5 text-gray-700 dark:text-gray-300 hover:bg-emerald-100/60 dark:hover:bg-emerald-900/40 rounded-lg transition-colors active:scale-95 flex items-center gap-1.5"
                  title="Play Selected"
                  aria-label="Play Selected"
                >
                  <Play className="w-4 h-4 text-emerald-600 dark:text-emerald-400 fill-current" />
                  <span className="hidden sm:inline text-xs sm:text-sm font-medium">Play</span>
                </button>
                <button
                  onClick={() => {
                    const audioFiles = Array.from(selectedItems)
                      .map(id => displayFolder?.files.find(f => f.id === id))
                      .filter((f): f is VirtualFile => Boolean(f && isAudioFile(f)));
                    audioFiles.forEach(f => addToQueue(f));
                    setSelectedItems(new Set());
                  }}
                  className="p-1.5 sm:px-3 sm:py-1.5 text-gray-700 dark:text-gray-300 hover:bg-emerald-100/60 dark:hover:bg-emerald-900/40 rounded-lg transition-colors active:scale-95 flex items-center gap-1.5"
                  title="Add to Queue"
                  aria-label="Add to Queue"
                >
                  <ListMusic className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
                  <span className="hidden sm:inline text-xs sm:text-sm font-medium">Queue</span>
                </button>
              </>
            )}
            <button 
              onClick={handleDownloadSelected} 
              className="p-1.5 sm:px-3 sm:py-1.5 text-gray-700 dark:text-gray-300 hover:bg-emerald-100/60 dark:hover:bg-emerald-900/40 rounded-lg transition-colors active:scale-95 flex items-center gap-1.5" 
              title="Download"
              aria-label="Download"
            >
              <Download className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
              <span className="hidden sm:inline text-xs sm:text-sm font-medium">Download</span>
            </button>
            <div className="w-px h-5 bg-gray-300 dark:bg-gray-700 mx-0.5"></div>
            <button
              onClick={handleDeleteSelected}
              className="p-1.5 sm:px-3 sm:py-1.5 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-lg transition-colors active:scale-95 flex items-center gap-1.5"
              title="Delete"
              aria-label="Delete"
            >
              <Trash2 className="w-4 h-4" />
              <span className="hidden sm:inline text-xs sm:text-sm font-medium">Delete</span>
            </button>
          </div>
        </div>
      </div>
      </header>

      {/* Breadcrumb Path Bar */}
      <div className="h-9 min-w-0 flex items-center border-b border-gray-200/70 dark:border-gray-800/70 px-2 sm:px-6 pl-[max(0.5rem,env(safe-area-inset-left,0px))] pr-[max(0.5rem,env(safe-area-inset-right,0px))] bg-drive-surface dark:bg-drive-darksurface shrink-0">
        <div className="min-w-0 w-full flex items-center overflow-x-auto overflow-y-hidden whitespace-nowrap text-sm sm:text-base font-medium text-gray-600 dark:text-gray-300">
          {pathStack.map((folder, idx) => (
            <React.Fragment key={folder.id}>
              <button onClick={() => navigateUp(idx)} className="breadcrumb-link shrink-0 px-1.5 sm:px-2 py-0.5 rounded-lg transition-colors flex items-center gap-1.5 focus:outline-none focus:ring-0">
                <span className="max-w-[12rem] truncate">{idx === 0 ? ('Home') : folder.name}</span>
              </button>
              {idx < pathStack.length - 1 && <ChevronRight className="w-4 h-4 mx-0.5 sm:mx-1 text-gray-400 shrink-0" />}
            </React.Fragment>
          ))}
        </div>
      </div>

      {/* Music Player (Minimal bar below header / breadcrumbs) */}
      <MusicPlayer />

      <main className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4 sm:p-6 pb-[calc(4.75rem+env(safe-area-inset-bottom,0px))] md:pb-6 pl-[max(1rem,env(safe-area-inset-left,0px))] pr-[max(1rem,env(safe-area-inset-right,0px))] bg-white dark:bg-[#131314] select-none touch-no-select">
        {loading ? (
          <div className="flex flex-col items-center justify-center h-64 text-gray-500 gap-4">
            <div className="app-loader">
              <VoxelLogoLoader />
              <div className="app-loader__bar" />
            </div>
            <p>Loading files...</p>
          </div>
        ) : displayFolder ? (
          <div key={`${currentFolder?.id || 'root'}-${viewMode}-${itemSize}`} className="drive-layout-transition max-w-7xl mx-auto gpu-fast">
            {(() => {
              const allFoldersList = Object.values(displayFolder.folders).sort((a, b) => {
                let cmp = 0;
                if (sortMode === 'date') {
                  cmp = getFolderTimestamp(a) - getFolderTimestamp(b);
                } else if (sortMode === 'size') {
                  const sizeA = (a.files || []).reduce((acc, f) => acc + (f.size || 0), 0);
                  const sizeB = (b.files || []).reduce((acc, f) => acc + (f.size || 0), 0);
                  cmp = sizeA - sizeB;
                } else {
                  cmp = a.name.localeCompare(b.name);
                }
                return sortOrder === 'asc' ? cmp : -cmp;
              });

              const sortedFiles = [...displayFolder.files].sort((a, b) => {
                let cmp = 0;
                if (sortMode === 'date') {
                  cmp = getFileTimestamp(a) - getFileTimestamp(b);
                } else if (sortMode === 'size') {
                  cmp = a.size - b.size;
                } else if (sortMode === 'duration') {
                  cmp = (a.duration || 0) - (b.duration || 0);
                } else {
                  cmp = a.name.localeCompare(b.name);
                }
                return sortOrder === 'asc' ? cmp : -cmp;
              });

              const totalItems = allFoldersList.length + sortedFiles.length;

              return (
                <>
                  {/* Folder & Files Toolbar / Sort Header */}
                  {totalItems > 0 && (
                    <div className="flex items-center justify-between gap-2 mb-3 pb-2 border-b border-gray-100 dark:border-zinc-800/60 select-none">
                      {/* Left: Folder Identity & Micro Counts Badge */}
                      <div className="flex items-center gap-2 min-w-0">
                        <div className="flex items-center gap-1.5 min-w-0">
                          <Folder className="w-3.5 h-3.5 text-zinc-400 dark:text-zinc-500 shrink-0" />
                          <span className="text-xs font-semibold text-zinc-700 dark:text-zinc-200 truncate max-w-[120px] xs:max-w-[180px] sm:max-w-xs">
                            {currentFolder?.name || 'All Files'}
                          </span>
                        </div>

                        <div className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-zinc-100/90 dark:bg-zinc-800/60 border border-zinc-200/50 dark:border-zinc-700/40 text-[10px] font-mono text-zinc-500 dark:text-zinc-400 shrink-0">
                          {allFoldersList.length > 0 && (
                            <span className="flex items-center gap-0.5">
                              <span className="font-bold text-zinc-700 dark:text-zinc-300">{allFoldersList.length}</span>
                              <span className="text-[9px] text-zinc-400 hidden xs:inline">{allFoldersList.length === 1 ? 'folder' : 'folders'}</span>
                            </span>
                          )}
                          {allFoldersList.length > 0 && sortedFiles.length > 0 && (
                            <span className="text-zinc-300 dark:text-zinc-600">•</span>
                          )}
                          {sortedFiles.length > 0 && (
                            <span className="flex items-center gap-0.5">
                              <span className="font-bold text-zinc-700 dark:text-zinc-300">{sortedFiles.length}</span>
                              <span className="text-[9px] text-zinc-400 hidden xs:inline">{sortedFiles.length === 1 ? 'file' : 'files'}</span>
                            </span>
                          )}
                        </div>
                      </div>

                      {/* Right: Sleek Micro Sort Controls */}
                      <div className="flex items-center gap-1.5 shrink-0" ref={folderSortMenuRef}>
                        <div className="relative">
                          <button
                            type="button"
                            onClick={() => setIsFolderSortOpen(prev => !prev)}
                            className={`h-7 px-2 rounded-lg text-xs font-medium flex items-center gap-1.5 transition-all select-none border active:scale-95 ${
                              isFolderSortOpen
                                ? 'bg-red-50 dark:bg-red-950/40 text-red-600 dark:text-rose-400 border-red-500/30 ring-1 ring-red-500/20'
                                : 'bg-gray-100 hover:bg-gray-200/80 dark:bg-zinc-800/80 dark:hover:bg-zinc-700/80 text-zinc-700 dark:text-zinc-300 border-gray-200/70 dark:border-zinc-700/50'
                            }`}
                            title="Sort mode"
                          >
                            <ArrowUpDown className="w-3 h-3 text-rose-500" />
                            <span className="text-[11px] font-semibold">
                              {sortMode === 'date' ? 'Date' : sortMode === 'duration' ? 'Time' : sortMode === 'name' ? 'Name' : 'Size'}
                            </span>
                            <ChevronDown className={`w-2.5 h-2.5 text-zinc-400 transition-transform duration-150 ${isFolderSortOpen ? 'rotate-180' : ''}`} />
                          </button>

                          {/* Floating Micro Popover Menu */}
                          {isFolderSortOpen && (
                            <div className="absolute right-0 mt-1.5 w-36 py-1 rounded-xl bg-white/95 dark:bg-[#18181b]/95 backdrop-blur-xl border border-black/10 dark:border-white/10 shadow-2xl z-50 animate-in fade-in zoom-in-95 duration-150">
                              {[
                                { id: 'date', label: 'Date Added' },
                                { id: 'name', label: 'Name' },
                                { id: 'size', label: 'Size' },
                                { id: 'duration', label: 'Duration' },
                              ].map(item => {
                                const isActive = sortMode === item.id;
                                return (
                                  <button
                                    key={item.id}
                                    type="button"
                                    onClick={() => {
                                      setSortMode(item.id as any);
                                      setIsFolderSortOpen(false);
                                    }}
                                    className={`w-full flex items-center justify-between px-2.5 py-1.5 text-xs font-medium transition-colors text-left ${
                                      isActive 
                                        ? 'bg-red-50 dark:bg-red-950/40 text-red-600 dark:text-rose-400 font-bold' 
                                        : 'text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800/80'
                                    }`}
                                  >
                                    <span>{item.label}</span>
                                    {isActive && <Check className="w-3 h-3 text-rose-500 stroke-[2.5]" />}
                                  </button>
                                );
                              })}
                            </div>
                          )}
                        </div>

                        {/* Direction Toggle Button */}
                        <button
                          type="button"
                          onClick={() => setSortOrder(prev => prev === 'asc' ? 'desc' : 'asc')}
                          className="h-7 px-1.5 rounded-lg bg-gray-100 hover:bg-gray-200/80 dark:bg-zinc-800/80 dark:hover:bg-zinc-700/80 text-zinc-700 dark:text-zinc-300 border border-gray-200/70 dark:border-zinc-700/50 flex items-center gap-0.5 text-[10px] font-mono font-bold transition-all active:scale-90"
                          title={sortOrder === 'asc' ? "Ascending (Oldest / A-Z)" : "Descending (Newest / Z-A)"}
                        >
                          {sortOrder === 'asc' ? (
                            <ArrowUp className="w-3 h-3 text-rose-500 stroke-[2.5]" />
                          ) : (
                            <ArrowDown className="w-3 h-3 text-rose-500 stroke-[2.5]" />
                          )}
                          <span className="text-[10px] text-zinc-500 dark:text-zinc-400">{sortOrder === 'asc' ? 'Asc' : 'Desc'}</span>
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Folders Section */}
                  {renderFolderSection(allFoldersList)}

                  {/* Files Section */}
                  {sortedFiles.length > 0 && (
                    <section>
                      {allFoldersList.length > 0 && (
                        <h2 className="text-sm font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-4">Files</h2>
                      )}
                  {viewMode === 'grid' || viewMode === 'gallery' ? (
                  <div className={
                    viewMode === 'gallery'
                      ? (itemSize === 'small'
                          ? "grid grid-cols-2 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3 sm:gap-4"
                          : itemSize === 'large'
                          ? "grid grid-cols-1 sm:grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6 sm:gap-8"
                          : "grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 sm:gap-6")
                      : (itemSize === 'small'
                          ? "grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-8 gap-2 sm:gap-3"
                          : itemSize === 'large'
                          ? "grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-4 gap-4 sm:gap-6"
                          : "grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3 sm:gap-4")
                  }>
                    {sortedFiles.map((file, fileIndex) => {
                      const isSelected = selectedItems.has(file.id);
                      const isCut = clipboard?.action === 'move' && clipboard.items.some(i => i.type === 'file' && i.item.id === file.id);
                      return (
                      <div 
                        key={file.id}
                        id={`file-${file.id}`}
                        onClick={(e) => {
                          if (longPressHandledRef.current) {
                            longPressHandledRef.current = false;
                            return;
                          }
                          if (selectedItems.size > 0) toggleSelection(e, file.id);
                          else {
                            if (isAudioFile(file)) {
                              const audioTracks = sortedFiles.filter(isAudioFile);
                              playTrack(file, audioTracks);
                            } else {
                              setActiveFile(file);
                              window.location.hash = `#/file/${encodeURIComponent(file.id)}`;
                            }
                          }
                        }}
                        onTouchStart={(e) => handleItemTouchStart(e, file.id)}
                        onTouchMove={handleItemTouchMove}
                        onTouchEnd={handleItemTouchEnd}
                        onTouchCancel={handleItemTouchEnd}
                        onContextMenu={(e) => handleContextMenu(e, { type: 'file', item: file })}
                        className={`group relative flex flex-col border rounded-xl overflow-hidden cursor-pointer select-none touch-no-select gpu-fast transition-[transform,border-color,background-color] duration-150 ease-out active:scale-[0.98] ${isCut ? 'opacity-50' : ''} ${isSelected ? 'border-emerald-500/50 ring-2 ring-emerald-500 bg-emerald-500/10 dark:bg-emerald-500/15' : highlightFileId === file.id ? 'border-blue-500 ring-2 ring-blue-500 bg-blue-500/10 dark:bg-blue-500/15' : 'border-gray-200 dark:border-gray-800 bg-drive-surface dark:bg-drive-darksurface hover:bg-drive-hover dark:hover:bg-drive-darkhover hover:-translate-y-0.5 hover:shadow-md'}`}
                      >
                        {renderSelectCheckbox(isSelected, (e) => toggleSelection(e, file.id), "absolute top-2 right-2 z-30 bg-white/40 dark:bg-black/40 backdrop-blur-md")}
                        <div className={`${viewMode === 'gallery' ? 'aspect-video' : 'aspect-square'} bg-gray-50 dark:bg-gray-800/50 flex items-center justify-center relative overflow-hidden p-0 border-b border-gray-100 dark:border-gray-800`}>
                          <NativeThumbnail 
                            file={file} 
                            order={fileIndex} 
                            iconClassName={viewMode === 'gallery' ? (itemSize === 'large' ? "w-28 h-28" : itemSize === 'small' ? "w-16 h-16" : "w-22 h-22") : (itemSize === 'large' ? "w-20 h-20" : itemSize === 'small' ? "w-10 h-10" : "w-14 h-14")} 
                            isGrid={true}
                            showPartsBadge={true} 
                          />
                          {file.mimeType.startsWith('video/') && (
                            <div className="absolute inset-0 bg-black/5 group-hover:bg-black/0 transition-colors flex items-center justify-center pointer-events-none">
                              <div className="w-12 h-12 rounded-full bg-black/20 backdrop-blur-sm flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                                <div className="w-0 h-0 border-t-8 border-b-8 border-l-[14px] border-y-transparent border-l-white ml-1" />
                              </div>
                            </div>
                          )}
                        </div>
                        <div className={itemSize === 'small' ? 'p-2' : itemSize === 'large' ? 'p-3.5' : 'p-2.5 sm:p-3'}>
                          <div className="flex items-start justify-between gap-1">
                            <div className="flex items-center gap-1.5 flex-1 min-w-0">
                              <span className={`font-semibold ${viewMode === 'gallery' ? (itemSize === 'large' ? 'text-lg line-clamp-2' : 'text-sm sm:text-base line-clamp-2') : (itemSize === 'small' ? 'text-xs truncate' : itemSize === 'large' ? 'text-base truncate' : 'text-sm truncate')} flex-1 min-w-0 dir-auto font-sans`} title={file.name}>
                                {file.name}
                              </span>
                              {file.isUncaptioned && (
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setUnindexedFileTarget(file);
                                    setIndexingFileName(file.name);
                                  }}
                                  className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-amber-500/15 hover:bg-amber-500/25 border border-amber-500/40 text-amber-500 dark:text-amber-400 text-[10px] font-bold shadow-sm transition-all hover:scale-105 active:scale-95 shrink-0"
                                  title="Unindexed Telegram File - Click to index into drive"
                                >
                                  <AlertCircle className="w-3 h-3 text-amber-500 animate-pulse" />
                                  <span>Index</span>
                                </button>
                              )}
                            </div>
                            <button
                              type="button"
                              onClick={(e) => openItemMenu(e, { type: 'file', item: file })}
                              className="p-1 -mr-1 -mt-0.5 text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg transition-colors shrink-0"
                              title="More options"
                              aria-label="More options"
                            >
                              <MoreVertical className="w-4 h-4" />
                            </button>
                          </div>
                          <div className="flex items-center gap-1.5 mt-1 text-[11px] sm:text-xs text-gray-400 dark:text-gray-500">
                            <span className="font-medium text-gray-500 dark:text-gray-400">{formatSize(file.size)}</span>
                            {file.parts.length > 1 && (
                              <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 bg-blue-500/10 text-blue-600 dark:text-blue-400 font-medium rounded-full text-[10px] shrink-0">
                                <Layers className="w-2.5 h-2.5" />
                                <span>{file.parts.length} Parts</span>
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                    )})}
                  </div>
                ) : (
                  <div className="flex flex-col gap-2">
                    {sortedFiles.map((file, fileIndex) => {
                      const isSelected = selectedItems.has(file.id);
                      const isCut = clipboard?.action === 'move' && clipboard.items.some(i => i.type === 'file' && i.item.id === file.id);
                      const ext = file.name.split('.').pop()?.toUpperCase() || 'FILE';
                      const isVideo = file.mimeType.startsWith('video/') || ['mp4', 'mkv', 'webm', 'mov', 'avi', 'flv'].includes(file.name.split('.').pop()?.toLowerCase() || '');

                      return (
                        <div 
                          key={file.id} 
                          id={`file-${file.id}`}
                          onClick={(e) => {
                            if (longPressHandledRef.current) {
                              longPressHandledRef.current = false;
                              return;
                            }
                            if (selectedItems.size > 0) toggleSelection(e, file.id);
                            else {
                              if (isAudioFile(file)) {
                                const audioTracks = sortedFiles.filter(isAudioFile);
                                playTrack(file, audioTracks);
                              } else {
                                setActiveFile(file);
                                window.location.hash = `#/file/${encodeURIComponent(file.id)}`;
                              }
                            }
                          }}
                          onTouchStart={(e) => handleItemTouchStart(e, file.id)}
                          onTouchMove={handleItemTouchMove}
                          onTouchEnd={handleItemTouchEnd}
                          onTouchCancel={handleItemTouchEnd}
                          onContextMenu={(e) => handleContextMenu(e, { type: 'file', item: file })}
                          className={`group flex items-center ${itemSize === 'small' ? 'gap-2.5 p-2' : itemSize === 'large' ? 'gap-4 p-3.5 sm:p-4' : 'gap-3 sm:gap-4 p-2.5 sm:p-3'} border rounded-xl cursor-pointer select-none touch-no-select gpu-fast transition-[transform,border-color,background-color] duration-150 ease-out active:scale-[0.99] ${isCut ? 'opacity-50' : ''} ${isSelected ? 'bg-emerald-500/10 dark:bg-emerald-500/15 border-emerald-500/50 ring-2 ring-emerald-500' : 'bg-drive-surface dark:bg-drive-darksurface border-gray-200/80 dark:border-gray-800/80 hover:bg-drive-hover dark:hover:bg-drive-darkhover hover:shadow-sm'}`}
                        >
                          {renderSelectCheckbox(isSelected, (e) => toggleSelection(e, file.id), "-ml-0.5 sm:-ml-1")}
                          
                          {/* Thumbnail / Icon container (Windows Content style) */}
                          <div className={`${itemSize === 'small' ? 'w-10 h-10 sm:w-12 sm:h-12' : itemSize === 'large' ? 'w-16 h-16 sm:w-20 sm:h-20' : 'w-12 h-12 sm:w-16 sm:h-16'} rounded-xl overflow-hidden bg-gray-100 dark:bg-gray-800/80 shrink-0 flex items-center justify-center relative border border-black/5 dark:border-white/5`}>
                            <NativeThumbnail 
                              file={file} 
                              order={fileIndex} 
                              iconClassName={itemSize === 'small' ? "w-5 h-5 sm:w-6 sm:h-6" : itemSize === 'large' ? "w-9 h-9 sm:w-11 sm:h-11" : "w-7 h-7 sm:w-9 sm:h-9"} 
                              isGrid={true} 
                              showPartsBadge={false}
                            />
                          </div>

                          {/* File Details (Responsive, zero horizontal overflow, robust styling) */}
                          <div className="flex-1 min-w-0 flex flex-col justify-center gap-1">
                            <div className="flex items-center gap-2 min-w-0">
                              <span className={`font-semibold ${itemSize === 'small' ? 'text-xs sm:text-sm' : itemSize === 'large' ? 'text-base sm:text-lg' : 'text-sm sm:text-base'} text-gray-900 dark:text-gray-100 truncate dir-auto font-sans`} title={file.name}>
                                {file.name}
                              </span>
                              {file.isUncaptioned && (
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setUnindexedFileTarget(file);
                                    setIndexingFileName(file.name);
                                  }}
                                  className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-amber-500/15 hover:bg-amber-500/25 border border-amber-500/40 text-amber-500 dark:text-amber-400 text-[10px] font-bold shadow-sm transition-all hover:scale-105 active:scale-95 shrink-0"
                                  title="Unindexed Telegram File - Click to index into drive"
                                >
                                  <AlertCircle className="w-3 h-3 text-amber-500 animate-pulse" />
                                  <span>Index</span>
                                </button>
                              )}
                            </div>
                            
                            {/* Metadata Pills */}
                            <div className="flex flex-wrap items-center gap-1.5 sm:gap-2 text-[11px] sm:text-xs text-gray-500 dark:text-gray-400">
                              <span className="font-medium text-gray-700 dark:text-gray-300">
                                {formatSize(file.size)}
                              </span>
                              
                              <span className="text-gray-300 dark:text-gray-600">•</span>
                              
                              <span className="text-[10px] tracking-wide font-medium px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300">
                                {ext}
                              </span>

                              {file.parts.length > 1 && (
                                <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-blue-500/10 text-blue-600 dark:text-blue-400 font-semibold rounded-full text-[10px] sm:text-xs border border-blue-500/25 whitespace-nowrap shrink-0 shadow-xs">
                                  <Layers className="w-3 h-3 text-blue-500 shrink-0" />
                                  <span>{file.parts.length} Parts</span>
                                </span>
                              )}

                              {isVideo && file.duration && file.duration > 0 && (
                                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-rose-500/10 text-rose-600 dark:text-rose-400 font-medium rounded text-[10px] sm:text-[11px] border border-rose-500/20 whitespace-nowrap shrink-0">
                                  <Clock className="w-3 h-3" />
                                  <span>{formatDuration(file.duration)}</span>
                                </span>
                              )}
                            </div>
                          </div>

                          {/* Actions */}
                          <button
                            type="button"
                            onClick={(e) => openItemMenu(e, { type: 'file', item: file })}
                            className="p-1.5 text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg transition-colors shrink-0"
                            title="More options"
                            aria-label="More options"
                          >
                            <MoreVertical className="w-4 h-4" />
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </section>
            )}
          </>
        );
      })()}
            
            {isFolderLoading ? (
              <div className="flex flex-col items-center justify-center py-20 text-gray-400 dark:text-gray-500 gap-4">
                <div className="app-loader">
                  <VoxelLogoLoader />
                  <div className="app-loader__bar" />
                </div>
                <p className="text-sm font-medium">Loading folder contents...</p>
              </div>
            ) : Object.keys(displayFolder.folders).length === 0 && displayFolder.files.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-20 text-gray-400 dark:text-gray-500">
                <Folder className="w-16 h-16 mb-4 opacity-50" />
                <p>This folder is empty</p>
              </div>
            ) : null}
          </div>
        ) : null}
      </main>

      {/* Toast Notification */}
      {toastMessage && (
        <div className="fixed top-20 right-6 z-50 animate-in slide-in-from-top-5 fade-in duration-300 max-w-sm">
          <div className={`flex items-start gap-3 p-4 rounded-xl shadow-2xl border ${toastMessage.type === 'error' ? 'bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800 text-red-800 dark:text-red-200' : 'bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-800 text-green-800 dark:text-green-200'}`}>
            <div className="flex-1">
              <h4 className="font-bold text-sm mb-1">{toastMessage.title}</h4>
              <p className="text-sm opacity-90 leading-relaxed">{toastMessage.message}</p>
            </div>
            <button onClick={() => setToastMessage(null)} className="p-1 hover:bg-black/5 dark:hover:bg-white/10 rounded-full transition-colors">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}
      
      {/* Clipboard Paste Floating Action Button */}
      {clipboard && selectedItems.size === 0 && (
        <div className="fixed bottom-[calc(4.75rem+env(safe-area-inset-bottom,0px))] sm:bottom-6 right-3 sm:right-6 z-40 bg-white/95 dark:bg-[#1c1c1f]/95 shadow-2xl rounded-full p-1.5 sm:p-2 flex items-center gap-2 border border-gray-200/80 dark:border-white/10 backdrop-blur-xl ring-1 ring-black/5 dark:ring-white/10 animate-in slide-in-from-bottom-5 duration-200 select-none">
          <button 
            onClick={handlePaste}
            className="flex items-center gap-2 px-3.5 sm:px-4 py-2 bg-blue-600 hover:bg-blue-500 active:scale-95 text-white rounded-full font-medium transition-all shadow-md shadow-blue-600/30 text-xs sm:text-sm"
          >
            <ClipboardPaste className="w-4 h-4 sm:w-5 sm:h-5" />
            <span>Paste {clipboard.items.length} {clipboard.items.length === 1 ? 'item' : 'items'}</span>
          </button>
          <button 
            onClick={() => setClipboard(null)}
            className="p-1.5 sm:p-2 text-gray-400 hover:text-gray-200 hover:bg-white/10 rounded-full transition-colors mr-0.5 active:scale-90"
            title="Cancel"
            aria-label="Cancel paste"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Background Operations UI (Docked safely above mobile footer, non-overlapping flex stack) */}
      {operations.length > 0 && (
        <div className="fixed bottom-[calc(4.75rem+env(safe-area-inset-bottom,0px))] sm:bottom-6 left-3 right-3 sm:left-6 sm:right-auto sm:w-96 z-40 flex flex-col gap-2.5 max-h-[45vh] overflow-y-auto pointer-events-none select-none">
          {operations.map(op => (
            <div 
              key={op.id} 
              className="pointer-events-auto bg-white/95 dark:bg-[#18191f]/95 backdrop-blur-2xl border border-gray-200/80 dark:border-white/10 shadow-2xl rounded-2xl p-3.5 sm:p-4 animate-in slide-in-from-bottom-2 duration-200 ring-1 ring-black/5 dark:ring-white/5"
            >
              <div className="flex items-center justify-between mb-1.5 gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  {op.status === 'running' ? (
                    op.phase === 'locating' ? (
                      <Search className="w-4 h-4 text-amber-400 shrink-0 animate-pulse" />
                    ) : (
                      <Loader2 className="w-4 h-4 text-blue-500 shrink-0 animate-spin" />
                    )
                  ) : op.status === 'error' ? (
                    <AlertCircle className="w-4 h-4 text-red-500 shrink-0" />
                  ) : (
                    <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0" />
                  )}
                  <span className="text-xs sm:text-sm font-bold text-gray-800 dark:text-gray-100 truncate capitalize">
                    {op.phase === 'locating' ? 'Locating' : op.type === 'copy' ? 'Copying' : op.type === 'move' ? 'Moving' : 'Deleting'} {op.name}
                  </span>
                </div>
                {op.status === 'running' ? (
                  <span className="text-[11px] font-mono font-bold text-blue-600 dark:text-blue-400 bg-blue-500/10 px-2 py-0.5 rounded-md tabular-nums shrink-0">
                    {Math.round(op.progress)}%
                  </span>
                ) : (
                  <button 
                    onClick={clearDoneOperations} 
                    className="p-1 rounded-lg text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-black/5 dark:hover:bg-white/10 transition-colors shrink-0"
                    title="Dismiss"
                  >
                    <X className="w-4 h-4" />
                  </button>
                )}
              </div>

              {/* Status detail text */}
              {op.statusText && (
                <p className="text-[11px] text-gray-500 dark:text-gray-400 truncate mb-2 leading-relaxed">
                  {op.statusText}
                </p>
              )}

              {/* Progress Bar */}
              <div className="w-full bg-gray-100 dark:bg-white/10 rounded-full h-1.5 mb-1.5 overflow-hidden">
                <div 
                  className={`h-1.5 rounded-full transition-all duration-300 ease-out ${
                    op.status === 'error' ? 'bg-red-500' : 
                    op.status === 'done' ? 'bg-emerald-500' : 
                    op.phase === 'locating' ? 'bg-gradient-to-r from-amber-500 to-blue-500' : 
                    'bg-blue-500'
                  }`} 
                  style={{ width: `${Math.max(3, Math.min(100, op.progress))}%` }}
                />
              </div>

              <div className="flex justify-between items-center text-[10px] text-gray-400 dark:text-gray-500">
                <span>
                  {op.status === 'done' ? 'Completed' : op.status === 'error' ? 'Failed' : op.phase === 'locating' ? 'Searching Cloud...' : 'Processing...'}
                </span>
                <span className="font-mono">
                  {op.current || 0} / {op.total || 0} items
                </span>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Settings Modal */}
      {(isSettingsOpen || isClosingSettings) && (
        <div
          className={`drive-settings-modal fixed inset-0 flex items-center justify-center z-50 p-3 sm:p-4 ${isClosingSettings ? 'drive-settings-modal--closing' : 'drive-settings-modal--open'}`}
          onClick={closeSettingsModal}
        >
          <div
            className="drive-settings-modal__panel bg-white dark:bg-drive-darksurface rounded-2xl sm:rounded-3xl w-full max-w-md p-4 sm:p-6 shadow-xl border border-gray-200 dark:border-gray-800 max-h-[min(86vh,48rem)] flex flex-col"
            onClick={e => e.stopPropagation()}
          >
            <div className="drive-settings-modal__header flex justify-between items-center mb-5 sm:mb-6 shrink-0">
              <div className="flex items-center gap-3 min-w-0">
                <Settings className="w-5 h-5 text-[#9A2227] shrink-0" />
                <div className="min-w-0">
                  <h2 className="text-xl font-bold truncate">Settings</h2>
                  <p className="text-xs text-gray-500 dark:text-gray-400 truncate">Personalize your cloud workspace</p>
                </div>
              </div>
              <button onClick={closeSettingsModal} className="p-2 rounded-xl text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors shrink-0" aria-label="Close settings">
                <X className="w-6 h-6" />
              </button>
            </div>
            
            <div className="space-y-6 overflow-y-auto pr-2 flex-1">
              <div className="rounded-2xl border border-violet-200/70 bg-violet-50/70 p-4 dark:border-violet-900/50 dark:bg-violet-950/20">
                <div className="mb-3 flex items-center justify-between gap-3">
                  <div>
                    <label className="block text-sm font-semibold text-violet-700 dark:text-violet-300">Telegram accounts</label>
                    <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">Switch securely between up to three cached sessions.</p>
                  </div>
                  <span className="rounded-full bg-violet-600 px-2 py-1 text-[11px] font-bold text-white">{accounts.length}/3</span>
                </div>
                <div className="space-y-2">
                  {accounts.map(account => (
                    <div key={account.id} className={`flex items-center gap-3 rounded-xl border p-3 ${account.id === activeAccountId ? 'border-violet-400 bg-white/80 dark:bg-white/5' : 'border-gray-200 bg-white/50 dark:border-gray-800 dark:bg-black/10'}`}>
                      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-violet-500 to-cyan-500 text-sm font-bold text-white">{(account.displayName || account.username || '?').slice(0, 1).toUpperCase()}</span>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-semibold">{account.displayName}</div>
                        <div className="truncate text-xs text-gray-500 dark:text-gray-400">{account.username ? `@${account.username}` : account.id}</div>
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0">
                        {account.id === activeAccountId ? (
                          <span className="text-[11px] font-semibold text-emerald-600 bg-emerald-500/10 px-2.5 py-1 rounded-lg">Active</span>
                        ) : (
                          <button
                            type="button"
                            disabled={!!accountAction}
                            onClick={async () => {
                              setAccountAction(account.id);
                              setAccountError('');
                              setSwitchingTargetAccount(account);
                              try {
                                await switchAccount(account.id);
                                setTimeout(() => {
                                  setSwitchingTargetAccount(null);
                                  setIsSettingsOpen(false);
                                }, 500);
                              } catch (error: any) {
                                setSwitchingTargetAccount(null);
                                setAccountError(error?.message || 'Could not switch account.');
                              } finally {
                                setAccountAction(null);
                              }
                            }}
                            className="rounded-lg bg-violet-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-violet-700 disabled:opacity-50"
                          >
                            {accountAction === account.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Switch'}
                          </button>
                        )}
                        <button
                          type="button"
                          disabled={!!accountAction || isTerminatingAccount}
                          title="Terminate session in Telegram"
                          onClick={() => {
                            setAccountError('');
                            setAccountToTerminate(account);
                          }}
                          className="p-1.5 text-gray-400 hover:text-rose-500 hover:bg-rose-500/10 rounded-lg transition-colors disabled:opacity-50"
                        >
                          <LogOut className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
                {accountError && <p className="mt-2 text-xs text-red-600">{accountError}</p>}
                <button type="button" disabled={accounts.length >= 3} onClick={() => setIsAddingAccount(true)} className="mt-3 w-full rounded-xl border border-dashed border-violet-300 px-3 py-2.5 text-sm font-semibold text-violet-700 transition hover:bg-violet-100 disabled:cursor-not-allowed disabled:opacity-40 dark:border-violet-800 dark:text-violet-300 dark:hover:bg-violet-950/40">+ Add Telegram account</button>
              </div>

              {/* Bot Configuration */}
              <div className="bg-[#9A2227]/5 dark:bg-[#9A2227]/10 p-4 rounded-xl border border-[#9A2227]/20">
                <label className="block text-sm font-semibold mb-1 text-[#9A2227]">Speed Boost (Bot Token)</label>
                <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
                  To bypass Telegram's user session limits for uploading/downloading, provide a Bot Token. The bot will automatically be added as an admin to your folders.
                </p>
                
                {botClient ? (
                  <div className="flex items-center justify-between bg-green-500/10 border border-green-500/20 p-3 rounded-lg">
                    <div className="flex items-center gap-2 text-green-600 dark:text-green-500 text-sm font-medium">
                      <CheckCircle2 className="w-4 h-4" />
                      Bot Connected
                    </div>
                    <button 
                      onClick={() => removeBot()}
                      className="text-xs px-3 py-1.5 bg-red-500/10 hover:bg-red-500/20 text-red-600 rounded-md transition-colors font-medium"
                    >
                      Disconnect
                    </button>
                  </div>
                ) : (
                  <div className="space-y-2">
                    <input 
                      type="text" 
                      value={botTokenInput}
                      onChange={e => { setBotTokenInput(e.target.value); setBotSaveError(''); }}
                      placeholder="123456789:ABCdefGHIjklmNOPQrsTUVwxyZ"
                      className="w-full bg-white dark:bg-[#131314] border border-gray-200 dark:border-gray-800 rounded-lg px-3 py-2 text-sm outline-none focus:border-[#9A2227] transition-colors"
                    />
                    {botSaveError && <p className="text-xs text-red-500">{botSaveError}</p>}
                    <button 
                      onClick={async () => {
                        if (!botTokenInput.trim()) return;
                        setIsBotSaving(true);
                        setBotSaveError('');
                        try {
                          await setupBot(botTokenInput.trim());
                          setBotTokenInput('');
                        } catch (e: any) {
                          setBotSaveError(e.message || 'Failed to connect bot');
                        } finally {
                          setIsBotSaving(false);
                        }
                      }}
                      disabled={isBotSaving || !botTokenInput.trim()}
                      className="w-full bg-[#9A2227] hover:bg-red-800 text-white font-medium text-sm py-2 rounded-lg transition-colors flex items-center justify-center disabled:opacity-50"
                    >
                      {isBotSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Connect Bot'}
                    </button>
                  </div>
                )}
              </div>

              {/* PWA & Mobile App Section */}
              <div className="rounded-2xl border border-red-200/70 bg-red-50/50 p-4 dark:border-red-900/40 dark:bg-red-950/15">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <div className="p-2 rounded-xl bg-red-500/10 text-red-500 dark:bg-red-500/20">
                      <Smartphone className="w-5 h-5" />
                    </div>
                    <div>
                      <h4 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Progressive Web App (PWA)</h4>
                      <p className="text-xs text-gray-500 dark:text-gray-400">
                        {isStandalone 
                          ? 'ZUD Cloud is running in standalone mobile application mode.' 
                          : 'Install on Android or iOS home screen for native fullscreen experience.'}
                      </p>
                    </div>
                  </div>
                  {isStandalone ? (
                    <span className="text-xs font-semibold text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 px-2.5 py-1 rounded-lg border border-emerald-500/20 shrink-0">
                      Installed
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={triggerInstall}
                      className="px-3.5 py-1.5 rounded-xl text-xs font-medium bg-red-600 hover:bg-red-500 text-white shadow-sm transition-colors shrink-0 flex items-center gap-1.5"
                    >
                      <Download className="w-3.5 h-3.5" />
                      <span>Install App</span>
                    </button>
                  )}
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium mb-3">General Settings</label>
                <div className="space-y-2">
                  <label className="flex items-center gap-3 p-3 bg-gray-50 dark:bg-[#131314] rounded-lg border border-gray-100 dark:border-gray-800 cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-800/80 transition-colors">
                    <input 
                      type="checkbox" 
                      checked={autoArchive}
                      onChange={(e) => handleAutoArchiveToggle(e.target.checked)}
                      className="w-4 h-4 text-drive-primary rounded border-gray-300 focus:ring-drive-primary"
                    />
                    <div className="flex-1">
                      <span className="font-medium text-sm block">Auto-Archive Root Folders</span>
                      <span className="text-xs text-gray-500 block mt-0.5">Automatically move all root folders (channels) to/from Archive</span>
                    </div>
                  </label>
                </div>
              </div>
              
            </div>
          </div>
        </div>
      )}

      {isAddingAccount && (
        <div className="fixed inset-0 z-[70]">
          <Login onSuccess={() => { setIsAddingAccount(false); setIsSettingsOpen(false); }} />
          <button type="button" onClick={() => setIsAddingAccount(false)} className="fixed right-4 top-4 z-[71] rounded-full bg-black/60 px-3 py-2 text-sm font-semibold text-white">Cancel</button>
        </div>
      )}

      {/* Search Modal */}
      {isSearchMounted && (
        <div className={`drive-search-modal fixed inset-0 z-50 flex justify-center items-start pt-16 sm:pt-24 px-4 ${searchPhase === 'closing' ? 'drive-search-modal--closing' : 'drive-search-modal--open'}`} onClick={closeSearchModal}>
          <div className="drive-search-modal__panel w-full max-w-2xl rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[80vh]" onClick={e => e.stopPropagation()}>
            <div className="flex items-center px-4 border-b border-gray-200 dark:border-gray-800">
              <Search className="w-6 h-6 text-gray-400 shrink-0" />
              <input 
                autoFocus
                type="text" 
                placeholder="Search files and folders..." 
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                className="w-full px-4 py-4 bg-transparent outline-none text-lg text-gray-900 dark:text-gray-100 placeholder-gray-500"
              />
              <button onClick={closeSearchModal} className="p-2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 rounded-full transition-colors">
                <X className="w-6 h-6" />
              </button>
            </div>
            
            {syncProgress && syncProgress.loaded < syncProgress.total && (
              <div className="px-4 py-3 flex items-center gap-3 bg-blue-50/50 dark:bg-blue-900/10 border-b border-blue-100 dark:border-blue-900/30 overflow-hidden animate-pulse">
                <Loader2 className="w-5 h-5 text-blue-500 animate-spin shrink-0" />
                <div className="flex-1 flex flex-col justify-center">
                  <div className="text-xs text-blue-600 dark:text-blue-400 font-medium tracking-wide uppercase">Syncing Cloud</div>
                  <div className="h-1 bg-blue-200 dark:bg-blue-800 rounded-full mt-1 overflow-hidden">
                    <div className="h-full bg-blue-500 transition-all duration-300" style={{ width: `${(syncProgress.loaded / syncProgress.total) * 100}%` }}></div>
                  </div>
                </div>
                <div className="text-xs font-bold text-blue-500 shrink-0 w-8 text-right">
                  {Math.round((syncProgress.loaded / syncProgress.total) * 100)}%
                </div>
              </div>
            )}
            <div className="flex-1 overflow-y-auto p-4 space-y-6">
              {(() => {
                if (searchResults.length === 0 && searchQuery) {
                  return (
                    <div className="flex flex-col items-center justify-center py-12 text-gray-500">
                      <Search className="w-12 h-12 mb-4 opacity-20" />
                      <p>No results found for "{searchQuery}"</p>
                    </div>
                  );
                }
                
                if (!searchQuery) return null;

                const currentFolderId = currentFolder?.id || 'root';
                const currentFolderResults = searchResults.filter(r => r.path.some(p => p.id === currentFolderId) || (r.type === 'folder' && r.item.id === currentFolderId));
                const cloudResults = searchResults.filter(r => !currentFolderResults.includes(r));

                const ResultItem = ({ result, idx }: { result: any, idx: number }) => (
                  <div 
                    key={idx}
                    onClick={() => {
                      if (result.type === 'file') {
                        if (isAudioFile(result.item)) {
                          playTrack(result.item);
                          closeSearchModal();
                        } else {
                          setActiveFile(result.item);
                          closeSearchModal();
                        }
                      } else {
                        goToFolder(result);
                      }
                    }}
                    onContextMenu={(e) => handleContextMenu(e, result)}
                    onTouchStart={(e) => handleTouchStartMenu(e, result)}
                    onTouchEnd={handleTouchEndMenu}
                    onTouchMove={handleTouchEndMenu}
                    className="group flex items-center gap-4 p-3 hover:bg-blue-50 dark:hover:bg-blue-900/20 rounded-xl cursor-pointer transition-all duration-200 transform hover:scale-[1.01]"
                  >
                    <div className="w-12 h-12 shrink-0 bg-gray-100 dark:bg-gray-800 rounded-lg flex items-center justify-center overflow-hidden border border-gray-200 dark:border-gray-700 group-hover:border-blue-200 dark:group-hover:border-blue-800 transition-colors relative">
                      {result.type === 'folder' ? <Folder className="w-6 h-6 text-blue-500 fill-blue-500/20" /> : <NativeThumbnail file={result.item} iconClassName="w-6 h-6" isGrid={true} />}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-semibold text-gray-900 dark:text-gray-100 truncate group-hover:text-blue-600 dark:group-hover:text-blue-400 transition-colors">{result.item.name}</div>
                      <div className="text-xs text-gray-500 truncate flex items-center gap-1 mt-0.5">
                        {result.path.map((p: any) => p.name).join(' > ')}
                      </div>
                    </div>
                  </div>
                );

                const createFakeFolder = (results: any[], name: string, id: string) => {
                  const fakeFolder: VirtualFolder = {
                    id: id,
                    name: name,
                    path: name,
                    files: results.filter(r => r.type === 'file').map(r => r.item),
                    folders: {},
                    isLoaded: true
                  };
                  results.filter(r => r.type === 'folder').forEach(r => {
                    fakeFolder.folders[r.item.id] = r.item;
                  });
                  return fakeFolder;
                };

                return (
                  <div className="animate-in fade-in slide-in-from-bottom-4 duration-300">
                    {currentFolderResults.length > 0 && (
                      <div className="mb-6">
                        <h3 className="text-xs font-bold text-gray-400 uppercase tracking-wider mb-2 px-2">In This Folder</h3>
                        <div className="space-y-1">
                          {currentFolderResults.slice(0, 4).map((r, i) => <ResultItem key={`cf-${i}`} result={r} idx={i} />)}
                        </div>
                        {currentFolderResults.length > 0 && (
                          <button
                            onClick={() => {
                              const f = createFakeFolder(currentFolderResults, `Search in ${currentFolder?.name}: ${searchQuery}`, `search:folder:${currentFolderId}:${searchQuery}`);
                              setCurrentFolder(f);
                              setPathStack([...pathStack, f]);
                              closeSearchModal();
                            }}
                            className="w-full mt-2 py-2.5 text-center text-sm font-medium text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20 rounded-xl transition-colors flex items-center justify-center gap-2"
                          >
                            See all {currentFolderResults.length} items in this folder <ChevronRight className="w-4 h-4" />
                          </button>
                        )}
                        {cloudResults.length > 0 && <div className="h-px bg-gray-200 dark:bg-gray-800 my-4" />}
                      </div>
                    )}

                    {cloudResults.length > 0 && (
                      <div>
                        <h3 className="text-xs font-bold text-gray-400 uppercase tracking-wider mb-2 px-2">Entire Cloud</h3>
                        <div className="space-y-1">
                          {cloudResults.slice(0, 4).map((r, i) => <ResultItem key={`cloud-${i}`} result={r} idx={i} />)}
                        </div>
                        {cloudResults.length > 0 && (
                          <button
                            onClick={() => {
                              const f = createFakeFolder(cloudResults, `Global Search: ${searchQuery}`, `search:cloud:${currentFolderId}:${searchQuery}`);
                              setCurrentFolder(f);
                              setPathStack([...pathStack, f]);
                              closeSearchModal();
                            }}
                            className="w-full mt-2 py-2.5 text-center text-sm font-medium text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20 rounded-xl transition-colors flex items-center justify-center gap-2"
                          >
                            See all {cloudResults.length} items in cloud <ChevronRight className="w-4 h-4" />
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                );
              })()}
            </div>
          </div>
        </div>
      )}

      {/* Context Menu */}
      {contextMenu && (
        <>
          <div 
            className="fixed inset-0 z-[59] cursor-pointer" 
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setContextMenu(null);
            }} 
            onTouchEnd={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setContextMenu(null);
            }} 
          />
          <div 
            className="fixed z-[60] bg-white dark:bg-[#2b2b2b] border border-gray-200 dark:border-gray-700 shadow-xl rounded-lg py-1 min-w-[160px] overflow-hidden animate-in fade-in zoom-in-95 duration-200 origin-top-left"
            style={{ top: Math.min(contextMenu.y, window.innerHeight - 180), left: Math.min(contextMenu.x, window.innerWidth - 160) }}
          >
          <button 
            onClick={() => goToFolder(contextMenu.result)}
            className="w-full px-4 py-2 text-left text-sm hover:bg-gray-100 dark:hover:bg-gray-800/80 text-gray-700 dark:text-gray-200 flex items-center gap-2"
          >
            <Folder className="w-4 h-4" /> Go to folder
          </button>
          {contextMenu.result.type === 'file' && isAudioFile(contextMenu.result.item) && (
            <>
              <button
                onClick={() => {
                  const audioTracks = (displayFolder?.files || []).filter(isAudioFile);
                  playTrack(contextMenu.result.item as VirtualFile, audioTracks);
                  setSelectedItems(new Set());
                  setContextMenu(null);
                }}
                className="w-full px-4 py-2 text-left text-sm hover:bg-emerald-50 dark:hover:bg-emerald-900/30 text-emerald-600 dark:text-emerald-400 font-medium flex items-center gap-2"
              >
                <Play className="w-4 h-4 fill-current" /> Play
              </button>
              <button
                onClick={() => {
                  addToQueue(contextMenu.result.item as VirtualFile);
                  setSelectedItems(new Set());
                  setContextMenu(null);
                }}
                className="w-full px-4 py-2 text-left text-sm hover:bg-emerald-50 dark:hover:bg-emerald-900/30 text-emerald-600 dark:text-emerald-400 font-medium flex items-center gap-2"
              >
                <ListMusic className="w-4 h-4" /> Add to Queue
              </button>
              <div className="h-px bg-gray-200 dark:bg-gray-700 my-1"></div>
            </>
          )}
          {contextMenu.result.type === 'file' ? (
            <button
              onClick={() => {
                downloadFile(contextMenu.result.item as VirtualFile);
                setSelectedItems(new Set());
                setContextMenu(null);
              }}
              className="w-full px-4 py-2 text-left text-sm hover:bg-gray-100 dark:hover:bg-gray-800/80 text-gray-700 dark:text-gray-200 flex items-center gap-2"
            >
              <Download className="w-4 h-4" /> Download
            </button>
          ) : contextMenu.result.type === 'folder' ? (
            <button
              onClick={() => {
                downloadFolder(contextMenu.result.item as VirtualFolder);
                setSelectedItems(new Set());
                setContextMenu(null);
              }}
              className="w-full px-4 py-2 text-left text-sm hover:bg-gray-100 dark:hover:bg-gray-800/80 text-emerald-600 dark:text-emerald-400 font-medium flex items-center gap-2"
            >
              <Download className="w-4 h-4 text-emerald-500" /> Download as ZIP
            </button>
          ) : null}
          <div className="h-px bg-gray-200 dark:bg-gray-700 my-1"></div>
          <button
            onClick={() => {
              setClipboard({ action: 'copy', items: [contextMenu.result] });
              setSelectedItems(new Set());
              setContextMenu(null);
            }}
            className="w-full px-4 py-2 text-left text-sm hover:bg-gray-100 dark:hover:bg-gray-800/80 text-gray-700 dark:text-gray-200 flex items-center gap-2"
          >
            <Copy className="w-4 h-4" /> Copy
          </button>
          <button
            onClick={() => {
              setClipboard({ action: 'move', items: [contextMenu.result] });
              setSelectedItems(new Set());
              setContextMenu(null);
            }}
            className="w-full px-4 py-2 text-left text-sm hover:bg-gray-100 dark:hover:bg-gray-800/80 text-gray-700 dark:text-gray-200 flex items-center gap-2"
          >
            <Scissors className="w-4 h-4" /> Move
          </button>
          <button
            onClick={() => {
              setRenameModal({ item: contextMenu.result, newName: contextMenu.result.item.name });
              setSelectedItems(new Set());
              setContextMenu(null);
            }}
            className="w-full px-4 py-2 text-left text-sm hover:bg-gray-100 dark:hover:bg-gray-800/80 text-gray-700 dark:text-gray-200 flex items-center gap-2"
          >
            <Edit2 className="w-4 h-4" /> Rename
          </button>
          <div className="h-px bg-gray-200 dark:bg-gray-700 my-1"></div>
          <button
            onClick={() => {
              setDeleteModalItems([contextMenu.result]);
              setSelectedItems(new Set());
              setContextMenu(null);
            }}
            className="w-full px-4 py-2 text-left text-sm hover:bg-red-50 dark:hover:bg-red-900/20 text-red-600 dark:text-red-400 flex items-center gap-2"
          >
            <Trash2 className="w-4 h-4" /> Delete
          </button>
        </div>
        </>
      )}

      {/* Media Viewer Modal */}
      {activeFile && (
        <div className={`fixed inset-0 ${activeFile.mimeType.startsWith('video/') ? 'bg-black' : 'bg-black/90 backdrop-blur-md'} flex flex-col z-50 transform-gpu will-change-transform will-change-opacity transition-all duration-200 ease-out ${isClosingMediaViewer ? 'opacity-0 scale-95 blur-xs pointer-events-none' : 'animate-in fade-in zoom-in-95 duration-250 ease-out'}`}>
          {!activeFile.mimeType.startsWith('video/') && (
            <header className="flex items-center justify-between p-4 pt-[max(1rem,env(safe-area-inset-top,0px))] pl-[max(1rem,env(safe-area-inset-left,0px))] pr-[max(1rem,env(safe-area-inset-right,0px))] bg-gradient-to-b from-black/80 via-black/40 to-transparent shrink-0 z-30">
              <div className="flex min-w-0 flex-1 items-center gap-3 text-white pr-2">
                <NativeThumbnail file={activeFile} iconClassName="w-6 h-6" isGrid={false} />
                <span className="font-medium truncate">{activeFile.name}</span>
              </div>
              <div className="flex items-center gap-2">
                {activeViewerIndex >= 0 && viewerFiles.length > 1 && (
                  <>
                    <button onClick={() => moveViewer(-1)} className="w-10 h-10 bg-white/10 hover:bg-white/20 rounded-full flex items-center justify-center text-white transition-colors" title="Previous image or PDF" aria-label="Previous image or PDF">
                      <ArrowLeft className="w-5 h-5" />
                    </button>
                    <span className="hidden sm:block text-xs text-white/60 tabular-nums">{activeViewerIndex + 1} / {viewerFiles.length}</span>
                    <button onClick={() => moveViewer(1)} className="w-10 h-10 bg-white/10 hover:bg-white/20 rounded-full flex items-center justify-center text-white transition-colors" title="Next image or PDF" aria-label="Next image or PDF">
                      <ArrowRight className="w-5 h-5" />
                    </button>
                  </>
                )}
                {activeFile.mimeType.startsWith('video/') && (
                  <button
                    onClick={closeMediaViewer}
                    className="absolute top-4 right-4 z-30 w-10 h-10 bg-black/60 hover:bg-black/80 rounded-full flex items-center justify-center text-white active:scale-95 transition-transform"
                    aria-label="Close viewer"
                  >
                    <X className="w-6 h-6" />
                  </button>
                )}
                <button onClick={() => downloadFile(activeFile)} className="w-10 h-10 bg-white/10 hover:bg-white/20 rounded-full flex items-center justify-center text-white transition-colors active:scale-95" title="Download file" aria-label="Download file">
                  <Download className="w-5 h-5" />
                </button>
                <button 
                  onClick={closeMediaViewer}
                  className="w-10 h-10 bg-white/10 hover:bg-white/20 rounded-full flex items-center justify-center text-white transition-colors active:scale-95"
                  aria-label="Close viewer"
                >
                  <X className="w-6 h-6" />
                </button>
              </div>
            </header>
          )}
          
          <div className={`flex-1 flex justify-center overflow-hidden p-0 ${activeFile.mimeType === 'application/pdf' || activeFile.name.toLowerCase().endsWith('.pdf') ? 'items-stretch' : 'items-center sm:p-4'}`}>
            {activeFile.mimeType.startsWith('video/') ? (
              <CustomVideoPlayer 
                key={activeFile.id}
                file={activeFile} 
                src={`/stream/${encodeURIComponent(activeFile.id)}`}
                onClose={closeMediaViewer}
                onDownload={() => downloadFile(activeFile)}
              />
            ) : activeFile.mimeType.startsWith('image/') ? (
              <ImageViewer
                src={`/stream/${encodeURIComponent(activeFile.id)}`}
                alt={activeFile.name}
                onSwipe={moveViewer}
              />
            ) : VIEWABLE_MEDIA(activeFile) ? (
              <PdfViewer
                src={`/stream/${encodeURIComponent(activeFile.id)}`}
                name={activeFile.name}
              />
            ) : isAudioFile(activeFile) ? (
              <div className="w-full max-w-2xl bg-white/10 p-8 rounded-3xl backdrop-blur-xl border border-white/20 shadow-2xl flex flex-col items-center">
                <FileAudio className="w-28 h-28 text-rose-500 mb-6 drop-shadow-lg" />
                <h3 className="text-2xl font-bold text-white mb-6 text-center">{activeFile.name}</h3>
                <button
                  onClick={() => {
                    playTrack(activeFile);
                    setActiveFile(null);
                  }}
                  className="px-6 py-3 rounded-full bg-gradient-to-r from-red-600 via-rose-600 to-blue-600 hover:from-red-500 hover:to-blue-500 text-white font-bold flex items-center gap-2 hover:scale-105 active:scale-95 transition-all shadow-lg shadow-red-600/40"
                >
                  <Play className="w-5 h-5 fill-current" /> Play in Music Player
                </button>
              </div>
            ) : (
              <div className="text-white flex flex-col items-center">
                <File className="w-24 h-24 mb-4 text-gray-400" />
                <p>Preview not available for this file type.</p>
                <button 
                  type="button"
                  onClick={() => downloadFile(activeFile)}
                  className="mt-6 px-6 py-3 bg-drive-primary hover:bg-blue-600 rounded-xl font-medium transition-colors flex items-center gap-2 shadow-lg active:scale-95"
                >
                  <Download className="w-5 h-5" />
                  Download File
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Create Folder Modal */}
      {(isCreateFolderModalOpen || isClosingFolderModal) && (
        <div className={`fixed inset-0 z-[70] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm gpu-fast transition-opacity duration-200 ${isClosingFolderModal ? 'opacity-0' : 'animate-in fade-in duration-200'}`}>
          <div className={`bg-white dark:bg-[#1c1c1e] rounded-2xl shadow-2xl w-full max-w-md overflow-hidden gpu-fast transition-all duration-200 ease-out ${isClosingFolderModal ? 'scale-95 translate-y-3 opacity-0' : 'animate-in zoom-in-95 duration-200'}`}>
            <div className="p-6">
              <h3 className="text-xl font-semibold text-gray-900 dark:text-gray-100 mb-4 flex items-center gap-2">
                <Folder className="w-6 h-6 text-blue-500" />
                Create New Folder
              </h3>

              <input
                type="text"
                value={newFolderName}
                onChange={e => setNewFolderName(e.target.value)}
                placeholder="Folder Name"
                className="w-full bg-gray-100 dark:bg-gray-800/50 border border-gray-200 dark:border-gray-700 rounded-xl px-4 py-3 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 transition-all placeholder:text-gray-400"
                autoFocus
                onKeyDown={e => {
                  if (e.key === 'Enter') submitCreateFolder();
                  if (e.key === 'Escape') closeCreateFolderModal();
                }}
              />
            </div>
            <div className="px-6 py-4 bg-gray-50 dark:bg-gray-800/20 border-t border-gray-100 dark:border-gray-800 flex justify-end gap-3">
              <button
                onClick={closeCreateFolderModal}
                className="px-4 py-2 text-sm font-medium text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700/50 rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={submitCreateFolder}
                disabled={!newFolderName.trim() || loading}
                className="px-6 py-2 text-sm font-medium text-white bg-blue-500 hover:bg-blue-600 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
              >
                {loading && <Loader2 className="w-4 h-4 animate-spin" />}
                Create
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Rename Modal */}
      {(renameModal || isClosingRenameModal) && (
        <div className={`fixed inset-0 z-[70] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm gpu-fast transition-opacity duration-200 ${isClosingRenameModal ? 'opacity-0' : 'animate-in fade-in duration-200'}`}>
          <div className={`bg-white dark:bg-[#1c1c1e] rounded-2xl shadow-2xl w-full max-w-md overflow-hidden gpu-fast transition-all duration-200 ease-out ${isClosingRenameModal ? 'scale-95 translate-y-3 opacity-0' : 'animate-in zoom-in-95 duration-200'}`}>
            <div className="p-6">
              <h3 className="text-xl font-semibold text-gray-900 dark:text-gray-100 mb-4 flex items-center gap-2">
                <Edit2 className="w-6 h-6 text-blue-500" />
                Rename Item
              </h3>
              <input
                type="text"
                value={renameModal?.newName || ''}
                onChange={e => setRenameModal(prev => prev ? { ...prev, newName: e.target.value } : null)}
                placeholder="New Name"
                className="w-full bg-gray-100 dark:bg-gray-800/50 border border-gray-200 dark:border-gray-700 rounded-xl px-4 py-3 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 transition-all placeholder:text-gray-400"
                autoFocus
                onKeyDown={async e => {
                  if (e.key === 'Enter' && renameModal) {
                     setLoading(true);
                     const currentPath = pathStack.map(f => f.name).join('/');
                     await renameItem(renameModal.item, renameModal.newName, currentPath);
                     closeRenameModal();
                     setLoading(false);
                  }
                  if (e.key === 'Escape') closeRenameModal();
                }}
              />
            </div>
            <div className="px-6 py-4 bg-gray-50 dark:bg-gray-800/20 border-t border-gray-100 dark:border-gray-800 flex justify-end gap-3">
              <button
                onClick={closeRenameModal}
                className="px-4 py-2 text-sm font-medium text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700/50 rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={async () => {
                   if (!renameModal) return;
                   setLoading(true);
                   const currentPath = pathStack.map(f => f.name).join('/');
                   await renameItem(renameModal.item, renameModal.newName, currentPath);
                   closeRenameModal();
                   setLoading(false);
                }}
                disabled={!renameModal?.newName.trim() || loading || renameModal?.newName === renameModal?.item.item.name}
                className="px-6 py-2 text-sm font-medium bg-blue-500 hover:bg-blue-600 text-white rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
              >
                {loading && <Loader2 className="w-4 h-4 animate-spin" />}
                Rename
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Mobile View Switcher Bottom Sheet */}
      {isMobileViewSheetMounted && (
        <div 
          className={`drive-view-sheet fixed inset-0 z-50 flex flex-col justify-end sm:hidden drive-view-sheet--${mobileViewSheetPhase}`}
          onClick={closeMobileViewSheet}
        >
          <div 
            className="drive-view-sheet__panel w-full rounded-t-3xl p-5 shadow-2xl border-t pb-[max(1.5rem,calc(1rem+env(safe-area-inset-bottom,0px)))]"
            onClick={e => e.stopPropagation()}
          >
            <div className="w-10 h-1 bg-gray-300 dark:bg-gray-700 rounded-full mx-auto mb-4" />
            
            <div className="flex items-center justify-between mb-3 px-0.5">
              <h4 className="text-xs font-bold text-gray-400 dark:text-gray-500 uppercase tracking-wider">Display Layout</h4>
            </div>

            <div className="grid grid-cols-3 gap-2.5 mb-5">
              {[
                { id: 'grid', label: 'Grid', desc: 'Card grid', icon: LayoutGrid },
                { id: 'list', label: 'Content', desc: 'Clean rows', icon: List },
                { id: 'gallery', label: 'Gallery', desc: 'Large view', icon: LayoutDashboard },
              ].map(item => {
                const Icon = item.icon;
                const isActive = viewMode === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => {
                      changeViewMode(item.id as any);
                    }}
                    className={`flex flex-col items-center justify-center gap-1.5 p-3 rounded-2xl border transition-all active:scale-95 ${
                      isActive
                        ? 'border-blue-500 bg-blue-50 dark:bg-blue-950/40 text-blue-600 dark:text-blue-400 font-semibold shadow-sm ring-1 ring-blue-500/20'
                        : 'border-gray-200 dark:border-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800'
                    }`}
                  >
                    <Icon className="w-5 h-5" />
                    <span className="text-xs">{item.label}</span>
                  </button>
                );
              })}
            </div>

            <div className="flex items-center justify-between mb-3 px-0.5">
              <h4 className="text-xs font-bold text-gray-400 dark:text-gray-500 uppercase tracking-wider">Item Size</h4>
            </div>

            <div className="grid grid-cols-3 gap-2.5 mb-5 p-1 bg-gray-100 dark:bg-gray-800/60 rounded-2xl">
              {[
                { id: 'small', label: 'Small', tag: 'S' },
                { id: 'medium', label: 'Medium', tag: 'M' },
                { id: 'large', label: 'Large', tag: 'L' },
              ].map(size => {
                const isActive = itemSize === size.id;
                return (
                  <button
                    key={size.id}
                    type="button"
                    onClick={() => {
                      changeItemSize(size.id as any);
                    }}
                    className={`py-2 px-3 rounded-xl text-xs transition-all flex flex-col items-center justify-center gap-0.5 active:scale-95 ${
                      isActive
                        ? 'bg-white dark:bg-gray-700 text-blue-600 dark:text-blue-400 shadow-sm font-bold'
                        : 'text-gray-600 dark:text-gray-400'
                    }`}
                  >
                    <span className="font-bold text-sm">{size.tag}</span>
                    <span className="text-[10px] opacity-80">{size.label}</span>
                  </button>
                );
              })}
            </div>

            <div className="flex items-center justify-between mb-2 px-0.5">
              <h4 className="text-xs font-bold text-gray-400 dark:text-gray-500 uppercase tracking-wider">Sort By</h4>
              <button
                type="button"
                onClick={() => setSortOrder(prev => prev === 'asc' ? 'desc' : 'asc')}
                className="text-xs text-rose-500 font-mono font-bold active:scale-95 transition-transform flex items-center gap-1"
              >
                <span>{sortOrder === 'asc' ? '↑ Oldest First' : '↓ Newest First'}</span>
              </button>
            </div>

            <div className="grid grid-cols-4 gap-1.5 mb-5 p-1 bg-gray-100 dark:bg-gray-800/60 rounded-2xl">
              {[
                { id: 'date', label: 'Date' },
                { id: 'name', label: 'Name' },
                { id: 'size', label: 'Size' },
                { id: 'duration', label: 'Time' },
              ].map(item => {
                const isActive = sortMode === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setSortMode(item.id as any)}
                    className={`py-2 px-1 rounded-xl text-xs transition-all text-center active:scale-95 ${
                      isActive 
                        ? 'bg-white dark:bg-gray-700 text-rose-600 dark:text-rose-400 shadow-sm font-bold' 
                        : 'text-gray-600 dark:text-gray-400'
                    }`}
                  >
                    <span>{item.label}</span>
                  </button>
                );
              })}
            </div>

            <button
              type="button"
              onClick={closeMobileViewSheet}
              className="w-full py-3 bg-blue-500 hover:bg-blue-600 active:scale-[0.98] text-white font-medium rounded-xl transition-all shadow-sm shadow-blue-500/20 text-sm"
            >
              Done
            </button>
          </div>
        </div>
      )}

      {/* Delete Progress Modal */}
      {deleteModalItems && (
        <DeleteProgressModal
          isOpen={true}
          items={deleteModalItems}
          client={client}
          onClose={() => setDeleteModalItems(null)}
          onComplete={(affectedChannels, deletedChannels) => {
            if (client) {
              const rootFolder = pathStack[0];
              if (rootFolder) {
                if (deletedChannels && deletedChannels.size > 0) {
                  deletedChannels.forEach(chanId => {
                    const targetKey = Object.keys(rootFolder.folders).find(k => String(rootFolder.folders[k].channelId) === String(chanId));
                    if (targetKey) delete rootFolder.folders[targetKey];
                  });
                  setPathStack(prev => [...prev]);
                }
                affectedChannels.forEach(chanId => {
                  if (deletedChannels && deletedChannels.has(chanId)) return;
                  refreshChannel(String(chanId));
                });
              }
            }

          }}
        />
      )}
      {/* Telegram Session Revocation / Expiration Notice Modal */}
      {sessionNotice && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/75 backdrop-blur-md animate-in fade-in duration-200">
          <div className="bg-white dark:bg-[#18191f] border border-amber-500/30 rounded-3xl shadow-2xl w-full max-w-md overflow-hidden animate-in zoom-in-95 duration-200">
            <div className="p-6">
              <div className="w-12 h-12 rounded-2xl bg-amber-500/15 border border-amber-500/20 flex items-center justify-center text-amber-500 mb-4">
                <ShieldAlert className="w-6 h-6" />
              </div>
              <h3 className="text-xl font-bold text-gray-900 dark:text-gray-100 mb-2">
                Telegram Session Ended
              </h3>
              <p className="text-sm text-gray-600 dark:text-gray-300 leading-relaxed mb-4">
                {sessionNotice.message}
              </p>
              <div className="p-3 bg-amber-500/10 dark:bg-amber-950/20 border border-amber-500/20 rounded-xl text-xs text-amber-800 dark:text-amber-300">
                Account: <span className="font-semibold text-gray-900 dark:text-gray-100">{sessionNotice.accountName || sessionNotice.accountId}</span>
              </div>
            </div>
            <div className="px-6 py-4 bg-gray-50 dark:bg-[#131418] border-t border-gray-100 dark:border-gray-800 flex justify-end gap-3">
              <button
                type="button"
                onClick={clearSessionNotice}
                className="px-5 py-2.5 bg-blue-600 hover:bg-blue-500 active:scale-95 text-white font-medium text-sm rounded-xl transition-all shadow-md shadow-blue-600/20"
              >
                Understood
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Terminate Session Confirmation Modal */}
      {accountToTerminate && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/75 backdrop-blur-md animate-in fade-in duration-200">
          <div className="bg-white dark:bg-[#18191f] border border-rose-500/30 rounded-3xl shadow-2xl w-full max-w-md overflow-hidden animate-in zoom-in-95 duration-200">
            <div className="p-6">
              <div className="w-12 h-12 rounded-2xl bg-rose-500/15 border border-rose-500/20 flex items-center justify-center text-rose-500 mb-4">
                <LogOut className="w-6 h-6" />
              </div>
              <h3 className="text-xl font-bold text-gray-900 dark:text-gray-100 mb-2">
                Terminate Session?
              </h3>
              <p className="text-sm text-gray-600 dark:text-gray-300 leading-relaxed mb-4">
                Are you sure you want to completely terminate the Telegram session for{' '}
                <strong className="text-gray-900 dark:text-gray-100 font-semibold">
                  {accountToTerminate.displayName || accountToTerminate.username || accountToTerminate.id}
                </strong>
                ? This will invalidate the session on Telegram servers and delete it from your saved accounts.
              </p>
              {accountError && (
                <div className="p-3 mb-2 bg-rose-500/10 border border-rose-500/20 rounded-xl text-xs text-rose-600 dark:text-rose-400">
                  {accountError}
                </div>
              )}
            </div>
            <div className="px-6 py-4 bg-gray-50 dark:bg-[#131418] border-t border-gray-100 dark:border-gray-800 flex justify-end gap-3">
              <button
                type="button"
                disabled={isTerminatingAccount}
                onClick={() => setAccountToTerminate(null)}
                className="px-4 py-2.5 text-sm font-medium text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-800 rounded-xl transition-colors disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={isTerminatingAccount}
                onClick={async () => {
                  if (!accountToTerminate) return;
                  setIsTerminatingAccount(true);
                  setAccountError('');
                  try {
                    const targetId = accountToTerminate.id;
                    await terminateAccount(targetId);
                    if (targetId === activeAccountId) {
                      setIsSettingsOpen(false);
                    }
                    setAccountToTerminate(null);
                  } catch (error: any) {
                    setAccountError(error?.message || 'Could not terminate account.');
                  } finally {
                    setIsTerminatingAccount(false);
                  }
                }}
                className="px-5 py-2.5 bg-rose-600 hover:bg-rose-500 active:scale-95 text-white font-medium text-sm rounded-xl transition-all shadow-md shadow-rose-600/20 flex items-center gap-2 disabled:opacity-50"
              >
                {isTerminatingAccount ? <Loader2 className="w-4 h-4 animate-spin" /> : <LogOut className="w-4 h-4" />}
                Terminate Session
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Telegram Restriction / Error Modal */}
      {restrictionModal && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/75 backdrop-blur-md animate-in fade-in duration-200">
          <div className="bg-white dark:bg-[#18191f] border border-amber-500/30 rounded-3xl shadow-2xl w-full max-w-lg overflow-hidden animate-in zoom-in-95 duration-200">
            <div className="p-6">
              <div className="w-12 h-12 rounded-2xl bg-amber-500/15 border border-amber-500/20 flex items-center justify-center text-amber-500 mb-4">
                <AlertTriangle className="w-6 h-6" />
              </div>
              <h3 className="text-xl font-bold text-gray-900 dark:text-gray-100 mb-2">
                {restrictionModal.title}
              </h3>
              <p className="text-sm text-gray-600 dark:text-gray-300 leading-relaxed mb-4">
                {restrictionModal.message}
              </p>
              {restrictionModal.suggestions && restrictionModal.suggestions.length > 0 && (
                <div className="space-y-2 mb-2">
                  {restrictionModal.suggestions.map((suggestion, index) => (
                    <div
                      key={index}
                      className="p-3 bg-gray-100 dark:bg-gray-800/60 border border-gray-200 dark:border-gray-700/60 rounded-xl text-xs text-gray-700 dark:text-gray-300 leading-relaxed"
                    >
                      {suggestion}
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="px-6 py-4 bg-gray-50 dark:bg-[#131418] border-t border-gray-100 dark:border-gray-800 flex justify-end gap-3">
              <button
                type="button"
                onClick={() => setRestrictionModal(null)}
                className="px-5 py-2.5 bg-blue-600 hover:bg-blue-500 active:scale-95 text-white font-medium text-sm rounded-xl transition-all shadow-md shadow-blue-600/20"
              >
                Understood
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Account Switching Cinematic Transition Overlay */}
      {switchingTargetAccount && (
        <div className="fixed inset-0 z-[250] flex flex-col items-center justify-center p-4 bg-[#080a12]/92 backdrop-blur-2xl animate-in fade-in duration-300 select-none">
          <div className="absolute w-80 h-80 rounded-full bg-gradient-to-tr from-rose-600/25 via-violet-600/30 to-cyan-500/25 blur-3xl animate-pulse pointer-events-none" />

          <div className="relative mb-6">
            <div className="absolute -inset-2.5 rounded-full bg-gradient-to-tr from-rose-500 via-violet-600 to-cyan-400 animate-[spin_3s_linear_infinite] blur-md opacity-80" />
            <div className="relative w-24 h-24 rounded-full bg-[#10121e] border-2 border-white/20 flex items-center justify-center shadow-2xl overflow-hidden">
              <span className="text-3xl font-black text-transparent bg-clip-text bg-gradient-to-br from-white via-violet-200 to-cyan-300">
                {(switchingTargetAccount.displayName || switchingTargetAccount.username || '?').slice(0, 1).toUpperCase()}
              </span>
            </div>
          </div>

          <h3 className="text-xl sm:text-2xl font-bold text-white text-center drop-shadow-md">
            Switching to {switchingTargetAccount.displayName || switchingTargetAccount.username}
          </h3>
          <p className="text-xs sm:text-sm text-cyan-300/80 mt-2 flex items-center gap-2">
            <Loader2 className="w-4 h-4 animate-spin text-cyan-400" />
            <span>Synchronizing Telegram Cloud Session...</span>
          </p>
        </div>
      )}

      {/* Unindexed File Indexing Confirmation Modal */}
      {unindexedFileTarget && (
        <div className="fixed inset-0 z-[150] flex items-center justify-center p-4 bg-black/80 backdrop-blur-md animate-in fade-in duration-200">
          <div className="bg-[#10121a] border border-amber-500/30 text-gray-100 rounded-3xl shadow-2xl shadow-amber-950/40 w-full max-w-md overflow-hidden p-6 animate-in zoom-in-95 duration-200">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-amber-500/20 to-rose-500/20 border border-amber-500/30 flex items-center justify-center text-amber-400 shrink-0">
                <AlertCircle className="w-6 h-6 animate-pulse" />
              </div>
              <div>
                <h3 className="text-lg font-bold text-white">Unindexed File Detected</h3>
                <p className="text-xs text-gray-400">Telegram Manual Upload</p>
              </div>
            </div>

            <p className="text-xs sm:text-sm text-gray-300 leading-relaxed mb-4">
              This file was uploaded or forwarded directly via Telegram without ZUD Cloud metadata. Would you like to index it and add official cloud metadata to your drive library?
            </p>

            <div className="p-3.5 rounded-2xl bg-black/40 border border-gray-800 mb-5 flex flex-col gap-3">
              <div className="flex items-start gap-3">
                <div className="w-10 h-10 rounded-xl bg-gray-900 border border-gray-800 flex items-center justify-center text-amber-400 shrink-0 mt-0.5">
                  <File className="w-5 h-5" />
                </div>
                <div className="min-w-0 flex-1">
                  <label className="text-[11px] font-medium text-gray-400 block mb-1">
                    File Name (Review & Edit):
                  </label>
                  <input
                    type="text"
                    value={indexingFileName}
                    onChange={(e) => setIndexingFileName(e.target.value)}
                    placeholder="Enter file name with extension"
                    className="w-full bg-gray-900/90 border border-gray-700/80 focus:border-amber-500 rounded-xl px-3 py-2 text-xs text-white placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-amber-500 transition-colors font-sans"
                  />
                </div>
              </div>
              <div className="flex items-center justify-between text-[11px] text-gray-400 px-1 pt-1 border-t border-gray-800/60">
                <span>Size: <strong className="text-gray-300 font-semibold">{formatSize(unindexedFileTarget.size)}</strong></span>
                {unindexedFileTarget.mimeType && (
                  <span className="truncate max-w-[200px] text-gray-400">{unindexedFileTarget.mimeType}</span>
                )}
              </div>
            </div>

            <div className="flex items-center justify-end gap-2.5">
              <button
                type="button"
                disabled={isIndexingDriveFile}
                onClick={() => setUnindexedFileTarget(null)}
                className="px-4 py-2 rounded-xl text-xs font-semibold text-gray-400 hover:text-white hover:bg-gray-800 transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={isIndexingDriveFile || !indexingFileName.trim()}
                onClick={() => handleIndexDriveFile(unindexedFileTarget, indexingFileName)}
                className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-gradient-to-r from-amber-500 to-rose-600 hover:from-amber-400 hover:to-rose-500 text-white text-xs font-bold shadow-lg shadow-rose-950/50 active:scale-95 transition-all disabled:opacity-50"
              >
                {isIndexingDriveFile ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
                <span>Index & Add to Drive</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Edge-to-Edge Docked Cyber Vault Footer (Mobile only - Zero interference with video/PDF/image overlays) */}
      {!activeFile && (
        <footer className="md:hidden fixed bottom-0 left-0 right-0 z-30 pointer-events-auto bg-[#0d0d10]/95 backdrop-blur-2xl border-t border-white/10 shadow-[0_-12px_40px_rgba(0,0,0,0.9)] pb-[max(0.6rem,env(safe-area-inset-bottom,0px))] pt-2.5 px-4 select-none animate-in fade-in slide-in-from-bottom-2 duration-300">
          {/* Top Laser Accent Stroke with Ruby Glow */}
          <div className="absolute top-0 left-0 right-0 h-[1.5px] bg-gradient-to-r from-transparent via-[#9A2227] via-rose-500 to-transparent opacity-90 shadow-[0_0_12px_rgba(244,63,94,0.65)]" />

          <div className="flex items-center justify-between gap-3">
            {/* Left Vault Identity */}
            <div className="flex items-center gap-2.5 min-w-0">
              <div className="relative shrink-0 flex items-center justify-center">
                <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-red-950/60 to-[#18181b] border border-red-500/30 flex items-center justify-center text-rose-400 shadow-inner">
                  <Database className="w-3.5 h-3.5" />
                </div>
                <span className="absolute -top-0.5 -right-0.5 flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-rose-400 opacity-60"></span>
                  <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-rose-500 shadow-[0_0_6px_#f43f5e]"></span>
                </span>
              </div>
              <div className="flex flex-col min-w-0">
                <span className="text-[10px] font-black uppercase tracking-widest text-zinc-300 flex items-center gap-1.5">
                  <span className="text-rose-500 font-extrabold tracking-wider">ZUD</span> VAULT
                </span>
                <span className="text-[10px] text-zinc-400 font-medium truncate">
                  Cloud Storage
                </span>
              </div>
            </div>

            {/* Right Metric Readout */}
            <div className="flex items-center gap-3 shrink-0">
              <div className="flex flex-col items-end">
                <div className="flex items-baseline gap-1.5">
                  <span className="text-[9px] uppercase font-mono tracking-wider text-zinc-400 font-medium">USED:</span>
                  <span className="text-xs font-extrabold font-mono tracking-tight bg-gradient-to-r from-white via-zinc-100 to-rose-200 bg-clip-text text-transparent">
                    {storageStats.formatted}
                  </span>
                </div>
                <div className="flex items-center gap-1 text-[10px] font-mono text-zinc-400">
                  <span className="text-zinc-300 font-semibold">{storageStats.fileCount}</span>
                  <span className="text-zinc-500">{storageStats.fileCount === 1 ? 'file' : 'files'}</span>
                </div>
              </div>
            </div>
          </div>
        </footer>
      )}

      <PWAInstallModal
        isOpen={isInstallModalOpen || showIOSGuide}
        onClose={() => {
          setIsInstallModalOpen(false);
          setShowIOSGuide(false);
        }}
        isIOS={isIOS}
        isAndroid={isAndroid}
        isFirefox={isFirefox}
        isSamsung={isSamsung}
        isChrome={isChrome}
        isSafari={isSafari}
        hasNativePrompt={hasNativePrompt}
        onInstall={promptNativeInstall}
      />
      
    </div>
  );
};