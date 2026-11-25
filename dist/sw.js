const THUMB_CACHE = 'zud-thumbs-v1';
const THUMB_TIMEOUT_MS = 25000;
const THUMB_CACHE_MAX_ENTRIES = 6000;
const SHELL_CACHE = 'zud-shell-v5';

const PRECACHE_URLS = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/manifest.json',
  '/cloud.png?v=3',
  '/cloud.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-192.png',
  '/icons/icon-maskable-512.png',
  '/icons/apple-touch-icon.png'
];

const inflightThumbs = new Map();
let putsSinceTrim = 0;

async function pruneOldVersions(cache, request) {
  const url = new URL(request.url);
  const keys = await cache.keys(new Request(url.origin + url.pathname), { ignoreSearch: true });
  await Promise.all(
    keys.filter((k) => k.url !== request.url).map((k) => cache.delete(k))
  );
}

async function trimCache(cache) {
  putsSinceTrim++;
  if (putsSinceTrim < 50) return;
  putsSinceTrim = 0;
  const keys = await cache.keys();
  if (keys.length > THUMB_CACHE_MAX_ENTRIES) {
    const excess = keys.length - THUMB_CACHE_MAX_ENTRIES + 500;
    await Promise.all(keys.slice(0, excess).map((k) => cache.delete(k)));
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(PRECACHE_URLS)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((key) => key !== THUMB_CACHE && key !== SHELL_CACHE).map((key) => caches.delete(key))
      );
      await self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  if (
    url.pathname === '/ws' ||
    url.pathname.startsWith('/ws/') ||
    url.pathname === '/apiws' ||
    url.pathname.startsWith('/apiws/') ||
    url.pathname === '/tgws' ||
    url.pathname.startsWith('/tgws/') ||
    url.pathname === '/health' ||
    url.pathname === '/api/health' ||
    url.pathname === '/api/itunes' ||
    event.request.headers.get('Upgrade')?.toLowerCase() === 'websocket' ||
    url.protocol === 'ws:' ||
    url.protocol === 'wss:'
  ) {
    return;
  }

  if (url.pathname.startsWith('/cover') || url.pathname.startsWith('/api/cover')) {
    const targetUrl = url.searchParams.get('url');
    if (!targetUrl) {
      event.respondWith(new Response(null, { status: 400 }));
      return;
    }
    
    event.respondWith(
      (async () => {
        const cache = await caches.open(THUMB_CACHE);
        const cachedResponse = await cache.match(event.request);
        if (cachedResponse) {
          return cachedResponse;
        }

        try {
          let res = await fetch(`/api/cover?url=${encodeURIComponent(targetUrl)}`).catch(() => null);
          if (!res || !res.ok) {
            res = await fetch(targetUrl, { mode: 'cors' }).catch(() => null);
          }
          if (res && res.ok) {
            const blob = await res.blob();
            const response = new Response(blob, {
              status: 200,
              headers: {
                'Content-Type': res.headers.get('content-type') || 'image/jpeg',
                'Cross-Origin-Resource-Policy': 'cross-origin',
                'Access-Control-Allow-Origin': '*',
                'Cache-Control': 'public, max-age=31536000'
              }
            });
            try {
              await cache.put(event.request, response.clone());
            } catch (_e) {}
            return response;
          }
        } catch (e) {
          console.warn('SW failed to proxy cover:', e);
        }
        return new Response(null, { status: 404 });
      })()
    );
    return;
  }
  
  // 3. Message Thumbnail
  if (url.pathname.startsWith('/thumb/')) {
    const messageId = decodeURIComponent(url.pathname.substring(7));
    
    event.respondWith(
      (async () => {
        const cache = await caches.open(THUMB_CACHE);
        const cachedResponse = await cache.match(event.request);
        if (cachedResponse) {
          return cachedResponse;
        }

        const inflightKey = event.request.url;
        const existing = inflightThumbs.get(inflightKey);
        if (existing) {
          const shared = await existing;
          return shared.clone();
        }

        const job = (async () => {
          let clients = await self.clients.matchAll({ includeUncontrolled: true, type: 'window' });
          let targetClient = event.clientId ? await self.clients.get(event.clientId) : null;
          if (!targetClient && clients.length > 0) targetClient = clients[0];
          
          if (!targetClient) {
            return new Response('No active client found', { status: 500 });
          }
          
          const messageChannel = new MessageChannel();
          const reqId = Math.random().toString(36).substring(7);
          
          const reqPromise = new Promise((resolve) => {
            const timeout = setTimeout(() => {
              messageChannel.port1.onmessage = null;
              resolve(new Response(null, { status: 504 }));
            }, THUMB_TIMEOUT_MS);

            messageChannel.port1.onmessage = async (msgEvent) => {
              if (msgEvent.data.type === 'DATA') {
                clearTimeout(timeout);
                const response = new Response(msgEvent.data.blob, {
                  status: 200,
                  headers: {
                    'Content-Type': 'image/jpeg',
                    'Cross-Origin-Resource-Policy': 'cross-origin',
                    'Access-Control-Allow-Origin': '*',
                    'Cache-Control': 'public, max-age=31536000'
                  }
                });
                try {
                  await cache.put(event.request, response.clone());
                  await pruneOldVersions(cache, event.request);
                  await trimCache(cache);
                } catch (_e) {}
                resolve(response);
              } else if (msgEvent.data.type === 'ERROR') {
                clearTimeout(timeout);
                resolve(new Response(null, { status: 404 }));
              }
            };
          });

          targetClient.postMessage({
            type: 'FETCH_THUMB',
            id: reqId,
            messageId
          }, [messageChannel.port2]);

          return await reqPromise;
        })();

        inflightThumbs.set(inflightKey, job);
        try {
          return (await job).clone();
        } finally {
          inflightThumbs.delete(inflightKey);
        }
      })()
    );
    return;
  }

  // 4. Telegram Stream Requests (High-speed range requests / media playback)
  if (url.pathname.startsWith('/stream/')) {
    const fileId = decodeURIComponent(url.pathname.substring(8));
    const rangeHeader = event.request.headers.get('Range') || 'bytes=0-';
    const isPreviewRequest = url.searchParams.get('preview') === 'true';

    event.respondWith(
      (async () => {
        if (event.request.signal?.aborted) {
          return new Response(null, { status: 499, statusText: 'Client Closed Request' });
        }

        let clients = await self.clients.matchAll({ includeUncontrolled: true, type: 'window' });
        let targetClient = event.clientId ? await self.clients.get(event.clientId) : null;
        if (!targetClient && clients.length > 0) targetClient = clients[0];

        if (!targetClient) {
          return new Response('No active client found to fetch from Telegram', { status: 500 });
        }

        const messageChannel = new MessageChannel();
        const reqId = Math.random().toString(36).substring(7);
        let aborted = false;
        let onAbort = null;

        const cleanupAbort = () => {
          if (onAbort && event.request.signal) {
            try {
              event.request.signal.removeEventListener('abort', onAbort);
            } catch (_) {}
            onAbort = null;
          }
        };

        const reqPromise = new Promise((resolve, reject) => {
          let settled = false;
          let streamController = null;
          let streamClosed = false;

          const closePort = () => {
            try { messageChannel.port1.onmessage = null; } catch (_) {}
            try { messageChannel.port1.close(); } catch (_) {}
          };

          const closeStreamSafe = () => {
            if (!streamController || streamClosed) return;
            streamClosed = true;
            try { streamController.close(); } catch (_) {}
          };

          const requestTimeout = setTimeout(() => {
            if (settled) return;
            settled = true;
            cleanupAbort();
            try { messageChannel.port1.postMessage({ type: 'CANCEL' }); } catch (_) {}
            closePort();
            reject(new Error('Telegram stream request timed out'));
          }, 120000);

          if (event.request.signal) {
            onAbort = () => {
              aborted = true;
              try { messageChannel.port1.postMessage({ type: 'CANCEL' }); } catch (_) {}
              closePort();
              closeStreamSafe();
              if (!settled) {
                settled = true;
                clearTimeout(requestTimeout);
                cleanupAbort();
                resolve(new Response(null, { status: 499, statusText: 'Client Closed Request' }));
              }
            };
            event.request.signal.addEventListener('abort', onAbort, { once: true });
          }

          messageChannel.port1.onmessage = (msgEvent) => {
            const data = msgEvent.data;
            if (!data) return;

            if (data.type === 'HEADERS') {
              if (settled) return;
              settled = true;
              clearTimeout(requestTimeout);

              if (data.start >= data.total) {
                cleanupAbort();
                closePort();
                resolve(new Response(null, {
                  status: 416,
                  headers: { 'Content-Range': `bytes */${data.total}` }
                }));
                return;
              }

              const streamHighWaterMark = data.preview ? 2 * 1024 * 1024 : 6 * 1024 * 1024;
              const stream = new ReadableStream({
                start(controller) {
                  streamController = controller;
                  if (aborted) {
                    closeStreamSafe();
                    cleanupAbort();
                    closePort();
                    return;
                  }
                  messageChannel.port1.onmessage = (e) => {
                    const msg = e.data;
                    if (!msg) return;
                    if (msg.type === 'DATA') {
                      if (!streamClosed && !aborted) {
                        try {
                          controller.enqueue(msg.chunk);
                        } catch (_e) {
                          streamClosed = true;
                        }
                      }
                    } else if (msg.type === 'END') {
                      closeStreamSafe();
                      cleanupAbort();
                      closePort();
                    } else if (msg.type === 'CANCEL') {
                      closeStreamSafe();
                      cleanupAbort();
                      closePort();
                    } else if (msg.type === 'ERROR') {
                      if (!streamClosed) {
                        streamClosed = true;
                        if (aborted) {
                          try { controller.close(); } catch (_e) {}
                        } else {
                          try {
                            controller.error(new Error(msg.error || 'Stream error'));
                          } catch (_e) {}
                        }
                      }
                      cleanupAbort();
                      closePort();
                    }
                  };
                },
                pull() {
                  if (aborted || streamClosed) return;
                  try {
                    messageChannel.port1.postMessage({ type: 'PULL' });
                  } catch (_) {}
                },
                cancel() {
                  streamClosed = true;
                  cleanupAbort();
                  try {
                    messageChannel.port1.postMessage({ type: 'CANCEL' });
                  } catch (_) {}
                  closePort();
                }
              }, {
                highWaterMark: streamHighWaterMark,
                size(chunk) { return chunk ? chunk.byteLength : 0; }
              });

              let mimeType = data.mimeType || 'application/octet-stream';
              if (mimeType.startsWith('video/')) {
                  if (mimeType.includes('quicktime') || mimeType.includes('x-m4v')) {
                      mimeType = 'video/mp4';
                  }
              } else if (mimeType.startsWith('audio/') || mimeType.includes('audio') || mimeType.includes('mpeg') || mimeType.includes('mp3')) {
                  if (mimeType.includes('mp3') || mimeType.includes('mpeg3') || mimeType.includes('x-mp3') || mimeType === 'audio/mpeg') {
                      mimeType = 'audio/mpeg';
                  } else if (mimeType.includes('m4a') || mimeType.includes('x-m4a') || mimeType.includes('aac')) {
                      mimeType = 'audio/mp4';
                  } else if (mimeType.includes('flac')) {
                      mimeType = 'audio/flac';
                  } else if (mimeType.includes('wav')) {
                      mimeType = 'audio/wav';
                  } else if (mimeType.includes('ogg') || mimeType.includes('opus')) {
                      mimeType = 'audio/ogg';
                  }
              }

              const responseHeaders = {
                'Content-Range': `bytes ${data.start}-${data.end}/${data.total}`,
                'Accept-Ranges': 'bytes',
                'Content-Length': (data.end - data.start + 1).toString(),
                'Content-Type': mimeType,
                'Cache-Control': data.preview ? 'private, max-age=30' : 'no-cache'
              };
              if (url.searchParams.get('download') === '1') {
                responseHeaders['Content-Disposition'] = `attachment; filename="${encodeURIComponent(fileId.split('/').pop() || 'file')}"`;
              }

              resolve(new Response(stream, {
                status: 206,
                headers: responseHeaders
              }));
            } else if (data.type === 'CANCEL') {
              if (settled) return;
              settled = true;
              clearTimeout(requestTimeout);
              cleanupAbort();
              closePort();
              resolve(new Response(null, { status: 499, statusText: 'Stream Cancelled' }));
            } else if (data.type === 'ERROR') {
              if (settled) return;
              settled = true;
              clearTimeout(requestTimeout);
              cleanupAbort();
              closePort();
              if (aborted) {
                resolve(new Response(null, { status: 499, statusText: 'Client Closed Request' }));
              } else {
                reject(new Error(data.error || 'Stream error'));
              }
            }
          };
        });

        targetClient.postMessage({
          type: 'FETCH_CHUNK',
          id: reqId,
          fileId,
          url: event.request.url,
          range: rangeHeader,
          preview: isPreviewRequest
        }, [messageChannel.port2]);

        try {
          return await reqPromise;
        } catch (err) {
          cleanupAbort();
          if (aborted || event.request.signal?.aborted) {
            return new Response(null, { status: 499, statusText: 'Client Closed Request' });
          }
          console.error("SW Fetch Error:", err);
          return new Response(err?.message || 'Stream error', { status: 502 });
        }
      })()
    );
    return;
  }

  // 5. Static Assets Caching (Stale-While-Revalidate for PWA shell)
  if (
    url.origin === self.location.origin &&
    (url.pathname.startsWith('/assets/') ||
     url.pathname.startsWith('/icons/') ||
     url.pathname.endsWith('.png') ||
     url.pathname.endsWith('.svg') ||
     url.pathname.endsWith('.webmanifest') ||
     url.pathname.endsWith('.json') ||
     url.pathname.endsWith('.woff2') ||
     url.pathname.endsWith('.css') ||
     url.pathname.endsWith('.js'))
  ) {
    event.respondWith(
      (async () => {
        const cached = await caches.match(event.request);
        const fetchPromise = fetch(event.request).then((networkRes) => {
          if (networkRes && networkRes.ok) {
            const clone = networkRes.clone();
            caches.open(SHELL_CACHE).then((cache) => cache.put(event.request, clone));
          }
          return networkRes;
        }).catch(() => null);

        return cached || (await fetchPromise) || new Response(null, { status: 404 });
      })()
    );
    return;
  }

  // 6. Navigation requests (Network-first with index.html fallback)
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).catch(async () => {
        const cached = await caches.match('/index.html');
        return cached || new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } });
      })
    );
    return;
  }
});
