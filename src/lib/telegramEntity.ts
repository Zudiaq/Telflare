import type { TelegramClient } from 'telegram';
import { Api } from 'telegram';
import bigInt from 'big-integer';

const resolvedEntities = new WeakMap<object, Map<string, Promise<any>>>();

const ACCESS_HASH_STORAGE_KEY = 'zud_channel_access_hashes';
const channelAccessHashMap = new Map<string, string>();

try {
  const saved = JSON.parse(localStorage.getItem(ACCESS_HASH_STORAGE_KEY) || '{}');
  for (const [k, v] of Object.entries(saved)) {
    if (k && v) channelAccessHashMap.set(k, String(v));
  }
} catch {}

export const channelNumericId = (value: string): string | null => {
  if (!/^-?\d+$/.test(value)) return null;
  if (value.startsWith('-100')) return value.slice(4);
  return value.replace(/^-/, '');
};

export const saveChannelAccessHash = (
  channelId: string | number | undefined | null,
  accessHash: string | number | bigint | object | undefined | null
) => {
  if (!channelId || accessHash === undefined || accessHash === null) return;
  const numId = channelNumericId(String(channelId));
  if (!numId) return;
  const hashStr = typeof accessHash === 'object' && typeof (accessHash as any).toString === 'function'
    ? (accessHash as any).toString()
    : String(accessHash);
  if (!hashStr || hashStr === '0') return;

  channelAccessHashMap.set(numId, hashStr);
  try {
    const saved = JSON.parse(localStorage.getItem(ACCESS_HASH_STORAGE_KEY) || '{}');
    saved[numId] = hashStr;
    localStorage.setItem(ACCESS_HASH_STORAGE_KEY, JSON.stringify(saved));
  } catch {}
};

export const getChannelAccessHash = (channelId: string | number | undefined | null): string | null => {
  if (!channelId) return null;
  const numId = channelNumericId(String(channelId));
  if (!numId) return null;
  if (channelAccessHashMap.has(numId)) return channelAccessHashMap.get(numId)!;
  try {
    const saved = JSON.parse(localStorage.getItem(ACCESS_HASH_STORAGE_KEY) || '{}');
    if (saved[numId]) {
      channelAccessHashMap.set(numId, String(saved[numId]));
      return String(saved[numId]);
    }
  } catch {}
  return null;
};

const entityId = (entity: any): string | null => {
  const id = entity?.id;
  if (id === undefined || id === null) return null;
  return typeof id === 'object' && typeof id.toString === 'function'
    ? id.toString()
    : String(id);
};

export const resolveTelegramEntity = async (
  client: TelegramClient,
  rawValue: string | number | bigint | object | undefined | null,
  fallbackClient?: TelegramClient | null
): Promise<any> => {
  if (rawValue && typeof rawValue === 'object') {
    const obj = rawValue as any;
    if (obj.className?.startsWith('InputPeer')) {
      return rawValue;
    }
    if ((obj.className === 'Channel' || obj.accessHash !== undefined) && obj.id !== undefined) {
      if (obj.accessHash) {
        saveChannelAccessHash(obj.id, obj.accessHash);
      }
      try {
        return await client.getInputEntity(rawValue as any);
      } catch {}
      if (obj.accessHash) {
        return new Api.InputPeerChannel({
          channelId: bigInt(obj.id) as any,
          accessHash: bigInt(obj.accessHash) as any,
        });
      }
    }
  }

  let entityValue: any = rawValue;
  if (rawValue && typeof rawValue === 'object') {
    const obj = rawValue as any;
    if (bigInt.isInstance(obj)) {
      entityValue = obj.toString();
    } else if (typeof obj.value !== 'undefined') {
      entityValue = String(obj.value);
    } else if (obj.channelId !== undefined) {
      entityValue = obj.channelId;
    } else if (obj.id !== undefined) {
      entityValue = obj.id;
    } else if (obj.userId !== undefined) {
      entityValue = obj.userId;
    } else if (typeof obj.toString === 'function' && obj.toString() !== '[object Object]') {
      entityValue = obj.toString();
    }
  }

  const raw = entityValue === undefined || entityValue === null || String(entityValue) === 'me'
    ? 'me'
    : String(entityValue);
  if (raw === 'me') return 'me';

  const numericId = channelNumericId(raw);
  if (numericId) {
    const cachedHash = getChannelAccessHash(numericId);
    if (cachedHash) {
      return new Api.InputPeerChannel({
        channelId: bigInt(numericId) as any,
        accessHash: bigInt(cachedHash) as any,
      });
    }
  }

  let clientCache = resolvedEntities.get(client as object);
  if (!clientCache) {
    clientCache = new Map();
    resolvedEntities.set(client as object, clientCache);
  }
  const cached = clientCache.get(raw);
  if (cached) return cached;

  const resolveWithClient = async (source: TelegramClient): Promise<any> => {
    if (numericId) {
      const channelPeerId = '-100' + numericId;

      try {
        const direct: any = await source.getInputEntity(channelPeerId);
        if (direct?.className === 'InputPeerChannel' || direct?.className === 'InputPeerChat') {
          if (direct.accessHash) saveChannelAccessHash(numericId, direct.accessHash);
          return direct;
        }
      } catch {}

      try {
        const dialogs = await source.getDialogs({ limit: 150 });
        for (const dialog of dialogs) {
          const entity: any = dialog?.entity;
          if (entity?.className === 'Channel' && entity.accessHash) {
            saveChannelAccessHash(entity.id ? entity.id.toString() : undefined, entity.accessHash);
          }
        }
        const channelDialog = dialogs.find((dialog: any) => {
          const entity = dialog?.entity;
          return (entity?.className === 'Channel' || entity?.className === 'Chat') && entityId(entity) === numericId;
        });
        const entity: any = channelDialog?.entity;
        if (entity) {
          if (entity.accessHash) saveChannelAccessHash(numericId, entity.accessHash);
          return source.getInputEntity(entity);
        }
      } catch {}

      try {
        const archivedDialogs = await source.getDialogs({ folder: 1, limit: 100 });
        for (const dialog of archivedDialogs) {
          const entity: any = dialog?.entity;
          if (entity?.className === 'Channel' && entity.accessHash) {
            saveChannelAccessHash(entity.id ? entity.id.toString() : undefined, entity.accessHash);
          }
        }
        const channelDialog = archivedDialogs.find((dialog: any) => {
          const entity = dialog?.entity;
          return (entity?.className === 'Channel' || entity?.className === 'Chat') && entityId(entity) === numericId;
        });
        const entity: any = channelDialog?.entity;
        if (entity) {
          if (entity.accessHash) saveChannelAccessHash(numericId, entity.accessHash);
          return source.getInputEntity(entity);
        }
      } catch {}

      const learnedHash = getChannelAccessHash(numericId);
      if (learnedHash) {
        return new Api.InputPeerChannel({
          channelId: bigInt(numericId) as any,
          accessHash: bigInt(learnedHash) as any,
        });
      }

      try {
        const direct = await source.getInputEntity(raw);
        if (direct?.className === 'InputPeerChannel' || direct?.className === 'InputPeerChat') {
          return direct;
        }
      } catch {}

      return source.getInputEntity(channelPeerId);
    }

    return source.getInputEntity(raw);
  };

  const promise = (async () => {
    if (fallbackClient && fallbackClient !== client) {
      return resolveWithClient(fallbackClient);
    }
    try {
      return await resolveWithClient(client);
    } catch (error) {
      if (!fallbackClient || fallbackClient === client) throw error;
      return resolveWithClient(fallbackClient);
    }
  })().catch(error => {
    clientCache?.delete(raw);
    throw error;
  });

  clientCache.set(raw, promise);
  return promise;
};

