import React, { useState, useEffect } from 'react';
import { UploadCloud, X, CheckCircle2, Pause, Play, Ban, AlertTriangle, Info } from 'lucide-react';
import bigInt from 'big-integer';
import { getFileIcon } from './FileIconMapper';
import { Api } from 'telegram';
import type { TelegramClient } from 'telegram';
import { uploadFile } from 'telegram/client/uploads';
import { canFastUpload, fastUploadBigFile, type UploadControl } from '../lib/fastUpload';
import { canHydraUpload, hydraUploadFile } from '../lib/hydraUpload';
import { resolveTelegramEntity } from '../lib/telegramEntity';
import { ensureTelegramConnected } from '../lib/dcSenderPool';
import { TransferSpeedTracker } from '../lib/transferSpeed';
import { buildTelegramCaption } from '../lib/caption';

export interface UploadTask {
  id: string;
  file: File;
  progress: number;
  status: 'pending' | 'processing' | 'uploading' | 'paused' | 'done' | 'cancelled' | 'error';
  statusText: string;
  targetFolderId: string;
  targetFolderPath: string;
  targetChannelId: string;
  speedBps: number;
  totalParts: number;
  viaBot: boolean;
}

const formatSpeed = (bytesPerSecond: number): string => {
  if (bytesPerSecond >= 1024 * 1024) return `${(bytesPerSecond / (1024 * 1024)).toFixed(1)} MB/s`;
  return `${Math.max(1, Math.round(bytesPerSecond / 1024))} KB/s`;
};

interface UploadManagerProps {
  client: TelegramClient | null;
  botClient: TelegramClient | null;
  botId: any | null;
  botUsername: string | null;
  currentFolderId: string;
  currentFolderPath: string;
  currentChannelId: string;
  onUploadComplete: (chanId: string) => void;
  hideMobileTrigger?: boolean;
}

type VideoUploadSupport = 'streamable' | 'conditional' | 'raw-only';

interface UploadWarning {
  file: File;
  support: VideoUploadSupport;
  title: string;
  message: string;
  probe?: 'passed' | 'failed';
}

const VIDEO_EXTENSIONS = new Set([
  'mp4', 'm4v', 'webm', 'mov', '3gp', 'ogv',
  'mkv', 'avi', 'flv', 'wmv', 'asf', 'ts', 'mts', 'm2ts', 'mpg', 'mpeg', 'vob'
]);

const classifyVideoUpload = (file: File): UploadWarning | null => {
  const extension = file.name.split('.').pop()?.toLowerCase() || '';
  const isVideo = file.type.startsWith('video/') || VIDEO_EXTENSIONS.has(extension);
  if (!isVideo) return null;

  if (['mp4', 'm4v'].includes(extension)) {
    return {
      file,
      support: 'streamable',
      title: 'Browser-streamable video',
      message: 'This file will be uploaded as-is. Streaming and external SRT/VTT subtitles are supported when the video uses browser-compatible codecs and Fast Start metadata.'
    };
  }

  if (extension === 'webm') {
    return {
      file,
      support: 'conditional',
      title: 'Browser-dependent video',
      message: 'WebM streaming depends on the browser and codec (VP8/VP9/AV1 with Opus/Vorbis). External SRT/VTT subtitles work only when the browser can play the video.'
    };
  }

  if (['mov', '3gp', 'ogv'].includes(extension)) {
    return {
      file,
      support: 'conditional',
      title: 'Conditional streaming support',
      message: `.${extension} files may stream only with compatible codecs and browsers. External SRT/VTT subtitles are not guaranteed. The original file will still be preserved.`
    };
  }

  return {
    file,
    support: 'raw-only',
    title: 'Raw download only',
    message: `.${extension || 'video'} is not guaranteed to stream in a browser without conversion. It will be uploaded and preserved for download, but external subtitles cannot be guaranteed during playback.`
  };
};

const probeBrowserPlayback = (file: File): Promise<boolean> => new Promise(resolve => {
  const video = document.createElement('video');
  const objectUrl = URL.createObjectURL(file);
  let settled = false;
  const finish = (result: boolean) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(objectUrl);
    resolve(result);
  };
  const timeout = window.setTimeout(() => finish(false), 8000);
  video.preload = 'metadata';
  video.muted = true;
  video.playsInline = true;
  video.onloadedmetadata = () => {
    finish(Number.isFinite(video.duration) && video.duration > 0 && video.videoWidth > 0);
  };
  video.onerror = () => finish(false);
  video.src = objectUrl;
});

class UploadCancelledError extends Error {
  constructor() {
    super('Upload cancelled');
    this.name = 'UploadCancelledError';
  }

}

