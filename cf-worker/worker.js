
/* ============================================================================
 * TELEGRAM DC HOST RESOLUTION & SOCKET CLEANUP
 * ============================================================================ */
const DC_MAP = {
  "1": "pluto.web.telegram.org",
  "2": "venus.web.telegram.org",
  "3": "aurora.web.telegram.org",
  "4": "vesta.web.telegram.org",
  "5": "flora.web.telegram.org",
};

const HOST_ALIAS_MAP = {
  "pluto": "pluto.web.telegram.org",
  "pluto-1": "pluto-1.web.telegram.org",
  "venus": "venus.web.telegram.org",
  "venus-1": "venus-1.web.telegram.org",
  "aurora": "aurora.web.telegram.org",
  "aurora-1": "aurora-1.web.telegram.org",
  "vesta": "vesta.web.telegram.org",
  "vesta-1": "vesta-1.web.telegram.org",
  "flora": "flora.web.telegram.org",
  "flora-1": "flora-1.web.telegram.org",
};

function resolveTelegramHost(rawInput, dcParam, isDownload) {
  if (dcParam && DC_MAP[String(dcParam)]) {
    const base = DC_MAP[String(dcParam)];
    return isDownload ? base.replace(".web.telegram.org", "-1.web.telegram.org") : base;
  }

  if (!rawInput) return "vesta.web.telegram.org";

  const clean = String(rawInput)
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^wss?:\/\//, "")
    .split("/")[0]
    .split(":")[0];

  if (HOST_ALIAS_MAP[clean]) {
    return HOST_ALIAS_MAP[clean];
  }

  if (/^(pluto|venus|aurora|vesta|flora)(-1)?\.web\.telegram\.org$/.test(clean)) {
    return clean;
  }

  if (/^149\.154\.175\.(5\d)$/.test(clean)) return "pluto.web.telegram.org";
  if (/^149\.154\.167\.([45]\d)$/.test(clean)) return "venus.web.telegram.org";
  if (/^149\.154\.175\.(1[01]\d)$/.test(clean)) return "aurora.web.telegram.org";
  if (/^149\.154\.167\.(9\d)$/.test(clean)) return "vesta.web.telegram.org";
  if (/^91\.108\.56\.\d+$/.test(clean)) return "flora.web.telegram.org";
  if (/^91\.108\.4\.\d+$/.test(clean)) return "pluto.web.telegram.org";

  return null;
}

function safeCloseSocket(ws, code, reason) {
  if (!ws) return;
  try {
    const validCode = code === 1000 || (typeof code === "number" && code >= 3000 && code <= 4999) ? code : 1000;
    ws.close(validCode, reason ? String(reason).slice(0, 100) : undefined);
  } catch (_) {
    try {
      ws.close();
    } catch (_e) {}
  }
}

/* ============================================================================
 * STATELESS ZERO-VPN MTPROTO WEBSOCKET RELAY
 * ============================================================================ */