export const resolveTelegramChannel = async (
  client: TelegramClient,
  rawValue: string | number | bigint | object | undefined | null,
  fallbackClient?: TelegramClient | null
): Promise<Api.InputChannel> => {
  if (rawValue && typeof rawValue === 'object') {
    const obj = rawValue as any;
    if (obj.className === 'InputChannel') {
      return obj;
    }
    if (obj.className === 'InputPeerChannel') {
      return new Api.InputChannel({
        channelId: bigInt(obj.channelId) as any,
        accessHash: bigInt(obj.accessHash) as any,
      });
    }
    if (obj.className === 'Channel' && obj.id && obj.accessHash) {
      return new Api.InputChannel({
        channelId: bigInt(obj.id) as any,
        accessHash: bigInt(obj.accessHash) as any,
      });
    }
    if (obj.id !== undefined && obj.accessHash !== undefined) {
      return new Api.InputChannel({
        channelId: bigInt(obj.id) as any,
        accessHash: bigInt(obj.accessHash) as any,
      });
    }
    if (obj.channelId !== undefined && obj.accessHash !== undefined) {
      return new Api.InputChannel({
        channelId: bigInt(obj.channelId) as any,
        accessHash: bigInt(obj.accessHash) as any,
      });
    }
  }

  let entityIdStr = '';
  if (rawValue && typeof rawValue === 'object') {
    const obj = rawValue as any;
    if (bigInt.isInstance(obj)) entityIdStr = obj.toString();
    else if (obj.id !== undefined) entityIdStr = String(obj.id);
    else if (obj.channelId !== undefined) entityIdStr = String(obj.channelId);
    else if (obj.value !== undefined) entityIdStr = String(obj.value);
  } else if (rawValue !== undefined && rawValue !== null) {
    entityIdStr = String(rawValue);
  }

  const numId = channelNumericId(entityIdStr);
  if (numId) {
    const cachedHash = getChannelAccessHash(numId);
    if (cachedHash) {
      return new Api.InputChannel({
        channelId: bigInt(numId) as any,
        accessHash: bigInt(cachedHash) as any,
      });
    }
  }

  const peer = await resolveTelegramEntity(client, rawValue, fallbackClient);
  if (peer && peer.className === 'InputChannel') {
    return peer;
  }
  if (peer && peer.className === 'InputPeerChannel') {
    return new Api.InputChannel({
      channelId: bigInt(peer.channelId) as any,
      accessHash: bigInt(peer.accessHash) as any,
    });
  }
  if (peer && peer.className === 'Channel' && peer.id) {
    return new Api.InputChannel({
      channelId: bigInt(peer.id) as any,
      accessHash: bigInt(peer.accessHash || 0) as any,
    });
  }

  try {
    const direct: any = await client.getInputEntity(rawValue as any);
    if (direct?.className === 'InputChannel') return direct;
    if (direct?.className === 'InputPeerChannel') {
      return new Api.InputChannel({
        channelId: bigInt(direct.channelId) as any,
        accessHash: bigInt(direct.accessHash) as any,
      });
    }
  } catch {}

  throw new Error(`Cannot cast ${peer?.className || typeof peer} to any kind of InputChannel`);
};
