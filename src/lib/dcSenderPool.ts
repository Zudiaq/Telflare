import { Api } from 'telegram';
import { MTProtoSender } from 'telegram/network';
import { LAYER } from 'telegram/tl/AllTLObjects';
import { ProxiedPromisedWebSockets } from './proxiedSocket';

/* ============================================================================
 * PERSISTENT 3-LANE MTPROTO DC SENDER POOL
 * ============================================================================ */
const MAX_LANES_PER_DC = 3;

interface LaneSlot {
  index: number;
  sender: any | null;
  connectPromise: Promise<any> | null;
  layerInitialized: boolean;
}

interface DcPoolSlot {
  dcId: number;
  authKey: any | null;
  authenticated: boolean;
  authPromise: Promise<void> | null;
  lanes: LaneSlot[];
  lastErrorAt: number;
}

interface ClientPoolState {
  slots: Map<number, DcPoolSlot>;
  mainConnectPromise: Promise<void> | null;
  reconnectingStartedAt: number;
  lifecycleHooked: boolean;
  getSenderHooked: boolean;
}

const clientPools = new WeakMap<object, ClientPoolState>();
const trackedClients = new Set<WeakRef<any>>();
let networkWatchersInstalled = false;

function installGlobalNetworkWatchers() {
  if (networkWatchersInstalled || typeof window === 'undefined') return;
  networkWatchersInstalled = true;

  const healAllActiveClients = () => {
    for (const ref of Array.from(trackedClients)) {
      const c = ref.deref();
      if (!c || c._destroyed || c._zudIntentionalDisconnect) {
        trackedClients.delete(ref);
        continue;
      }
      void ensureTelegramConnected(c).catch(() => {});
    }
  };

  window.addEventListener('online', healAllActiveClients);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      healAllActiveClients();
    }
  });
}

function createDcSlot(dcId: number): DcPoolSlot {
  const lanes: LaneSlot[] = [];
  for (let i = 0; i < MAX_LANES_PER_DC; i++) {
    lanes.push({
      index: i,
      sender: null,
      connectPromise: null,
      layerInitialized: false,
    });
  }
  return {
    dcId,
    authKey: null,
    authenticated: false,
    authPromise: null,
    lanes,
    lastErrorAt: 0,
  };
}

function getPoolState(client: any): ClientPoolState {
  let state = clientPools.get(client);
  if (!state) {
    state = {
      slots: new Map<number, DcPoolSlot>(),
      mainConnectPromise: null,
      reconnectingStartedAt: 0,
      lifecycleHooked: false,
      getSenderHooked: false,
    };
    clientPools.set(client, state);
    if (typeof WeakRef !== 'undefined') {
      trackedClients.add(new WeakRef(client));
    }
    installGlobalNetworkWatchers();
  }

  if (!state.lifecycleHooked && client) {
    state.lifecycleHooked = true;
    if (typeof client.connect === 'function') {
      const origConnect = client.connect.bind(client);
      client.connect = async (...args: any[]) => {
        client._zudIntentionalDisconnect = false;
        return origConnect(...args);
      };
    }
    if (typeof client.disconnect === 'function') {
      const origDisconnect = client.disconnect.bind(client);
      client.disconnect = async (...args: any[]) => {
        client._zudIntentionalDisconnect = true;
        try {
          await disconnectClientDcSenders(client);
        } catch {
        }
        return origDisconnect(...args);
      };
    }
  }

  if (!state.getSenderHooked && client && typeof client.getSender === 'function') {
    state.getSenderHooked = true;
    client.getSender = (dcId?: number) => {
      return dcId ? getDcSender(client, dcId) : ensureTelegramConnected(client).then(() => client._sender);
    };
  }

  return state;
}

export function installDcSenderPool(client: any): void {
  if (!client || typeof client !== 'object') return;
  getPoolState(client);
}

export function getSenderPendingCount(sender: any): number {
  if (!sender) return 0;
  let count = 0;
  const pending = sender._pendingState;
  if (pending) {
    if (typeof pending.size === 'number') count += pending.size;
    else if (typeof pending.values === 'function') {
      try {
        count += Array.from(pending.values()).length;
      } catch {
      }
    }
  }
  const queued = sender._sendQueue?._pendingStates;
  if (Array.isArray(queued)) count += queued.length;
  return count;
}

