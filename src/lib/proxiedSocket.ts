import { PromisedWebSockets } from 'telegram/extensions';
import { Buffer } from 'buffer';

/* ============================================================================
 * CLOUDFLARE EDGE PROXY ROUTE CONFIGURATION
 * ============================================================================ */
const ROUTE_STORAGE_KEY = 'zud_working_route';
const PROBE_UNAVAILABLE_TTL_MS = 20_000;
const PROBE_AVAILABLE_TTL_MS = 300_000;
const DIRECT_CONNECT_TIMEOUT_MS = 6_500;
const PROXY_CONNECT_TIMEOUT_MS = 12_000;

type RouteKind = 'direct' | 'proxy';
type ProxyProbeState = 'unknown' | 'available' | 'unavailable';

let proxyProbeState: ProxyProbeState = 'unknown';
let proxyProbeCheckedAt = 0;
let activeProxyPath: '/ws' | '/apiws' = '/ws';
let inflightProxyProbe: Promise<ProxyProbeState> | null = null;

const closeError = new Error('WebSocket was closed');

function recordWorkingRoute(route: RouteKind) {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(ROUTE_STORAGE_KEY, route);
    }
  } catch {
    // ignore storage quota / privacy mode errors
  }
}

/* ============================================================================
 * TELEGRAM DC HOST MAPPING & PROXY URL BUILDER
 * ============================================================================ */
export const DC_DOMAINS: Record<string, string> = {
  '1': 'pluto.web.telegram.org',
  '2': 'venus.web.telegram.org',
  '3': 'aurora.web.telegram.org',
  '4': 'vesta.web.telegram.org',
  '5': 'flora.web.telegram.org',
};

export function resolveTelegramHost(ip: string): string {
  if (!ip) return 'vesta.web.telegram.org';
  const clean = String(ip)
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^wss?:\/\//, '')
    .split('/')[0]
    .split(':')[0];
  if (/^(pluto|venus|aurora|vesta|flora)(-1)?\.web\.telegram\.org$/.test(clean)) return clean;
  if (/^(pluto|venus|aurora|vesta|flora)(-1)?$/.test(clean)) return `${clean}.web.telegram.org`;
  if (/^149\.154\.175\.(5\d)/.test(clean)) return 'pluto.web.telegram.org';
  if (/^149\.154\.167\.([45]\d)/.test(clean)) return 'venus.web.telegram.org';
  if (/^149\.154\.175\.(1[01]\d)/.test(clean)) return 'aurora.web.telegram.org';
  if (/^149\.154\.167\.(9\d)/.test(clean)) return 'vesta.web.telegram.org';
  if (/^91\.108\.56\./.test(clean)) return 'flora.web.telegram.org';
  if (/^91\.108\.4\./.test(clean)) return 'pluto.web.telegram.org';
  return 'vesta.web.telegram.org';
}

function getShortDcAlias(dcHost: string): string {
  return dcHost.replace(/\.web\.telegram\.org$/i, '');
}

function getDirectWsUrl(dcHost: string, port: number, testServers: boolean): string {
  return port === 443
    ? `wss://${dcHost}/apiws${testServers ? '_test' : ''}`
    : `ws://${dcHost}:${port}/apiws${testServers ? '_test' : ''}`;
}

function buildSameOriginProxyUrl(
  path: '/ws' | '/apiws' | '/tgws',
  dcHost: string,
  port: number,
  testServers: boolean,
): string {
  const isHttps = window.location.protocol === 'https:';
  const wsProto = isHttps ? 'wss:' : 'ws:';
  if (path === '/ws') {
    const alias = getShortDcAlias(dcHost);
    const portQuery = port && port !== 443 ? `&port=${port}` : '';
    return `${wsProto}//${window.location.host}/ws?h=${encodeURIComponent(alias)}${portQuery}${testServers ? '&test=1' : ''}`;
  }
  return `${wsProto}//${window.location.host}${path}?ip=${encodeURIComponent(dcHost)}&port=${port}${testServers ? '&test=1' : ''}`;
}

function buildCustomProxyUrl(customProxy: string, dcHost: string, port: number, testServers: boolean): string {
  const trimmed = customProxy.replace(/\/+$/, '');
  const hasProto = trimmed.startsWith('ws://') || trimmed.startsWith('wss://');
  const proto = hasProto ? '' : (window.location.protocol === 'https:' ? 'wss://' : 'ws://');
  const base = `${proto}${trimmed}`;
  const alias = getShortDcAlias(dcHost);
  return `${base}/ws?h=${encodeURIComponent(alias)}&ip=${encodeURIComponent(dcHost)}&port=${port}${testServers ? '&test=1' : ''}`;
}

