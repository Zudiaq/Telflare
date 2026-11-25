const isCanvasMostlyBlack = (ctx: CanvasRenderingContext2D, w: number, h: number): boolean => {
  try {
    const data = ctx.getImageData(Math.floor(w * 0.15), Math.floor(h * 0.15), Math.max(4, Math.floor(w * 0.7)), Math.max(4, Math.floor(h * 0.7))).data;
    let sum = 0;
    let samples = 0;
    for (let i = 0; i < data.length; i += 40) {
      sum += data[i] + data[i + 1] + data[i + 2];
      samples++;
    }
    return samples > 0 && (sum / (samples * 3)) < 10;
  } catch {
    return false;
  }
};

/* ============================================================================
 * HARDWARE GPU VIDEO COLLAGE & THUMBNAIL GENERATOR
 * ============================================================================ */
export const generateVideoCollage = (
  file: File,
  onProgress?: (msg: string) => void,
  segment?: { index: number; total: number },
): Promise<{ blob: Blob; duration: number; width: number; height: number } | null> => {
  return new Promise((resolve) => {
    if (onProgress) onProgress('Loading video (Hardware GPU)...');
    const video = document.createElement('video');
    video.preload = 'auto';
    video.playsInline = true;
    video.muted = true;
    const objectUrl = URL.createObjectURL(file);
    video.src = objectUrl;

    let settled = false;
    const finish = (res: { blob: Blob; duration: number; width: number; height: number } | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(tId);
      try {
        video.pause();
        video.removeAttribute('src');
        video.load();
      } catch {}
      URL.revokeObjectURL(objectUrl);
      resolve(res);
    };

    const tId = setTimeout(() => finish(null), 12000);
    let started = false;

    const startExtraction = () => {
      if (started || settled) return;
      const fullDuration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
      const vw = video.videoWidth || 0;
      const vh = video.videoHeight || 0;
      if (!vw || !vh) return;
      started = true;
      clearTimeout(tId);

      const safeDur = fullDuration > 0 ? fullDuration : 10;
      const segmentStart = segment ? (safeDur * segment.index) / segment.total : 0;
      const segmentEnd = segment ? (safeDur * (segment.index + 1)) / segment.total : safeDur;
      const sTime = segmentStart;
      const partDuration = Math.max(0.5, segmentEnd - sTime);

      let cw: number;
      let ch: number;
      if (vw >= vh) {
        cw = 320;
        ch = Math.max(2, Math.round((vh / vw) * 320));
      } else {
        ch = 320;
        cw = Math.max(2, Math.round((vw / vh) * 320));
      }

      const canvas = document.createElement('canvas');
      canvas.width = cw;
      canvas.height = ch;
      const ctx = canvas.getContext('2d', { alpha: false });
      if (!ctx) {
        finish(null);
        return;
      }

      const halfW = cw / 2;
      const halfH = ch / 2;

      const seekTo = (time: number): Promise<boolean> => {
        return new Promise((res) => {
          const clamped = Math.max(0, Math.min(safeDur - 0.05, time));
          let done = false;
          const ok = (success: boolean) => {
            if (!done) {
              done = true;
              clearTimeout(t);
              video.onseeked = null;
              res(success);
            }
          };
          const t = setTimeout(() => ok(video.readyState >= 2), 3200);
          video.onseeked = () => ok(video.readyState >= 2);
          try {
            if (typeof (video as any).fastSeek === 'function' && Math.abs(video.currentTime - clamped) > 0.5) {
              (video as any).fastSeek(clamped);
            } else {
              video.currentTime = clamped;
            }
          } catch {
            ok(video.readyState >= 2);
          }
        });
      };

      const run = async () => {
        try {
          const points: Array<{ pct: number; x: number; y: number; label: string }> = [
            { pct: 0.2, x: 0, y: 0, label: '20%' },
            { pct: 0.4, x: halfW, y: 0, label: '40%' },
            { pct: 0.65, x: 0, y: halfH, label: '65%' },
            { pct: 0.85, x: halfW, y: halfH, label: '85%' },
          ];

          let capturedCount = 0;
          for (const pt of points) {
            if (onProgress) onProgress(`Extracting ${pt.label} frame (GPU)...`);
            const targetT = sTime + partDuration * pt.pct;
            const ok = await seekTo(targetT);
            if (ok && video.readyState >= 2) {
              ctx.drawImage(video, pt.x, pt.y, halfW, halfH);
              capturedCount++;
            }
          }

          // If video was unseekable or mostly black, grab a single crisp frame at 15% (or current decoded frame)
          if (capturedCount < 4 || isCanvasMostlyBlack(ctx, cw, ch)) {
            await seekTo(sTime + Math.min(partDuration * 0.15, 4));
            if (video.readyState >= 2) {
              ctx.drawImage(video, 0, 0, cw, ch);
              capturedCount = Math.max(capturedCount, 1);
            }
          } else {
            if (onProgress) onProgress('Stitching 2x2 collage...');
            ctx.strokeStyle = 'rgba(255,255,255,0.22)';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(halfW, 0);
            ctx.lineTo(halfW, ch);
            ctx.moveTo(0, halfH);
            ctx.lineTo(cw, halfH);
            ctx.stroke();
          }

          if (capturedCount === 0) {
            finish(null);
            return;
          }

          canvas.toBlob(
            (blob) => {
              if (blob && blob.size > 0) {
                finish({ blob, duration: fullDuration || partDuration, width: vw, height: vh });
              } else {
                finish(null);
              }
            },
            'image/jpeg',
            0.78,
          );
        } catch (e) {
          console.error('Collage error', e);
          finish(null);
        }
      };

      void run();
    };

    video.onloadedmetadata = startExtraction;
    video.onloadeddata = startExtraction;
    video.onerror = () => finish(null);
  });
};
