import React, { useState, useRef, useCallback, useEffect } from 'react';
import { ZoomIn, ZoomOut, RotateCcw } from 'lucide-react';
import { MediaLoadingText } from './MediaLoadingText';

/* ============================================================================
 * COMPONENT: ImageViewer
 * Touch and mouse interactive image viewer with zoom, pan, and swipe controls.
 * ============================================================================ */
export const ImageViewer: React.FC<{ src: string, alt: string, onSwipe?: (direction: -1 | 1) => void }> = ({ src, alt, onSwipe }) => {
  const [isLoaded, setIsLoaded] = useState(false);
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const pointers = useRef(new Map<number, { x: number, y: number }>());
  const pinchRef = useRef<{ distance: number, scale: number } | null>(null);
  const pinchStartRef = useRef<{ distance: number, scale: number, offset: { x: number, y: number }, center: { x: number, y: number } } | null>(null);
  const panRef = useRef<{ x: number, y: number, offset: { x: number, y: number } } | null>(null);
  const swipeRef = useRef<{ x: number, y: number } | null>(null);
  const getViewportCenter = (element: HTMLElement) => {
    const rect = element.getBoundingClientRect();
    return { x: rect.width / 2, y: rect.height / 2 };
  };
  const zoomAt = (element: HTMLElement, nextScale: number, clientX: number, clientY: number) => {
    const rect = element.getBoundingClientRect();
    const center = getViewportCenter(element);
    const anchor = { x: clientX - rect.left, y: clientY - rect.top };
    setOffset(current => {
      const imagePoint = {
        x: (anchor.x - center.x - current.x) / scale,
        y: (anchor.y - center.y - current.y) / scale
      };
      return {
        x: anchor.x - center.x - imagePoint.x * nextScale,
        y: anchor.y - center.y - imagePoint.y * nextScale
      };
    });
    setScale(nextScale);
  };

  const reset = useCallback(() => {
    setScale(1);
    setOffset({ x: 0, y: 0 });
  }, []);
  
  useEffect(() => {
    setIsLoaded(false);
    reset();
  }, [reset, src]);
  
  const clampScale = (value: number) => Math.min(8, Math.max(1, value));
  const distance = (a: { x: number, y: number }, b: { x: number, y: number }) =>
    Math.hypot(a.x - b.x, a.y - b.y);

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.current.size === 1) swipeRef.current = { x: event.clientX, y: event.clientY };
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      pinchRef.current = { distance: distance(a, b), scale };
      const center = {
        x: (a.x + b.x) / 2,
        y: (a.y + b.y) / 2
      };
      pinchStartRef.current = { distance: distance(a, b), scale, offset, center };
      panRef.current = null;
    } else {
      panRef.current = { x: event.clientX, y: event.clientY, offset };
    }
  };
  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(event.pointerId)) return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.current.size === 2 && pinchRef.current) {
      const [a, b] = [...pointers.current.values()];
      const nextScale = clampScale(pinchRef.current.scale * (distance(a, b) / pinchRef.current.distance));
      const start = pinchStartRef.current;
      if (start) {
        const rect = event.currentTarget.getBoundingClientRect();
        const viewportCenter = getViewportCenter(event.currentTarget);
        const anchor = { x: (a.x + b.x) / 2 - rect.left, y: (a.y + b.y) / 2 - rect.top };
        const startAnchor = { x: start.center.x - rect.left, y: start.center.y - rect.top };
        const imagePoint = {
          x: (startAnchor.x - viewportCenter.x - start.offset.x) / start.scale,
          y: (startAnchor.y - viewportCenter.y - start.offset.y) / start.scale
        };
        setOffset({
          x: anchor.x - viewportCenter.x - imagePoint.x * nextScale,
          y: anchor.y - viewportCenter.y - imagePoint.y * nextScale
        });
      }
      setScale(nextScale);
    } else if (panRef.current) {
      setOffset({
        x: panRef.current.offset.x + event.clientX - panRef.current.x,
        y: panRef.current.offset.y + event.clientY - panRef.current.y
      });
    }
  };
  const handlePointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    const swipe = swipeRef.current;
    pointers.current.delete(event.pointerId);
    if (pointers.current.size < 2) {
      pinchRef.current = null;
      pinchStartRef.current = null;
    }
    if (pointers.current.size === 0) panRef.current = null;
    if (swipe && pointers.current.size === 0 && scale <= 1.05 && onSwipe) {
      const dx = event.clientX - swipe.x;
      const dy = event.clientY - swipe.y;
      if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 1.25) onSwipe(dx < 0 ? 1 : -1);
    }
    if (pointers.current.size === 0) swipeRef.current = null;
  };

  return (
    <div
      className="relative flex-1 min-h-0 w-full overflow-hidden flex items-center justify-center select-none"
      style={{ touchAction: 'none', overscrollBehavior: 'contain', overflowAnchor: 'none' }}
      onWheel={event => {
        event.preventDefault();
        zoomAt(event.currentTarget, clampScale(scale * (event.deltaY < 0 ? 1.12 : 0.89)), event.clientX, event.clientY);
      }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
    >
      <img
        key={src}
        src={src}
        alt={alt}
        draggable={false}
        loading="eager"
        decoding="async"
        className={`max-w-[calc(100vw-1.5rem)] max-h-[calc(100vh-9rem)] sm:max-w-[calc(100vw-3rem)] sm:max-h-[calc(100vh-8rem)] object-contain will-change-transform transition-opacity duration-200 ${isLoaded ? 'opacity-100' : 'opacity-0'}`}
        style={{ transform: `translate3d(${offset.x}px, ${offset.y}px, 0) scale(${scale})` }}
        onLoad={() => setIsLoaded(true)}
      />
      {!isLoaded && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/35 backdrop-blur-sm">
          <MediaLoadingText />
        </div>
      )}
      <div className="absolute bottom-[calc(1rem+env(safe-area-inset-bottom,0px))] left-1/2 -translate-x-1/2 flex items-center gap-1 rounded-xl bg-black/75 p-1 text-white shadow-2xl backdrop-blur-md z-20">
        <button onClick={() => setScale(value => clampScale(value - 0.25))} className="p-2 hover:bg-white/15 rounded-lg active:scale-95" aria-label="Zoom out"><ZoomOut className="w-5 h-5" /></button>
        <button onClick={reset} className="px-2 py-2 text-xs font-medium min-w-12 active:scale-95" aria-label="Reset zoom">{Math.round(scale * 100)}%</button>
        <button onClick={() => setScale(value => clampScale(value + 0.25))} className="p-2 hover:bg-white/15 rounded-lg active:scale-95" aria-label="Zoom in"><ZoomIn className="w-5 h-5" /></button>
        <button onClick={reset} className="p-2 hover:bg-white/15 rounded-lg active:scale-95" aria-label="Reset image"><RotateCcw className="w-4 h-4" /></button>
      </div>
    </div>
  );
};
