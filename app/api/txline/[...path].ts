import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  applyTxlineClientCacheHeaders,
  joinPathSegments,
  normalizeQuery,
  proxyTxlineGet,
  stripConditionalRequestHeaders,
} from "./proxyCore";

/** Resolve TxLINE API sub-path from catch-all query or request URL. */
function resolveApiPath(req: VercelRequest): string {
  const fromQuery = joinPathSegments(req.query.path as string | string[] | undefined);
  if (fromQuery) return fromQuery;

  const pathname = (req.url ?? "").split("?")[0];
  const prefix = "/api/txline/";
  if (pathname.startsWith(prefix)) {
    return pathname.slice(prefix.length);
  }
  return "";
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Content-Type", "application/json");
  applyTxlineClientCacheHeaders(res);

  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed", method: req.method });
  }

  stripConditionalRequestHeaders(req.headers as Record<string, string | string[] | undefined>);

  const apiPath = resolveApiPath(req);
  if (!apiPath) {
    return res.status(400).json({ error: "Missing TxLINE API path" });
  }

  try {
    const result = await proxyTxlineGet(apiPath, normalizeQuery(req.query));

    applyTxlineClientCacheHeaders(res);

    if (result.status === 304) {
      return res.status(500).json({ error: "upstream returned 304 with no body" });
    }

    if (result.status >= 200 && result.status < 300) {
      return res.status(200).json(result.body);
    }

    return res.status(result.status).json(result.body);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[api/txline] proxy failed", { path: apiPath, message });
    return res.status(500).json({ error: message });
  }
}
