/* ============================================================================
 * HOOK: useDriveOperations
 * File and folder operations: copy, move, delete, rename, and channel mutations.
 * ============================================================================ */
import { useState, useCallback } from 'react';
import { Api } from 'telegram';
import { buildTelegramCaption } from '../lib/caption';
import type { VirtualFolder, VirtualFile } from '../lib/vfs';
import { parseMetadata, parseMetadataList } from '../lib/vfs';
import bigInt from 'big-integer';
import { gate, getFloodWaitSeconds } from '../lib/tgGate';
import { getActiveTelegramClient } from '../lib/telegram';

const channelKey = (channel: any): string => (
  channel && typeof channel === 'object'
    ? String(channel.id ?? channel.channelId ?? channel.userId ?? '')
    : String(channel ?? '')
);

const resolvePeer = async (client: any, channel: any) => (
  channel === 'me' ? 'me' : channel && typeof channel === 'object' ? channel : client.getInputEntity(channel)
);

export type OperationPhase = 'locating' | 'transferring' | 'deleting' | 'done' | 'error';

export type Operation = {
  id: string;
  name: string;
  progress: number;
  total: number;
  current?: number;
  type: 'copy' | 'move' | 'delete';
  status: 'running' | 'done' | 'error';
  phase?: OperationPhase;
  statusText?: string;
};

type PasteOptions = {
  onProgress?: (progress: number, total: number) => void;
  onFloodWait?: (seconds: number, retryAttempt?: number) => void | Promise<void>;
  suppressOperation?: boolean;
};

const floodWaitSeconds = (error: any): number => {
  return getFloodWaitSeconds(error);
};

