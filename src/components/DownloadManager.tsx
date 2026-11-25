import React, { useState, useEffect, useRef } from 'react';
import { Download, X, Play, Pause, Ban, CheckCircle2 } from 'lucide-react';
import { getFileIcon } from './FileIconMapper';
import { Api } from 'telegram';
import type { TelegramClient } from 'telegram';
import type { VirtualFile, VirtualFolder } from '../lib/vfs';
import { startOPFSDownload, DownloadControl } from '../lib/opfsDownload';
import { downloadFolderAsZip, collectFolderFiles } from '../lib/folderZip';
import { resolveTelegramEntity } from '../lib/telegramEntity';
import { TransferSpeedTracker } from '../lib/transferSpeed';

export interface DownloadTask {
  id: string;
  file: VirtualFile;
  totalSize: number;
  downloadedSize: number;
  progress: number;
  speedBps: number;
  status: 'downloading' | 'completed' | 'error' | 'paused' | 'cancelled';
  statusText: string;
  control: DownloadControl;
  totalParts: number;
  viaBot: boolean;
}

export interface DownloadManagerProps {
  client: TelegramClient | null;
  botClient: TelegramClient | null;
  botId: any | null;
  botUsername: string | null;
}

/* ============================================================================
 * COMPONENT: DownloadManager
 * Multi-part direct-to-disk OPFS downloader with 4-way concurrency.
 * ============================================================================ */