export function isDcSenderHealthy(sender: any): boolean {
  if (!sender) return false;
  if (sender.userDisconnected) return false;
  if (sender.isReconnecting) return false;
  if (typeof sender.isConnected === 'function' && !sender.isConnected()) return false;
  if (sender._connection && !sender._connection._connected) return false;
  const sock = sender._connection?.socket || sender._connection?._socket;
  if (sock && (sock.closed || (sock.client && sock.client.readyState !== 1))) return false;
  return true;
}

async function teardownSender(sender: any, reason = 'Sender recycled'): Promise<void> {
  if (!sender) return;
  try {
    sender.userDisconnected = true;
    sender._userConnected = false;
    sender.isReconnecting = true;
    sender.reconnect = () => {};
    sender._reconnect = async () => {};

    const err = new Error(reason);
    const pending = sender._pendingState;
    if (pending && typeof pending.values === 'function') {
      for (const st of pending.values()) {
        try {
          st?.reject?.(err);
        } catch {
        }
      }
      try {
        pending.clear();
      } catch {
      }
    }
    const queuePending = sender._sendQueue?._pendingStates;
    if (Array.isArray(queuePending)) {
      for (const st of queuePending) {
        try {
          st?.reject?.(err);
        } catch {
        }
      }
      queuePending.length = 0;
    }
  } catch {
  }
  try {
    let t: any;
    await Promise.race([
      Promise.resolve(sender.disconnect?.()),
      new Promise<void>((resolve) => {
        t = setTimeout(resolve, 1500);
      }),
    ]).finally(() => {
      if (t) clearTimeout(t);
    });
  } catch {
  }
}

/* ============================================================================
 * SELF-HEALING CONNECTION & LANE MANAGEMENT
 * ============================================================================ */
export async function ensureTelegramConnected(client: any): Promise<void> {
  if (!client) throw new Error('Telegram client is not initialized');
  if (client._destroyed) throw new Error('Telegram client was destroyed');

  const state = getPoolState(client);
  const mainSender = client._sender;

  if (client.connected && isDcSenderHealthy(mainSender)) {
    state.reconnectingStartedAt = 0;
    return;
  }

  if (mainSender?.isReconnecting) {
    if (!state.reconnectingStartedAt) {
      state.reconnectingStartedAt = Date.now();
    }
    if (Date.now() - state.reconnectingStartedAt < 6000) {
      await new Promise((r) => setTimeout(r, 250));
      if (client.connected && isDcSenderHealthy(client._sender)) {
        state.reconnectingStartedAt = 0;
        return;
      }
    }
  }

  if (!state.mainConnectPromise) {
    state.mainConnectPromise = (async () => {
      try {
        client._zudIntentionalDisconnect = false;
        if (typeof client.connect === 'function') {
          let connectTimer: any = null;
          await Promise.race([
            client.connect(),
            new Promise<void>((_, reject) => {
              connectTimer = setTimeout(() => reject(new Error('Main Telegram connect timeout')), 14000);
            }),
          ]).finally(() => {
            if (connectTimer) clearTimeout(connectTimer);
          });
        }
        try {
          client._connectedDeferred?.resolve?.();
        } catch {
        }
        state.reconnectingStartedAt = 0;
      } finally {
        state.mainConnectPromise = null;
      }
    })();
  }

  await state.mainConnectPromise;
}

function resolveSocketClass(client: any) {
  return client.networkSocket || ProxiedPromisedWebSockets;
}

async function buildInitConnectionQuery(client: any, innerQuery: any) {
  const baseInit = client._initRequest;
  if (!baseInit) return innerQuery;
  return new Api.InitConnection({
    apiId: baseInit.apiId,
    deviceModel: baseInit.deviceModel || 'ZUD Cloud Web',
    systemVersion: baseInit.systemVersion || '1.0',
    appVersion: baseInit.appVersion || '2.0',
    langCode: baseInit.langCode || 'en',
    langPack: baseInit.langPack || '',
    systemLangCode: baseInit.systemLangCode || 'en',
    proxy: baseInit.proxy,
    query: innerQuery,
  });
}