export const useDriveOperations = (rawClient: any, zudRootChannelId: string | null, onComplete: (affectedChannels: Set<string>, deletedChannels?: Set<string>) => void) => {
  const client = rawClient
    ? new Proxy(rawClient, {
        get(_target, property) {
          const active = getActiveTelegramClient() || rawClient;
          const value = active[property];
          return typeof value === 'function' ? value.bind(active) : value;
        }
      })
    : null;
  const [operations, setOperations] = useState<Operation[]>([]);

  const flattenItems = (items: { type: 'file' | 'folder', item: any }[]) => {
    const files: VirtualFile[] = [];
    const folders: VirtualFolder[] = [];
    const extract = (item: any, type: 'file' | 'folder') => {
      if (type === 'file') {
        files.push(item);
      } else {
        folders.push(item);
        Object.values(item.folders).forEach(f => extract(f, 'folder'));
        item.files.forEach((f: VirtualFile) => files.push(f));
      }
    };
    items.forEach(x => extract(x.item, x.type));
    return { files, folders };
  };

  const deleteItems = useCallback(async (items: { type: 'file' | 'folder', item: any }[]) => {
    if (!client) return;
    const { files, folders } = flattenItems(items);
    if (files.length === 0 && folders.length === 0) return;

    const opId = Math.random().toString(36).substring(7);
    const opName = items.length === 1 ? items[0].item.name : `${items.length} items`;
    
    const totalItems = files.length + folders.length;
    setOperations(prev => [...prev, {
      id: opId,
      name: opName,
      progress: 0,
      current: 0,
      total: totalItems,
      type: 'delete',
      status: 'running',
      phase: 'locating',
      statusText: `Locating items to delete (0/${totalItems})...`
    }]);

    let done = 0;
    const affectedChannels = new Set<string>();

    const byChannel: Record<string, number[]> = {};

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      file.parts.forEach(p => {
        const chan = p.channelId || 'me';
        affectedChannels.add(String(chan));
        if (!byChannel[chan]) byChannel[chan] = [];
        byChannel[chan].push(p.messageId);
      });
      const scanned = i + 1;
      const scanPct = Math.min(25, Math.round((scanned / totalItems) * 25));
      setOperations(prev => prev.map(o => o.id === opId ? {
        ...o,
        phase: 'locating',
        current: scanned,
        progress: scanPct,
        statusText: `Locating file messages ${scanned} of ${totalItems} ("${file.name}")...`
      } : o));
    }

    const channelsToDelete = new Set<string>();

    for (let j = 0; j < folders.length; j++) {
      const folder = folders[j];
      if (folder.msgId && folder.channelId) {
        const chan = String(folder.channelId.value !== undefined ? folder.channelId.value : folder.channelId);
        affectedChannels.add(chan);
        if (!byChannel[chan]) byChannel[chan] = [];
        byChannel[chan].push(folder.msgId);
      } else if (folder.channelId && String(folder.channelId) === String(folder.id)) {
        // Root Folder (Channel)
        channelsToDelete.add(String(folder.channelId));
      }
      done++; // For progress
    }

    for (const [chanId, msgIds] of Object.entries(byChannel)) {
      try {
        const chunkSize = 100;
        for (let i = 0; i < msgIds.length; i += chunkSize) {
          const chunk = msgIds.slice(i, i + chunkSize);
          if (chanId === 'me') {
            await client.invoke(new Api.messages.DeleteMessages({ id: chunk, revoke: true }));
          } else {
            const peer = await client.getInputEntity(chanId);
            await client.invoke(new Api.channels.DeleteMessages({ channel: peer, id: chunk }));
          }
        }
      } catch (e) {
        console.error("Failed to delete", e);
      }
      
      // Update progress per channel batch instead
      done += msgIds.length;
      const delProgress = Math.min(99, 25 + Math.round((Math.min(done, totalItems) / totalItems) * 75));
      setOperations(prev => prev.map(o => o.id === opId ? {
        ...o,
        phase: 'deleting',
        progress: delProgress,
        current: Math.min(done, totalItems),
        statusText: `Deleting messages (${Math.min(done, totalItems)}/${totalItems})...`
      } : o));
    }
    
    for (const chanId of channelsToDelete) {
      try {
        const peer = await client.getInputEntity(chanId);
        await client.invoke(new Api.channels.DeleteChannel({ channel: peer }));
      } catch (e) {
        console.error("Failed to delete channel", e);
      }
    }
    
    setOperations(prev => prev.map(o => o.id === opId ? {
      ...o,
      status: 'done',
      phase: 'done',
      progress: 100,
      current: totalItems,
      statusText: 'Deleted successfully'
    } : o));
    setTimeout(() => {
      setOperations(prev => prev.filter(o => o.id !== opId || o.status === 'running'));
    }, 4500);
    onComplete(affectedChannels, channelsToDelete);
  }, [client, onComplete]);

  const pasteItems = useCallback(async (
    action: 'copy' | 'move',
      items: { type: 'file' | 'folder', item: any }[],
      targetFolder: VirtualFolder,
      options?: PasteOptions
    ): Promise<boolean> => {
      if (!client) return false;
      const { files, folders } = flattenItems(items);
      if (files.length === 0 && folders.length === 0) return true;
  
      const totalItems = files.length + folders.length;
      if (totalItems === 0) return true;
  
      const opId = Math.random().toString(36).substring(7);
      const request = <T,>(fn: () => Promise<T>) => gate(1, fn);
      const requestWithFloodRetry = async <T,>(fn: () => Promise<T>): Promise<T> => {
        while (true) {
          try {
            return await request(fn);
          } catch (error) {
            const seconds = floodWaitSeconds(error);
            if (!seconds) throw error;
            await options?.onFloodWait?.(seconds, 1);
          }
        }
      };
      const opName = items.length === 1 ? items[0].item.name : `${items.length} items`;
      
      if (!options?.suppressOperation) {
        setOperations(prev => [...prev, {
          id: opId,
          name: opName,
          progress: 0,
          current: 0,
          total: totalItems,
          type: action,
          status: 'running',
          phase: 'locating',
          statusText: `Locating items (0/${totalItems})...`
        }]);
      }
  
      let done = 0;
      let failures = 0;
      const affectedChannels = new Set<string>();
      
      const newFolderIds = new Map<string, string>();
      if (action === 'copy') {
          for (const f of folders) {
              const mappedId = Math.random().toString(36).substring(2, 14);
              const sourceChannel = channelKey(f.channelId);
              // Folder nodes synthesized from file paths do not have a message
              // yet, but their children can still reference the node as pId.
              // Map both representations so neither case becomes "UnknownFolder".
              if (f.folderId) newFolderIds.set(`${sourceChannel}:${String(f.folderId)}`, mappedId);
              newFolderIds.set(`${sourceChannel}:${String(f.id)}`, mappedId);
          }
      }
      
      const allToProcess = [];
      const processedFolderIds = new Set<string>();
      if (action === 'copy' && folders.length > 0) {
        const sendDirectoryMetadata = async (metadata: any, folder: VirtualFolder) => {
          const metadataJson = JSON.stringify(metadata)
            .replace(/":/g, '": ')
            .replace(/,(?=")/g, ', ');
          const message = `📁 Directory:** \`${metadata.n || folder.name}\`\n\n\`${metadataJson}\``;
          const randomId = bigInt(Math.floor(Math.random() * Number.MAX_SAFE_INTEGER)) as any;
          try {
            while (true) {
              try {
                const targetPeer = await requestWithFloodRetry(() =>
                  resolvePeer(client, targetFolder.channelId || (targetFolder.id === 'root' ? zudRootChannelId : 'me') || 'me')
                );
                await requestWithFloodRetry(() => client.invoke(new Api.messages.SendMessage({
                  peer: targetPeer,
                  message,
                  randomId
                })));
                break;
              } catch (error) {
                const waitSeconds = floodWaitSeconds(error);
                if (!waitSeconds) throw error;
                await options?.onFloodWait?.(waitSeconds);
              }
            }
            done += 1;
            const currentPct = Math.min(99, 45 + Math.round((done / totalItems) * 55));
            if (!options?.suppressOperation) {
              setOperations(prev => prev.map(o => o.id === opId ? {
                ...o,
                phase: 'transferring',
                current: done,
                progress: currentPct,
                statusText: `Created directory "${folder.name}" (${done}/${totalItems})`
              } : o));
            }
            options?.onProgress?.(done, totalItems);
          } catch (error) {
            console.error(`Failed to send directory metadata for "${folder.name}"`, error);
            failures += 1;
          }
        };

        for (let fIdx = 0; fIdx < folders.length; fIdx++) {
          const folder = folders[fIdx];
          if (!folder.channelId) continue;
          const currentScanned = fIdx + 1;
          const scanPct = Math.min(45, Math.round((currentScanned / totalItems) * 45));
          if (!options?.suppressOperation) {
            setOperations(prev => prev.map(o => o.id === opId ? {
              ...o,
              phase: 'locating',
              current: currentScanned,
              progress: scanPct,
              statusText: `Locating folder ${currentScanned} of ${totalItems} ("${folder.name}")...`
            } : o));
          }
          const sourceChannelKey = channelKey(folder.channelId);
          let meta: any = null;
          if (folder.msgId) {
            const peer = await requestWithFloodRetry(() => resolvePeer(client, folder.channelId));
            const messages = await requestWithFloodRetry<any[]>(() => client.getMessages(peer, { ids: [folder.msgId] }) as any);
            const metadataList = parseMetadataList(messages?.[0]?.message);
            meta = metadataList.find(item => String(item.id) === String(folder.folderId || folder.id)) || metadataList.find(item => item.t === 'dir');
          }
          if (!meta) {
            const mappedFolderId = newFolderIds.get(`${sourceChannelKey}:${String(folder.folderId || folder.id)}`);
            const parent = folders
              .filter(candidate => candidate !== folder && String(folder.id).startsWith(`${String(candidate.id)}/`))
              .sort((a, b) => String(b.id).length - String(a.id).length)[0];
            const mappedParentId = parent
              ? newFolderIds.get(`${sourceChannelKey}:${String(parent.folderId || parent.id)}`)
              : undefined;
            meta = {
              t: 'dir',
              n: folder.name,
              id: mappedFolderId || Math.random().toString(36).substring(2, 14),
              pId: mappedParentId || (targetFolder.id === 'root' || targetFolder.id === channelKey(targetFolder.channelId)
                ? 'root'
                : targetFolder.folderId || 'root')
            };
          }
          meta.n = meta.n || meta.f || folder.name;
          delete meta.path;
          const isRootOfOperation = items.some(item => item.type === 'folder' && item.item.id === folder.id);
          if (isRootOfOperation) {
            meta.pId = targetFolder.id === 'root' || targetFolder.id === channelKey(targetFolder.channelId)
              ? 'root'
              : targetFolder.folderId || 'root';
          } else {
            const mappedParentId = meta.pId
              ? newFolderIds.get(`${sourceChannelKey}:${String(meta.pId)}`)
              : undefined;
            if (mappedParentId) meta.pId = mappedParentId;
          }
          const mappedFolderId = meta.id
            ? newFolderIds.get(`${sourceChannelKey}:${String(meta.id)}`)
            : undefined;
          if (mappedFolderId) meta.id = mappedFolderId;

          // Keep each directory definition in its own message. This makes
          // partial retries unambiguous and prevents one malformed entry from
          // hiding an entire parent/child batch during reconstruction.
          await sendDirectoryMetadata(meta, folder);
          processedFolderIds.add(folder.id);
        }
      }
      for (const f of folders) {
          if (f.channelId && !processedFolderIds.has(f.id)) allToProcess.push({ type: 'folder', item: f });
      }
      for (const f of files) {
          allToProcess.push({ type: 'file', item: f });
      }

      const batchedRootFileIds = new Set<string>();
      const targetChannelKey = channelKey(
        targetFolder.channelId || (targetFolder.id === 'root' ? zudRootChannelId : 'me')
      );
      const canBatchRootFiles = action === 'copy' &&
        (targetFolder.id === 'root' || targetFolder.id === targetChannelKey);
      if (canBatchRootFiles) {
        const rootFiles = files.filter(file => {
          if (file.path.includes('/')) return false;
          if (file.parts.length === 0) return false;
          return file.parts.every(part => channelKey(part.channelId) === channelKey(file.parts[0].channelId));
        });
        const rootFilePartsByChannel = new Map<string, { file: VirtualFile; parts: VirtualFile['parts'] }[]>();
        for (const file of rootFiles) {
          if (file.parts.length > 100) continue;
          const channel = channelKey(file.parts[0].channelId);
          const entries = rootFilePartsByChannel.get(channel) || [];
          entries.push({ file, parts: file.parts });
          rootFilePartsByChannel.set(channel, entries);
        }

        for (const entries of rootFilePartsByChannel.values()) {
          let batch: { file: VirtualFile; part: VirtualFile['parts'][number] }[] = [];
          const flushForwardBatch = async () => {
            if (batch.length === 0) return;
            const currentBatch = batch;
            batch = [];
            const sourcePeer = await requestWithFloodRetry(() => resolvePeer(client, currentBatch[0].part.channelId));
            const targetChan = targetFolder.channelId || (targetFolder.id === 'root' ? zudRootChannelId : 'me') || 'me';
            const targetPeer = await requestWithFloodRetry(() => resolvePeer(client, targetChan));
            const ids = currentBatch.map(entry => entry.part.messageId);
            const randomIds = ids.map(() => bigInt(Math.floor(Math.random() * Number.MAX_SAFE_INTEGER)) as any);
            try {
              while (true) {
                try {
                  await requestWithFloodRetry(() => client.invoke(new Api.messages.ForwardMessages({
                    fromPeer: sourcePeer,
                    id: ids,
                    randomId: randomIds,
                    toPeer: targetPeer,
                    dropAuthor: true
                  })));
                  break;
                } catch (error) {
                  const waitSeconds = floodWaitSeconds(error);
                  if (!waitSeconds) throw error;
                  await options?.onFloodWait?.(waitSeconds);
                }
              }
            } catch (error) {
              // Do not fall back to individual sends after an uncertain batch
              // result: Telegram may have accepted part of the request.
              // Stable random IDs make a retry safe, while a hard failure is
              // surfaced to the caller without creating duplicate media.
              console.error('Failed to forward a root-file batch', error);
              const failedFiles = new Set(currentBatch.map(entry => entry.file.id));
              failedFiles.forEach(id => batchedRootFileIds.add(id));
              failures += failedFiles.size;
              return;
            }
            const completedFiles = new Set(currentBatch.map(entry => entry.file.id));
            completedFiles.forEach(id => batchedRootFileIds.add(id));
            done += completedFiles.size;
            setOperations(prev => prev.map(o => o.id === opId ? { ...o, progress: done } : o));
            options?.onProgress?.(done, files.length + folders.length);
          };
          for (const entry of entries) {
            const partEntries = entry.parts.map(part => ({ file: entry.file, part }));
            if (batch.length > 0 && batch.length + partEntries.length > 100) {
              await flushForwardBatch();
            }
            batch.push(...partEntries);
          }
          await flushForwardBatch();
        }
      }
      const processableItems = allToProcess.filter(processObj =>
        processObj.type !== 'file' || !batchedRootFileIds.has(processObj.item.id)
      );
      
      processLoop: for (let itemIdx = 0; itemIdx < processableItems.length; itemIdx++) {
        const processObj = processableItems[itemIdx];
        try {
          const isFile = processObj.type === 'file';
          const fileOrFolder: any = processObj.item;
          const itemName = fileOrFolder.name || (isFile ? 'file' : 'folder');
          const currentItemNumber = done + 1;
          const scanPct = Math.min(48, Math.round((currentItemNumber / totalItems) * 45));

          if (!options?.suppressOperation) {
            setOperations(prev => prev.map(o => o.id === opId ? {
              ...o,
              phase: 'locating',
              current: currentItemNumber,
              progress: scanPct,
              statusText: `Locating ${isFile ? 'file' : 'folder'} ${currentItemNumber} of ${totalItems} ("${itemName}")...`
            } : o));
          }
          
          const partsToProcess = isFile ? fileOrFolder.parts : [{ channelId: fileOrFolder.channelId, messageId: fileOrFolder.msgId }];
          
          for (const p of partsToProcess) {
             const chan = p.channelId || 'me';
             const targetChan = targetFolder.channelId || (targetFolder.id === 'root' ? zudRootChannelId : 'me') || 'me';
             const sourceChannelKey = channelKey(chan);
             const targetChannelKey = channelKey(targetChan);
             
             if (action === 'move') {
               affectedChannels.add(sourceChannelKey);
             }
             affectedChannels.add(targetChannelKey);
  
             const peer = await requestWithFloodRetry(() => resolvePeer(client, chan));
             let msg: any = null;
             let meta: any;
             if (isFile || fileOrFolder.msgId) {
               const msgs: any[] = await requestWithFloodRetry(() =>
                 client.getMessages(peer, { ids: [p.messageId] }) as any
               );
               msg = msgs && msgs.length > 0 ? msgs[0] : null;
               if (!msg || !msg.message) {
                 console.error(`Could not load source message ${p.messageId} from channel ${sourceChannelKey}.`);
                 failures += 1;
                 continue;
               }
               meta = parseMetadata(msg.message);
               if (!meta) {
                 console.error(`Source message ${p.messageId} does not contain valid Cloud metadata.`);
                 failures += 1;
                 continue;
               }
             } else {
               // A folder reconstructed from a child file has no directory
               // message to copy. Materialize its directory metadata in the
               // destination so the receiver can rebuild the exact tree.
               const mappedFolderId = newFolderIds.get(`${sourceChannelKey}:${String(fileOrFolder.id)}`);
               const parent = folders
                 .filter(folder => folder !== fileOrFolder
                   && String(fileOrFolder.id).startsWith(`${String(folder.id)}/`))
                 .sort((a, b) => String(b.id).length - String(a.id).length)[0];
               const mappedParentId = parent
                 ? newFolderIds.get(`${sourceChannelKey}:${String(parent.folderId || parent.id)}`)
                 : undefined;
               meta = {
                 t: 'dir',
                 n: fileOrFolder.name,
                 id: mappedFolderId || Math.random().toString(36).substring(2, 14),
                 pId: mappedParentId || (targetFolder.id === 'root' || targetFolder.id === targetChannelKey
                   ? 'root'
                   : targetFolder.folderId || 'root')
               };
             }
             
             // Update Metadata
             meta.n = meta.n || meta.f;
             delete meta.path; // legacy
             
             // Check if this item is a ROOT of the operation
             const isRootOfOperation = items.some(i => i.type === processObj.type && i.item.id === fileOrFolder.id);
             
             if (isRootOfOperation) {
                 if (targetFolder.id === 'root' || targetFolder.id === targetChannelKey) {
                     meta.pId = 'root';
                 } else {
                     meta.pId = targetFolder.folderId || 'root';
                 }
             } else {
                 // It's a nested item. For move, keep original pId. For copy, update to mapped pId
                 const mappedParentId = meta.pId ? newFolderIds.get(`${sourceChannelKey}:${String(meta.pId)}`) : undefined;
                 if (action === 'copy' && mappedParentId) {
                     meta.pId = mappedParentId;
                 }
             }
             
             // If the item itself is a folder being copied, update its OWN id
             const mappedFolderId = meta.id ? newFolderIds.get(`${sourceChannelKey}:${String(meta.id)}`) : undefined;
             if (action === 'copy' && meta.t === 'dir' && mappedFolderId) {
                 meta.id = mappedFolderId;
             }
             
             const fileName = meta.n || meta.f || 'Unknown';
             const newCaption = buildTelegramCaption(fileName, meta);
             const randomId = bigInt(Math.floor(Math.random() * Number.MAX_SAFE_INTEGER)) as any;

             if (!options?.suppressOperation) {
               const currentExec = done + 1;
               const execPct = Math.min(98, 48 + Math.round((currentExec / totalItems) * 50));
               setOperations(prev => prev.map(o => o.id === opId ? {
                 ...o,
                 phase: 'transferring',
                 current: currentExec,
                 progress: execPct,
                 statusText: `${action === 'move' ? 'Moving' : 'Copying'} ${currentExec} of ${totalItems} ("${fileName}")...`
               } : o));
             }
             
             if (action === 'move') {
                if (!msg) {
                  failures += 1;
                  continue;
                }
                if (sourceChannelKey === targetChannelKey) {
                    // Same channel, just edit caption
                    await requestWithFloodRetry(() => client.invoke(new Api.messages.EditMessage({
                       peer: peer,
                       id: p.messageId,
                       message: newCaption
                    })));
                } else {
                    // Different channel, send media to new channel and delete from old
                    const targetPeer = await requestWithFloodRetry(() => resolvePeer(client, targetChan));
                    if (msg?.media) {
                       await requestWithFloodRetry(() => client.invoke(new Api.messages.SendMedia({
                          peer: targetPeer,
                          media: msg.media,
                          message: newCaption,
                          randomId: randomId
                       })));
                    } else {
                       await requestWithFloodRetry(() => client.invoke(new Api.messages.SendMessage({
                          peer: targetPeer,
                          message: newCaption,
                          randomId: randomId
                       })));
                    }
                    if (sourceChannelKey === 'me') {
                        await requestWithFloodRetry(() => client.invoke(new Api.messages.DeleteMessages({
                            id: [p.messageId],
                            revoke: true
                        })));
                    } else {
                        const sourcePeer = await requestWithFloodRetry(() => resolvePeer(client, chan));
                        await requestWithFloodRetry(() => client.invoke(new Api.channels.DeleteMessages({
                            channel: sourcePeer,
                            id: [p.messageId]
                        })));
                    }
                }
             } else if (action === 'copy') {
                const targetPeer = await requestWithFloodRetry(() => resolvePeer(client, targetChan));
                
                if (msg?.media) {
                   await requestWithFloodRetry(() => client.invoke(new Api.messages.SendMedia({
                      peer: targetPeer,
                      media: msg.media,
                      message: newCaption,
                      randomId: randomId
                   })));
                } else {
                   await requestWithFloodRetry(() => client.invoke(new Api.messages.SendMessage({
                      peer: targetPeer,
                      message: newCaption,
                      randomId: randomId
                   })));
                }
             }
          }
      } catch (e) {
        console.error(`Failed to ${action} file`, e);
        const waitSeconds = floodWaitSeconds(e);
        if (waitSeconds > 0) {
          await options?.onFloodWait?.(waitSeconds);
          continue processLoop;
        }
        failures += 1;
      }
      done++;
      const finishPct = Math.min(99, Math.round((done / totalItems) * 100));
      if (!options?.suppressOperation) {
        setOperations(prev => prev.map(o => o.id === opId ? {
          ...o,
          current: done,
          progress: finishPct,
          statusText: `${action === 'move' ? 'Moved' : 'Copied'} ${done} of ${totalItems}`
        } : o));
      }
      options?.onProgress?.(done, totalItems);
    }
    
    if (!options?.suppressOperation) {
      setOperations(prev => prev.map(o => o.id === opId ? {
        ...o,
        status: failures > 0 ? 'error' : 'done',
        phase: 'done',
        progress: 100,
        current: totalItems,
        statusText: failures > 0 ? `Completed with ${failures} error(s)` : 'Completed successfully'
      } : o));
      setTimeout(() => {
        setOperations(prev => prev.filter(o => o.id !== opId || o.status === 'running'));
      }, 4500);
    }
    onComplete(affectedChannels);
    return failures === 0;
  }, [client, onComplete, zudRootChannelId]);

  const renameItem = useCallback(async (
    item: { type: 'file' | 'folder', item: any },
    newName: string,
    _currentPath: string
  ) => {
    if (!client || !newName.trim()) return false;
    const affectedChannels = new Set<string>();
    
    try {
      if (item.type === 'file') {
        const file = item.item;
        for (const p of file.parts) {
           const chan = p.channelId || 'me';
           affectedChannels.add(String(chan));
           
           const peer = chan === 'me' ? 'me' : await client.getInputEntity(chan);
           const msgs = await client.getMessages(peer, { ids: [p.messageId] });
           const msg = msgs && msgs.length > 0 ? msgs[0] : null;
           if (!msg || !msg.message) continue;
           
           const meta = parseMetadata(msg.message);
           if (!meta) continue;
           
           meta.n = newName; // Update name in meta
           if (!meta.pId) {
               // Migrate legacy to new schema during rename
               const pathParts = (meta.path || '').split('/');
               pathParts.pop(); // remove old filename
               const oldDir = pathParts.join('/');
               meta.pId = oldDir === '' ? 'root' : oldDir; // Note: oldDir doesn't perfectly map to folder IDs, but 'root' does
               // Actually, it's safer to just set pId to the current context's folder ID
               const parentFolderId = file.id.split('/').slice(1, -1).join('/'); // 'chanId/folder1/file' -> 'folder1'
               meta.pId = parentFolderId || 'root';
               delete meta.path;
           }
           const newCaption = buildTelegramCaption(newName, meta);
           
           await client.invoke(new Api.messages.EditMessage({
              peer: peer,
              id: p.messageId,
              message: newCaption
           }));
        }
        onComplete(affectedChannels);
        return true;
      } else {
        const folder = item.item;
        if (folder.channelId && folder.id === String(folder.channelId)) {
           // Root Channel Rename
           const peer = await client.getInputEntity(folder.channelId);
           await client.invoke(new Api.channels.EditTitle({
              channel: peer,
              title: newName
           }));
           affectedChannels.add(String(folder.channelId));
           onComplete(affectedChannels);
           return true;
        } else if (folder.msgId) {
           // Virtual Folder Rename
           const chan = folder.channelId || 'me';
           affectedChannels.add(String(chan));
           const peer = chan === 'me' ? 'me' : await client.getInputEntity(chan);
           
           const msgs = await client.getMessages(peer, { ids: [folder.msgId] });
           const msg = msgs && msgs.length > 0 ? msgs[0] : null;
           if (msg && msg.message) {
               const meta = parseMetadata(msg.message);
               if (meta) {
                  meta.n = newName;
                  const newCaption = `📁 **Directory:** \`${newName}\`\n\n\`${JSON.stringify(meta)}\``;
                  await client.invoke(new Api.messages.EditMessage({
                     peer: peer,
                     id: folder.msgId,
                     message: newCaption
                  }));
               }
           }
           onComplete(affectedChannels);
           return true;
        }
        return false;
      }
    } catch (e) {
      console.error("Failed to rename", e);
      return false;
    }
  }, [client, onComplete]);

  const clearDoneOperations = useCallback(() => {
    setOperations(prev => prev.filter(o => o.status === 'running'));
  }, []);

  return { operations, deleteItems, pasteItems, renameItem, clearDoneOperations };
};
