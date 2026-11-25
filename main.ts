import { serveDir, serveFile } from "https://deno.land/std@0.224.0/http/file_server.ts";

/**
 * Handles Telegram MTProto WebSocket proxying.
 * Upgrades incoming client WebSocket, connects to the requested Telegram DC,
 * and streams MTProto binary frames bidirectionally.
 */
function handleTgWebSocketProxy(req: Request, url: URL): Response {
  let targetIp = url.searchParams.get("ip") || "vesta.web.telegram.org";
  targetIp = targetIp.replace(/^https?:\/\//, '').replace(/^wss?:\/\//, '').split('/')[0].split(':')[0];
  const targetPort = url.searchParams.get("port") || "443";
  const isTest = url.searchParams.get("test") === "1";

  const dcParam = url.searchParams.get("dc");
  if (dcParam) {
    const dcMap: Record<string, string> = {
      "1": "pluto.web.telegram.org",
      "2": "venus.web.telegram.org",
      "3": "aurora.web.telegram.org",
      "4": "vesta.web.telegram.org",
      "5": "flora.web.telegram.org",
    };
    if (dcMap[dcParam]) {
      targetIp = dcMap[dcParam];
    }
  }

  // Security: only allow connections to Telegram's Web MTProto infrastructure
  const isAllowedHost =
    targetIp.endsWith(".web.telegram.org") ||
    targetIp === "web.telegram.org" ||
    /^149\.154\.(16[0-7]|17[0-5])\.\d+$/.test(targetIp) ||
    /^91\.108\.(4|5[6-9]|60)\.\d+$/.test(targetIp);

  if (!isAllowedHost) {
    return new Response("Forbidden target host: " + targetIp, { status: 403 });
  }

  const secProto = req.headers.get("sec-websocket-protocol");
  const protocol = secProto ? secProto.split(",")[0].trim() : undefined;

  let upgradeResult;
  try {
    upgradeResult = Deno.upgradeWebSocket(req, protocol ? { protocol } : undefined);
  } catch (err) {
    console.error("[Deno TG Proxy] Upgrade failed:", err);
    return new Response("WebSocket upgrade failed: " + err, { status: 400 });
  }

  const { socket: clientWs, response } = upgradeResult;
  clientWs.binaryType = "arraybuffer";

  // Target Telegram WebSocket endpoint
  const targetUrl = `wss://${targetIp}:${targetPort}/apiws${isTest ? "_test" : ""}`;

  let tgWs: WebSocket | null = null;
  const earlyClientQueue: Array<string | ArrayBuffer | ArrayBufferView | Blob> = [];
  let isTgOpen = false;

  try {
    tgWs = new WebSocket(targetUrl, protocol ? [protocol] : ["binary"]);
    tgWs.binaryType = "arraybuffer";
  } catch (err) {
    console.error("[Deno TG Proxy] Failed to connect to Telegram:", err);
    try {
      clientWs.close(1011, "Failed to connect to Telegram");
    } catch (_) {}
    return response;
  }

  // Forward client messages to Telegram
  clientWs.onmessage = (event) => {
    if (isTgOpen && tgWs && tgWs.readyState === WebSocket.OPEN) {
      tgWs.send(event.data);
    } else {
      earlyClientQueue.push(event.data);
    }
  };

  // When Telegram WebSocket opens, flush any queued messages
  tgWs.onopen = () => {
    isTgOpen = true;
    while (earlyClientQueue.length > 0 && tgWs && tgWs.readyState === WebSocket.OPEN) {
      const msg = earlyClientQueue.shift();
      if (msg) tgWs.send(msg);
    }
  };

  // Forward Telegram messages to client
  tgWs.onmessage = (event) => {
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(event.data);
    }
  };

  const cleanup = () => {
    try {
      if (clientWs.readyState === WebSocket.OPEN || clientWs.readyState === WebSocket.CONNECTING) {
        clientWs.close();
      }
    } catch (_) {}
    try {
      if (tgWs && (tgWs.readyState === WebSocket.OPEN || tgWs.readyState === WebSocket.CONNECTING)) {
        tgWs.close();
      }
    } catch (_) {}
  };

  clientWs.onerror = (e) => {
    console.warn("[Deno TG Proxy] Client socket error:", e);
    cleanup();
  };

  clientWs.onclose = (e) => {
    try {
      if (tgWs && (tgWs.readyState === WebSocket.OPEN || tgWs.readyState === WebSocket.CONNECTING)) {
        const safeCode = (e.code === 1000 || (e.code >= 3000 && e.code <= 4999)) ? e.code : 1000;
        tgWs.close(safeCode);
      }
    } catch (_) {
      try { tgWs?.close(); } catch (_) {}
    }
  };

  tgWs.onerror = (e) => {
    console.warn("[Deno TG Proxy] Telegram socket error:", e);
    cleanup();
  };

  tgWs.onclose = (e) => {
    try {
      if (clientWs.readyState === WebSocket.OPEN) {
        const safeCode = (e.code === 1000 || (e.code >= 3000 && e.code <= 4999)) ? e.code : 1000;
        clientWs.close(safeCode);
      }
    } catch (_) {
      try { clientWs?.close(); } catch (_) {}
    }
  };

  return response;
}

/**
 * Proxies artwork / cover images from external CDNs so they load smoothly
 * without CORS or geo-blocking restrictions.
 */