async function connectLaneSender(
  client: any,
  slot: DcPoolSlot,
  lane: LaneSlot,
): Promise<any> {
  if (client._destroyed) {
    throw new Error('Telegram client was destroyed');
  }

  await ensureTelegramConnected(client);

  const dcId = slot.dcId;
  const homeDcId = Number((client.session as any)?.dcId || 0);
  if (dcId === homeDcId && !slot.authKey) {
    slot.authKey = client.session?.getAuthKey?.(dcId) || client.session?.authKey || null;
    if (slot.authKey?.getKey?.()) {
      slot.authenticated = true;
    }
  } else if (dcId !== homeDcId && !slot.authKey) {
    const savedForeignKey = client.session?.getAuthKey?.(dcId) || null;
    if (savedForeignKey?.getKey?.()) {
      slot.authKey = savedForeignKey;
    }
  }

  if (lane.sender) {
    const old = lane.sender;
    lane.sender = null;
    lane.layerInitialized = false;
    await teardownSender(old, 'Sender lane reconnecting');
  }

  let lastErr: any = null;
  const maxConnectAttempts = 2;

  for (let attempt = 0; attempt < maxConnectAttempts; attempt++) {
    if (client._destroyed) throw new Error('Telegram client was destroyed');

    const hasAuthKey = Boolean(slot.authKey && typeof slot.authKey.getKey === 'function' && slot.authKey.getKey());
    const useDownloadDc = hasAuthKey && attempt === 0;

    let sender: any = null;
    try {
      const dc = await client.getDC(dcId, useDownloadDc);
      sender = new (MTProtoSender as any)(slot.authKey || undefined, {
        logger: client._log,
        dcId,
        retries: 1,
        delay: 200,
        autoReconnect: false,
        connectTimeout: client._timeout,
        authKeyCallback: async (ak: any) => {
          slot.authKey = ak;
          if (typeof client._authKeyCallback === 'function') {
            try {
              await client._authKeyCallback(ak, dcId);
            } catch {
            }
          }
        },
        isMainSender: false,
        onConnectionBreak: () => {
          slot.authenticated = false;
          if (dcId !== homeDcId) {
            slot.authKey = null;
          }
          if (lane.sender === sender) {
            lane.sender = null;
            lane.layerInitialized = false;
          }
        },
        client,
        securityChecks: client._securityChecks,
        _exportedSenderPromises: new Map(),
        reconnectRetries: 0,
      });

      sender.reconnect = () => {
        sender.isReconnecting = true;
        sender.userDisconnected = true;
        sender._userConnected = false;
        if (lane.sender === sender) {
          lane.sender = null;
          lane.layerInitialized = false;
        }
        void teardownSender(sender, 'Connection lost');
      };
      sender._reconnect = async () => {};

      const ConnectionClass = client._connection;
      const conn = new ConnectionClass({
        ip: dc.ipAddress,
        port: dc.port,
        dcId,
        loggers: client._log,
        proxy: client._proxy,
        testServers: client.testServers,
        socket: resolveSocketClass(client),
      });

      let connectTimer: any = null;
      const connected = await Promise.race([
        sender.connect(conn, false),
        new Promise<boolean>((_, reject) => {
          connectTimer = setTimeout(() => reject(new Error(`Sender connect timeout for DC ${dcId}`)), 14000);
        }),
      ]).finally(() => {
        if (connectTimer) clearTimeout(connectTimer);
      });

      if (!connected || !isDcSenderHealthy(sender)) {
        throw new Error(`WebSocket connection failed for DC ${dcId}`);
      }

      slot.authKey = sender.authKey || slot.authKey;

      if (dcId !== homeDcId && !slot.authenticated) {
        if (!slot.authPromise) {
          slot.authPromise = (async () => {
            const auth = await client.invoke(new Api.auth.ExportAuthorization({ dcId }));
            const initQuery = await buildInitConnectionQuery(
              client,
              new Api.auth.ImportAuthorization({
                id: auth.id,
                bytes: auth.bytes,
              }),
            );
            try {
              await sender.send(
                new Api.InvokeWithLayer({
                  layer: LAYER,
                  query: initQuery,
                }),
              );
              lane.layerInitialized = true;
            } catch (err: any) {
              if (err?.errorMessage !== 'DC_ID_INVALID') {
                throw err;
              }
            }
            slot.authenticated = true;
          })().finally(() => {
            slot.authPromise = null;
          });
        }
        await slot.authPromise;
      }

      sender.dcId = dcId;
      sender.userDisconnected = false;
      sender._zudLaneIndex = lane.index;
      lane.sender = sender;
      return sender;
    } catch (err: any) {
      lastErr = err;
      const errMsg = String(err?.message || err?.errorMessage || err || '');
      if (/AUTH_KEY_UNREGISTERED|SESSION_REVOKED|AUTH_KEY_PERM_EMPTY|404/i.test(errMsg)) {
        slot.authenticated = false;
        if (dcId !== homeDcId) {
          slot.authKey = null;
        }
      }
      if (sender) {
        await teardownSender(sender, 'Failed connecting sender');
      }
    }
  }

  // Last-resort safe fallback for home DC ONLY if main sender is healthy
  if (dcId === homeDcId && isDcSenderHealthy(client._sender)) {
    return client._sender;
  }

  slot.lastErrorAt = Date.now();
  throw lastErr || new Error(`Unable to acquire healthy sender for DC ${dcId}`);
}

