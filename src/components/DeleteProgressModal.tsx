import React, { useState, useEffect, useRef } from 'react';
import { Trash2, CheckCircle2, Clock, Loader2, Folder, File, ShieldAlert, X, Search } from 'lucide-react';
import { Api } from 'telegram';
import type { TelegramClient } from 'telegram';
import { resolveTelegramEntity } from '../lib/telegramEntity';
import type { VirtualFile, VirtualFolder } from '../lib/vfs';

export interface DeleteModalItem {
  type: 'file' | 'folder';
  item: any;
}

export interface DeleteProgressModalProps {
  isOpen: boolean;
  items: DeleteModalItem[];
  client: TelegramClient | null;
  onClose: () => void;
  onComplete: (affectedChannels: Set<string>, deletedChannels?: Set<string>) => void;
}

interface FlatDeleteTask {
  id: string;
  name: string;
  type: 'file' | 'folder' | 'channel';
  channelMsgMap: Record<string, number[]>;
  channelToDelete?: string;
}

const getFloodWaitSeconds = (err: any): number => {
  if (err && typeof err.seconds === 'number' && err.seconds > 0) return err.seconds;
  const msg = String(err?.message || err?.errorMessage || '');
  const match = msg.match(/FLOOD_WAIT_(\d+)/i);
  if (match) return parseInt(match[1], 10);
  return 0;
};

const channelKey = (channel: any): string => {
  if (!channel) return 'me';
  if (typeof channel === 'object') {
    return String(channel.id ?? channel.channelId ?? channel.userId ?? 'me');
  }
  return String(channel);
};

/* ============================================================================
 * COMPONENT: DeleteProgressModal
 * Recursive batch deletion confirmation and progress dialog with flood protection.
 * ============================================================================ */
