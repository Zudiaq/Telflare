import React, { useState, useRef, useEffect } from 'react';
import {
  Play, Pause, SkipForward, SkipBack, X, ChevronDown, Shuffle,
  Repeat, Volume2, VolumeX, ListMusic, Music, GripVertical,
  ChevronUp, Disc3
} from 'lucide-react';
import { useMusicPlayer } from '../context/MusicPlayerContext';
import { parseTrackInfo, formatDuration } from '../lib/musicUtils';

const FramelessPlayPauseButton: React.FC<{
  isPlaying: boolean;
  onClick: (e: React.MouseEvent) => void;
  size?: 'sm' | 'lg';
  idPrefix?: string;
}> = ({ isPlaying, onClick, size = 'sm' }) => {
  const isLg = size === 'lg';
  const iconSize = isLg ? 'w-10 h-10 sm:w-12 sm:h-12' : 'w-5 h-5 sm:w-6 sm:h-6';

  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClick(e);
      }}
      className={`group/playbtn relative flex items-center justify-center p-0 bg-transparent border-0 outline-none select-none cursor-pointer focus:outline-none transition-transform duration-200 ease-out hover:scale-120 active:scale-85 ${
        isLg ? 'p-2' : 'p-1'
      }`}
      title={isPlaying ? 'Pause' : 'Play'}
      aria-label={isPlaying ? 'Pause' : 'Play'}
    >
      {/* Ambient glow behind icon */}
      <div
        className={`absolute inset-0 rounded-full bg-white/25 blur-md pointer-events-none transition-all duration-300 ease-out ${
          isPlaying
            ? 'opacity-80 scale-125'
            : 'opacity-0 scale-75 group-hover/playbtn:opacity-60 group-hover/playbtn:scale-110'
        }`}
      />

      <div className={`relative ${iconSize} flex items-center justify-center drop-shadow-[0_2px_10px_rgba(255,255,255,0.4)] group-hover/playbtn:drop-shadow-[0_4px_16px_rgba(255,255,255,0.8)] transition-all duration-200`}>
        {isPlaying ? (
          <Pause className="w-full h-full text-white fill-white transition-transform duration-150 active:scale-90" />
        ) : (
          <Play className="w-full h-full text-white fill-white translate-x-0.5 transition-transform duration-150 active:scale-90" />
        )}
      </div>
    </button>
  );
};

/* ============================================================================
 * COMPONENT: MusicPlayer
 * Audio player UI: minimal floating bar, expanded full view, queue management.
 * ============================================================================ */
