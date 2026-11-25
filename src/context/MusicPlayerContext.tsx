import React, { createContext, useContext, useEffect, useRef, useState, useCallback } from 'react';
import type { VirtualFile } from '../lib/vfs';
import { useTelegram } from './TelegramContext';
import { parseTrackInfo, getCachedTrackCover, fetchHighResArtwork, registerPlayableFile } from '../lib/musicUtils';

interface MusicPlayerContextType {
  currentTrack: VirtualFile | null;
  queue: VirtualFile[];
  playlistContext: VirtualFile[];
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  volume: number;
  isMuted: boolean;
  isShuffle: boolean;
  repeatMode: 'off' | 'all' | 'one';
  isMinimalOpen: boolean;
  isExpanded: boolean;
  isQueueOpen: boolean;
  playTrack: (track: VirtualFile, newQueue?: VirtualFile[]) => void;
  addToQueue: (track: VirtualFile) => void;
  addNextToQueue: (track: VirtualFile) => void;
  removeFromQueue: (index: number) => void;
  reorderQueue: (fromIndex: number, toIndex: number) => void;
  clearQueue: () => void;
  togglePlay: () => void;
  pause: () => void;
  resume: () => void;
  nextTrack: () => void;
  prevTrack: () => void;
  seek: (time: number) => void;
  setVolume: (vol: number) => void;
  toggleMute: () => void;
  toggleShuffle: () => void;
  toggleRepeat: () => void;
  closePlayer: () => void;
  setExpanded: (expanded: boolean) => void;
  setQueueOpen: (open: boolean) => void;
  getTrackThumbUrl: (track: VirtualFile | null) => string;
}

const MusicPlayerContext = createContext<MusicPlayerContextType | undefined>(undefined);

/* ============================================================================
 * CONTEXT: MusicPlayerProvider
 * Audio state management: queueing, shuffling, repeating, volume, and playback.
 * ============================================================================ */