export const DeleteProgressModal: React.FC<DeleteProgressModalProps> = ({
  isOpen,
  items,
  client,
  onClose,
  onComplete,
}) => {
  const [phase, setPhase] = useState<'confirm' | 'deleting' | 'completed'>('confirm');
  const [currentSubPhase, setCurrentSubPhase] = useState<'locating' | 'deleting'>('locating');
  const [statusText, setStatusText] = useState('');
  const [currentProgress, setCurrentProgress] = useState(0);
  const [tasks, setTasks] = useState<FlatDeleteTask[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [currentTaskName, setCurrentTaskName] = useState('');
  const [floodWaitSeconds, setFloodWaitSeconds] = useState<number | null>(null);
  const [hasRootChannel, setHasRootChannel] = useState(false);
  const [isClosing, setIsClosing] = useState(false);
  const isCancelledRef = useRef(false);

  const handleClose = () => {
    isCancelledRef.current = true;
    setIsClosing(true);
    setTimeout(() => {
      onClose();
      setIsClosing(false);
    }, 200);
  };

  useEffect(() => {
    if (!isOpen || items.length === 0) return;
    setPhase('confirm');
    setCurrentIndex(0);
    setCurrentTaskName('');
    setFloodWaitSeconds(null);
    isCancelledRef.current = false;

    const flattened: FlatDeleteTask[] = [];
    let rootChannelFound = false;

    const extractItems = (item: any, type: 'file' | 'folder') => {
      if (type === 'file') {
        const file = item as VirtualFile;
        const channelMsgMap: Record<string, number[]> = {};
        (file.parts || []).forEach(p => {
          const chan = channelKey(p.channelId);
          if (!channelMsgMap[chan]) channelMsgMap[chan] = [];
          channelMsgMap[chan].push(p.messageId);
        });
        flattened.push({
          id: file.id,
          name: file.name,
          type: 'file',
          channelMsgMap,
        });
      } else {
        const folder = item as VirtualFolder;
        if (folder.channelId && String(folder.channelId) === String(folder.id)) {
          rootChannelFound = true;
          flattened.push({
            id: folder.id,
            name: folder.name,
            type: 'channel',
            channelMsgMap: {},
            channelToDelete: String(folder.channelId),
          });
        } else {
          if (folder.folders) {
            Object.values(folder.folders).forEach(sub => extractItems(sub, 'folder'));
          }
          if (folder.files) {
            folder.files.forEach(f => extractItems(f, 'file'));
          }
          if (folder.msgId && folder.channelId) {
            const chan = channelKey(folder.channelId);
            flattened.push({
              id: folder.id,
              name: folder.name,
              type: 'folder',
              channelMsgMap: { [chan]: [folder.msgId] },
            });
          }
        }
      }
    };

    items.forEach(i => extractItems(i.item, i.type));
    setTasks(flattened);
    setHasRootChannel(rootChannelFound);
  }, [isOpen, items]);

  if (!isOpen || tasks.length === 0) return null;

  const startDeletion = async () => {
    if (!client) return;
    setPhase('deleting');
    setCurrentProgress(0);

    const affectedChannels = new Set<string>();
    const deletedChannels = new Set<string>();

    for (let i = 0; i < tasks.length; i++) {
      if (isCancelledRef.current) break;

      const task = tasks[i];
      setCurrentIndex(i);
      setCurrentTaskName(task.name);

      setCurrentSubPhase('locating');
      setStatusText(`Locating target messages ${i + 1} of ${tasks.length} ("${task.name}")...`);
      setCurrentProgress(Math.min(95, Math.round(((i + 0.35) / tasks.length) * 100)));
      await new Promise(r => setTimeout(r, 40));

      // Handle channel deletion
      if (task.type === 'channel' && task.channelToDelete) {
        affectedChannels.add(task.channelToDelete);
        deletedChannels.add(task.channelToDelete);
        setCurrentSubPhase('deleting');
        setStatusText(`Deleting channel ${i + 1} of ${tasks.length} ("${task.name}")...`);
        let channelDone = false;
        while (!channelDone && !isCancelledRef.current) {
          try {
            const peer = await resolveTelegramEntity(client, task.channelToDelete);
            await client.invoke(new Api.channels.DeleteChannel({ channel: peer }));
            channelDone = true;
          } catch (err: any) {
            const waitSec = getFloodWaitSeconds(err);
            if (waitSec > 0) {
              setFloodWaitSeconds(waitSec);
              for (let s = waitSec; s > 0; s--) {
                if (isCancelledRef.current) break;
                setFloodWaitSeconds(s);
                await new Promise(r => setTimeout(r, 1000));
              }
              setFloodWaitSeconds(null);
            } else {
              console.error(`Error deleting channel ${task.name}:`, err);
              channelDone = true; // Skip non-flood error
            }
          }
        }
      }

      // Handle message deletion across channels
      for (const [chanId, msgIds] of Object.entries(task.channelMsgMap)) {
        if (isCancelledRef.current) break;
        affectedChannels.add(chanId);

        setCurrentSubPhase('deleting');
        setStatusText(`Deleting messages for "${task.name}" (${i + 1}/${tasks.length})...`);
        const chunkSize = 100;
        for (let c = 0; c < msgIds.length; c += chunkSize) {
          if (isCancelledRef.current) break;
          const chunk = msgIds.slice(c, c + chunkSize);
          let chunkDone = false;

          while (!chunkDone && !isCancelledRef.current) {
            try {
              if (chanId === 'me') {
                await client.invoke(new Api.messages.DeleteMessages({ id: chunk, revoke: true }));
              } else {
                const peer = await resolveTelegramEntity(client, chanId);
                await client.invoke(new Api.channels.DeleteMessages({ channel: peer, id: chunk }));
              }
              chunkDone = true;
            } catch (err: any) {
              const waitSec = getFloodWaitSeconds(err);
              if (waitSec > 0) {
                setFloodWaitSeconds(waitSec);
                for (let s = waitSec; s > 0; s--) {
                  if (isCancelledRef.current) break;
                  setFloodWaitSeconds(s);
                  await new Promise(r => setTimeout(r, 1000));
                }
                setFloodWaitSeconds(null);
              } else {
                console.error(`Error deleting messages in channel ${chanId}:`, err);
                chunkDone = true; // Skip non-flood error
              }
            }
          }
        }
      }

      setCurrentProgress(Math.round(((i + 1) / tasks.length) * 100));
      // Small pacing delay to avoid tight loop
      await new Promise(r => setTimeout(r, 60));
    }

    setCurrentIndex(tasks.length);
    setCurrentProgress(100);
    setPhase('completed');
    onComplete(affectedChannels, deletedChannels);
    setTimeout(() => {
      handleClose();
    }, 2800);
  };

  const progressPercent = currentProgress;

  if (phase === 'confirm') {
    return (
      <div 
        className="fixed inset-0 z-[120] flex items-center justify-center p-3 sm:p-4 bg-black/65 backdrop-blur-md animate-in fade-in duration-200"
        aria-label="Delete Confirmation"
      >
        <div className="bg-white/95 dark:bg-[#18191f]/95 backdrop-blur-2xl text-gray-900 dark:text-gray-100 rounded-3xl shadow-2xl overflow-hidden border border-gray-200/80 dark:border-white/10 ring-1 ring-black/5 dark:ring-white/5 w-full max-w-md animate-in zoom-in-95 duration-200">
          <div className="p-5">
            <div className="flex items-start justify-between gap-3 mb-3.5">
              <div className="flex items-center gap-3">
                <div className="p-2.5 bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400 rounded-xl shrink-0">
                  <Trash2 className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-base font-bold text-gray-900 dark:text-gray-100">
                    Delete {items.length} {items.length === 1 ? 'Item' : 'Items'}
                  </h3>
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                    Sequential cloud deletion
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={handleClose}
                className="rounded-lg p-1.5 text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
                aria-label="Close"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {hasRootChannel && (
              <div className="mb-3.5 p-3 bg-red-500/10 border border-red-500/30 rounded-xl flex items-start gap-2.5">
                <ShieldAlert className="w-4 h-4 text-red-500 shrink-0 mt-0.5" />
                <p className="text-xs text-red-700 dark:text-red-300 leading-relaxed font-medium">
                  Warning: A selected item is a root folder (Telegram Channel). Deleting it will permanently remove the channel and all its data.
                </p>
              </div>
            )}

            <p className="text-xs text-gray-600 dark:text-gray-300">
              Are you sure you want to permanently delete these items?
            </p>

            {/* Items preview list */}
            <div className="mt-3 max-h-32 overflow-y-auto space-y-1.5 p-2 bg-gray-50 dark:bg-gray-800/40 rounded-xl border border-gray-100 dark:border-gray-800">
              {items.slice(0, 8).map((it, idx) => (
                <div key={idx} className="flex items-center gap-2 text-xs text-gray-700 dark:text-gray-300 truncate">
                  {it.type === 'folder' ? <Folder className="w-3.5 h-3.5 text-blue-500 shrink-0" /> : <File className="w-3.5 h-3.5 text-gray-400 shrink-0" />}
                  <span className="truncate">{it.item.name}</span>
                </div>
              ))}
              {items.length > 8 && (
                <div className="text-[11px] text-gray-400 italic pt-0.5 pl-1">
                  ...and {items.length - 8} more items
                </div>
              )}
            </div>
          </div>

          <div className="px-5 py-3 bg-gray-50 dark:bg-gray-800/20 border-t border-gray-100 dark:border-gray-800 flex justify-end gap-2.5">
            <button
              type="button"
              onClick={handleClose}
              className="px-3.5 py-1.5 text-xs font-semibold text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700/50 rounded-xl transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={startDeletion}
              className="px-4 py-1.5 text-xs font-semibold bg-red-600 hover:bg-red-500 active:scale-95 text-white rounded-xl transition-all shadow-md shadow-red-950/20 flex items-center gap-1.5"
            >
              <Trash2 className="w-3.5 h-3.5" />
              Delete
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Deleting & Completed Phase: Docked smoothly at bottom-safe zone above mobile footer and non-colliding
  return (
    <div 
      className={`fixed z-[100] left-3 right-3 bottom-[calc(4.75rem+env(safe-area-inset-bottom,0px))] sm:left-auto sm:right-6 sm:bottom-6 sm:w-96 pointer-events-auto gpu-fast transition-all duration-300 ease-out select-none ${
        isClosing 
          ? 'opacity-0 translate-y-4 scale-95 pointer-events-none' 
          : 'animate-in fade-in slide-in-from-bottom-4 duration-300'
      }`}
      aria-label="Delete Notification"
    >
      <div className="bg-white/95 dark:bg-[#18191f]/95 backdrop-blur-2xl text-gray-900 dark:text-gray-100 rounded-2xl shadow-2xl overflow-hidden border border-gray-200/80 dark:border-white/10 ring-1 ring-black/5 dark:ring-white/5">
        
        {/* Phase 2: Deleting Progress & FloodWait Alert */}
        {phase === 'deleting' && (
          <div className="p-4 sm:p-5">
            <div className="flex items-start justify-between mb-3 gap-2">
              <div className="flex items-center gap-3 min-w-0 flex-1">
                <div className={`p-2 rounded-xl shrink-0 ${currentSubPhase === 'locating' ? 'bg-amber-500/15 text-amber-500' : 'bg-red-500/15 text-red-500'}`}>
                  {currentSubPhase === 'locating' ? (
                    <Search className="w-4 h-4 animate-pulse" />
                  ) : (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <h3 className="text-sm font-bold text-gray-900 dark:text-gray-100 truncate">
                    {currentSubPhase === 'locating' ? 'Locating Items' : 'Deleting Items'} ({currentIndex + 1}/{tasks.length})
                  </h3>
                  <p className="text-[11px] text-gray-500 dark:text-gray-400 truncate mt-0.5">
                    {statusText || currentTaskName || 'Processing...'}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <span className="text-xs font-mono font-bold text-red-600 dark:text-red-400 bg-red-500/10 px-2 py-0.5 rounded-md tabular-nums">
                  {progressPercent}%
                </span>
                <button
                  type="button"
                  onClick={handleClose}
                  className="rounded-lg p-1 text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-black/5 dark:hover:bg-white/10 transition-colors"
                  aria-label="Stop and Close"
                  title="Stop deletion"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>

            {/* Progress Bar */}
            <div className="w-full bg-gray-100 dark:bg-white/10 rounded-full h-1.5 overflow-hidden mb-2">
              <div
                className="bg-gradient-to-r from-amber-500 to-red-500 h-1.5 rounded-full transition-all duration-300 ease-out"
                style={{ width: `${Math.max(3, progressPercent)}%` }}
              />
            </div>

            {/* Telegram FloodWait Warning Banner */}
            {floodWaitSeconds !== null ? (
              <div className="p-3 bg-amber-500/10 border border-amber-500/30 rounded-xl flex items-start gap-2.5 animate-in fade-in zoom-in-95 duration-200">
                <Clock className="w-4 h-4 text-amber-500 shrink-0 mt-0.5 animate-pulse" />
                <div className="min-w-0 flex-1">
                  <h4 className="text-xs font-bold text-amber-800 dark:text-amber-300">
                    Telegram Rate Limit (FloodWait)
                  </h4>
                  <p className="text-[11px] text-amber-700/90 dark:text-amber-400/90 mt-0.5 leading-relaxed">
                    Telegram servers temporarily rate-limited requests due to high speed.
                  </p>
                  <div className="mt-2 flex items-center gap-2">
                    <span className="text-[11px] font-medium text-amber-800 dark:text-amber-200">
                      Automatic retry in:
                    </span>
                    <span className="text-xs font-black text-amber-600 dark:text-amber-400 bg-amber-500/20 px-2 py-0.5 rounded-md tabular-nums font-mono">
                      {floodWaitSeconds}s
                    </span>
                  </div>
                </div>
              </div>
            ) : (
              <div className="flex items-center justify-between text-[10px] text-gray-400 dark:text-gray-500">
                <span>{currentSubPhase === 'locating' ? 'Locating from Cloud...' : 'Removing messages...'}</span>
                <span className="font-mono">{currentIndex + 1} / {tasks.length} items</span>
              </div>
            )}
          </div>
        )}

        {/* Phase 3: Completion View with Done Button */}
        {phase === 'completed' && (
          <div className="p-4 sm:p-5 text-center animate-in fade-in zoom-in-95 duration-200">
            <div className="w-10 h-10 bg-emerald-100 dark:bg-emerald-900/30 text-emerald-600 dark:text-emerald-400 rounded-full flex items-center justify-center mx-auto mb-2 shadow-lg shadow-emerald-500/10">
              <CheckCircle2 className="w-6 h-6" />
            </div>

            <h3 className="text-sm font-bold text-gray-900 dark:text-gray-100 mb-0.5">
              Deletion Completed
            </h3>
            <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
              Successfully removed {tasks.length} {tasks.length === 1 ? 'item' : 'items'} from cloud.
            </p>

            <button
              type="button"
              onClick={handleClose}
              className="w-full py-2 px-4 bg-emerald-600 hover:bg-emerald-500 active:scale-95 text-white font-semibold text-xs rounded-xl transition-all shadow-md shadow-emerald-950/20 flex items-center justify-center gap-1.5"
            >
              <CheckCircle2 className="w-3.5 h-3.5" />
              <span>Done</span>
            </button>
          </div>
        )}

      </div>
    </div>
  );
};
