import React, { useEffect, useMemo, useState } from 'react';
import { ArrowDownToLine, ArrowUpFromLine, CheckCircle2, Download, Pause, Play, X, Ban } from 'lucide-react';
import type { DownloadTask } from './DownloadManager';
import type { UploadTask } from './UploadManager';

type TransferTab = 'downloads' | 'uploads';
type TransferAction = { type: 'pause' | 'resume' | 'cancel' | 'remove' | 'cancelAll' | 'clearAll'; id: string };

const formatSpeed = (bps: number) => {
  if (!bps) return '0 KB/s';
  if (bps >= 1024 * 1024) return `${(bps / (1024 * 1024)).toFixed(1)} MB/s`;
  return `${Math.max(1, Math.round(bps / 1024))} KB/s`;
};

const dispatchAction = (action: TransferAction) => {
  window.dispatchEvent(new CustomEvent<TransferAction>('zud:transfer-action', { detail: action }));
};

/* ============================================================================
 * COMPONENT: TransferCenter
 * Floating drawer monitoring concurrent upload and download progress and controls.
 * ============================================================================ */
export const TransferCenter: React.FC<{ hidden?: boolean }> = ({ hidden = false }) => {
  const [uploads, setUploads] = useState<UploadTask[]>([]);
  const [downloads, setDownloads] = useState<DownloadTask[]>([]);
  const [open, setOpen] = useState(false);
  const [isClosing, setIsClosing] = useState(false);
  const [tab, setTab] = useState<TransferTab>('downloads');

  useEffect(() => {
    const onState = (event: Event) => {
      const detail = (event as CustomEvent<{ kind: TransferTab; tasks: UploadTask[] | DownloadTask[] }>).detail;
      if (detail.kind === 'uploads') setUploads(detail.tasks as UploadTask[]);
      else setDownloads(detail.tasks as DownloadTask[]);
      if (detail.tasks.length > 0) {
        setIsClosing(false);
        setOpen(true);
        setTab(current => current);
      }
    };
    window.addEventListener('zud:transfer-state', onState);
    return () => window.removeEventListener('zud:transfer-state', onState);
  }, []);

  const visibleTasks = tab === 'uploads' ? uploads : downloads;
  const hasUploads = uploads.length > 0;
  const hasDownloads = downloads.length > 0;
  const allTasks = useMemo(() => [...uploads, ...downloads], [uploads, downloads]);
  const activeCount = useMemo(
    () => allTasks.filter(task => ['uploading', 'downloading', 'pending'].includes(task.status)).length,
    [allTasks]
  );
  const isFinishedOrStopped = allTasks.length > 0 && activeCount === 0;
  const allSucceeded = allTasks.length > 0 && allTasks.every(t => t.status === 'done' || t.status === 'completed');

  useEffect(() => {
    if (!hasUploads && hasDownloads) setTab('downloads');
    if (!hasDownloads && hasUploads) setTab('uploads');
  }, [hasUploads, hasDownloads]);

  const handleStopAll = () => {
    dispatchAction({ type: 'cancelAll', id: '' });
  };

  const handleClose = () => {
    setIsClosing(true);
    setTimeout(() => {
      setOpen(false);
      setIsClosing(false);
    }, 200);
  };

  const handleDone = () => {
    setIsClosing(true);
    setTimeout(() => {
      dispatchAction({ type: 'clearAll', id: '' });
      setUploads([]);
      setDownloads([]);
      setOpen(false);
      setIsClosing(false);
    }, 200);
  };

  if (hidden || (!hasUploads && !hasDownloads)) return null;

  return (
    <section className={`transfer-center ${open && !isClosing ? 'transfer-center--open' : ''}`} aria-label="Transfer Center">
      <button 
        className="transfer-center__compact" 
        onClick={() => {
          if (open) handleClose();
          else {
            setIsClosing(false);
            setOpen(true);
          }
        }} 
        aria-expanded={open}
      >
        <span className="flex items-center gap-2">
          {activeCount > 0 ? <ArrowUpFromLine className="h-4 w-4 animate-pulse text-blue-500" /> : <CheckCircle2 className="h-4 w-4 text-emerald-500" />}
          <span>Transfer Center</span>
        </span>
        <span className="text-xs opacity-75">{activeCount > 0 ? `${activeCount} active` : 'Done'}</span>
      </button>
      {(open || isClosing) && (
        <div className={`transfer-center__panel ${isClosing ? 'transfer-center__panel--exit' : 'transfer-center__panel--enter'}`}>
          <header className="transfer-center__header">
            <div>
              <p className="text-sm font-bold">Transfer Center</p>
              <p className="text-[11px] opacity-60">Live upload and download activity</p>
            </div>
            <div className="flex items-center gap-1.5">
              {activeCount > 0 && (
                <button
                  onClick={handleStopAll}
                  className="flex items-center gap-1 px-2 py-1 text-xs font-semibold text-amber-600 dark:text-amber-400 hover:bg-amber-500/10 rounded-md transition-colors"
                  title="Stop all ongoing transfers"
                >
                  <Ban className="h-3.5 w-3.5" />
                  <span>Stop All</span>
                </button>
              )}
              <button onClick={handleClose} className="rounded-lg p-1.5 opacity-70 hover:opacity-100" aria-label="Minimize transfer center"><X className="h-4 w-4" /></button>
            </div>
          </header>

          {/* Success / Finished Banner with Done button */}
          {isFinishedOrStopped && (
            <div className="p-3 bg-emerald-500/10 dark:bg-emerald-500/15 border-b border-emerald-500/20 flex items-center justify-between gap-3 animate-in fade-in duration-200">
              <div className="flex items-center gap-2.5 min-w-0">
                <div className="p-1.5 rounded-full bg-emerald-500/20 text-emerald-600 dark:text-emerald-400 shrink-0">
                  <CheckCircle2 className="h-4 w-4" />
                </div>
                <div className="min-w-0">
                  <p className="text-xs font-bold text-gray-900 dark:text-gray-100 truncate">
                    {allSucceeded ? 'Transfers completed successfully!' : 'Transfers stopped / finished'}
                  </p>
                  <p className="text-[10px] text-gray-500 dark:text-gray-400">
                    {allTasks.length} {allTasks.length === 1 ? 'task' : 'tasks'} recorded
                  </p>
                </div>
              </div>
              <button
                onClick={handleDone}
                className="px-3 py-1 bg-emerald-600 hover:bg-emerald-500 active:scale-95 text-white font-bold text-xs rounded-lg transition-all shadow-sm shrink-0 flex items-center gap-1"
                aria-label="Done"
              >
                <CheckCircle2 className="h-3.5 w-3.5" />
                <span>Done</span>
              </button>
            </div>
          )}

          <nav className="transfer-center__tabs" aria-label="Transfer type">
            {hasDownloads && <button className={tab === 'downloads' ? 'is-active' : ''} onClick={() => setTab('downloads')}><Download className="h-4 w-4" /> Downloads <span>{downloads.length}</span></button>}
            {hasUploads && <button className={tab === 'uploads' ? 'is-active' : ''} onClick={() => setTab('uploads')}><ArrowUpFromLine className="h-4 w-4" /> Uploads <span>{uploads.length}</span></button>}
          </nav>
          <div className="transfer-center__list transfer-center__list--switch" key={tab}>
            {visibleTasks.map(task => {
              const upload = tab === 'uploads';
              const status = task.status;
              const active = upload ? status === 'uploading' || status === 'paused' : status === 'downloading' || status === 'paused';
              const id = task.id;
              const title = upload ? (task as UploadTask).file.name : (task as DownloadTask).file.name;
              return (
                <article className="transfer-center__item" key={id}>
                  <div className="transfer-center__progress" style={{ transform: `translateX(${(task.progress * 100) - 100}%)` }} />
                  <div className="relative z-10 flex min-w-0 items-start gap-2.5">
                    <div className="rounded-lg bg-black/5 p-2 dark:bg-white/5">{upload ? <ArrowUpFromLine className="h-4 w-4 text-blue-500" /> : <ArrowDownToLine className="h-4 w-4 text-[#9A2227]" />}</div>
                    <div className="min-w-0 flex-1">
                      <h4 className="manager-file-title text-xs font-semibold" title={title}><span>{title}</span></h4>
                      <div className="mt-1 flex min-w-0 items-center gap-2 text-[11px] opacity-70">
                        <span className="min-w-0 flex-1 truncate">{task.statusText}</span>
                        {active && <><span className="shrink-0">{Math.round(task.progress * 100)}%</span><span className="shrink-0 font-semibold text-emerald-500">{formatSpeed(task.speedBps)}</span></>}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-0.5">
                      {active && <button onClick={() => dispatchAction({ type: status === 'paused' ? 'resume' : 'pause', id })} className="p-1.5" aria-label={status === 'paused' ? 'Resume' : 'Pause'}>{status === 'paused' ? <Play className="h-4 w-4 text-blue-500" /> : <Pause className="h-4 w-4 text-amber-500" />}</button>}
                      {active && <button onClick={() => dispatchAction({ type: 'cancel', id })} className="p-1.5" aria-label="Cancel"><Ban className="h-4 w-4 text-red-500" /></button>}
                      {(status === 'completed' || status === 'done') && <CheckCircle2 className="h-4 w-4 text-green-500" />}
                      {(status === 'cancelled' || status === 'error') && (
                        <button
                          onClick={() => dispatchAction({ type: 'remove', id })}
                          className="transfer-center__remove rounded-md p-1"
                          aria-label={`Remove ${title} from transfer list`}
                          title="Remove from list"
                        >
                          <X className="h-4 w-4" />
                        </button>
                      )}
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
};
