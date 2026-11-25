import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile } from '@ffmpeg/util';

let ffmpeg: FFmpeg | null = null;

/* ============================================================================
 * ZERO-VPN FFMPEG WASM LOADER & COVER EXTRACTOR
 * ============================================================================ */
export const loadFFmpeg = async (onProgress?: (p: number) => void): Promise<FFmpeg> => {
  if (ffmpeg) return ffmpeg;
  
  const instance = new FFmpeg();
  
  if (onProgress) {
    instance.on('progress', ({ progress }) => {
       onProgress(progress);
    });
  }
  
  try {
    const base = typeof window !== 'undefined' ? `${window.location.origin}/api/ffmpeg` : '';
    if (base) {
      await instance.load({
        coreURL: `${base}/ffmpeg-core.js`,
        wasmURL: `${base}/ffmpeg-core.wasm`,
      });
    } else {
      await instance.load();
    }
  } catch {
    await instance.load();
  }
  
  ffmpeg = instance;
  return ffmpeg;
};

export const generateFFmpegThumbnail = async (file: File, duration: number = 10, vw: number, vh: number, onProgress?: (msg: string) => void): Promise<Blob | null> => {
  try {
    const ff = await loadFFmpeg();
    ff.on('progress', ({ progress }) => {
      if (onProgress) onProgress(`FFmpeg Processing... ${Math.round(progress * 100)}%`);
    });
    
    if (onProgress) onProgress('Loading video into FFmpeg memory...');
    const ext = (file.name.split('.').pop() || 'mp4').toLowerCase().replace(/[^a-z0-9]/g, '') || 'mp4';
    const inputName = `input_video.${ext}`;
    
    // Prevent OOM browser crash on large 1-4GB MKV/AVI/MOV files: read up to 24MB head slice for cover extraction
    const isLargeFile = file.size > 48 * 1024 * 1024;
    const sampleBlob = isLargeFile ? file.slice(0, 24 * 1024 * 1024) : file;
    await ff.writeFile(inputName, await fetchFile(sampleBlob));
    
    if (onProgress) onProgress(`Extracting frames and generating cover...`);
    const dur = duration > 0 ? duration : 10;
    
    // For head-sliced large files, seek near the start (1s..5s) where frames are guaranteed in the 24MB slice!
    const t20 = isLargeFile ? '1.00' : (dur * 0.20).toFixed(2);
    const t40 = isLargeFile ? '2.50' : (dur * 0.40).toFixed(2);
    const t60 = isLargeFile ? '4.00' : (dur * 0.60).toFixed(2);
    const t80 = isLargeFile ? '5.50' : (dur * 0.80).toFixed(2);

    // Calculate proper dimensions (Max 320px)
    let cw, ch;
    if (vw > vh) {
        cw = 320;
        ch = Math.round((vh / vw) * 320);
    } else {
        ch = 320;
        cw = Math.round((vw / vh) * 320);
    }
    // Make them even numbers for FFmpeg
    cw = cw % 2 !== 0 ? cw + 1 : cw;
    ch = ch % 2 !== 0 ? ch + 1 : ch;
    
    const hw = cw / 2;
    const hh = ch / 2;

    // Extract frames sequentially to prevent memory crashes in FFmpeg Wasm
    const extractSingleFrame = async (timeSec: string, targetW: number, targetH: number, outName: string): Promise<Blob | null> => {
      try {
        await ff.exec([
          '-ss', timeSec,
          '-i', inputName,
          '-frames:v', '1',
          '-vf', `scale=${targetW}:${targetH}`,
          '-q:v', '4',
          outName
        ]);
        const data = await ff.readFile(outName);
        await ff.deleteFile(outName).catch(() => {});
        return new Blob([data as any], { type: 'image/jpeg' });
      } catch (err) {
        console.warn(`Frame at ${timeSec}s failed:`, err);
        return null;
      }
    };

    // Helper to load Blob into HTMLImageElement
    const loadImage = (blob: Blob): Promise<HTMLImageElement> => {
      return new Promise((resolve, reject) => {
        const img = new Image();
        const url = URL.createObjectURL(blob);
        img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
        img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Img load failed")); };
        img.src = url;
      });
    };

    // Try extracting 4 frames for 2x2 collage
    if (onProgress) onProgress(`Extracting multi-point frames...`);
    const blob1 = await extractSingleFrame(t20, hw, hh, 'f1.jpg');
    const blob2 = await extractSingleFrame(t40, hw, hh, 'f2.jpg');
    const blob3 = await extractSingleFrame(t60, hw, hh, 'f3.jpg');
    const blob4 = await extractSingleFrame(t80, hw, hh, 'f4.jpg');

    if (blob1 && blob2 && blob3 && blob4) {
      try {
        if (onProgress) onProgress(`Stitching collage...`);
        const [img1, img2, img3, img4] = await Promise.all([
          loadImage(blob1),
          loadImage(blob2),
          loadImage(blob3),
          loadImage(blob4)
        ]);

        const canvas = document.createElement('canvas');
        canvas.width = cw;
        canvas.height = ch;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.drawImage(img1, 0, 0, hw, hh);
          ctx.drawImage(img2, hw, 0, hw, hh);
          ctx.drawImage(img3, 0, hh, hw, hh);
          ctx.drawImage(img4, hw, hh, hw, hh);

          // Subtle divider line
          ctx.strokeStyle = 'rgba(255,255,255,0.2)';
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(hw, 0); ctx.lineTo(hw, ch);
          ctx.moveTo(0, hh); ctx.lineTo(cw, hh);
          ctx.stroke();

          const collageBlob = await new Promise<Blob | null>(res => canvas.toBlob(res, 'image/jpeg', 0.8));
          await ff.deleteFile(inputName).catch(() => {});
          if (collageBlob) return collageBlob;
        }
      } catch (stitchErr) {
        console.warn("Canvas collage stitching failed:", stitchErr);
      }
    }

    // Fallback: high quality single frame (try 1s then 0s so truncated/short streams ALWAYS produce a frame)
    if (onProgress) onProgress(`Generating single frame cover...`);
    const fallbackTime = isLargeFile ? '1.00' : (dur > 20 ? dur * 0.25 : dur * 0.1).toFixed(2);
    let singleBlob = await extractSingleFrame(fallbackTime, cw, ch, 'single.jpg');
    if (!singleBlob) {
      singleBlob = await extractSingleFrame('0.00', cw, ch, 'single0.jpg');
    }
    await ff.deleteFile(inputName).catch(() => {});
    return singleBlob;
  } catch (error) {
    console.error("FFmpeg thumbnail generation failed:", error);
    return null;
  }
};

