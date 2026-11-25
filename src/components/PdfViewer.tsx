import React, { useState, useEffect, useRef, useCallback } from 'react';
import { ZoomIn, ZoomOut, ArrowLeft, ArrowRight } from 'lucide-react';
import * as pdfjsLib from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { MediaLoadingText } from './MediaLoadingText';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

/* ============================================================================
 * COMPONENT: PdfViewer
 * High-performance PDF renderer with canvas, text layer, and zoom controls.
 * ============================================================================ */
export const PdfViewer: React.FC<{ src: string, name: string }> = ({ src, name }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const renderTaskRef = useRef<pdfjsLib.RenderTask | null>(null);
  const pointers = useRef(new Map<number, { x: number, y: number }>());
  const pinchRef = useRef<{ distance: number, scale: number, center: { x: number, y: number }, offset: { x: number, y: number } } | null>(null);
  const panRef = useRef<{ x: number, y: number, offset: { x: number, y: number } } | null>(null);
  const [document, setDocument] = useState<pdfjsLib.PDFDocumentProxy | null>(null);
  const [pageNumber, setPageNumber] = useState(1);
  const [pageInput, setPageInput] = useState('1');
  const [scale, setScale] = useState(1);
  const scaleRef = useRef(1);
  const baseScaleRef = useRef(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const offsetRef = useRef({ x: 0, y: 0 });
  const [loading, setLoading] = useState(true);
  const [rendering, setRendering] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [textItems, setTextItems] = useState<Array<{ text: string, left: number, top: number, width: number, height: number, angle: number, fontSize: number }>>([]);
  
  const clampScale = (value: number) => Math.min(4, Math.max(baseScaleRef.current, value));
  const pointerDistance = (a: { x: number, y: number }, b: { x: number, y: number }) => Math.hypot(a.x - b.x, a.y - b.y);
  
  const updateOffset = (next: { x: number, y: number }) => {
    offsetRef.current = next;
    setOffset(next);
  };
  
  const resetView = useCallback(() => {
    scaleRef.current = 1;
    setScale(1);
    updateOffset({ x: 0, y: 0 });
  }, []);
  
  const zoomAt = useCallback((nextScale: number, clientX: number, clientY: number) => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const rect = viewport.getBoundingClientRect();
    const anchor = { x: clientX - rect.left, y: clientY - rect.top };
    const center = { x: rect.width / 2, y: rect.height / 2 };
    const currentOffset = offsetRef.current;
    const currentScale = scaleRef.current;
    const currentRatio = currentScale / baseScaleRef.current;
    const nextRatio = nextScale / baseScaleRef.current;
    const point = {
      x: (anchor.x - center.x - currentOffset.x) / currentRatio,
      y: (anchor.y - center.y - currentOffset.y) / currentRatio
    };
    const nextOffset = {
      x: anchor.x - center.x - point.x * nextRatio,
      y: anchor.y - center.y - point.y * nextRatio
    };
    scaleRef.current = nextScale;
    setScale(nextScale);
    updateOffset(nextOffset);
  }, []);

  useEffect(() => {
    let disposed = false;
    setLoading(true);
    setError(null);
    setTextItems([]);
    setDocument(null);
    setPageNumber(1);
    setPageInput('1');
    baseScaleRef.current = 1;
    resetView();
    fetch(src, {
      cache: 'no-store',
      headers: { Accept: 'application/pdf, application/octet-stream;q=0.9' }
    })
      .then(response => {
        if (!response.ok) throw new Error(`The server returned HTTP ${response.status}`);
        return response.arrayBuffer();
      })
      .then(data => {
        if (new TextDecoder().decode(data.slice(0, 5)) !== '%PDF-') {
          throw new Error('The downloaded file is not a valid PDF. Please re-upload the original file.');
        }
        return pdfjsLib.getDocument({ data, useSystemFonts: true, verbosity: 0 }).promise;
      })
      .then(pdf => {
        if (disposed) return;
        setDocument(pdf);
        setLoading(false);
      })
      .catch(reason => {
        if (!disposed) {
          setError(reason instanceof Error ? reason.message : 'Unable to open this PDF');
          setLoading(false);
        }
      });
    return () => {
      disposed = true;
      renderTaskRef.current?.cancel();
    };
  }, [src, resetView]);

  useEffect(() => {
    if (!document) return;
    let cancelled = false;
    document.getPage(pageNumber).then(async page => {
      if (cancelled) return;
      const baseViewport = page.getViewport({ scale: 1 });
      const viewportBounds = viewportRef.current;
      const availableWidth = Math.max(240, (viewportBounds?.clientWidth || window.innerWidth) - 24);
      const availableHeight = Math.max(240, (viewportBounds?.clientHeight || window.innerHeight) - 12);
      const fitScale = Math.min(
        availableWidth / baseViewport.width,
        availableHeight / baseViewport.height
      );
      baseScaleRef.current = fitScale;
      scaleRef.current = fitScale;
      setScale(fitScale);
      updateOffset({ x: 0, y: 0 });
      const fitViewport = page.getViewport({ scale: fitScale });
      const textContent = await page.getTextContent();
      const nextTextItems = textContent.items.flatMap(item => {
        if (!('str' in item) || !item.str) return [];
        const transform = pdfjsLib.Util.transform(fitViewport.transform, item.transform);
        const fontSize = Math.max(1, Math.hypot(transform[2], transform[3]));
        return [{
          text: item.str,
          left: transform[4],
          top: transform[5] - fontSize,
          width: Math.max(1, item.width * fitScale),
          height: fontSize * 1.25,
          angle: Math.atan2(transform[1], transform[0]),
          fontSize
        }];
      });
      setTextItems(nextTextItems);
    }).catch(reason => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : 'Unable to load this PDF page');
    });
    return () => {
      cancelled = true;
      renderTaskRef.current?.cancel();
      renderTaskRef.current = null;
    };
  }, [document, pageNumber]);

  useEffect(() => {
    if (!document) return;
    let cancelled = false;

    document.getPage(pageNumber).then(page => {
      if (cancelled) return;
      const baseViewport = page.getViewport({ scale: 1 });
      const fitScale = baseScaleRef.current;
      const displayViewport = page.getViewport({ scale: fitScale });
      const canvas = canvasRef.current;
      const context = canvas?.getContext('2d', { alpha: false });
      if (!canvas || !context || !fitScale || cancelled) return;

      const devicePixelRatio = window.devicePixelRatio || 1;
      const targetPixelRatio = Math.min(3.5, Math.max(2, devicePixelRatio * 2));
      const desiredScale = scaleRef.current * targetPixelRatio;
      const maxCanvasPixels = 24_000_000;
      const desiredPixels = baseViewport.width * desiredScale * baseViewport.height * desiredScale;
      const renderScale = desiredPixels > maxCanvasPixels
        ? desiredScale * Math.sqrt(maxCanvasPixels / desiredPixels)
        : desiredScale;
      const renderViewport = page.getViewport({ scale: renderScale });

      canvas.width = Math.ceil(renderViewport.width);
      canvas.height = Math.ceil(renderViewport.height);
      canvas.style.width = `${displayViewport.width}px`;
      canvas.style.height = `${displayViewport.height}px`;
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = 'high';
      renderTaskRef.current?.cancel();
      const task = page.render({
        canvasContext: context,
        viewport: renderViewport
      });
      renderTaskRef.current = task;
      setRendering(true);
      task.promise.then(() => {
        if (!cancelled) setRendering(false);
      }).catch(reason => {
        if (!cancelled && reason?.name !== 'RenderingCancelledException') {
          setError(reason instanceof Error ? reason.message : 'Unable to render this PDF page');
          setRendering(false);
        }
      });
    }).catch(reason => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : 'Unable to render this PDF page');
    });

    return () => {
      cancelled = true;
      renderTaskRef.current?.cancel();
      renderTaskRef.current = null;
    };
  }, [document, pageNumber, scale]);

  useEffect(() => {
    setPageInput(String(pageNumber));
  }, [pageNumber]);

  const goToPage = (nextPage: number) => {
    if (!document || !Number.isFinite(nextPage)) return;
    const boundedPage = Math.min(document.numPages, Math.max(1, Math.trunc(nextPage)));
    setPageNumber(boundedPage);
    setPageInput(String(boundedPage));
  };
  
  const commitPageInput = () => {
    const requestedPage = Number.parseInt(pageInput, 10);
    goToPage(Number.isFinite(requestedPage) ? requestedPage : pageNumber);
  };

  return (
    <div className="relative flex-1 min-h-0 w-full flex flex-col items-center">
      <div className="fixed bottom-[calc(1rem+env(safe-area-inset-bottom,0px))] sm:top-[calc(1rem+env(safe-area-inset-top,0px))] sm:bottom-auto left-1/2 -translate-x-1/2 z-[60] flex justify-center px-1 pointer-events-auto">
        <div className="flex items-center gap-0.5 rounded-xl bg-black/95 p-1 text-white shadow-2xl ring-1 ring-white/20 backdrop-blur-md">
          <button onClick={() => goToPage(pageNumber - 1)} disabled={!document || pageNumber <= 1} className="p-2 sm:p-2.5 rounded-lg hover:bg-white/15 disabled:opacity-30" aria-label="Previous PDF page"><ArrowLeft className="w-5 h-5" /></button>
          <form
            className="flex items-center text-xs sm:text-sm tabular-nums"
            onSubmit={event => {
              event.preventDefault();
              commitPageInput();
            }}
          >
            <input
              value={pageInput}
              onChange={event => setPageInput(event.target.value)}
              onBlur={commitPageInput}
              onFocus={event => event.currentTarget.select()}
              inputMode="numeric"
              aria-label="PDF page number"
              className="w-14 sm:w-16 bg-transparent text-center outline-none rounded-md px-1 py-1 focus:bg-white/15"
            />
            <span className="whitespace-nowrap pr-1.5 sm:pr-2 text-white/70">/ {document?.numPages ?? '-'}</span>
          </form>
          <button onClick={() => goToPage(pageNumber + 1)} disabled={!document || pageNumber >= document.numPages} className="p-2 sm:p-2.5 rounded-lg hover:bg-white/15 disabled:opacity-30" aria-label="Next PDF page"><ArrowRight className="w-5 h-5" /></button>
          <button onClick={() => zoomAt(clampScale(scaleRef.current - 0.15), window.innerWidth / 2, window.innerHeight / 2)} disabled={!document} className="p-2 sm:p-2.5 rounded-lg hover:bg-white/15 disabled:opacity-30" aria-label="Zoom out"><ZoomOut className="w-5 h-5" /></button>
          <span className="text-xs tabular-nums min-w-11 text-center">{Math.round((scale / Math.max(baseScaleRef.current, 0.01)) * 100)}%</span>
          <button onClick={() => zoomAt(clampScale(scaleRef.current + 0.15), window.innerWidth / 2, window.innerHeight / 2)} disabled={!document} className="p-2 sm:p-2.5 rounded-lg hover:bg-white/15 disabled:opacity-30" aria-label="Zoom in"><ZoomIn className="w-5 h-5" /></button>
        </div>
      </div>
      <div
        ref={viewportRef}
        className="relative flex-1 min-h-0 w-full overflow-hidden flex items-center justify-center select-none"
        style={{ touchAction: 'none', overscrollBehavior: 'contain' }}
        onWheel={event => {
          event.preventDefault();
          zoomAt(clampScale(scaleRef.current * (event.deltaY < 0 ? 1.12 : 0.89)), event.clientX, event.clientY);
        }}
        onPointerDown={event => {
          event.currentTarget.setPointerCapture(event.pointerId);
          pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
          if (pointers.current.size === 2) {
            const [a, b] = [...pointers.current.values()];
            pinchRef.current = {
              distance: pointerDistance(a, b),
              scale: scaleRef.current,
              center: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
              offset: offsetRef.current
            };
            panRef.current = null;
          } else {
            panRef.current = { x: event.clientX, y: event.clientY, offset: offsetRef.current };
          }
        }}
        onPointerMove={event => {
          if (!pointers.current.has(event.pointerId)) return;
          pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
          if (pointers.current.size === 2 && pinchRef.current) {
            const [a, b] = [...pointers.current.values()];
            const nextScale = clampScale(pinchRef.current.scale * (pointerDistance(a, b) / pinchRef.current.distance));
            zoomAt(nextScale, (a.x + b.x) / 2, (a.y + b.y) / 2);
          } else if (panRef.current) {
            updateOffset({
              x: panRef.current.offset.x + event.clientX - panRef.current.x,
              y: panRef.current.offset.y + event.clientY - panRef.current.y
            });
          }
        }}
        onPointerUp={event => {
          pointers.current.delete(event.pointerId);
          if (pointers.current.size < 2) pinchRef.current = null;
          if (pointers.current.size === 0) panRef.current = null;
        }}
        onPointerCancel={event => {
          pointers.current.delete(event.pointerId);
          pinchRef.current = null;
          panRef.current = null;
        }}
      >
        {(loading || rendering) && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/35 backdrop-blur-sm">
            <MediaLoadingText />
          </div>
        )}
        {error && <p className="text-white text-center max-w-lg">Unable to open {name}: {error}</p>}
        {!error && (
          <div
            className="relative bg-white shadow-2xl will-change-transform"
            style={{
              transform: `translate3d(${offset.x}px, ${offset.y}px, 0) scale(${scale / Math.max(baseScaleRef.current, 0.01)})`,
              transformOrigin: 'center center'
            }}
          >
            <canvas ref={canvasRef} className="block" aria-label={`${name}, page ${pageNumber}`} />
            <div
              className="pointer-events-none absolute inset-0 overflow-hidden select-text"
              aria-label="Selectable PDF text"
            >
              {textItems.map((item, i) => (
                <span
                  key={i}
                  className="absolute whitespace-pre text-transparent pointer-events-auto selection:bg-[#9A2227]/30"
                  style={{
                    left: `${item.left}px`,
                    top: `${item.top}px`,
                    width: `${item.width}px`,
                    height: `${item.height}px`,
                    fontSize: `${item.fontSize}px`,
                    transform: `rotate(${item.angle}rad)`,
                    transformOrigin: 'top left'
                  }}
                >
                  {item.text}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