function ensureLaneConnected(client: any, slot: DcPoolSlot, lane: LaneSlot): Promise<any> {
  if (lane.sender && isDcSenderHealthy(lane.sender)) {
    return Promise.resolve(lane.sender);
  }
  if (!lane.connectPromise) {
    lane.connectPromise = connectLaneSender(client, slot, lane).finally(() => {
      lane.connectPromise = null;
    });
  }
  return lane.connectPromise;
}

/**
 * Acquires the least-loaded healthy MTProtoSender from the persistent 2-lane DC pool
 * without GramJS's 30-second EXPORTED_SENDER_RELEASE_TIMEOUT or reconnect storms.
 */
export async function getDcSender(client: any, dcId?: number): Promise<any> {
  if (!client) throw new Error('Client is not initialized');

  const homeDcId = Number((client.session as any)?.dcId || 4);
  const targetDcId = Number(dcId || homeDcId);

  const state = getPoolState(client);
  let slot = state.slots.get(targetDcId);
  if (!slot) {
    slot = createDcSlot(targetDcId);
    state.slots.set(targetDcId, slot);
  }

  const healthyLanes = slot.lanes.filter((l) => l.sender && isDcSenderHealthy(l.sender));
  if (healthyLanes.length > 0) {
    healthyLanes.sort((a, b) => getSenderPendingCount(a.sender) - getSenderPendingCount(b.sender));
    const best = healthyLanes[0];

    // If Lane 0 has >= 2 in-flight requests and we already hold an authenticated DC key,
    // warm up Lane 1 in the background so rapid seeks bypass TCP head-of-line queueing!
    const hasAuthKey = Boolean(slot.authKey && typeof slot.authKey.getKey === 'function' && slot.authKey.getKey());
    if (
      healthyLanes.length < MAX_LANES_PER_DC &&
      hasAuthKey &&
      (targetDcId === homeDcId || slot.authenticated) &&
      getSenderPendingCount(best.sender) >= 2
    ) {
      const idleLane = slot.lanes.find((l) => (!l.sender || !isDcSenderHealthy(l.sender)) && !l.connectPromise);
      if (idleLane) {
        void ensureLaneConnected(client, slot, idleLane).catch(() => {});
      }
    }

    return best.sender;
  }

  return ensureLaneConnected(client, slot, slot.lanes[0]);
}

/**
 * Proactively warms both WebSocket lanes for `dcId` in the background so timeline
 * hover snapshots and rapid video seeks immediately run across 2 warm connections.
 */
export async function warmDcSenderLanes(client: any, dcId?: number): Promise<void> {
  if (!client || client._destroyed) return;
  try {
    const homeDcId = Number((client.session as any)?.dcId || 4);
    const targetDcId = Number(dcId || homeDcId);
    await getDcSender(client, targetDcId);
    const state = clientPools.get(client);
    const slot = state?.slots.get(targetDcId);
    if (!slot) return;
    const hasAuthKey = Boolean(slot.authKey && typeof slot.authKey.getKey === 'function' && slot.authKey.getKey());
    if (!hasAuthKey || (targetDcId !== homeDcId && !slot.authenticated)) return;
    // Proactively warm 2 lanes (Lane 0 & Lane 1); Lane 2 auto-scales on active video + scrub load
    const warmupCount = Math.min(2, slot.lanes.length);
    for (let i = 0; i < warmupCount; i++) {
      const lane = slot.lanes[i];
      if ((!lane.sender || !isDcSenderHealthy(lane.sender)) && !lane.connectPromise) {
        void ensureLaneConnected(client, slot, lane).catch(() => {});
      }
    }
  } catch {
    // ignore background warm errors
  }
}