async function handleWebSocketTunnel(request, url) {
  const upgradeHeader = request.headers.get("Upgrade") || request.headers.get("upgrade");
  if (!upgradeHeader || upgradeHeader.toLowerCase() !== "websocket") {
    const isProbe = url.searchParams.get("probe") === "1";
    return new Response(
      JSON.stringify({
        status: "ok",
        proxy: "zud-cloudflare-mtproto",
        time: Date.now(),
      }),
      {
        status: isProbe ? 200 : 426,
        headers: {
          "Content-Type": "application/json",
          "X-Zud-Proxy": "ready",
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Expose-Headers": "X-Zud-Proxy",
          "Cache-Control": "no-store, no-cache, must-revalidate",
        },
      }
    );
  }

  const hostHint = url.searchParams.get("h") || url.searchParams.get("ip") || "";
  const dcParam = url.searchParams.get("dc");
  const isDownload = url.searchParams.get("dl") === "1";
  const targetPort = url.searchParams.get("port") || "443";
  const isTest = url.searchParams.get("test") === "1";
  const targetHost = resolveTelegramHost(hostHint, dcParam, isDownload);

  if (!targetHost || !/^(pluto|venus|aurora|vesta|flora)(-1)?\.web\.telegram\.org$/.test(targetHost)) {
    return new Response("Forbidden target host", { status: 403 });
  }

  const WebSocketPairClass = globalThis.WebSocketPair;
  if (!WebSocketPairClass) {
    return new Response("WebSocketPair unavailable in runtime", { status: 500 });
  }

  const secProto = request.headers.get("Sec-WebSocket-Protocol") || request.headers.get("sec-websocket-protocol");
  const protocol = secProto
    ? secProto.split(",").map((s) => s.trim()).find((s) => s.toLowerCase() === "binary") || secProto.split(",")[0].trim()
    : "binary";

  const portSuffix = targetPort && targetPort !== "443" ? `:${targetPort}` : "";
  const targetUrl = `https://${targetHost}${portSuffix}/apiws${isTest ? "_test" : ""}`;

  try {
    const upstreamRes = await fetch(targetUrl, {
      method: "GET",
      headers: {
        Upgrade: "websocket",
        "Sec-WebSocket-Protocol": protocol || "binary",
        Origin: "https://web.telegram.org",
        "User-Agent":
          request.headers.get("User-Agent") ||
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
      },
    });

    const upstreamWs = upstreamRes.webSocket;
    if (!upstreamWs) {
      return new Response(`Upstream Telegram DC did not upgrade (HTTP ${upstreamRes.status})`, {
        status: 502,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "no-store",
        },
      });
    }

    const pair = new WebSocketPairClass();
    const clientWs = pair[0];
    const serverWs = pair[1];

    const pendingToClient = [];
    const pendingToUpstream = [];
    let closed = false;

    const closeBoth = (code, reason) => {
      if (closed) return;
      closed = true;
      pendingToClient.length = 0;
      pendingToUpstream.length = 0;
      safeCloseSocket(serverWs, code, reason);
      safeCloseSocket(upstreamWs, code, reason);
    };

    upstreamWs.accept();
    serverWs.accept();

    const flushToUpstream = () => {
      while (pendingToUpstream.length > 0 && !closed) {
        if (upstreamWs.readyState !== 1) break;
        const frame = pendingToUpstream.shift();
        upstreamWs.send(frame);
      }
    };

    const flushToClient = () => {
      while (pendingToClient.length > 0 && !closed) {
        if (serverWs.readyState !== 1) break;
        const frame = pendingToClient.shift();
        serverWs.send(frame);
      }
    };

    serverWs.addEventListener("message", (event) => {
      if (closed) return;
      try {
        if (upstreamWs.readyState === 1) {
          flushToUpstream();
          upstreamWs.send(event.data);
        } else {
          pendingToUpstream.push(event.data);
        }
      } catch (_) {
        closeBoth(1011, "Upstream send error");
      }
    });

    upstreamWs.addEventListener("message", (event) => {
      if (closed) return;
      try {
        if (serverWs.readyState === 1) {
          flushToClient();
          serverWs.send(event.data);
        } else {
          pendingToClient.push(event.data);
        }
      } catch (_) {
        closeBoth(1011, "Client send error");
      }
    });

    upstreamWs.addEventListener("open", flushToUpstream);
    serverWs.addEventListener("open", flushToClient);

    serverWs.addEventListener("close", (ev) => closeBoth(ev?.code || 1000, ev?.reason));
    serverWs.addEventListener("error", () => closeBoth(1011, "Client WS error"));
    upstreamWs.addEventListener("close", (ev) => closeBoth(ev?.code || 1000, ev?.reason));
    upstreamWs.addEventListener("error", () => closeBoth(1011, "Upstream WS error"));

    const responseHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store, no-cache, must-revalidate",
    };
    if (protocol) {
      responseHeaders["Sec-WebSocket-Protocol"] = protocol;
    }

    return new Response(null, {
      status: 101,
      webSocket: clientWs,
      headers: responseHeaders,
    });
  } catch (err) {
    return new Response(`Edge tunnel error: ${err && err.message ? err.message : String(err)}`, {
      status: 502,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-store",
      },
    });
  }
}