async function handleCoverProxy(req: Request, url: URL): Promise<Response> {
  const targetUrl = url.searchParams.get("url");
  if (!targetUrl) {
    return new Response("Missing url param", { status: 400 });
  }

  try {
    const parsed = new URL(targetUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return new Response("Invalid protocol", { status: 400 });
    }

    const res = await fetch(targetUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept": "image/*,*/*;q=0.8",
      },
    });

    if (!res.ok) {
      return new Response("Cover fetch failed", { status: res.status });
    }

    const headers = new Headers();
    headers.set("Content-Type", res.headers.get("content-type") || "image/jpeg");
    headers.set("Cache-Control", "public, max-age=31536000, immutable");
    headers.set("Access-Control-Allow-Origin", "*");
    headers.set("Cross-Origin-Resource-Policy", "cross-origin");

    return new Response(res.body, {
      status: 200,
      headers,
    });
  } catch (err) {
    return new Response(String(err), { status: 500 });
  }
}

/**
 * Proxies song search requests to iTunes API to reliably retrieve 1000x1000 album covers.
 */
async function handleItunesProxy(req: Request, url: URL): Promise<Response> {
  const query = url.searchParams.get("query") || url.searchParams.get("term") || "";
  if (!query) {
    return new Response(JSON.stringify({ resultCount: 0, results: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  }

  try {
    const itunesUrl = `https://itunes.apple.com/search?term=${encodeURIComponent(query)}&entity=song&limit=1`;
    const res = await fetch(itunesUrl);
    const data = await res.text();

    return new Response(data, {
      status: res.status,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=86400",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", },
    });
  }
}

/**
 * Injects required security headers (COOP, COEP, CORS) for OPFS direct-to-disk
 * downloads, Web Workers, and streaming media playback.
 */
function applySecurityHeaders(res: Response, pathname: string): Response {
  const headers = new Headers(res.headers);
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
  headers.set("Cross-Origin-Embedder-Policy", "credentialless");
  headers.set("Access-Control-Allow-Origin", "*");

  if (pathname === "/" || pathname === "/index.html") {
    headers.set("Cache-Control", "no-cache, no-store, must-revalidate");
  } else if (pathname === "/sw.js") {
    headers.set("Cache-Control", "no-cache, no-store, must-revalidate");
    headers.set("Content-Type", "application/javascript; charset=UTF-8");
    headers.set("Service-Worker-Allowed", "/");
  } else if (pathname.startsWith("/assets/")) {
    headers.set("Cache-Control", "public, max-age=31536000, immutable");
  }

  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}

/**
 * Central request router handling both Deno.serve and export default.fetch
 */
export async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);

  // 1. WebSocket upgrade for Telegram MTProto traffic
  if (req.headers.get("upgrade")?.toLowerCase() === "websocket" || url.pathname === "/apiws" || url.pathname === "/tgws") {
    return handleTgWebSocketProxy(req, url);
  }

  // 2. Health check
  if (url.pathname === "/api/health") {
    return new Response(JSON.stringify({
      status: "ok",
      service: "ZUD-Cloud",
      runtime: "Deno Deploy",
      timestamp: Date.now()
    }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-cache",
      },
    });
  }

  // 3. HTTP APIs (cover proxy, iTunes search)
  if (url.pathname === "/api/cover" || url.pathname === "/cover") {
    return await handleCoverProxy(req, url);
  }

  if (url.pathname === "/api/itunes") {
    return await handleItunesProxy(req, url);
  }

  // 4. Primary HTML entrypoint: serve index.html with COOP/COEP
  if (url.pathname === "/" || url.pathname === "/index.html") {
    try {
      const indexRes = await serveFile(req, "./dist/index.html");
      return applySecurityHeaders(indexRes, "/index.html");
    } catch (_) {
      try {
        const rootIndex = await serveFile(req, "./index.html");
        return applySecurityHeaders(rootIndex, "/index.html");
      } catch (_) {}
    }
  }

  // 5. Static asset serving (try ./dist first, then fallback to root .)
  try {
    let response = await serveDir(req, {
      fsRoot: "./dist",
      showDirListing: false,
      enableCors: true,
      quiet: true,
    });

    if (response.status === 404) {
      response = await serveDir(req, {
        fsRoot: ".",
        showDirListing: false,
        enableCors: true,
        quiet: true,
      });
    }

    // 6. SPA fallback for client-side routes (e.g. /folders/... or /search)
    if (response.status === 404 && !url.pathname.startsWith("/assets/") && !url.pathname.includes(".")) {
      try {
        const spaIndex = await serveFile(req, "./dist/index.html");
        return applySecurityHeaders(spaIndex, "/index.html");
      } catch (_) {
        try {
          const rootSpa = await serveFile(req, "./index.html");
          return applySecurityHeaders(rootSpa, "/index.html");
        } catch (_) {}
      }
    }

    return applySecurityHeaders(response, url.pathname);
  } catch (err) {
    console.error("[Static Server Error]", err);
    try {
      const fallback = await serveFile(req, "./dist/index.html");
      return applySecurityHeaders(fallback, "/index.html");
    } catch (_) {
      try {
        const rootFallback = await serveFile(req, "./index.html");
        return applySecurityHeaders(rootFallback, "/index.html");
      } catch (_) {
        return new Response("Service initializing, please reload in a moment.", { status: 503 });
      }
    }
  }
}

export default {
  fetch: handleRequest,
};

Deno.serve(handleRequest);