/* ============================================================================
 * EDGE PROXY READINESS PROBE & CANDIDATE SELECTION
 * ============================================================================ */
async function checkSingleProbeEndpoint(path: '/ws' | '/apiws'): Promise<ProxyProbeState> {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), 4000) : null;
  try {
    const res = await fetch(`${path}?probe=1`, {
      method: 'GET',
      cache: 'no-store',
      signal: controller?.signal,
    });
    const proxyHeader = (res.headers.get?.('x-zud-proxy') || '').toLowerCase();
    const ct = (res.headers.get?.('content-type') || '').toLowerCase();
    if (proxyHeader === 'ready') {
      activeProxyPath = path;
      return 'available';
    }
    if (ct.includes('text/html')) {
      return 'unavailable';
    }
    if (res.status === 426 || (ct.includes('application/json') && (res.ok || res.status === 400))) {
      activeProxyPath = path;
      return 'available';
    }
    return 'unavailable';
  } catch {
    return 'unknown';
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function probeSameOriginProxy(force = false): Promise<ProxyProbeState> {
  if (typeof window === 'undefined' || typeof fetch !== 'function') {
    return 'unavailable';
  }

  const now = Date.now();
  const ttl = proxyProbeState === 'available' ? PROBE_AVAILABLE_TTL_MS : PROBE_UNAVAILABLE_TTL_MS;
  if (!force && proxyProbeState !== 'unknown' && now - proxyProbeCheckedAt < ttl) {
    return proxyProbeState;
  }

  if (inflightProxyProbe) {
    return inflightProxyProbe;
  }

  inflightProxyProbe = (async () => {
    try {
      let state = await checkSingleProbeEndpoint('/ws');
      if (state === 'unavailable') {
        const legacyState = await checkSingleProbeEndpoint('/apiws');
        if (legacyState === 'available') {
          state = 'available';
        }
      }
      proxyProbeState = state;
      proxyProbeCheckedAt = Date.now();
      return proxyProbeState;
    } finally {
      inflightProxyProbe = null;
    }
  })();

  return inflightProxyProbe;
}

interface CandidateRoute {
  url: string;
  kind: RouteKind;
  timeoutMs: number;
}

async function getCandidateRoutes(ip: string, port: number, testServers: boolean): Promise<CandidateRoute[]> {
  const dcHost = resolveTelegramHost(ip);
  const directUrl = getDirectWsUrl(dcHost, port, testServers);

  if (typeof window === 'undefined' || !window.location) {
    return [{ url: directUrl, kind: 'direct', timeoutMs: DIRECT_CONNECT_TIMEOUT_MS }];
  }

  if (localStorage.getItem('zud_direct_tg') === 'true') {
    return [{ url: directUrl, kind: 'direct', timeoutMs: DIRECT_CONNECT_TIMEOUT_MS }];
  }

  const customProxy = localStorage.getItem('zud_custom_tg_proxy') || (import.meta as any).env?.VITE_TG_PROXY_URL;
  if (customProxy) {
    return [
      {
        url: buildCustomProxyUrl(customProxy, dcHost, port, testServers),
        kind: 'proxy',
        timeoutMs: PROXY_CONNECT_TIMEOUT_MS,
      },
      { url: directUrl, kind: 'direct', timeoutMs: DIRECT_CONNECT_TIMEOUT_MS },
    ];
  }

  const probe = await probeSameOriginProxy();
  const wsUrl = buildSameOriginProxyUrl('/ws', dcHost, port, testServers);
  const apiwsUrl = buildSameOriginProxyUrl('/apiws', dcHost, port, testServers);
  const directCandidate: CandidateRoute = {
    url: directUrl,
    kind: 'direct',
    timeoutMs: DIRECT_CONNECT_TIMEOUT_MS,
  };

  if (probe === 'unavailable') {
    return [directCandidate];
  }

  if (probe === 'available') {
    const primaryUrl = activeProxyPath === '/apiws' ? apiwsUrl : wsUrl;
    const secondaryUrl = activeProxyPath === '/apiws' ? wsUrl : apiwsUrl;
    return [
      { url: primaryUrl, kind: 'proxy', timeoutMs: PROXY_CONNECT_TIMEOUT_MS },
      { url: secondaryUrl, kind: 'proxy', timeoutMs: PROXY_CONNECT_TIMEOUT_MS },
      directCandidate,
    ];
  }

  return [
    { url: wsUrl, kind: 'proxy', timeoutMs: PROXY_CONNECT_TIMEOUT_MS },
    { url: apiwsUrl, kind: 'proxy', timeoutMs: PROXY_CONNECT_TIMEOUT_MS },
    directCandidate,
  ];
}

export function getProxiedWsLink(ip: string, port: number, testServers: boolean = false): string {
  const dcHost = resolveTelegramHost(ip);
  const directUrl = getDirectWsUrl(dcHost, port, testServers);

  if (typeof window === 'undefined' || !window.location) {
    return directUrl;
  }

  if (localStorage.getItem('zud_direct_tg') === 'true') {
    return directUrl;
  }

  const customProxy = localStorage.getItem('zud_custom_tg_proxy') || (import.meta as any).env?.VITE_TG_PROXY_URL;
  if (customProxy) {
    return buildCustomProxyUrl(customProxy, dcHost, port, testServers);
  }

  if (proxyProbeState === 'unavailable') {
    return directUrl;
  }

  return buildSameOriginProxyUrl(activeProxyPath, dcHost, port, testServers);
}

export class ProxiedPromisedWebSockets extends PromisedWebSockets {
  getWebSocketLink(ip: string, port: number, testServers: boolean): string {
    return (this as any)._pinnedWsUrl || getProxiedWsLink(ip, port, testServers);
  }
}

function detachOfflineListener(sock: any) {
  if (typeof window !== 'undefined' && sock?._offlineHandler) {
    try {
      window.removeEventListener('offline', sock._offlineHandler);
    } catch {
      // ignore
    }
    sock._offlineHandler = null;
  }
}

/* ============================================================================
 * BROWSER WEBSOCKET CONNECTION & GRAMJS PATCH
 * ============================================================================ */
function connectSingleBrowserUrl(
  sock: any,
  targetUrl: string,
  timeoutMs: number,
): Promise<any> {
  sock.stream = Buffer.alloc(0);
  sock.canRead = new Promise((resolve) => {
    sock.resolveRead = resolve;
  });
  sock.closed = false;
  sock.website = targetUrl;
  sock._pinnedWsUrl = targetUrl;
  sock._recvChain = Promise.resolve();

  detachOfflineListener(sock);

  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: any = null;
    let ws: WebSocket;

    const cleanupPendingSocket = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (ws) {
        ws.onopen = null;
        ws.onerror = null;
        ws.onclose = null;
        ws.onmessage = null;
        try {
          if (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN) {
            ws.close();
          }
        } catch {
          // ignore close errors
        }
      }
      sock.closed = true;
      detachOfflineListener(sock);
      try {
        sock.resolveRead?.(false);
      } catch {
        // ignore
      }
    };

    try {
      ws = new WebSocket(targetUrl, 'binary');
      ws.binaryType = 'arraybuffer';
      sock.client = ws;
    } catch (err) {
      sock.closed = true;
      reject(err);
      return;
    }

    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanupPendingSocket();
      reject(new Error(`WebSocket connection timeout to ${targetUrl} after ${timeoutMs}ms`));
    }, timeoutMs);

    ws.onopen = () => {
      if (settled) return;
      settled = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }

      const offlineHandler = () => {
        try {
          sock.close();
        } catch {
          // ignore
        }
      };
      sock._offlineHandler = offlineHandler;
      if (typeof window !== 'undefined') {
        window.addEventListener('offline', offlineHandler, { once: true });
      }

      ws.onmessage = (message: MessageEvent) => {
        const raw = message.data;
        if (raw instanceof ArrayBuffer) {
          sock._recvChain = sock._recvChain.then(() => {
            if (sock.closed) return;
            sock.stream = Buffer.concat([sock.stream, Buffer.from(raw)]);
            sock.resolveRead?.(true);
          });
        } else {
          sock._recvChain = sock._recvChain.then(async () => {
            if (sock.closed) return;
            const ab = await new Response(raw).arrayBuffer();
            if (sock.closed) return;
            sock.stream = Buffer.concat([sock.stream, Buffer.from(ab)]);
            sock.resolveRead?.(true);
          }).catch(() => {});
        }
      };

      ws.onerror = () => {
        if (!sock.closed) {
          sock.closed = true;
          detachOfflineListener(sock);
          try {
            sock.resolveRead?.(false);
          } catch {
            // ignore
          }
        }
      };

      ws.onclose = () => {
        sock.closed = true;
        detachOfflineListener(sock);
        try {
          sock.resolveRead?.(false);
        } catch {
          // ignore
        }
      };

      resolve(sock);
    };

    ws.onerror = () => {
      if (settled) return;
      settled = true;
      cleanupPendingSocket();
      reject(new Error(`WebSocket connection failed to ${targetUrl}`));
    };

    ws.onclose = () => {
      if (settled) return;
      settled = true;
      cleanupPendingSocket();
      reject(new Error(`WebSocket closed before opening to ${targetUrl}`));
    };
  });
}

