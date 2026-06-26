const TXLINE_ORIGIN = "https://txline-dev.txodds.com";

let cachedJwt: string | null = null;

function getApiToken(): string {
  const token = process.env.TXLINE_API_TOKEN;
  if (!token) {
    throw new Error("TXLINE_API_TOKEN is not configured on the server");
  }
  return token;
}

export async function mintGuestJwt(forceRefresh = false): Promise<string> {
  if (!forceRefresh && cachedJwt) {
    return cachedJwt;
  }

  const res = await fetch(`${TXLINE_ORIGIN}/auth/guest/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    cache: "no-store",
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`TxLINE guest/start failed (${res.status}): ${text.slice(0, 300)}`);
  }

  let data: { token?: string };
  try {
    data = JSON.parse(text) as { token?: string };
  } catch {
    throw new Error(`TxLINE guest/start returned non-JSON: ${text.slice(0, 200)}`);
  }

  if (!data.token) {
    throw new Error("TxLINE guest/start response missing token");
  }

  cachedJwt = data.token;
  return cachedJwt;
}

function authHeaders(jwt: string): Record<string, string> {
  return {
    Authorization: `Bearer ${jwt}`,
    "X-Api-Token": getApiToken(),
    Accept: "application/json",
  };
}

/** Upstream fetch headers — never send conditional validators; force full response. */
function upstreamFetchHeaders(jwt: string): Record<string, string> {
  return {
    ...authHeaders(jwt),
    "Cache-Control": "no-cache",
    Pragma: "no-cache",
  };
}

function buildUpstreamUrl(apiPath: string, query: Record<string, string>): string {
  const qs = new URLSearchParams(query).toString();
  return `${TXLINE_ORIGIN}/api/${apiPath}${qs ? `?${qs}` : ""}`;
}

async function parseUpstreamBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { raw: text };
  }
}

function isEmptyBody(body: unknown): boolean {
  if (body === null || body === undefined) return true;
  if (typeof body === "string" && body.trim() === "") return true;
  return false;
}

async function fetchUpstream(jwt: string, upstreamUrl: string): Promise<Response> {
  return fetch(upstreamUrl, {
    method: "GET",
    headers: upstreamFetchHeaders(jwt),
    cache: "no-store",
  });
}

/** Response headers for browser/CDN — never cache TxLINE proxy responses. */
export function applyTxlineClientCacheHeaders(
  res: { setHeader: (name: string, value: string) => void; removeHeader?: (name: string) => void }
): void {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  if (res.removeHeader) {
    res.removeHeader("ETag");
    res.removeHeader("Last-Modified");
  }
}

/**
 * Proxy a GET to TxLINE /api/<path> with guest JWT + API token.
 * Refreshes JWT once on upstream 401. Never returns 304 to callers.
 */
export async function proxyTxlineGet(
  apiPath: string,
  query: Record<string, string>
): Promise<{ status: number; body: unknown }> {
  const upstreamUrl = buildUpstreamUrl(apiPath, query);

  async function forward(
    jwt: string,
    authRetried: boolean,
    cacheRetried: boolean
  ): Promise<{ status: number; body: unknown }> {
    const upstream = await fetchUpstream(jwt, upstreamUrl);

    if (upstream.status === 401 && !authRetried) {
      const freshJwt = await mintGuestJwt(true);
      return forward(freshJwt, true, cacheRetried);
    }

    if (upstream.status === 304 && !cacheRetried) {
      return forward(jwt, authRetried, true);
    }

    if (upstream.status === 304) {
      throw new Error("upstream returned 304 with no body after cache-bypass retry");
    }

    const body = await parseUpstreamBody(upstream);

    if (upstream.status >= 200 && upstream.status < 300 && isEmptyBody(body)) {
      if (!cacheRetried) {
        return forward(jwt, authRetried, true);
      }
      throw new Error(`upstream returned empty body (status ${upstream.status})`);
    }

    return { status: upstream.status, body };
  }

  const jwt = await mintGuestJwt();
  return forward(jwt, false, false);
}

/** Normalize query maps from Vercel or URLSearchParams (drops empty keys). */
export function normalizeQuery(
  raw: Record<string, string | string[] | undefined>
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key === "path" || value === undefined) continue;
    out[key] = Array.isArray(value) ? value.join(",") : value;
  }
  return out;
}

export function joinPathSegments(path: string | string[] | undefined): string {
  if (!path) return "";
  return Array.isArray(path) ? path.join("/") : path;
}

/** Drop conditional request headers so upstream/CDN returns full 200 bodies. */
export function stripConditionalRequestHeaders(
  headers: Record<string, string | string[] | undefined>
): void {
  const keys = Object.keys(headers);
  for (const key of keys) {
    const lower = key.toLowerCase();
    if (lower === "if-none-match" || lower === "if-modified-since" || lower === "etag") {
      delete headers[key];
    }
  }
}