export const DownloadManager: React.FC<DownloadManagerProps> = ({ client, botClient, botId, botUsername }) => {
  const [tasks, setTasks] = useState<DownloadTask[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  
  const progressHistoryRef = useRef<Record<string, { bytes: number, time: number }>>({});
  const speedTrackersRef = useRef(new Map<string, TransferSpeedTracker>());

  useEffect(() => {
    window.dispatchEvent(new CustomEvent('zud:transfer-state', { detail: { kind: 'downloads', tasks } }));
  }, [tasks]);

  useEffect(() => {
    const handleAction = (event: Event) => {
      const { type, id } = (event as CustomEvent<{ type: string; id: string }>).detail;
      if (type === 'cancelAll') {
        tasks.forEach(t => {
          if (t.status === 'downloading' || t.status === 'paused') {
            cancelTask(t);
          }
        });
        return;
      }
      if (type === 'clearAll') {
        tasks.forEach(t => {
          if (t.status === 'downloading' || t.status === 'paused') {
            cancelTask(t);
          }
        });
        setTasks([]);
        return;
      }
      const task = tasks.find(item => item.id === id);
      if (!task) return;
      if (type === 'remove') {
        if (task.status === 'cancelled' || task.status === 'error' || task.status === 'completed') {
          setTasks(current => current.filter(item => item.id !== id));
        }
      } else if (type === 'pause') pauseTask(task);
      else if (type === 'resume') resumeTask(task);
      else if (type === 'cancel') cancelTask(task);
    };
    window.addEventListener('zud:transfer-action', handleAction);
    return () => window.removeEventListener('zud:transfer-action', handleAction);
  }, [tasks]);

  useEffect(() => {
    const handleStartDownload = async (e: any) => {
      if (!client) return;
      const item: any = e.detail;
      if (!item) return;

      const isFolder = !!item.folders || (!item.parts && !item.mimeType);

      if (isFolder) {
        const folder = item as VirtualFolder;
        const { files: folderFiles } = collectFolderFiles(folder);
        const totalFolderSize = folderFiles.reduce((sum, f) => sum + (f.file.size || 0), 0);
        const zipFileName = `${(folder.name || 'CloudFolder').replace(/[\\/:*?"<>|]/g, '_')}.zip`;

        const control = new DownloadControl();
        const virtualZipFile: VirtualFile = {
          id: folder.id,
          name: zipFileName,
          path: folder.path || '',
          mimeType: 'application/zip',
          size: totalFolderSize,
          parts: [],
          isComplete: true,
        };

        const newTask: DownloadTask = {
          id: folder.id,
          file: virtualZipFile,
          totalSize: totalFolderSize,
          downloadedSize: 0,
          progress: 0,
          speedBps: 0,
          status: 'downloading',
          statusText: 'Preparing ZIP...',
          control,
          totalParts: folderFiles.length || 1,
          viaBot: !!botClient,
        };

        setTasks(current => {
          if (current.find(t => t.id === folder.id)) return current;
          if (!isOpen) setIsOpen(true);
          return [newTask, ...current];
        });

        progressHistoryRef.current[folder.id] = { bytes: 0, time: Date.now() };

        try {
          const activeClient = botClient || client;
          await downloadFolderAsZip(
            folder,
            activeClient,
            control,
            (received, total, statusText) => {
              setTasks(currentTasks => {
                return currentTasks.map(t => {
                  if (t.id === folder.id && t.status !== 'cancelled') {
                    const newProgress = total > 0 ? Math.min(received / total, 1) : 0;
                    const now = performance.now();
                    let tracker = speedTrackersRef.current.get(folder.id);
                    if (!tracker) {
                      tracker = new TransferSpeedTracker();
                      tracker.reset(received);
                      speedTrackersRef.current.set(folder.id, tracker);
                    }
                    const speedBps = tracker.update(received, now);

                    return {
                      ...t,
                      downloadedSize: received,
                      progress: newProgress,
                      speedBps,
                      statusText: statusText || 'Zipping folder...',
                    };
                  }
                  return t;
                });
              });
            },
            activeClient === botClient ? client : null
          );

          if (!control.cancelled) {
            setTasks(currentTasks => currentTasks.map(t => 
              t.id === folder.id ? { ...t, status: 'completed', statusText: 'Completed', progress: 1, downloadedSize: t.totalSize } : t
            ));
          }
        } catch (err: any) {
          if (err?.message === 'CANCELLED') return;
          console.error("Folder ZIP download failed:", err);
          setTasks(currentTasks => currentTasks.map(t => 
            t.id === folder.id ? { ...t, status: 'error', statusText: 'Error' } : t
          ));
        }
        return;
      }

      const file: VirtualFile = item;
      const control = new DownloadControl();

      const newTask: DownloadTask = {
        id: file.id,
        file,
        totalSize: file.size,
        downloadedSize: 0,
        progress: 0,
        speedBps: 0,
        status: 'downloading',
        statusText: 'Starting...',
        control,
        totalParts: file.parts.length || 1,
        viaBot: !!botClient,
      };

      setTasks(current => {
        if (current.find(t => t.id === file.id)) return current;
        if (!isOpen) setIsOpen(true);
        return [newTask, ...current];
      });
      
      progressHistoryRef.current[file.id] = { bytes: 0, time: Date.now() };

      try {
        const activeClient = botClient || client;
        if (botClient && botId && client) {
          try {
             const uniqueChannels = [...new Set(file.parts.map(p => p.channelId).filter(Boolean))];
             for (const channelId of uniqueChannels) {
               if (String(channelId) === 'me') continue;
               try {
                 const entity = await resolveTelegramEntity(client, channelId);
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
               } catch (e) {}
             }
          } catch(e) {}
        }
        await startOPFSDownload(file, activeClient, control, (received, total) => {
          setTasks(currentTasks => {
            return currentTasks.map(t => {
              if (t.id === file.id && t.status !== 'cancelled') {
                const newProgress = Math.min(received / total, 1);
                
                const now = performance.now();
                let tracker = speedTrackersRef.current.get(file.id);
                if (!tracker) {
                  tracker = new TransferSpeedTracker();
                  tracker.reset(received);
                  speedTrackersRef.current.set(file.id, tracker);
                }
                const speedBps = tracker.update(received, now);

                return {
                  ...t,
                  downloadedSize: received,
                  progress: newProgress,
                  speedBps,
                  statusText: 'Downloading...'
                };
              }
              return t;
            });
          });
        }, activeClient === botClient ? client : null);

        if (!control.cancelled) {
          setTasks(currentTasks => currentTasks.map(t => 
            t.id === file.id ? { ...t, status: 'completed', statusText: 'Completed', progress: 1, downloadedSize: t.totalSize } : t
          ));
        }
      } catch (err: any) {
        if (err.message === 'CANCELLED') return;
        console.error("Download failed:", err);
        setTasks(currentTasks => currentTasks.map(t => 
          t.id === file.id ? { ...t, status: 'error', statusText: 'Error' } : t
        ));
      }
    };

    window.addEventListener('startBackgroundDownload', handleStartDownload);
    window.addEventListener('startFolderZipDownload', handleStartDownload);
    return () => {
      window.removeEventListener('startBackgroundDownload', handleStartDownload);
      window.removeEventListener('startFolderZipDownload', handleStartDownload);
    };
  }, [isOpen, client, botClient, botId, botUsername]);

  const pauseTask = (task: DownloadTask) => {
    task.control.pause();
    setTasks(ts => ts.map(t => t.id === task.id ? { ...t, status: 'paused', statusText: 'Paused', speedBps: 0 } : t));
  };

  const resumeTask = (task: DownloadTask) => {
    task.control.resume();
    progressHistoryRef.current[task.id] = { bytes: task.downloadedSize, time: Date.now() };
    setTasks(ts => ts.map(t => t.id === task.id ? { ...t, status: 'downloading', statusText: 'Downloading...' } : t));
  };

  const cancelTask = (task: DownloadTask) => {
    task.control.cancel();
    setTasks(ts => ts.map(t => t.id === task.id ? { ...t, status: 'cancelled', statusText: 'Cancelled', speedBps: 0 } : t));
  };
  
  const formatSpeed = (bps: number) => {
    if (!bps) return '';
    const k = 1024, sizes = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
    const i = Math.floor(Math.log(bps) / Math.log(k));
    return parseFloat((bps / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  const activeTasksCount = tasks.filter(t => t.status === 'downloading' || t.status === 'paused').length;

  return (
    <>
      {/* Floating Toggle Button */}
      {(tasks.length > 0) && (
        <button
          onClick={() => setIsOpen(true)}
          className="hidden"
        >
          {activeTasksCount > 0 ? (
            <Download className="w-5 h-5 animate-bounce" />
          ) : (
            <CheckCircle2 className="w-5 h-5" />
          )}
          <span className="hidden sm:inline">
            {activeTasksCount > 0 ? `${activeTasksCount} Downloading` : 'Downloads Complete'}
          </span>
        </button>
      )}

      {/* Slide-up Panel (matching UploadManager exactly) */}
      {isOpen && (
        <>
          <div className="fixed inset-0 z-[100] bg-black/20 sm:hidden" onClick={() => setIsOpen(false)} />
          
          <div className="hidden">
            {/* Header */}
            <div className="p-4 bg-gray-50 dark:bg-gray-800/50 border-b border-gray-200 dark:border-gray-800 flex items-center justify-between">
              <h3 className="font-semibold text-gray-900 dark:text-gray-100 flex items-center gap-2">
                <Download className="w-5 h-5 text-[#9A2227]" />
                Download Manager ({tasks.filter(t => t.status === 'completed').length}/{tasks.length})
              </h3>
              <button 
                onClick={() => {
                  setTasks(ts => ts.filter(t => !['completed', 'error', 'cancelled'].includes(t.status)));
                  setIsOpen(false);
                }}
                className="p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* List */}
            <div className="min-h-0 flex-1 overflow-y-auto p-2">
              {tasks.length === 0 ? (
                <div className="h-32 flex flex-col items-center justify-center text-gray-400 gap-2">
                  <Download className="w-8 h-8 opacity-50" />
                  <span className="text-sm font-medium">No active downloads</span>
                </div>
              ) : (
                tasks.map(task => (
                  <div key={task.id} className="p-3 h-[5.75rem] bg-white dark:bg-[#1c1c1e] rounded-xl hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors group relative overflow-hidden mb-2 border border-gray-100 dark:border-gray-800">
                    <div className="absolute inset-0 bg-[#9A2227]/10 dark:bg-[#9A2227]/20 w-full transform transition-transform duration-300" style={{ transform: `translateX(${(task.progress * 100) - 100}%)` }} />
                    {task.totalParts > 1 && Array.from({ length: task.totalParts - 1 }).map((_, i) => (
                      <div key={i} className="absolute top-0 bottom-0 w-px bg-white/60 dark:bg-black/60 z-10" style={{ left: `${((i + 1) / task.totalParts) * 100}%` }} />
                    ))}
                    <div className="relative z-20 flex items-start gap-3">
                      <div className="p-2 bg-[#9A2227]/10 text-[#9A2227] rounded-lg shrink-0">
                        {getFileIcon(task.file.name, task.file.mimeType, "w-5 h-5")}
                      </div>
                      <div className="flex-1 min-w-0">
                        <h4 className="manager-file-title text-sm font-medium text-gray-900 dark:text-gray-100" dir="auto"><span>{task.file.name}</span></h4>
                        <div className="flex min-w-0 items-center gap-2 mt-1">
                          <span className="min-w-0 flex-1 truncate text-xs text-gray-500 dark:text-gray-400">{task.statusText}</span>
                          {(task.status === 'downloading' || task.status === 'paused') && (
                            <>
                              <span className="text-xs font-semibold text-[#9A2227]">{Math.round(task.progress * 100)}%</span>
                              {task.speedBps > 0 && <span className="text-xs font-semibold text-emerald-500">{formatSpeed(task.speedBps)}</span>}
                            </>
                          )}
                          {task.viaBot && (
                            <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-600 dark:text-amber-500 uppercase tracking-wider ml-auto whitespace-nowrap">Speed Bot</span>
                          )}
                        </div>
                      </div>
                      <div className="shrink-0 flex items-center h-9">
                        {task.status === 'downloading' || task.status === 'paused' ? (
                          <div className="flex items-center gap-1">
                            {task.status === 'downloading' ? (
                              <button onClick={() => pauseTask(task)} className="p-1 text-amber-500 hover:text-amber-400" title="Pause download"><Pause className="w-4 h-4" /></button>
                            ) : (
                              <button onClick={() => resumeTask(task)} className="p-1 text-blue-500 hover:text-blue-400" title="Resume download"><Play className="w-4 h-4" /></button>
                            )}
                            <button onClick={() => cancelTask(task)} className="p-1 text-red-500 hover:text-red-400" title="Cancel download"><Ban className="w-4 h-4" /></button>
                          </div>
                        ) : (
                          <div className="flex items-center gap-1 text-gray-400">
                            {task.status === 'completed' && <CheckCircle2 className="w-4 h-4 text-green-500" />}
                            {task.status === 'error' && <Ban className="w-4 h-4 text-red-500" />}
                            {task.status === 'cancelled' && <X className="w-4 h-4" />}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </>
      )}
    </>
  );
};