/* ============================================================================
 * DIRECT POOLED RPC DISPATCH & INVALIDATION
 * ============================================================================ */
const senderLayerInitLocks = new WeakMap<object, Promise<void>>();

async function ensureSenderLayerInited(client: any, sender: any): Promise<void> {
  if (!sender || typeof sender !== 'object') return;
  let lock = senderLayerInitLocks.get(sender);
  if (!lock) {
    lock = (async () => {
      const initQuery = await buildInitConnectionQuery(client, new Api.help.GetConfig());
      await sender.send(
        new Api.InvokeWithLayer({
          layer: LAYER,
          query: initQuery,
        }),
      );
    })().finally(() => {
      senderLayerInitLocks.delete(sender);
    });
    senderLayerInitLocks.set(sender, lock);
  }
  await lock;
}

export async function sendWithDcSender<T = any>(
  client: any,
  dcId: number | undefined,
  request: any,
  timeoutMs = 14000,
): Promise<{ result: T; sender: any }> {
  const sender = await getDcSender(client, dcId);
  if (!sender || typeof sender.send !== 'function') {
    const fallbackRes = await (client as any).invokeWithSender(request, sender);
    return { result: fallbackRes, sender };
  }

  const execOnce = async () => {
    let timer: any = null;
    try {
      return await Promise.race([
        sender.send(request),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('TIMEOUT')), timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  try {
    const result = await execOnce();
    return { result, sender };
  } catch (err: any) {
    const errMsg = String(err?.message || err?.errorMessage || err || '');
    if (/CONNECTION_NOT_INITED/i.test(errMsg) && isDcSenderHealthy(sender)) {
      await ensureSenderLayerInited(client, sender);
      const retryResult = await execOnce();
      return { result: retryResult, sender };
    }
    throw Object.assign(err instanceof Error ? err : new Error(errMsg), {
      _zudSenderUsed: sender,
      newDc: err?.newDc,
      seconds: err?.seconds,
      errorMessage: err?.errorMessage,
    });
  }
}

/**
 * Marks a sender unhealthy and tears it down cleanly so the next `getDcSender`
 * uses another healthy lane or opens a fresh WebSocket.
 */
export async function invalidateDcSender(
  client: any,
  dcId?: number,
  badSender?: any,
  opts?: { clearAuth?: boolean },
): Promise<void> {
  if (!client) return;
  const homeDcId = Number((client.session as any)?.dcId || 4);
  const targetDcId = Number(dcId || homeDcId);
  const state = clientPools.get(client);
  if (!state) return;
  const slot = state.slots.get(targetDcId);
  if (!slot) return;

  if (opts?.clearAuth) {
    slot.authenticated = false;
    if (targetDcId !== homeDcId) {
      slot.authKey = null;
    }
  }

  if (badSender && badSender === client._sender) {
    return;
  }

  const jobs: Promise<void>[] = [];
  for (const lane of slot.lanes) {
    if (!badSender || lane.sender === badSender) {
      const target = lane.sender;
      if (target && target !== client._sender) {
        lane.sender = null;
        lane.layerInitialized = false;
        jobs.push(teardownSender(target, 'Sender invalidated'));
      }
    }
  }
  if (jobs.length > 0) {
    await Promise.allSettled(jobs);
  }
}

export async function disconnectClientDcSenders(client: any): Promise<void> {
  if (!client) return;
  const state = clientPools.get(client);
  if (!state) return;

  const jobs: Promise<void>[] = [];
  for (const slot of state.slots.values()) {
    slot.authenticated = false;
    for (const lane of slot.lanes) {
      const s = lane.sender;
      lane.sender = null;
      lane.layerInitialized = false;
      if (s && s !== client._sender) {
        jobs.push(teardownSender(s, 'Client disconnected'));
      }
    }
  }
  state.slots.clear();
  await Promise.allSettled(jobs);
}

/* ============================================================================
 * Per-DC Priority Concurrency Limiter for GetFile RPCs
 * Caps active chunk RPCs across each DC's dual lanes while detaching cancelled
 * seeks immediately so fresh seeks or newly opened videos NEVER block behind
 * orphaned chunks from a closed video or skipped timeline position.
 * ============================================================================ */

const MAX_CONCURRENT_RPC_PER_DC = 10;
const MAX_WIRE_INFLIGHT_PER_DC = 15;

interface RpcWaiter {
  priority: number;
  seq: number;
  isCancelled: () => boolean;
  grant: (counted: boolean) => void;
}

interface DcGateState {
  active: number;
  wireInflight: number;
  waiters: RpcWaiter[];
}

const dcGates = new Map<number, DcGateState>();
let rpcWaiterSeq = 0;

function getDcGate(dcId: number): DcGateState {
  let g = dcGates.get(dcId);
  if (!g) {
    g = { active: 0, wireInflight: 0, waiters: [] };
    dcGates.set(dcId, g);
  }
  return g;
}

function pumpDcGate(dcId: number) {
  const g = getDcGate(dcId);
  if (g.waiters.length === 0) return;

  g.waiters.sort((a, b) => a.priority - b.priority || a.seq - b.seq);

  while (g.waiters.length > 0 && g.waiters[0].isCancelled()) {
    const stale = g.waiters.shift()!;
    stale.grant(false);
  }

  while (
    g.active < MAX_CONCURRENT_RPC_PER_DC &&
    g.wireInflight < MAX_WIRE_INFLIGHT_PER_DC &&
    g.waiters.length > 0
  ) {
    const next = g.waiters.shift()!;
    if (next.isCancelled()) {
      next.grant(false);
      continue;
    }
    g.active++;
    g.wireInflight++;
    next.grant(true);
  }
}

export interface DcSlotHandle {
  acquired: boolean;
  /** Frees the logical concurrency slot early when a seek/video is cancelled while RPC finishes on wire */
  detachLogicalSlot: () => void;
  /** Called in `finally` when the underlying wire RPC settles */
  release: () => void;
}

function makeAcquiredHandle(dcId: number, g: DcGateState): DcSlotHandle {
  let logicalReleased = false;
  let wireReleased = false;
  return {
    acquired: true,
    detachLogicalSlot: () => {
      if (logicalReleased) return;
      logicalReleased = true;
      g.active = Math.max(0, g.active - 1);
      pumpDcGate(dcId);
    },
    release: () => {
      if (!logicalReleased) {
        logicalReleased = true;
        g.active = Math.max(0, g.active - 1);
      }
      if (!wireReleased) {
        wireReleased = true;
        g.wireInflight = Math.max(0, g.wireInflight - 1);
      }
      pumpDcGate(dcId);
    },
  };
}

const EMPTY_SLOT_HANDLE: DcSlotHandle = {
  acquired: false,
  detachLogicalSlot: () => {},
  release: () => {},
};

export async function acquireDcDownloadSlot(
  dcId: number,
  priority: number,
  isCancelled: () => boolean,
  onAbort?: (cancelWaiter: () => void) => void,
): Promise<DcSlotHandle> {
  const effectiveDc = Number(dcId || 4);
  if (isCancelled()) {
    return EMPTY_SLOT_HANDLE;
  }

  const g = getDcGate(effectiveDc);
  if (
    g.active < MAX_CONCURRENT_RPC_PER_DC &&
    g.wireInflight < MAX_WIRE_INFLIGHT_PER_DC &&
    g.waiters.length === 0
  ) {
    g.active++;
    g.wireInflight++;
    return makeAcquiredHandle(effectiveDc, g);
  }

  return new Promise((resolve) => {
    let settled = false;
    const waiter: RpcWaiter = {
      priority,
      seq: rpcWaiterSeq++,
      isCancelled,
      grant: (counted: boolean) => {
        if (settled) {
          if (counted) {
            g.active = Math.max(0, g.active - 1);
            g.wireInflight = Math.max(0, g.wireInflight - 1);
            pumpDcGate(effectiveDc);
          }
          return;
        }
        settled = true;
        if (!counted || isCancelled()) {
          if (counted) {
            g.active = Math.max(0, g.active - 1);
            g.wireInflight = Math.max(0, g.wireInflight - 1);
            pumpDcGate(effectiveDc);
          }
          resolve(EMPTY_SLOT_HANDLE);
          return;
        }
        resolve(makeAcquiredHandle(effectiveDc, g));
      },
    };
    g.waiters.push(waiter);
    if (onAbort) {
      onAbort(() => {
        if (settled) return;
        const idx = g.waiters.indexOf(waiter);
        if (idx !== -1) {
          g.waiters.splice(idx, 1);
        }
        waiter.grant(false);
      });
    }
    pumpDcGate(effectiveDc);
  });
}