const getUploadType = (file: File): { type: string, label: string, mime: string, icon: React.ReactNode } => {
  const mime = file.type.toLowerCase() || 'application/octet-stream';
  const ext = file.name.split('.').pop()?.toLowerCase();
  
  const icon = getFileIcon(file.name, mime, "w-5 h-5");
  
  const videoExts = ['mp4', 'mkv', 'webm', 'mov', 'avi', 'flv', 'm4v', 'ts', '3gp', 'wmv', 'asf', 'ogv'];
  if (mime.startsWith('video/') || (ext && videoExts.includes(ext))) {
    const determinedMime = (mime && mime !== 'application/octet-stream') ? mime : (
      ext === 'mkv' ? 'video/x-matroska' :
      ext === 'webm' ? 'video/webm' :
      ext === 'mov' ? 'video/quicktime' :
      ext === 'avi' ? 'video/x-msvideo' :
      ext === 'flv' ? 'video/x-flv' :
      ext === 'ts' ? 'video/mp2t' :
      ext === '3gp' ? 'video/3gpp' :
      ext === 'wmv' ? 'video/x-ms-wmv' :
      ext === 'asf' ? 'video/x-ms-asf' :
      ext === 'ogv' ? 'video/ogg' :
      'video/mp4'
    );
    return { type: 'video', label: 'Video', mime: determinedMime, icon };
  }
  if (mime.startsWith('image/')) return { type: 'image', label: 'Image', mime, icon };
  if (mime.startsWith('audio/')) return { type: 'audio', label: 'Audio', mime, icon };
  if (mime === 'application/pdf' || ext === 'pdf') return { type: 'pdf', label: 'PDF document', mime, icon };
  if (mime.includes('zip') || mime.includes('rar') || mime.includes('7z') || ['zip', 'rar', '7z', 'tar', 'gz'].includes(ext || '')) {
    return { type: 'archive', label: 'Archive', mime, icon };
  }
  if (mime.startsWith('text/') || mime.includes('document') || mime.includes('spreadsheet') || mime.includes('presentation')) {
    return { type: 'document', label: 'Document', mime, icon };
  }
  return { type: 'file', label: 'File', mime, icon };
};

class TaskControl implements UploadControl {
  paused = false;
  cancelled = false;
  private resumeWaiters: (() => void)[] = [];

  async wait(): Promise<void> {
    if (!this.paused || this.cancelled) return;
    await new Promise<void>(resolve => this.resumeWaiters.push(resolve));
  }

  resume() {
    this.paused = false;
    this.resumeWaiters.splice(0).forEach(resolve => resolve());
  }

  cancel() {
    this.cancelled = true;
    this.resume();
  }

  throwIfCancelled() {
    if (this.cancelled) throw new UploadCancelledError();
  }
}

/* ============================================================================
 * COMPONENT: UploadManager
 * Multi-part chunked upload pipeline, video cover generation, and progress tracking.
 * ============================================================================ */