export const MusicPlayerProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { activeAccountId } = useTelegram();
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const [currentTrack, setCurrentTrack] = useState<VirtualFile | null>(null);
  const [queue, setQueue] = useState<VirtualFile[]>([]);
  const [playlistContext, setPlaylistContext] = useState<VirtualFile[]>([]);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolumeState] = useState(1);
  const [isMuted, setIsMuted] = useState(false);
  const [isShuffle, setIsShuffle] = useState(false);
  const [repeatMode, setRepeatMode] = useState<'off' | 'all' | 'one'>('off');
  const [isMinimalOpen, setIsMinimalOpen] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const [isQueueOpen, setIsQueueOpen] = useState(false);

  const storageKey = `zud_music_player_${activeAccountId || 'default'}`;
  const [highResArtworks, setHighResArtworks] = useState<{ [id: string]: string }>({});

  // Helper to build thumbnail URL for a track (prioritizes high-resolution artwork)
  const getTrackThumbUrl = useCallback((track: VirtualFile | null): string => {
    if (!track) return '';
    if ((track as any).coverUrl) {
      return (track as any).coverUrl;
    }
    if (highResArtworks[track.id]) {
      return highResArtworks[track.id];
    }
    const { title, artist } = parseTrackInfo(track);
    const cachedCover = getCachedTrackCover(track.name) ||
      getCachedTrackCover(track.id) ||
      getCachedTrackCover(title) ||
      getCachedTrackCover(`${artist}_${title}`);
    if (cachedCover) {
      return cachedCover;
    }

    if (!track.parts || track.parts.length === 0) return '';
    const p = track.parts[0];
    const chanKey = p.channelId ? `${p.channelId}_${p.messageId}` : p.messageId;
    return `/thumb/${encodeURIComponent(chanKey)}?v=${track.date || 0}`;
  }, [highResArtworks]);

  // Fetch high-res artwork on the fly for current track
  useEffect(() => {
    if (!currentTrack) return;
    const { artist, title } = parseTrackInfo(currentTrack);
    fetchHighResArtwork(artist, title).then(url => {
      if (url) {
        setHighResArtworks(prev => ({ ...prev, [currentTrack.id]: url }));
      }
    });
  }, [currentTrack]);

  const currentTrackRef = useRef<VirtualFile | null>(null);
  useEffect(() => {
    currentTrackRef.current = currentTrack;
  }, [currentTrack]);

  // Initialize Audio element
  useEffect(() => {
    const audio = new Audio();
    audio.preload = 'metadata';
    audio.crossOrigin = 'anonymous';
    audioRef.current = audio;

    const handleTimeUpdate = () => {
      setCurrentTime(audio.currentTime);
    };

    const handleDurationChange = () => {
      if (audio.duration && !isNaN(audio.duration) && isFinite(audio.duration)) {
        setDuration(audio.duration);
      }
    };

    const handleLoadedMetadata = () => {
      if (audio.duration && !isNaN(audio.duration) && isFinite(audio.duration)) {
        setDuration(audio.duration);
      }
    };

    const handlePlay = () => setIsPlaying(true);
    const handlePause = () => setIsPlaying(false);
    const handleError = () => {
      console.warn('Audio element error:', audio.error);
    };

    audio.addEventListener('timeupdate', handleTimeUpdate);
    audio.addEventListener('durationchange', handleDurationChange);
    audio.addEventListener('loadedmetadata', handleLoadedMetadata);
    audio.addEventListener('canplay', handleLoadedMetadata);
    audio.addEventListener('play', handlePlay);
    audio.addEventListener('pause', handlePause);
    audio.addEventListener('error', handleError);

    return () => {
      audio.pause();
      audio.removeEventListener('timeupdate', handleTimeUpdate);
      audio.removeEventListener('durationchange', handleDurationChange);
      audio.removeEventListener('loadedmetadata', handleLoadedMetadata);
      audio.removeEventListener('canplay', handleLoadedMetadata);
      audio.removeEventListener('play', handlePlay);
      audio.removeEventListener('pause', handlePause);
      audio.removeEventListener('error', handleError);
    };
  }, []);

  // Load cached state per account
  useEffect(() => {
    try {
      const saved = localStorage.getItem(storageKey);
      if (saved) {
        const data = JSON.parse(saved);
        if (data.currentTrack) {
          setCurrentTrack(data.currentTrack);
          setIsMinimalOpen(Boolean(data.isMinimalOpen));
        }
        if (Array.isArray(data.queue)) {
          setQueue(data.queue);
        }
        if (Array.isArray(data.playlistContext)) {
          setPlaylistContext(data.playlistContext);
        }
        if (typeof data.volume === 'number') {
          setVolumeState(data.volume);
          if (audioRef.current) audioRef.current.volume = data.volume;
        }
        if (data.repeatMode) setRepeatMode(data.repeatMode);
        if (typeof data.isShuffle === 'boolean') setIsShuffle(data.isShuffle);
      }
    } catch (e) {
      console.warn('Failed to load music player state:', e);
    }
  }, [storageKey]);

  // Persist state per account
  useEffect(() => {
    if (!currentTrack && queue.length === 0 && !isMinimalOpen) return;
    try {
      const stateToSave = {
        currentTrack,
        queue,
        playlistContext,
        isMinimalOpen,
        volume,
        repeatMode,
        isShuffle
      };
      localStorage.setItem(storageKey, JSON.stringify(stateToSave));
    } catch (e) {
      console.warn('Failed to save music player state:', e);
    }
  }, [currentTrack, queue, playlistContext, isMinimalOpen, volume, repeatMode, isShuffle, storageKey]);

  const togglePlay = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) {
      audio.play().catch(e => console.warn('Audio play error:', e));
    } else {
      audio.pause();
    }
  }, []);

  const pause = useCallback(() => {
    audioRef.current?.pause();
  }, []);

  const resume = useCallback(() => {
    audioRef.current?.play().catch(e => console.warn('Audio resume error:', e));
  }, []);

  // Play a specific track with optional updated playlist context
  const playTrack = useCallback((track: VirtualFile, newQueue?: VirtualFile[]) => {
    const audio = audioRef.current;
    if (!audio) return;

    registerPlayableFile(track);

    setCurrentTrack(track);
    setIsMinimalOpen(true);
    setCurrentTime(0);
    setDuration(track.duration || 0);

    if (newQueue && Array.isArray(newQueue) && newQueue.length > 0) {
      setPlaylistContext([...newQueue]);
    }

    try {
      audio.pause();
    } catch {}
    const streamUrl = (track as any).streamUrl || `/stream/${encodeURIComponent(track.id)}`;
    audio.src = streamUrl;
    audio.play().catch(e => {
      console.warn('Audio play error (awaiting interaction or buffering):', e?.message);
    });
  }, []);

  const nextTrack = useCallback(() => {
    // 1. If manual user queue has tracks, play next manual track
    if (queue.length > 0) {
      const next = queue[0];
      setQueue(prev => prev.slice(1));
      playTrack(next);
      return;
    }

    // 2. Otherwise play next track in playlistContext based on the active sort order
    const tracks = playlistContext.length > 0 ? playlistContext : (currentTrack ? [currentTrack] : []);
    if (tracks.length === 0) {
      pause();
      return;
    }

    const currentIdx = tracks.findIndex(t => t.id === currentTrack?.id);
    if (isShuffle && tracks.length > 1) {
      let randIdx = currentIdx;
      while (randIdx === currentIdx) {
        randIdx = Math.floor(Math.random() * tracks.length);
      }
      playTrack(tracks[randIdx]);
      return;
    }

    const nextIdx = currentIdx !== -1 ? currentIdx + 1 : 0;
    if (nextIdx < tracks.length) {
      playTrack(tracks[nextIdx]);
    } else {
      if (repeatMode === 'all') {
        playTrack(tracks[0]);
      } else {
        pause();
      }
    }
  }, [queue, playlistContext, currentTrack, isShuffle, repeatMode, playTrack, pause]);

  const prevTrack = useCallback(() => {
    const audio = audioRef.current;
    if (audio && audio.currentTime > 3) {
      audio.currentTime = 0;
      setCurrentTime(0);
      return;
    }

    const tracks = playlistContext.length > 0 ? playlistContext : (currentTrack ? [currentTrack] : []);
    if (tracks.length === 0) {
      if (audio) {
        audio.currentTime = 0;
        setCurrentTime(0);
      }
      return;
    }

    const currentIdx = tracks.findIndex(t => t.id === currentTrack?.id);
    const prevIdx = currentIdx > 0 ? currentIdx - 1 : (repeatMode === 'all' ? tracks.length - 1 : 0);
    if (prevIdx >= 0 && prevIdx < tracks.length && prevIdx !== currentIdx) {
      playTrack(tracks[prevIdx]);
    } else {
      if (audio) {
        audio.currentTime = 0;
        setCurrentTime(0);
      }
    }
  }, [playlistContext, currentTrack, repeatMode, playTrack]);

  // Update MediaSession metadata
  useEffect(() => {
    if (!currentTrack || typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
    const { title, artist, album } = parseTrackInfo(currentTrack);
    const thumbUrl = getTrackThumbUrl(currentTrack);

    navigator.mediaSession.metadata = new MediaMetadata({
      title,
      artist,
      album,
      artwork: thumbUrl ? [{ src: thumbUrl, sizes: '512x512', type: 'image/jpeg' }] : []
    });

    navigator.mediaSession.setActionHandler('play', () => resume());
    navigator.mediaSession.setActionHandler('pause', () => pause());
    navigator.mediaSession.setActionHandler('nexttrack', () => nextTrack());
    navigator.mediaSession.setActionHandler('previoustrack', () => prevTrack());
  }, [currentTrack, getTrackThumbUrl, nextTrack, pause, prevTrack, resume]);

  // Handle track ended
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const handleEnded = () => {
      if (repeatMode === 'one') {
        audio.currentTime = 0;
        audio.play().catch(e => console.warn('Repeat one error:', e));
      } else {
        nextTrack();
      }
    };

    audio.addEventListener('ended', handleEnded);
    return () => audio.removeEventListener('ended', handleEnded);
  }, [repeatMode, nextTrack]);

  const seek = useCallback((time: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = time;
    setCurrentTime(time);
  }, []);

  const setVolume = useCallback((vol: number) => {
    const clamped = Math.max(0, Math.min(1, vol));
    setVolumeState(clamped);
    if (audioRef.current) {
      audioRef.current.volume = clamped;
    }
    if (clamped > 0) setIsMuted(false);
  }, []);

  const toggleMute = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (isMuted) {
      audio.volume = volume > 0 ? volume : 1;
      setIsMuted(false);
    } else {
      audio.volume = 0;
      setIsMuted(true);
    }
  }, [isMuted, volume]);

  const toggleShuffle = useCallback(() => {
    setIsShuffle(prev => !prev);
  }, []);

  const toggleRepeat = useCallback(() => {
    setRepeatMode(prev => {
      if (prev === 'off') return 'all';
      if (prev === 'all') return 'one';
      return 'off';
    });
  }, []);

  const addToQueue = useCallback((track: VirtualFile) => {
    registerPlayableFile(track);
    setQueue(prev => [...prev, track]);
    // If nothing playing currently, start playing this track
    if (!currentTrack && !isPlaying) {
      playTrack(track);
    }
  }, [currentTrack, isPlaying, playTrack]);

  const addNextToQueue = useCallback((track: VirtualFile) => {
    registerPlayableFile(track);
    setQueue(prev => [track, ...prev]);
    if (!currentTrack && !isPlaying) {
      playTrack(track);
    }
  }, [currentTrack, isPlaying, playTrack]);

  const removeFromQueue = useCallback((index: number) => {
    setQueue(prev => prev.filter((_, idx) => idx !== index));
  }, []);

  const reorderQueue = useCallback((fromIndex: number, toIndex: number) => {
    setQueue(prev => {
      const copy = [...prev];
      const [item] = copy.splice(fromIndex, 1);
      copy.splice(toIndex, 0, item);
      return copy;
    });
  }, []);

  const clearQueue = useCallback(() => {
    setQueue([]);
  }, []);

  const closePlayer = useCallback(() => {
    audioRef.current?.pause();
    setIsPlaying(false);
    setIsMinimalOpen(false);
    setIsExpanded(false);
    setIsQueueOpen(false);
  }, []);

  return (
    <MusicPlayerContext.Provider
      value={{
        currentTrack,
        queue,
        playlistContext,
        isPlaying,
        currentTime,
        duration,
        volume,
        isMuted,
        isShuffle,
        repeatMode,
        isMinimalOpen,
        isExpanded,
        isQueueOpen,
        playTrack,
        addToQueue,
        addNextToQueue,
        removeFromQueue,
        reorderQueue,
        clearQueue,
        togglePlay,
        pause,
        resume,
        nextTrack,
        prevTrack,
        seek,
        setVolume,
        toggleMute,
        toggleShuffle,
        toggleRepeat,
        closePlayer,
        setExpanded: setIsExpanded,
        setQueueOpen: setIsQueueOpen,
        getTrackThumbUrl
      }}
    >
      {children}
    </MusicPlayerContext.Provider>
  );
};

export const useMusicPlayer = () => {
  const context = useContext(MusicPlayerContext);
  if (!context) {
    throw new Error('useMusicPlayer must be used within a MusicPlayerProvider');
  }
  return context;
};