export const MusicPlayer: React.FC = () => {
  const {
    currentTrack,
    queue,
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
    togglePlay,
    nextTrack,
    prevTrack,
    seek,
    setVolume,
    toggleMute,
    toggleShuffle,
    toggleRepeat,
    closePlayer,
    setExpanded,
    setQueueOpen,
    removeFromQueue,
    reorderQueue,
    clearQueue,
    getTrackThumbUrl,
    playTrack
  } = useMusicPlayer();

  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
  const [isClosing, setIsClosing] = useState(false);
  const progressBarRef = useRef<HTMLDivElement | null>(null);
  const touchQueueIdxRef = useRef<number | null>(null);

  // Scrubber drag / seek states
  const [isScrubbing, setIsScrubbing] = useState(false);
  const [scrubTime, setScrubTime] = useState(0);
  const [hoverTime, setHoverTime] = useState<number | null>(null);
  const [hoverPosition, setHoverPosition] = useState<number | null>(null);
  const isDraggingScrubRef = useRef(false);

  // Smooth exit handler for closing minimal player
  const handleClose = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isClosing) return;
    setIsClosing(true);
    setTimeout(() => {
      closePlayer();
      setIsClosing(false);
    }, 280);
  };

  // Keyboard navigation when expanded
  useEffect(() => {
    if (!isExpanded) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        seek(Math.max(0, currentTime - 5));
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        seek(Math.min(duration, currentTime + 5));
      } else if (e.key === ' ' || e.code === 'Space') {
        e.preventDefault();
        togglePlay();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isExpanded, currentTime, duration, seek, togglePlay]);

  if (!isMinimalOpen || !currentTrack) return null;

  const { title, artist, album } = parseTrackInfo(currentTrack);
  const thumbUrl = getTrackThumbUrl(currentTrack);
  const effectiveTime = isScrubbing ? scrubTime : currentTime;
  const effectivePercent = duration > 0 ? Math.max(0, Math.min(100, (effectiveTime / duration) * 100)) : 0;

  // Handle seeking click/drag with PointerEvents for desktop mouse and mobile touch
  const getTimeFromPointer = (clientX: number, target: HTMLDivElement): number => {
    const rect = target.getBoundingClientRect();
    if (rect.width <= 0) return 0;
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    return ratio * duration;
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (duration <= 0) return;
    isDraggingScrubRef.current = true;
    setIsScrubbing(true);
    e.currentTarget.setPointerCapture(e.pointerId);
    const targetTime = getTimeFromPointer(e.clientX, e.currentTarget);
    setScrubTime(targetTime);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (duration <= 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    setHoverPosition(ratio * 100);
    setHoverTime(ratio * duration);

    if (isDraggingScrubRef.current) {
      const targetTime = ratio * duration;
      setScrubTime(targetTime);
    }
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isDraggingScrubRef.current) return;
    isDraggingScrubRef.current = false;
    setIsScrubbing(false);
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {}
    const targetTime = getTimeFromPointer(e.clientX, e.currentTarget);
    seek(targetTime);
  };

  const handlePointerCancel = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isDraggingScrubRef.current) return;
    isDraggingScrubRef.current = false;
    setIsScrubbing(false);
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {}
  };

  // Drag and drop for queue
  const handleDragStart = (index: number) => {
    setDraggedIndex(index);
  };

  const handleDragOver = (e: React.DragEvent, index: number) => {
    e.preventDefault();
    if (draggedIndex === null || draggedIndex === index) return;
    reorderQueue(draggedIndex, index);
    setDraggedIndex(index);
  };

  const handleDragEnd = () => {
    setDraggedIndex(null);
  };

  // Touch drag and drop for queue on mobile
  const handleTouchQueueStart = (e: React.TouchEvent, index: number) => {
    e.stopPropagation();
    touchQueueIdxRef.current = index;
    setDraggedIndex(index);
    if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
      navigator.vibrate(25);
    }
  };

  const handleTouchQueueMove = (e: React.TouchEvent) => {
    if (touchQueueIdxRef.current === null) return;
    const touch = e.touches[0];
    const targetEl = document.elementFromPoint(touch.clientX, touch.clientY);
    const rowEl = targetEl?.closest('[data-queue-index]');
    if (rowEl) {
      const targetIdx = parseInt(rowEl.getAttribute('data-queue-index') || '-1', 10);
      if (targetIdx >= 0 && targetIdx !== touchQueueIdxRef.current && targetIdx < queue.length) {
        reorderQueue(touchQueueIdxRef.current, targetIdx);
        touchQueueIdxRef.current = targetIdx;
        setDraggedIndex(targetIdx);
        if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
          navigator.vibrate(15);
        }
      }
    }
  };

  const handleTouchQueueEnd = () => {
    touchQueueIdxRef.current = null;
    setDraggedIndex(null);
  };

  return (
    <>
      {/* 1. Minimal Mode: Thin glassmorphic bar anchored right below the header with smooth entrance and exit */}
      <div
        className={`w-full px-2 sm:px-4 py-2 transition-all duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)] ${
          isClosing
            ? 'opacity-0 -translate-y-4 scale-95 pointer-events-none'
            : 'animate-in fade-in slide-in-from-top-2 duration-300'
        }`}
      >
        <div
          onClick={() => setExpanded(true)}
          className="max-w-7xl mx-auto h-14 sm:h-16 rounded-2xl bg-gradient-to-r from-[#17090e]/95 via-[#0e101a]/95 to-[#0b1322]/95 border border-red-500/25 hover:border-blue-500/40 backdrop-blur-2xl shadow-2xl shadow-red-950/40 flex items-center justify-between px-2.5 sm:px-4 gap-1.5 sm:gap-4 relative overflow-hidden cursor-pointer group transition-all"
        >
          {/* Bottom thin progress bar with interactive scrubber */}
          <div
            onClick={e => e.stopPropagation()}
            onPointerDown={e => {
              e.stopPropagation();
              handlePointerDown(e);
            }}
            onPointerMove={e => {
              e.stopPropagation();
              handlePointerMove(e);
            }}
            onPointerUp={e => {
              e.stopPropagation();
              handlePointerUp(e);
            }}
            onPointerCancel={e => {
              e.stopPropagation();
              handlePointerCancel(e);
            }}
            className="absolute bottom-0 inset-x-0 h-3 cursor-pointer z-20 group/miniscrub flex items-end touch-none"
            title="Click or drag to seek"
          >
            <div className="w-full h-[2.5px] group-hover/miniscrub:h-1 transition-[height] bg-white/10 relative overflow-visible">
              <div
                className="h-full bg-gradient-to-r from-red-600 via-rose-500 to-blue-500 relative"
                style={{ width: `${effectivePercent}%` }}
              >
                <div
                  className={`absolute right-0 top-1/2 -translate-y-1/2 translate-x-1/2 w-2.5 h-2.5 rounded-full bg-white shadow-md shadow-red-500/50 transition-all ${
                    isScrubbing ? 'scale-125' : 'scale-0 group-hover/miniscrub:scale-100'
                  }`}
                />
              </div>
            </div>
          </div>

          {/* Left: Track Thumbnail + Title & Artist with smooth entrance on track switch */}
          <div
            key={currentTrack?.id || 'none'}
            className="flex items-center gap-3 min-w-0 flex-1 sm:max-w-md animate-in fade-in-50 slide-in-from-right-2 duration-300 ease-out will-change-transform"
          >
            <div className="w-10 h-10 sm:w-11 sm:h-11 rounded-xl overflow-hidden bg-red-950/50 border border-red-500/30 shrink-0 relative flex items-center justify-center shadow-md">
              {thumbUrl ? (
                <img
                  src={thumbUrl}
                  crossOrigin="anonymous"
                  alt=""
                  className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-200"
                  onError={e => {
                    (e.currentTarget as HTMLElement).style.display = 'none';
                    const fallback = e.currentTarget.nextElementSibling as HTMLElement;
                    if (fallback) fallback.style.display = 'flex';
                  }}
                />
              ) : null}
              <div
                style={{ display: thumbUrl ? 'none' : 'flex' }}
                className="w-full h-full items-center justify-center pointer-events-none"
              >
                <Music className="w-4 h-4 text-rose-400 opacity-60" />
              </div>
            </div>

            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="font-bold text-xs sm:text-sm text-white truncate group-hover:text-rose-200 transition-colors">
                  {title}
                </span>
                {isPlaying && (
                  <div className="flex items-end gap-0.5 h-3 shrink-0">
                    <span className="w-0.5 bg-gradient-to-t from-red-500 to-rose-400 animate-[bounce_0.8s_infinite] h-2.5 rounded-full" />
                    <span className="w-0.5 bg-gradient-to-t from-blue-500 to-sky-400 animate-[bounce_0.6s_infinite_0.2s] h-3 rounded-full" />
                    <span className="w-0.5 bg-gradient-to-t from-red-500 to-blue-300 animate-[bounce_0.9s_infinite_0.4s] h-1.5 rounded-full" />
                  </div>
                )}
              </div>
              <div className="text-[11px] sm:text-xs text-gray-400 truncate mt-0.5">
                {artist}
              </div>
            </div>
          </div>

          {/* Right Controls: Play/Pause, Skip, Queue, Close */}
          <div
            onClick={e => e.stopPropagation()}
            className="flex items-center gap-2 sm:gap-3 shrink-0"
          >
            {/* Previous Track */}
            <button
              onClick={prevTrack}
              className="group/btn p-1.5 sm:p-2 text-gray-300 hover:text-white rounded-xl hover:bg-white/10 active:scale-80 transition-all duration-200"
              title="Previous Track"
            >
              <SkipBack className="w-4 h-4 sm:w-5 sm:h-5 transition-transform duration-200 ease-out group-hover/btn:-translate-x-1" />
            </button>

            {/* Frameless Morphing Play/Pause Button */}
            <FramelessPlayPauseButton
              isPlaying={isPlaying}
              onClick={togglePlay}
              size="sm"
              idPrefix="min"
            />

            {/* Skip / Next */}
            <button
              onClick={nextTrack}
              className="group/btn p-1.5 sm:p-2 text-gray-300 hover:text-white rounded-xl hover:bg-white/10 active:scale-80 transition-all duration-200"
              title="Next Track"
            >
              <SkipForward className="w-4 h-4 sm:w-5 sm:h-5 transition-transform duration-200 ease-out group-hover/btn:translate-x-1" />
            </button>

            {/* Queue Button */}
            <button
              onClick={() => {
                setExpanded(true);
                setQueueOpen(true);
              }}
              className="group/btn relative p-2 text-gray-300 hover:text-white rounded-xl hover:bg-white/10 active:scale-80 transition-all duration-200 hidden sm:flex"
              title="Queue"
            >
              <ListMusic className="w-4 h-4 transition-transform duration-200 ease-out group-hover/btn:scale-115" />
              {queue.length > 0 && (
                <span className="absolute top-1 right-1 w-3.5 h-3.5 rounded-full bg-gradient-to-r from-red-600 to-blue-600 text-[9px] font-bold text-white flex items-center justify-center shadow-sm animate-in zoom-in-75 duration-200">
                  {queue.length > 9 ? '9+' : queue.length}
                </span>
              )}
            </button>

            {/* Close Button with Exit Animation */}
            <button
              onClick={handleClose}
              className="group/btn p-1.5 sm:p-2 text-gray-400 hover:text-rose-400 rounded-xl hover:bg-white/10 active:scale-75 transition-all duration-200"
              title="Close Player"
            >
              <X className="w-4 h-4 sm:w-4 sm:h-4 transition-transform duration-300 ease-out group-hover/btn:rotate-90 group-hover/btn:scale-115" />
            </button>
          </div>
        </div>
      </div>

      {/* 2. Expanded Mode: Full screen player modal with smooth slide animation */}
      <div
        className={`fixed inset-0 z-[100] flex flex-col justify-between p-4 sm:p-8 bg-[#090b12]/95 backdrop-blur-3xl text-white select-none overflow-y-auto transition-all duration-500 ease-[cubic-bezier(0.16,1,0.3,1)] ${
          isExpanded
            ? 'opacity-100 translate-y-0 scale-100 pointer-events-auto'
            : 'opacity-0 -translate-y-full scale-95 pointer-events-none'
        }`}
      >
        {/* Top Bar */}
        <div className="flex items-center justify-between w-full max-w-4xl mx-auto">
          <button
            onClick={() => setExpanded(false)}
            className="group/btn p-2.5 rounded-2xl bg-white/5 hover:bg-white/10 text-gray-300 hover:text-white active:scale-80 transition-all duration-200"
            title="Minimize"
          >
            <ChevronDown className="w-6 h-6 transition-transform duration-200 ease-out group-hover/btn:translate-y-1" />
          </button>

          <div className="text-center">
            <span className="text-[11px] font-bold uppercase tracking-widest text-rose-400">
              Playing from ZUD Cloud
            </span>
            <p className="text-xs text-gray-400 font-medium truncate max-w-xs sm:max-w-md">
              {album || 'Cloud Music'}
            </p>
          </div>

          <button
            onClick={() => setQueueOpen(!isQueueOpen)}
            className={`group/btn p-2.5 rounded-2xl transition-all duration-200 relative active:scale-80 ${
              isQueueOpen
                ? 'bg-gradient-to-r from-red-600 to-blue-600 text-white shadow-lg shadow-red-600/30 scale-105'
                : 'bg-white/5 hover:bg-white/10 text-gray-300 hover:text-white hover:scale-105'
            }`}
            title="Queue"
          >
            <ListMusic className="w-6 h-6 transition-transform duration-200 group-hover/btn:rotate-6" />
            {queue.length > 0 && (
              <span className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-red-500 text-[10px] font-bold text-white flex items-center justify-center animate-in zoom-in-75 duration-200">
                {queue.length}
              </span>
            )}
          </button>
        </div>

        {/* Main Body: Switch between Player View & Queue View */}
        {isQueueOpen ? (
          /* Queue Drawer View */
          <div className="w-full max-w-2xl mx-auto my-6 flex-1 flex flex-col bg-black/40 border border-red-500/20 rounded-3xl p-5 overflow-hidden backdrop-blur-xl">
            <div className="flex items-center justify-between pb-3 border-b border-gray-800">
              <h3 className="text-lg font-bold text-white flex items-center gap-2">
                <ListMusic className="w-5 h-5 text-rose-400" />
                Queue
              </h3>
              {queue.length > 0 && (
                <button
                  onClick={clearQueue}
                  className="text-xs text-gray-400 hover:text-rose-400 transition-colors"
                >
                  Clear all
                </button>
              )}
            </div>

            {/* Now Playing in Queue */}
            <div className="mt-4 mb-3">
              <span className="text-xs font-bold uppercase tracking-wider text-rose-400 block mb-2">
                Now Playing
              </span>
              <div className="flex items-center gap-3 p-3 rounded-2xl bg-gradient-to-r from-red-950/40 to-blue-950/30 border border-red-500/30">
                <div className="w-11 h-11 rounded-xl overflow-hidden bg-red-900/40 shrink-0 relative flex items-center justify-center">
                  {thumbUrl ? (
                    <img src={thumbUrl} crossOrigin="anonymous" alt="" className="w-full h-full object-cover" />
                  ) : (
                    <Music className="w-4 h-4 text-rose-400 opacity-50" />
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <h4 className="font-semibold text-sm text-white truncate">{title}</h4>
                  <p className="text-xs text-blue-300/80 truncate">{artist}</p>
                </div>
                <div className="flex items-end gap-0.5 h-4 w-4 justify-center">
                  <span className="w-1 bg-red-500 animate-[bounce_0.8s_infinite] h-3 rounded-full" />
                  <span className="w-1 bg-blue-400 animate-[bounce_0.6s_infinite_0.2s] h-4 rounded-full" />
                  <span className="w-1 bg-rose-400 animate-[bounce_0.9s_infinite_0.4s] h-2 rounded-full" />
                </div>
              </div>
            </div>

            {/* Next Up List */}
            <div className="flex-1 overflow-y-auto space-y-2 pr-1">
              <span className="text-xs font-bold uppercase tracking-wider text-gray-400 block mt-2 mb-2">
                Next in Queue ({queue.length})
              </span>

              {queue.length === 0 ? (
                <div className="py-12 text-center text-gray-500 text-xs">
                  Queue is empty. Select songs from your files to queue them up!
                </div>
              ) : (
                queue.map((track, idx) => {
                  const qInfo = parseTrackInfo(track);
                  const qThumb = getTrackThumbUrl(track);

                  return (
                    <div
                      key={track.id}
                      data-queue-index={idx}
                      draggable
                      onDragStart={() => handleDragStart(idx)}
                      onDragOver={e => handleDragOver(e, idx)}
                      onDragEnd={handleDragEnd}
                      className={`flex items-center gap-3 p-2.5 rounded-2xl bg-white/[0.03] hover:bg-white/[0.07] border border-gray-800/60 transition-all duration-300 ease-out cursor-move group ${
                        draggedIndex === idx ? 'opacity-30 scale-95 border-rose-500 shadow-lg shadow-rose-950/50' : 'hover:scale-[1.01]'
                      }`}
                    >
                      {/* Drag Handle with touch & mouse drag support */}
                      <div
                        onTouchStart={e => handleTouchQueueStart(e, idx)}
                        onTouchMove={handleTouchQueueMove}
                        onTouchEnd={handleTouchQueueEnd}
                        onTouchCancel={handleTouchQueueEnd}
                        className="touch-none cursor-grab active:cursor-grabbing p-1 -m-1"
                        title="Drag to reorder"
                      >
                        <GripVertical className="w-4 h-4 text-gray-500 group-hover:text-gray-300 shrink-0" />
                      </div>

                      {/* Thumbnail */}
                      <div className="w-10 h-10 rounded-xl overflow-hidden bg-red-950/40 shrink-0 relative flex items-center justify-center">
                        {qThumb ? (
                          <img src={qThumb} crossOrigin="anonymous" alt="" className="w-full h-full object-cover" />
                        ) : (
                          <Music className="w-4 h-4 text-rose-400 opacity-50" />
                        )}
                      </div>

                      {/* Info */}
                      <div
                        onClick={() => playTrack(track)}
                        className="flex-1 min-w-0 cursor-pointer"
                      >
                        <h4 className="font-semibold text-xs sm:text-sm text-white truncate group-hover:text-blue-300">
                          {qInfo.title}
                        </h4>
                        <p className="text-[11px] text-gray-400 truncate">{qInfo.artist}</p>
                      </div>

                      {/* Quick Reorder Up/Down */}
                      <div className="flex items-center gap-0.5">
                        <button
                          onClick={() => reorderQueue(idx, Math.max(0, idx - 1))}
                          disabled={idx === 0}
                          className="p-1.5 text-gray-400 hover:text-white hover:scale-125 active:scale-75 transition-all duration-200 disabled:opacity-20"
                          title="Move Up"
                        >
                          <ChevronUp className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => reorderQueue(idx, Math.min(queue.length - 1, idx + 1))}
                          disabled={idx === queue.length - 1}
                          className="p-1.5 text-gray-400 hover:text-white hover:scale-125 active:scale-75 transition-all duration-200 disabled:opacity-20"
                          title="Move Down"
                        >
                          <ChevronDown className="w-3.5 h-3.5" />
                        </button>
                      </div>

                      {/* Remove */}
                      <button
                        onClick={() => removeFromQueue(idx)}
                        className="p-1 text-gray-400 hover:text-rose-400 transition-colors"
                        title="Remove from queue"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        ) : (
            /* Standard Player Central View */
            <div
              key={currentTrack?.id || 'none'}
              className="w-full max-w-md mx-auto my-auto flex flex-col items-center animate-in fade-in-50 zoom-in-95 duration-400 ease-out will-change-transform"
            >
              {/* Dynamic ambient colorful backdrop glow */}
              <div className="relative mb-6 sm:mb-8 group">
                <div
                  className={`absolute -inset-6 rounded-full bg-gradient-to-tr from-red-600/40 via-rose-600/30 to-blue-600/40 blur-3xl transition-opacity duration-700 pointer-events-none ${
                    isPlaying ? 'opacity-80 scale-105' : 'opacity-25 scale-95'
                  }`}
                />

                {/* Large Cover Artwork with rotating vinyl aesthetic */}
                <div className="w-52 h-52 sm:w-72 md:w-80 sm:h-72 md:h-80 rounded-[28px] sm:rounded-[32px] overflow-hidden bg-gradient-to-tr from-red-950 via-[#180a12] to-blue-950 border border-red-500/30 p-1.5 sm:p-2 shadow-2xl shadow-red-950/60 shrink-0 relative flex items-center justify-center">
                  <div
                    className={`w-full h-full rounded-[24px] overflow-hidden bg-[#0e0a12] relative flex items-center justify-center transition-transform duration-700 ${
                      isPlaying ? 'scale-[1.02]' : 'scale-100'
                    }`}
                  >
                    {thumbUrl ? (
                      <img
                        src={thumbUrl}
                        crossOrigin="anonymous"
                        alt={title}
                        className="w-full h-full object-cover select-none"
                      />
                    ) : (
                      <div className="flex flex-col items-center justify-center gap-3">
                        <Disc3
                          className="w-28 h-28 text-rose-500 animate-[spin_8s_linear_infinite]"
                          style={{
                            animationPlayState: isPlaying ? 'running' : 'paused',
                            opacity: isPlaying ? 1 : 0.6
                          }}
                        />
                        <span className="text-xs font-semibold text-rose-300/80 uppercase tracking-widest">ZUD Music</span>
                      </div>
                    )}

                    {/* Subtle gradient sheen overlay */}
                    <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-white/5 pointer-events-none" />

                    {/* Playing Badge */}
                    {isPlaying && (
                      <div className="absolute bottom-3 right-3 px-2.5 py-1 rounded-full bg-black/60 backdrop-blur-md border border-red-500/30 flex items-center gap-1.5 shadow-lg">
                        <Disc3
                          className="w-3.5 h-3.5 text-rose-400 animate-[spin_3s_linear_infinite]"
                          style={{ animationPlayState: isPlaying ? 'running' : 'paused' }}
                        />
                        <span className="text-[10px] font-bold tracking-wider text-blue-200">PLAYING</span>
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {/* Title & Artist with Live Equalizer */}
              <div className="w-full text-center px-4 mb-3">
                <div className="flex items-center justify-center gap-2 mb-1">
                  <h2 className="text-xl sm:text-2xl font-black text-white truncate drop-shadow-md">
                    {title}
                  </h2>
                  {isPlaying && (
                    <div className="flex items-end gap-0.5 h-4 shrink-0">
                      <span className="w-1 bg-gradient-to-t from-red-600 to-rose-400 animate-[bounce_0.8s_infinite] h-3 rounded-full" />
                      <span className="w-1 bg-gradient-to-t from-red-500 to-blue-400 animate-[bounce_0.6s_infinite_0.15s] h-4 rounded-full" />
                      <span className="w-1 bg-gradient-to-t from-rose-500 to-blue-300 animate-[bounce_0.9s_infinite_0.3s] h-2.5 rounded-full" />
                      <span className="w-1 bg-gradient-to-t from-red-500 to-blue-400 animate-[bounce_0.7s_infinite_0.45s] h-3.5 rounded-full" />
                    </div>
                  )}
                </div>
                <p className="text-sm sm:text-base text-blue-300/90 font-medium truncate">
                  {artist}
                </p>
              </div>
            </div>
          )}

          {/* Bottom Scrubber & Playback Controls */}
          <div className="w-full max-w-2xl mx-auto space-y-4">
            {/* Scrubber Bar */}
            <div className="space-y-1.5 select-none">
              <div
                ref={progressBarRef}
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
                onPointerCancel={handlePointerCancel}
                onPointerLeave={() => {
                  if (!isDraggingScrubRef.current) {
                    setHoverTime(null);
                    setHoverPosition(null);
                  }
                }}
                className="w-full py-3.5 cursor-pointer relative flex items-center group touch-none"
              >
                {/* Floating Scrub / Hover Time Tooltip */}
                {(isScrubbing || (hoverPosition !== null && hoverTime !== null)) && (
                  <div
                    className="absolute -top-7 -translate-x-1/2 px-2 py-0.5 rounded-md bg-red-950/90 border border-rose-400/40 text-[11px] font-bold text-blue-200 pointer-events-none shadow-lg shadow-red-950/60 backdrop-blur-md animate-in fade-in duration-150 z-30 flex items-center gap-1"
                    style={{ left: `${isScrubbing ? effectivePercent : hoverPosition}%` }}
                  >
                    <span>{formatDuration(isScrubbing ? scrubTime : (hoverTime ?? 0))}</span>
                  </div>
                )}

                {/* Track background */}
                <div className="w-full h-1.5 group-hover:h-2 rounded-full bg-white/15 relative overflow-visible transition-[height] duration-150">
                  {/* Hover track preview */}
                  {hoverPosition !== null && !isScrubbing && (
                    <div
                      className="absolute inset-y-0 left-0 rounded-full bg-white/10 pointer-events-none"
                      style={{ width: `${hoverPosition}%` }}
                    />
                  )}

                  {/* Played Fill */}
                  <div
                    className="h-full bg-gradient-to-r from-red-600 via-rose-500 to-blue-500 rounded-full relative"
                    style={{ width: `${effectivePercent}%` }}
                  >
                    {/* Scrubber Knob / Handle */}
                    <div
                      className={`absolute right-0 top-1/2 -translate-y-1/2 translate-x-1/2 w-3.5 h-3.5 rounded-full bg-white shadow-md shadow-red-500/50 transition-all ${
                        isScrubbing ? 'scale-125 ring-4 ring-rose-500/30' : 'scale-0 group-hover:scale-100'
                      }`}
                    />
                  </div>
                </div>
              </div>

              {/* Time Numbers */}
              <div className="flex items-center justify-between text-xs font-semibold text-gray-400 px-0.5">
                <span className={isScrubbing ? 'text-blue-400 font-bold' : ''}>
                  {formatDuration(effectiveTime)}
                </span>
                <span>{formatDuration(duration)}</span>
              </div>
            </div>

            {/* Playback Buttons Row */}
            <div className="flex items-center justify-between max-w-md mx-auto py-2">
              {/* Shuffle */}
              <button
                onClick={toggleShuffle}
                className={`p-2.5 rounded-xl relative transition-all duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)] hover:scale-120 active:scale-75 ${
                  isShuffle ? 'text-blue-400 font-bold drop-shadow-[0_0_8px_rgba(56,189,248,0.7)]' : 'text-gray-400 hover:text-white'
                }`}
                title="Shuffle"
              >
                <Shuffle className="w-5 h-5" />
                {isShuffle && (
                  <span className="absolute bottom-1 left-1/2 -translate-x-1/2 w-1.5 h-1.5 rounded-full bg-blue-400 shadow-[0_0_6px_rgba(56,189,248,0.9)]" />
                )}
              </button>

              {/* Prev */}
              <button
                onClick={prevTrack}
                className="p-3 text-gray-300 hover:text-white transition-all duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)] hover:scale-125 active:scale-80 hover:drop-shadow-[0_0_12px_rgba(244,63,94,0.6)]"
                title="Previous Track"
              >
                <SkipBack className="w-6 h-6 fill-current" />
              </button>

              {/* Frameless Morphing Play/Pause Button - Zero circle border, floating high-framerate SVG morph */}
              <FramelessPlayPauseButton
                isPlaying={isPlaying}
                onClick={togglePlay}
                size="lg"
                idPrefix="exp"
              />

              {/* Next */}
              <button
                onClick={nextTrack}
                className="p-3 text-gray-300 hover:text-white transition-all duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)] hover:scale-125 active:scale-80 hover:drop-shadow-[0_0_12px_rgba(56,189,248,0.6)]"
                title="Next Track"
              >
                <SkipForward className="w-6 h-6 fill-current" />
              </button>

              {/* Repeat */}
              <button
                onClick={toggleRepeat}
                className={`p-2.5 rounded-xl relative transition-all duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)] hover:scale-120 active:scale-75 ${
                  repeatMode !== 'off'
                    ? 'text-blue-400 font-bold drop-shadow-[0_0_8px_rgba(56,189,248,0.7)]'
                    : 'text-gray-400 hover:text-white'
                }`}
                title={`Repeat: ${repeatMode}`}
              >
                <Repeat className="w-5 h-5" />
                {repeatMode === 'one' && (
                  <span className="absolute -top-1 -right-1 text-[9px] font-black bg-gradient-to-r from-red-500 to-rose-500 text-white rounded-full w-4 h-4 flex items-center justify-center shadow-md">
                    1
                  </span>
                )}
                {repeatMode === 'all' && (
                  <span className="absolute bottom-1 left-1/2 -translate-x-1/2 w-1.5 h-1.5 rounded-full bg-blue-400 shadow-[0_0_6px_rgba(56,189,248,0.9)]" />
                )}
              </button>
            </div>

            {/* Volume Control Bar */}
            <div className="flex items-center justify-center gap-3 max-w-xs mx-auto pb-2">
              <button
                onClick={toggleMute}
                className="text-gray-400 hover:text-white transition-transform duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)] hover:scale-120 active:scale-80"
              >
                {isMuted || volume === 0 ? (
                  <VolumeX className="w-5 h-5 text-rose-400" />
                ) : (
                  <Volume2 className="w-5 h-5 text-blue-300" />
                )}
              </button>

              <input
                type="range"
                min="0"
                max="1"
                step="0.01"
                value={isMuted ? 0 : volume}
                onChange={e => setVolume(parseFloat(e.target.value))}
                className="w-32 sm:w-40 h-1.5 bg-white/10 accent-blue-500 rounded-full cursor-pointer hover:accent-rose-400 transition-all"
              />
            </div>
          </div>
        </div>
    </>
  );
};
