
export interface ProbedAudioTrack {
  index: number;
  trackNum: number;
  codec: string;
  language: string;
  label: string;
}

export interface ProbedSubtitleTrack {
  index: number;
  trackNum: number;
  codec: string;
  language: string;
  label: string;
}

export interface VideoMetadata {
  duration: number;
  width: number;
  height: number;
  audioTracks: ProbedAudioTrack[];
  subtitleTracks: ProbedSubtitleTrack[];
}

function readVint(view: DataView, offset: number): { val: number; len: number } | null {
  if (offset >= view.byteLength) return null;
  const b = view.getUint8(offset);
  let mask = 0x80;
  let len = 1;
  while (len <= 8 && !(b & mask)) {
    mask >>= 1;
    len++;
  }
  if (len > 8 || offset + len > view.byteLength) return null;
  let val = b & (mask - 1);
  for (let i = 1; i < len; i++) {
    val = (val * 256) + view.getUint8(offset + i);
  }
  return { val, len };
}

function readEbmlId(view: DataView, offset: number): { id: number; len: number } | null {
  if (offset >= view.byteLength) return null;
  const b = view.getUint8(offset);
  let mask = 0x80;
  let len = 1;
  while (len <= 4 && !(b & mask)) {
    mask >>= 1;
    len++;
  }
  if (len > 4 || offset + len > view.byteLength) return null;
  let id = 0;
  for (let i = 0; i < len; i++) {
    id = (id * 256) + view.getUint8(offset + i);
  }
  return { id, len };
}

function readString(view: DataView, offset: number, length: number): string {
  const bytes = new Uint8Array(view.buffer, view.byteOffset + offset, Math.min(length, view.byteLength - offset));
  try {
    return new TextDecoder('utf-8').decode(bytes).replace(/\0/g, '').trim();
  } catch {
    return '';
  }
}

function readUint(view: DataView, offset: number, length: number): number {
  if (length <= 0 || offset < 0 || offset + length > view.byteLength) return 0;
  let val = 0;
  for (let i = 0; i < length; i++) {
    val = (val * 256) + view.getUint8(offset + i);
  }
  return val;
}

function readFloat(view: DataView, offset: number, length: number): number {
  if (length === 4) return view.getFloat32(offset, false);
  if (length === 8) return view.getFloat64(offset, false);
  return 0;
}