export const UploadManager: React.FC<UploadManagerProps> = ({ client, botClient, botId, botUsername, currentFolderId, currentFolderPath, currentChannelId, onUploadComplete, hideMobileTrigger = false }) => {
  const [tasks, setTasks] = useState<UploadTask[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [pendingUploadFiles, setPendingUploadFiles] = useState<File[] | null>(null);
  const [uploadWarnings, setUploadWarnings] = useState<UploadWarning[]>([]);
  const [isCheckingPlayback, setIsCheckingPlayback] = useState(false);
  const probeRunRef = React.useRef(0);
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const controlsRef = React.useRef(new Map<string, TaskControl>());
  const processingRef = React.useRef(false);
  const speedTrackersRef = React.useRef(new Map<string, TransferSpeedTracker>());

  useEffect(() => {
    window.dispatchEvent(new CustomEvent('zud:transfer-state', { detail: { kind: 'uploads', tasks } }));
  }, [tasks]);

  useEffect(() => {
    const handleAction = (event: Event) => {
      const { type, id } = (event as CustomEvent<{ type: string; id: string }>).detail;
      if (type === 'cancelAll') {
        tasks.forEach(t => {
          if (t.status === 'uploading' || t.status === 'pending' || t.status === 'paused') {
            cancelTask(t);
          }
        });
        return;
      }
      if (type === 'clearAll') {
        tasks.forEach(t => {
          if (t.status === 'uploading' || t.status === 'pending' || t.status === 'paused') {
            cancelTask(t);
          }
        });
        setTasks([]);
        return;
      }
      const task = tasks.find(item => item.id === id);
      if (!task) return;
      if (type === 'remove') {
        if (task.status === 'cancelled' || task.status === 'error' || task.status === 'done') {
          setTasks(current => current.filter(item => item.id !== id));
        }
      } else if (type === 'pause') pauseTask(task);
      else if (type === 'resume') resumeTask(task);
      else if (type === 'cancel') cancelTask(task);
    };
    window.addEventListener('zud:transfer-action', handleAction);
    return () => window.removeEventListener('zud:transfer-action', handleAction);
  }, [tasks]);

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  };

  useEffect(() => {
    const activeTask = [...tasks]
      .filter(t => t.status === 'pending')
      .sort((a, b) => a.file.name.localeCompare(b.file.name, undefined, { sensitivity: 'base', numeric: true }))[0];
    if (activeTask && client && !processingRef.current) {
      processUpload(activeTask);
    }
  }, [tasks, client, botClient, botId, botUsername]);

  useEffect(() => {
    const openPicker = () => fileInputRef.current?.click();
    window.addEventListener('zud:open-upload-picker', openPicker);
    return () => window.removeEventListener('zud:open-upload-picker', openPicker);
  }, []);

  const processUpload = async (task: UploadTask) => {
    if (!client) return;
    if (processingRef.current) return;
    processingRef.current = true;
    const control = controlsRef.current.get(task.id) || new TaskControl();
    controlsRef.current.set(task.id, control);
    
    setTasks(ts => ts.map(t => t.id === task.id ? { ...t, status: 'uploading', statusText: 'Preparing...' } : t));

    try {
      control.throwIfCancelled();
      const file = task.file;
      const CHUNK_SIZE = 999 * 1024 * 1024; // 999MB
      const totalSize = file.size;
      const totalParts = Math.ceil(totalSize / CHUNK_SIZE);
      const uploadType = getUploadType(file);
      const isVideo = uploadType.type === 'video';
      let currentSpeed = 0;
      let probedVideoDuration = 0;
      let probedVideoWidth = 0;
      let probedVideoHeight = 0;
      let probedSubs: any[] = [];

      // Probe the original container once. Probing it inside the part loop
      // repeatedly reads the whole file and made large multipart uploads
      // needlessly expensive and prone to cancellation.
      if (isVideo) {
        try {
          const { probeVideoFile } = await import('../lib/videoProbe');
          const probed = await probeVideoFile(file);
          probedVideoDuration = probed.duration || 0;
          probedVideoWidth = probed.width || 0;
          probedVideoHeight = probed.height || 0;
          probedSubs = probed.subtitleTracks || [];
        } catch (error) {
          console.warn('Video metadata probe failed; continuing without track metadata', error);
        }
      }

      for (let p = 1; p <= totalParts; p++) {
        await control.wait();
        control.throwIfCancelled();
        const startByte = (p - 1) * CHUNK_SIZE;
        const endByte = Math.min(p * CHUNK_SIZE, totalSize);
        const chunk = file.slice(startByte, endByte, file.type);
        // Use native File object since we already sliced it (bypasses memory crash)
        const customFile = new File([chunk], file.name, { type: file.type || "application/octet-stream" });

        let thumbBlob: Blob | undefined;
        let videoDuration = probedVideoDuration;
        let vW = probedVideoWidth;
        let vH = probedVideoHeight;

        if (isVideo) {
          setTasks(ts => ts.map(t => t.id === task.id ? { ...t, statusText: `Preparing video metadata for part ${p}...` } : t));
          
          try {
            setTasks(ts => ts.map(t => t.id === task.id ? { ...t, statusText: `Generating cover for part ${p} of ${totalParts}...` } : t));

            const { generateVideoCollage } = await import('../lib/videoUtils');
            const col = await generateVideoCollage(file, (msg) => {
               setTasks(ts => ts.map(t => t.id === task.id ? { ...t, statusText: msg } : t));
            }, { index: p - 1, total: totalParts });
            if (col) {
              thumbBlob = col.blob;
              if (!videoDuration) videoDuration = col.duration;
              if (!vW) vW = col.width;
              if (!vH) vH = col.height;
            } else {
              setTasks(ts => ts.map(t => t.id === task.id ? { ...t, statusText: `Generating cover via FFmpeg...` } : t));
              
              const targetW = vW > 0 ? vW : 1280;
              const targetH = vH > 0 ? vH : 720;

              const { generateFFmpegThumbnail } = await import('../lib/ffmpeg');
              const ffBlob = await generateFFmpegThumbnail(file, videoDuration, targetW, targetH, (msg) => {
                 setTasks(ts => ts.map(t => t.id === task.id ? { ...t, statusText: msg } : t));
              });
              
              if (ffBlob) {
                thumbBlob = ffBlob;
                if (!vW) vW = targetW;
                if (!vH) vH = targetH;
              } else {
                setTasks(ts => ts.map(t => t.id === task.id ? { ...t, statusText: `Cover generation failed! Uploading without cover...` } : t));
                await new Promise(r => setTimeout(r, 1000));
              }
            }
          } catch (e: any) {
            console.error(e);
            setTasks(ts => ts.map(t => t.id === task.id ? { ...t, statusText: `Cover error: ${e.message ? e.message : 'Unknown'}` } : t));
            await new Promise(r => setTimeout(r, 2000));
          }
        }

        const metaJsonObj: any = {
          n: file.name,
          p: p,
          tp: totalParts,
          t: uploadType.type,
          mime: uploadType.mime,
          pId: task.targetFolderId,
          s: chunk.size,
          ts: totalSize,
        };
        if (isVideo && videoDuration > 0) {
            // Byte-based boundaries are the only safe fallback without
            // demuxing every cluster. Keep the canonical duration and the
            // byte interval so the player can preserve a stable global time.
            metaJsonObj.dur = Math.round(videoDuration * (chunk.size / totalSize) * 100) / 100;
            metaJsonObj.totalDur = Math.round(videoDuration * 100) / 100;
            metaJsonObj.offset = Math.round(videoDuration * (startByte / totalSize) * 100) / 100;
            if (vW > 0 && vH > 0) { metaJsonObj.w = vW; metaJsonObj.h = vH; }
            if (probedSubs.length > 0) metaJsonObj.subs = probedSubs;
        }
        const caption = buildTelegramCaption(file.name, metaJsonObj);

        // Upload manually to bypass gramjs 20MB crash in browser
        setTasks(ts => ts.map(t => t.id === task.id ? { ...t, status: 'uploading', statusText: `Uploading part ${p}/${totalParts} (Media)...` } : t));
        const reportProgress = (progress: number) => {
           const overallProgress = ((p - 1) / totalParts) + (progress / totalParts);
           const now = performance.now();
           const uploadedBytes = totalSize * overallProgress;
           
           let tracker = speedTrackersRef.current.get(task.id);
           if (!tracker) {
             tracker = new TransferSpeedTracker();
             tracker.reset(uploadedBytes);
             speedTrackersRef.current.set(task.id, tracker);
           }
           currentSpeed = tracker.update(uploadedBytes, now);

           setTasks(ts => ts.map(t => t.id === task.id ? { ...t, progress: overallProgress, speedBps: currentSpeed } : t));
        };

        const activeClient = botClient || client;
        if (botClient && botId && currentChannelId !== 'me' && client) {
          try {
            let entityId: any = currentChannelId;
            if (typeof currentChannelId === 'string' && /^-?\d+$/.test(currentChannelId)) {
              entityId = bigInt(currentChannelId);
            }
            const entity = await client.getInputEntity(entityId);
            const botEntity = botUsername ? await client.getInputEntity(botUsername) : botId;
            
            await client.invoke(new Api.channels.InviteToChannel({
               channel: entity,
               users: [botEntity]
            })).catch(() => {});
            await client.invoke(new Api.channels.EditAdmin({
               channel: entity,
               userId: botEntity,
               adminRights: new Api.ChatAdminRights({
                  postMessages: true,
                  editMessages: true,
                  deleteMessages: true,
                  changeInfo: false,
                  inviteUsers: false,
                  pinMessages: false,
                  addAdmins: false,
                  anonymous: false,
                  manageCall: false,
                  manageTopics: false
               }),
               rank: "ZUD SpeedBot"
            })).catch(() => {});

          } catch(e) {}
        }

        let fileHandle: any = undefined;
        await ensureTelegramConnected(activeClient);
        if (canHydraUpload(customFile.size)) {
          try {
            fileHandle = await hydraUploadFile(activeClient, customFile, customFile.name, reportProgress, control as any);
          } catch (hydraErr) {
            control.throwIfCancelled();
            console.warn('Hydra 3-lane upload failed, falling back to fast uploader:', hydraErr);
            fileHandle = undefined;
          }
        }
        if (!fileHandle && canFastUpload(customFile.size)) {
          // Pipelined 512KB parts (upload.saveBigFilePart); falls back to gramJS' uploader on any failure
          try {
            fileHandle = await fastUploadBigFile(activeClient, customFile, customFile.name, reportProgress, control);
          } catch (fastErr) {
            control.throwIfCancelled();
            console.warn('Fast upload failed, falling back to the standard uploader:', fastErr);
            fileHandle = undefined;
          }
        }
        if (!fileHandle) {
          await control.wait();
          control.throwIfCancelled();
          fileHandle = await uploadFile(activeClient, {
            file: customFile,
            workers: 4,
            maxBufferSize: 64 * 1024 * 1024,
            onProgress: reportProgress
          });
        }

        const targetChannel = task.targetChannelId || currentChannelId || 'me';
        const targetPeer = await resolveTelegramEntity(
          activeClient,
          targetChannel,
          activeClient === botClient ? client : null,
        );

        setTasks(ts => ts.map(t => t.id === task.id ? { ...t, statusText: `Finalizing part ${p} metadata...` } : t));
        
        let uploadedThumb: any = undefined;
        let videoCoverPhoto: any = undefined;
        if (thumbBlob) {
             setTasks(ts => ts.map(t => t.id === task.id ? { ...t, statusText: `Uploading cover for part ${p}...` } : t));
             try {
               const thumbCustomFile = new File([thumbBlob], "thumb.jpg", { type: "image/jpeg" });
               uploadedThumb = await hydraUploadFile(activeClient, thumbCustomFile, "thumb.jpg").catch(() =>
                 uploadFile(activeClient, { file: thumbCustomFile, workers: 1 })
               );
               if (isVideo && uploadedThumb) {
                 setTasks(ts => ts.map(t => t.id === task.id ? { ...t, statusText: `Attaching video cover...` } : t));
                 try {
                   const photoMedia = new Api.InputMediaUploadedPhoto({
                     file: uploadedThumb,
                   });
                   const uploadMediaRes = await activeClient.invoke(new Api.messages.UploadMedia({
                     peer: targetPeer,
                     media: photoMedia,
                   }));
                   if (uploadMediaRes instanceof Api.MessageMediaPhoto && uploadMediaRes.photo instanceof Api.Photo) {
                     videoCoverPhoto = new Api.InputPhoto({
                       id: uploadMediaRes.photo.id,
                       accessHash: uploadMediaRes.photo.accessHash,
                       fileReference: uploadMediaRes.photo.fileReference
                     });
                   }
                 } catch (coverErr) {
                   // Non-fatal: `thumb: uploadedThumb` still attaches the document thumbnail cleanly!
                   console.warn('Optional videoCover UploadMedia skipped:', coverErr);
                 }
               }
             } catch (thumbErr) {
               console.warn('Thumbnail upload failed, continuing media send:', thumbErr);
             }
        }

        setTasks(ts => ts.map(t => t.id === task.id ? { ...t, statusText: `Finalizing part ${p} metadata...` } : t));
        
        // Determine accurate MIME type to prevent container mismatch (e.g. MKV with multiple audio/subs)
        const fileExt = file.name.split('.').pop()?.toLowerCase();
        let exactMime = uploadType.mime;
        if (fileExt === 'mkv') exactMime = 'video/x-matroska';
        else if (fileExt === 'webm') exactMime = 'video/webm';
        else if (fileExt === 'mov') exactMime = 'video/quicktime';
        else if (fileExt === 'avi') exactMime = 'video/x-msvideo';
        else if (fileExt === 'flv') exactMime = 'video/x-flv';
        else if (fileExt === 'ts') exactMime = 'video/mp2t';
        else if (fileExt === 'mp4' || fileExt === 'm4v') exactMime = 'video/mp4';
        else if (isVideo && (!exactMime || exactMime === 'application/octet-stream')) exactMime = 'video/mp4';

        const attrs: Api.TypeDocumentAttribute[] = [];
        
        if (isVideo) {
             attrs.push(new Api.DocumentAttributeVideo({
                 duration: Math.max(1, Math.floor((videoDuration || 1) * (chunk.size / totalSize))),
                 w: vW > 0 ? vW : 1280,
                 h: vH > 0 ? vH : 720,
                 supportsStreaming: true
             }));
        }
        // Always include DocumentAttributeFilename to preserve exact filename across all platforms
        attrs.push(new Api.DocumentAttributeFilename({ fileName: file.name }));

        const media = new Api.InputMediaUploadedDocument({
            file: fileHandle,
            mimeType: exactMime || "application/octet-stream",
            attributes: attrs,
            thumb: uploadedThumb,
            videoCover: isVideo ? videoCoverPhoto : undefined,
            forceFile: !isVideo,
        });

        // Send the media directly to the resolved peer
        await activeClient.sendFile(targetPeer, {
          file: media,
          caption: caption,
        });
      }

      setTasks(ts => ts.map(t => t.id === task.id ? { ...t, status: 'done', statusText: 'Completed', progress: 1 } : t));
      onUploadComplete(task.targetChannelId);
    } catch (e: any) {
      if (e instanceof UploadCancelledError || control.cancelled) {
        setTasks(ts => ts.map(t => t.id === task.id ? { ...t, status: 'cancelled', statusText: 'Cancelled' } : t));
      } else {
        setTasks(ts => ts.map(t => t.id === task.id ? { ...t, status: 'error', statusText: 'Upload error: ' + e.message } : t));
      }
    } finally {
      processingRef.current = false;
    }
  };

  const pauseTask = (task: UploadTask) => {
    const control = controlsRef.current.get(task.id);
    if (!control || task.status !== 'uploading') return;
    control.paused = true;
    setTasks(ts => ts.map(t => t.id === task.id ? { ...t, status: 'paused', statusText: 'Paused' } : t));
  };

  const resumeTask = (task: UploadTask) => {
    const control = controlsRef.current.get(task.id);
    if (!control || task.status !== 'paused') return;
    control.resume();
    setTasks(ts => ts.map(t => t.id === task.id ? { ...t, status: 'uploading', statusText: 'Resuming...' } : t));
  };

  const cancelTask = (task: UploadTask) => {
    const control = controlsRef.current.get(task.id);
    if (control) control.cancel();
    else controlsRef.current.set(task.id, Object.assign(new TaskControl(), { cancelled: true }));
    setTasks(ts => ts.map(t => t.id === task.id ? { ...t, status: 'cancelled', statusText: 'Cancelling...' } : t));
  };

  const addFilesToQueue = (files: File[]) => {
    if (!client) return;
    if (files.length === 0) return;

    const newTasks: UploadTask[] = [...files]
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }))
      .map(f => ({
      id: Math.random().toString(36).substr(2, 9),
      file: f,
      progress: 0,
      status: 'pending',
      statusText: 'Waiting in queue...',
      targetFolderId: currentFolderId,
      targetFolderPath: currentFolderPath,
      targetChannelId: currentChannelId,
      speedBps: 0,
      totalParts: Math.ceil(f.size / (999 * 1024 * 1024)) || 1,
      viaBot: !!botClient
      }));

    setTasks(prev => [...prev, ...newTasks]);
  };

  const enqueueFiles = async (files: File[]) => {
    if (!client || files.length === 0) return;
    const initialWarnings = files
      .map(classifyVideoUpload)
      .filter((warning): warning is UploadWarning => warning !== null);
    if (initialWarnings.length > 0) {
      const probeRun = ++probeRunRef.current;
      setPendingUploadFiles(files);
      setIsCheckingPlayback(true);
      setUploadWarnings(initialWarnings.map(warning => ({
        ...warning,
        title: 'Checking browser playback...',
        message: 'Testing whether this browser can read the video metadata. The original file will not be modified.'
      })));
      try {
        const probedWarnings = await Promise.all(initialWarnings.map(async warning => {
          const passed = await probeBrowserPlayback(warning.file);
          if (passed) {
            return {
              ...warning,
              support: 'streamable' as const,
              probe: 'passed' as const,
              title: 'Playable in this browser',
              message: 'This browser can read the video metadata. The original file will be uploaded unchanged and external SRT/VTT subtitles can be used when playback continues successfully.'
            };
          }
          return {
            ...warning,
            support: 'raw-only' as const,
            probe: 'failed' as const,
            title: 'Playback check failed - raw download only',
            message: 'This browser could not read the video metadata within the verification window. The original file can still be uploaded unchanged, but browser streaming and external subtitles are not guaranteed.'
          };
        }));
        if (probeRun === probeRunRef.current) setUploadWarnings(probedWarnings);
      } finally {
        if (probeRun === probeRunRef.current) setIsCheckingPlayback(false);
      }
      return;
    }
    addFilesToQueue(files);
  };

  const confirmUpload = () => {
    if (!pendingUploadFiles || isCheckingPlayback) return;
    const files = pendingUploadFiles;
    setPendingUploadFiles(null);
    setUploadWarnings([]);
    addFilesToQueue(files);
  };

  const cancelUploadConfirmation = () => {
    probeRunRef.current++;
    setPendingUploadFiles(null);
    setUploadWarnings([]);
    setIsCheckingPlayback(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    enqueueFiles(Array.from(e.dataTransfer.files));
  };

  const handleFileSelection = (e: React.ChangeEvent<HTMLInputElement>) => {
    enqueueFiles(Array.from(e.target.files || []));
    e.target.value = '';
  };

  useEffect(() => {
    const handleWindowDragEnter = (e: DragEvent) => {
      e.preventDefault();
      if (e.dataTransfer?.types.includes('Files')) {
        setIsDragging(true);
      }
    };
    const handleWindowDragOver = (e: DragEvent) => e.preventDefault();
    const handleWindowDrop = (e: DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
    };
    
    window.addEventListener('dragenter', handleWindowDragEnter);
    window.addEventListener('dragover', handleWindowDragOver);
    window.addEventListener('drop', handleWindowDrop);
    
    return () => {
      window.removeEventListener('dragenter', handleWindowDragEnter);
      window.removeEventListener('dragover', handleWindowDragOver);
      window.removeEventListener('drop', handleWindowDrop);
    };
  }, []);

  return (
    <>
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={handleFileSelection}
      />
      {!hideMobileTrigger && <button
        type="button"
        onClick={() => fileInputRef.current?.click()}
        disabled={!client}
        className="fixed bottom-5 left-5 z-[80] sm:hidden flex items-center gap-2 rounded-full bg-blue-600 px-4 py-3 text-sm font-semibold text-white shadow-xl shadow-blue-950/30 transition hover:bg-blue-500 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
        aria-label="Upload files"
      >
        <UploadCloud className="h-5 w-5" />
        Upload
      </button>}
      {isDragging && (
        <div 
          className="fixed inset-0 z-[100] bg-blue-500/20 backdrop-blur-sm border-4 border-blue-500 border-dashed flex items-center justify-center animate-in fade-in duration-200"
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          <div className="bg-white dark:bg-[#1c1c1e] p-8 rounded-3xl shadow-2xl flex flex-col items-center animate-in zoom-in-95 duration-300">
            <UploadCloud className="w-20 h-20 text-blue-500 mb-4 animate-bounce" />
            <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Drop files here</h2>
            <p className="text-gray-500 mt-2">to upload directly into the current folder</p>
          </div>
        </div>
      )}

      {pendingUploadFiles && (
        <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="upload-support-title"
            className="w-full max-w-2xl overflow-hidden rounded-3xl border border-white/10 bg-white shadow-2xl dark:bg-[#17181c]"
          >
            <div className="border-b border-gray-200 bg-gradient-to-r from-blue-600 to-indigo-600 p-5 text-white dark:border-white/10">
              <div className="flex items-start gap-3">
                <div className="rounded-2xl bg-white/15 p-2.5">
                  <UploadCloud className="h-6 w-6" />
                </div>
                <div className="min-w-0">
                  <h2 id="upload-support-title" className="text-lg font-bold">Review video compatibility</h2>
                  <p className="mt-1 text-sm text-blue-100">
                    Please review the streaming limitations before uploading.
                  </p>
                </div>
              </div>
            </div>

            <div className="max-h-[55vh] space-y-3 overflow-y-auto p-5">
              {uploadWarnings.map(warning => (
                <div
                  key={`${warning.file.name}-${warning.file.size}-${warning.file.lastModified}`}
                  className={`rounded-2xl border p-4 ${
                    warning.support === 'raw-only'
                      ? 'border-amber-300/60 bg-amber-50 dark:border-amber-500/30 dark:bg-amber-950/20'
                      : 'border-blue-200 bg-blue-50 dark:border-blue-500/30 dark:bg-blue-950/20'
                  }`}
                >
                  <div className="flex items-start gap-3">
                    <div className={`mt-0.5 rounded-xl p-2 ${
                      warning.support === 'raw-only'
                        ? 'bg-amber-500/15 text-amber-600 dark:text-amber-300'
                        : 'bg-blue-500/15 text-blue-600 dark:text-blue-300'
                    }`}>
                      {warning.support === 'raw-only' ? <AlertTriangle className="h-5 w-5" /> : <Info className="h-5 w-5" />}
                    </div>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="break-all text-sm font-bold text-gray-900 dark:text-gray-100">{warning.file.name}</h3>
                        <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${
                          warning.support === 'raw-only'
                            ? 'bg-amber-500/15 text-amber-700 dark:text-amber-300'
                            : 'bg-blue-500/15 text-blue-700 dark:text-blue-300'
                        }`}>
                          {warning.title}
                        </span>
                      </div>
                      <p className="mt-2 text-xs leading-5 text-gray-600 dark:text-gray-300">{warning.message}</p>
                    </div>
                  </div>
                </div>
              ))}
              <p className="rounded-2xl border border-gray-200 bg-gray-50 p-4 text-xs leading-5 text-gray-600 dark:border-white/10 dark:bg-white/5 dark:text-gray-300">
                The original file will be uploaded without changing its bytes. Large files may be stored as multiple Telegram parts. Confirm only if you accept the streaming limitations listed above.
              </p>
            </div>

            <div className="flex flex-col-reverse gap-3 border-t border-gray-200 bg-gray-50 p-5 sm:flex-row sm:justify-end dark:border-white/10 dark:bg-white/[0.03]">
              <button
                type="button"
                onClick={cancelUploadConfirmation}
                className="rounded-xl border border-gray-300 px-4 py-2.5 text-sm font-semibold text-gray-700 transition hover:bg-gray-100 dark:border-white/15 dark:text-gray-200 dark:hover:bg-white/10"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={confirmUpload}
                disabled={isCheckingPlayback}
                className="rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white shadow-lg shadow-blue-600/20 transition hover:bg-blue-500 active:scale-[0.98] disabled:cursor-wait disabled:opacity-60"
              >
                {isCheckingPlayback ? 'Checking playback...' : 'I understand, upload files'}
              </button>
            </div>
          </div>
        </div>
      )}

      {tasks.length > 0 && (
        <div className="hidden">
          <div className="p-4 bg-gray-50 dark:bg-gray-800/50 border-b border-gray-200 dark:border-gray-800 flex items-center justify-between">
            <h3 className="font-semibold text-gray-900 dark:text-gray-100 flex items-center gap-2">
              <UploadCloud className="w-5 h-5 text-blue-500" />
              Upload Manager ({tasks.filter(t => t.status === 'done').length}/{tasks.length})
            </h3>
            <button 
              onClick={() => setTasks(ts => ts.filter(t => !['done', 'error', 'cancelled'].includes(t.status)))}
              className="p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {tasks.map(task => (
              <div key={task.id} className="p-3 h-[5.75rem] bg-white dark:bg-[#1c1c1e] rounded-xl hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors group relative overflow-hidden mb-2 border border-gray-100 dark:border-gray-800">
                <div className="absolute inset-0 bg-blue-50 dark:bg-blue-900/10 w-full transform transition-transform duration-300" style={{ transform: `translateX(${(task.progress * 100) - 100}%)` }} />
                {task.totalParts > 1 && Array.from({ length: task.totalParts - 1 }).map((_, i) => (
                  <div key={i} className="absolute top-0 bottom-0 w-px bg-white/60 dark:bg-black/60 z-10" style={{ left: `${((i + 1) / task.totalParts) * 100}%` }} />
                ))}
                <div className="relative z-20 flex items-start gap-3">
                  <div className="p-2 bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 rounded-lg shrink-0">
                    {getUploadType(task.file).icon}
                  </div>
                  <div className="flex-1 min-w-0">
                    <h4 className="manager-file-title text-sm font-medium text-gray-900 dark:text-gray-100" dir="auto"><span>{task.file.name}</span></h4>
                    <div className="flex min-w-0 items-center gap-2 mt-1">
                      <span className="min-w-0 flex-1 truncate text-xs text-gray-500 dark:text-gray-400">{task.statusText}</span>
                      {task.status === 'uploading' && (
                        <>
                          <span className="text-xs font-semibold text-blue-500">{Math.round(task.progress * 100)}%</span>
                          {task.speedBps > 0 && <span className="text-xs font-semibold text-emerald-500">{formatSpeed(task.speedBps)}</span>}
                        </>
                      )}
                      {task.viaBot && (
                        <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 uppercase tracking-wider ml-auto whitespace-nowrap">Speed Bot</span>
                      )}
                    </div>
                  </div>
                  <div className="shrink-0 flex items-center h-9">
                    {task.status === 'uploading' || task.status === 'paused' ? (
                      <div className="flex items-center gap-1">
                        {task.status === 'uploading' ? (
                          <button onClick={() => pauseTask(task)} className="p-1 text-amber-500 hover:text-amber-400" title="Pause upload" aria-label="Pause upload"><Pause className="w-4 h-4" /></button>
                        ) : (
                          <button onClick={() => resumeTask(task)} className="p-1 text-blue-500 hover:text-blue-400" title="Resume upload" aria-label="Resume upload"><Play className="w-4 h-4" /></button>
                        )}
                        <button onClick={() => cancelTask(task)} className="p-1 text-red-500 hover:text-red-400" title="Cancel upload" aria-label="Cancel upload"><Ban className="w-4 h-4" /></button>
                      </div>
                    ) : task.status === 'pending' ? (
                      <button onClick={() => cancelTask(task)} className="p-1 text-red-500 hover:text-red-400" title="Cancel queued upload" aria-label="Cancel queued upload">
                        <Ban className="w-4 h-4" />
                      </button>
                    ) : task.status === 'done' ? (
                      <CheckCircle2 className="w-5 h-5 text-green-500" />
                    ) : task.status === 'error' ? (
                      <X className="w-5 h-5 text-red-500" />
                    ) : null}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
};