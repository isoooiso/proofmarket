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

/**
 * Proxy a GET to TxLINE /api/<path> with guest JWT + API token.
 * Refreshes JWT once on upstream 401.
 */
export async function proxyTxlineGet(
  apiPath: string,
  query: Record<string, string>
): Promise<{ status: number; body: unknown }> {
  const upstreamUrl = buildUpstreamUrl(apiPath, query);

  async function forward(jwt: string, retried: boolean): Promise<{ status: number; body: unknown }> {
    const upstream = await fetch(upstreamUrl, {
      method: "GET",
      headers: authHeaders(jwt),
    });

    if (upstream.status === 401 && !retried) {
      const freshJwt = await mintGuestJwt(true);
      return forward(freshJwt, true);
    }

    return { status: upstream.status, body: await parseUpstreamBody(upstream) };
  }

  const jwt = await mintGuestJwt();
  return forward(jwt, false);
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