let patchApplied = false;

export function applyProxiedWebSocketsPatch() {
  if (patchApplied) return;
  patchApplied = true;

  if (typeof window !== 'undefined') {
    void probeSameOriginProxy();
  }

  try {
    if (PromisedWebSockets && PromisedWebSockets.prototype) {
      const originalGetLink = PromisedWebSockets.prototype.getWebSocketLink;
      PromisedWebSockets.prototype.getWebSocketLink = function (ip: string, port: number, testServers: boolean) {
        if ((this as any)._pinnedWsUrl) {
          return (this as any)._pinnedWsUrl;
        }
        try {
          return getProxiedWsLink(ip, port, testServers);
        } catch {
          return originalGetLink ? originalGetLink.call(this, ip, port, testServers) : `wss://${ip}/apiws`;
        }
      };

      PromisedWebSockets.prototype.write = function (data: Buffer | Uint8Array | ArrayBuffer) {
        const ws: WebSocket | undefined = (this as any).client;
        if ((this as any).closed || !ws || ws.readyState !== 1) {
          throw closeError;
        }
        try {
          ws.send(data as any);
        } catch {
          try {
            (this as any).close();
          } catch {
            // ignore
          }
          throw closeError;
        }
      };

      PromisedWebSockets.prototype.close = async function () {
        const self = this as any;
        self.closed = true;
        detachOfflineListener(self);
        const ws: WebSocket | undefined = self.client;
        if (ws) {
          ws.onopen = null;
          ws.onerror = null;
          ws.onclose = null;
          ws.onmessage = null;
          try {
            if (ws.readyState === 0 || ws.readyState === 1) {
              ws.close();
            }
          } catch {
            // ignore
          }
        }
        try {
          self.resolveRead?.(false);
        } catch {
          // ignore
        }
      };

      const originalConnect = PromisedWebSockets.prototype.connect;
      PromisedWebSockets.prototype.connect = async function (port: number, ip: string, testServers: boolean = false) {
        if (typeof WebSocket === 'undefined' || typeof window === 'undefined') {
          return originalConnect.call(this, port, ip, testServers);
        }

        const routes = await getCandidateRoutes(ip, port, testServers);
        let lastErr: any = null;

        for (const route of routes) {
          try {
            const res = await connectSingleBrowserUrl(this, route.url, route.timeoutMs);
            recordWorkingRoute(route.kind);
            return res;
          } catch (err) {
            lastErr = err;
            if (route.kind === 'direct' && routes.length === 1) {
              const refreshed = await probeSameOriginProxy(true);
              if (refreshed === 'available') {
                const dcHost = resolveTelegramHost(ip);
                const fallbackProxy = buildSameOriginProxyUrl(activeProxyPath, dcHost, port, testServers);
                try {
                  const res = await connectSingleBrowserUrl(this, fallbackProxy, PROXY_CONNECT_TIMEOUT_MS);
                  recordWorkingRoute('proxy');
                  return res;
                } catch (proxyErr) {
                  lastErr = proxyErr;
                }
              }
            }
          }
        }

        console.warn('[ProxiedSocket] All WebSocket route candidates failed:', lastErr);
        throw lastErr || new Error('WebSocket connection failed');
      };

      console.log('✅ ProxiedPromisedWebSockets patch applied to GramJS MTProto connection pipeline!');
    }

    if (typeof window !== 'undefined') {
      (window as any).zudSetDirectTg = (enable: boolean) => {
        if (enable) {
          localStorage.setItem('zud_direct_tg', 'true');
          recordWorkingRoute('direct');
        } else {
          localStorage.removeItem('zud_direct_tg');
        }
        proxyProbeCheckedAt = 0;
        console.log(`Telegram direct connection set to: ${enable}`);
      };
      (window as any).zudSetCustomProxy = (proxyUrl: string) => {
        if (proxyUrl) {
          localStorage.setItem('zud_custom_tg_proxy', proxyUrl);
          recordWorkingRoute('proxy');
        } else {
          localStorage.removeItem('zud_custom_tg_proxy');
        }
        proxyProbeCheckedAt = 0;
        console.log(`Custom Telegram proxy set to: ${proxyUrl || 'default'}`);
      };
    }
  } catch (err) {
    console.warn('Could not apply ProxiedWebSockets patch:', err);
  }
}