/* ============================================================================
 * MEDIA METADATA, COVER & FFMPEG EDGE PROXIES
 * ============================================================================ */
async function handleItunesSearch(url) {
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
    return new Response(JSON.stringify({ resultCount: 0, results: [], error: String(err) }), {
      status: 200,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  }
}

async function handleCoverProxy(url) {
  const targetUrl = url.searchParams.get("url");
  if (!targetUrl) return new Response("Missing url param", { status: 400 });
  try {
    const parsed = new URL(targetUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return new Response("Invalid protocol", { status: 400 });
    }
    const res = await fetch(targetUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        Accept: "image/*,*/*;q=0.8",
      },
    });
    if (!res.ok) return new Response("Cover fetch failed", { status: res.status });
    const headers = new Headers();
    headers.set("Content-Type", res.headers.get("content-type") || "image/jpeg");
    headers.set("Cache-Control", "public, max-age=31536000, immutable");
    headers.set("Access-Control-Allow-Origin", "*");
    headers.set("Cross-Origin-Resource-Policy", "cross-origin");
    return new Response(res.body, { status: 200, headers });
  } catch (err) {
    return new Response(String(err), { status: 502 });
  }
}

async function handleFfmpegProxy(pathname) {
  const filename = pathname.replace(/^\/api\/ffmpeg\//, "");
  if (!/^(ffmpeg-core\.(js|wasm))$/.test(filename)) {
    return new Response("Forbidden asset", { status: 403 });
  }
  const upstreamUrl = `https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/esm/${filename}`;
  try {
    const res = await fetch(upstreamUrl);
    if (!res.ok) return new Response("Upstream FFmpeg core error", { status: res.status });
    const headers = new Headers();
    headers.set("Content-Type", filename.endsWith(".wasm") ? "application/wasm" : "text/javascript; charset=utf-8");
    headers.set("Cache-Control", "public, max-age=31536000, immutable");
    headers.set("Access-Control-Allow-Origin", "*");
    headers.set("Cross-Origin-Resource-Policy", "cross-origin");
    return new Response(res.body, { status: 200, headers });
  } catch (err) {
    return new Response(String(err), { status: 502 });
  }
}

/* ============================================================================
 * CLOUDFLARE WORKER ENTRYPOINT & STATIC ASSETS ROUTER
 * ============================================================================ */
export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
          "Access-Control-Allow-Headers": "*",
          "Access-Control-Expose-Headers": "X-Zud-Proxy",
        },
      });
    }

    const url = new URL(request.url);
    const pathname = url.pathname;

    if (
      pathname === "/ws" ||
      pathname.startsWith("/ws/") ||
      pathname === "/apiws" ||
      pathname.startsWith("/apiws/") ||
      pathname === "/tgws" ||
      pathname.startsWith("/tgws/")
    ) {
      return handleWebSocketTunnel(request, url);
    }

    if (pathname === "/api/health" || pathname === "/health") {
      return new Response(
        JSON.stringify({
          status: "ok",
          proxy: "zud-cloudflare-mtproto",
          runtime: "cloudflare-workers-assets",
          timestamp: Date.now(),
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "X-Zud-Proxy": "ready",
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Expose-Headers": "X-Zud-Proxy",
            "Cache-Control": "no-store, no-cache, must-revalidate",
          },
        }
      );
    }

    if (pathname === "/api/itunes") {
      return handleItunesSearch(url);
    }

    if (pathname === "/api/cover" || pathname === "/cover") {
      return handleCoverProxy(url);
    }

    if (pathname.startsWith("/api/ffmpeg/")) {
      return handleFfmpegProxy(pathname);
    }

    if (env && env.ASSETS && typeof env.ASSETS.fetch === "function") {
      return env.ASSETS.fetch(request);
    }

    if (pathname === "/") {
      return new Response(
        JSON.stringify({
          status: "ok",
          proxy: "zud-cloudflare-mtproto",
          runtime: "cloudflare-standalone-worker",
          timestamp: Date.now(),
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "X-Zud-Proxy": "ready",
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "no-store",
          },
        }
      );
    }

    return new Response("Not Found", { status: 404 });
  },
};