export function probeEbmlMetadata(buffer: ArrayBuffer): VideoMetadata | null {
  const view = new DataView(buffer);
  let pos = 0;
  let duration = 0;
  let width = 0;
  let height = 0;
  let timecodeScale = 1000000;
  const audioTracks: ProbedAudioTrack[] = [];
  const subtitleTracks: ProbedSubtitleTrack[] = [];

  while (pos < view.byteLength - 4) {
    const el = readEbmlId(view, pos);
    if (!el) break;
    pos += el.len;
    const sz = readVint(view, pos);
    if (!sz) break;
    pos += sz.len;

    const start = pos;
    const end = Math.min(view.byteLength, pos + sz.val);

    if (el.id === 0x18538067) {
      let sPos = start;
      while (sPos < end - 4) {
        const sub = readEbmlId(view, sPos);
        if (!sub) break;
        sPos += sub.len;
        const subSz = readVint(view, sPos);
        if (!subSz) break;
        sPos += subSz.len;
        const subStart = sPos;
        const subEnd = Math.min(end, sPos + subSz.val);

        if (sub.id === 0x1549A966) {
          let ip = subStart;
          while (ip < subEnd - 2) {
            const ie = readEbmlId(view, ip);
            if (!ie) break;
            ip += ie.len;
            const isz = readVint(view, ip);
            if (!isz) break;
            ip += isz.len;

            if (ie.id === 0x2AD7B1) {
              timecodeScale = readUint(view, ip, isz.val);
            } else if (ie.id === 0x4489) {
              duration = readFloat(view, ip, isz.val);
            }
            ip += isz.val;
          }
        }
        else if (sub.id === 0x1654AE6B) {
          let tp = subStart;
          while (tp < subEnd - 2) {
            const te = readEbmlId(view, tp);
            if (!te) break;
            tp += te.len;
            const tsz = readVint(view, tp);
            if (!tsz) break;
            tp += tsz.len;

            if (te.id === 0xAE) {
              let trkP = tp;
              const trkEnd = Math.min(subEnd, tp + tsz.val);
              let trkType = 0;
              let trkCodec = '';
              let trkLang = 'und';
              let trkName = '';
              let trkNum = 0;
              let w = 0;
              let h = 0;

              while (trkP < trkEnd - 2) {
                const fe = readEbmlId(view, trkP);
                if (!fe) break;
                trkP += fe.len;
                const fsz = readVint(view, trkP);
                if (!fsz) break;
                trkP += fsz.len;

                if (fe.id === 0xD7) trkNum = readUint(view, trkP, fsz.val);
                else if (fe.id === 0x83) trkType = readUint(view, trkP, fsz.val);
                else if (fe.id === 0x86) trkCodec = readString(view, trkP, fsz.val);
                else if (fe.id === 0x22B59C) trkLang = readString(view, trkP, fsz.val);
                else if (fe.id === 0x536E) trkName = readString(view, trkP, fsz.val);
                else if (fe.id === 0xE0) {
                  let vp = trkP;
                  const vend = trkP + fsz.val;
                  while (vp < vend - 2) {
                    const ve = readEbmlId(view, vp);
                    if (!ve) break;
                    vp += ve.len;
                    const vsz = readVint(view, vp);
                    if (!vsz) break;
                    vp += vsz.len;
                    if (ve.id === 0xB0) w = readUint(view, vp, vsz.val);
                    else if (ve.id === 0xBA) h = readUint(view, vp, vsz.val);
                    else if (ve.id === 0x54B0 && !w) w = readUint(view, vp, vsz.val);
                    else if (ve.id === 0x54BA && !h) h = readUint(view, vp, vsz.val);
                    vp += vsz.val;
                  }
                }
                if (fsz.val > trkEnd - trkP) {
                  trkP = trkEnd;
                  break;
                }
                trkP += fsz.val;
              }

              if (trkType === 1 && !width) {
                width = w;
                height = h;
              } else if (trkType === 2) {
                const langLabel = trkLang !== 'und' ? ` (${trkLang.toUpperCase()})` : '';
                audioTracks.push({
                  index: audioTracks.length,
                  trackNum: trkNum || audioTracks.length + 1,
                  codec: trkCodec,
                  language: trkLang,
                  label: trkName ? `${trkName}${langLabel}` : `Audio Track ${audioTracks.length + 1}${langLabel}`
                });
              } else if (trkType === 17) { // Subtitle Track
                const langLabel = trkLang !== 'und' ? ` (${trkLang.toUpperCase()})` : '';
                subtitleTracks.push({
                  index: subtitleTracks.length,
                  trackNum: trkNum || subtitleTracks.length + 1,
                  codec: trkCodec,
                  language: trkLang,
                  label: trkName ? `${trkName}${langLabel}` : `Subtitle ${subtitleTracks.length + 1}${langLabel}`
                });
              }
            }
            tp += tsz.val;
          }
        }
        sPos += subSz.val;
      }
      duration = (duration * timecodeScale) / 1e9;
      break;
    } else {
      pos += sz.val;
    }
  }

  if (duration > 0 || (width > 0 && height > 0)) {
    return {
      duration: Math.round(duration * 100) / 100,
      width,
      height,
      audioTracks,
      subtitleTracks
    };
  }
  return null;
}

/**
 * Universal video metadata prober for any File or Blob.
 * Tries fast binary header parsing first, then falls back to HTML5 <video> tag.
 */
export async function probeVideoFile(file: File | Blob): Promise<VideoMetadata> {
  const isMkvOrWebm = (file as File).name?.toLowerCase().endsWith('.mkv') || 
                      (file as File).name?.toLowerCase().endsWith('.webm') ||
                      file.type?.includes('matroska') ||
                      file.type?.includes('webm');

  // Try EBML parsing on the first 512KB - 2MB
  if (isMkvOrWebm || !file.type || file.type === 'application/octet-stream') {
    try {
      const sliceSize = Math.min(file.size, 2 * 1024 * 1024);
      const buffer = await file.slice(0, sliceSize).arrayBuffer();
      const probed = probeEbmlMetadata(buffer);
      if (probed && probed.duration > 0 && probed.width > 0) {
        return probed;
      }
    } catch (err) {
      console.warn("EBML probe failed, trying HTML5 fallback:", err);
    }
  }

  // HTML5 <video> metadata extractor fallback (for MP4, MOV, WebM natively supported by browser)
  const html5Meta = await new Promise<{ duration: number; width: number; height: number }>((resolve) => {
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.playsInline = true;
    video.muted = true;
    const url = URL.createObjectURL(file);
    video.src = url;

    const timer = setTimeout(() => {
      URL.revokeObjectURL(url);
      resolve({ duration: 0, width: 0, height: 0 });
    }, 3000);

    video.onloadedmetadata = () => {
      clearTimeout(timer);
      const d = video.duration && !isNaN(video.duration) ? video.duration : 0;
      const w = video.videoWidth || 0;
      const h = video.videoHeight || 0;
      URL.revokeObjectURL(url);
      resolve({ duration: d, width: w, height: h });
    };

    video.onerror = () => {
      clearTimeout(timer);
      URL.revokeObjectURL(url);
      resolve({ duration: 0, width: 0, height: 0 });
    };
  });

  return {
    duration: html5Meta.duration,
    width: html5Meta.width,
    height: html5Meta.height,
    audioTracks: [],
    subtitleTracks: []
  };
}