/**
 * Extracts an embedded subtitle track to SRT text using FFmpeg Wasm.
 */
/* ============================================================================
 * SUBTITLE EXTRACTION & MP4 REMUX UTILITIES
 * ============================================================================ */
export const extractEmbeddedSubtitle = async (
  videoBlob: Blob,
  subtitleStreamIndex: number = 0,
  onProgress?: (msg: string) => void
): Promise<string | null> => {
  try {
    const ff = await loadFFmpeg();
    const inputName = 'sub_input.tmp';
    const outputName = 'output.srt';

    if (onProgress) onProgress('Loading video for subtitle extraction...');
    await ff.writeFile(inputName, await fetchFile(videoBlob));

    if (onProgress) onProgress('Extracting subtitle track...');
    await ff.exec([
      '-i', inputName,
      '-map', `0:s:${subtitleStreamIndex}`,
      '-c:s', 'copy',
      outputName
    ]);

    const data = await ff.readFile(outputName);
    await ff.deleteFile(inputName).catch(() => {});
    await ff.deleteFile(outputName).catch(() => {});

    if (typeof data === 'string') return data;
    return new TextDecoder('utf-8').decode(data);
  } catch (err) {
    console.warn("Subtitle extraction error:", err);
    return null;
  }
};

/**
 * Remuxes MKV/unsupported video container to standard MP4 with fast stream copying (-c copy).
 * Completes in seconds without heavy CPU re-encoding.
 */
export const remuxToBrowserMp4 = async (
  videoBlob: Blob,
  audioTrackIndex: number = 0,
  onProgress?: (msg: string) => void
): Promise<Blob | null> => {
  try {
    const ff = await loadFFmpeg();
    const inputName = 'remux_in.mkv';
    const outputName = 'remux_out.mp4';

    if (onProgress) onProgress('Loading video into memory...');
    await ff.writeFile(inputName, await fetchFile(videoBlob));

    if (onProgress) onProgress('Remuxing video & selected audio track to MP4...');
    // Fast stream copy: -c copy -movflags +faststart
    try {
      await ff.exec([
        '-i', inputName,
        '-map', '0:v:0',
        '-map', `0:a:${audioTrackIndex}?`,
        '-c', 'copy',
        '-movflags', '+faststart',
        outputName
      ]);
    } catch {
      // Fallback: copy video and transcode audio to AAC if audio codec is not MP4 compatible
      await ff.exec([
        '-i', inputName,
        '-map', '0:v:0',
        '-map', `0:a:${audioTrackIndex}?`,
        '-c:v', 'copy',
        '-c:a', 'aac',
        '-movflags', '+faststart',
        outputName
      ]);
    }

    const data = await ff.readFile(outputName);
    await ff.deleteFile(inputName).catch(() => {});
    await ff.deleteFile(outputName).catch(() => {});

    return new Blob([data as any], { type: 'video/mp4' });
  } catch (err) {
    console.error("Remux error:", err);
    return null;
  }
};
