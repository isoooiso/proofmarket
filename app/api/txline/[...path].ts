import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  joinPathSegments,
  normalizeQuery,
  proxyTxlineGet,
} from "./proxyCore";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed", method: req.method });
  }

  const apiPath = joinPathSegments(req.query.path as string | string[] | undefined);
  if (!apiPath) {
    return res.status(400).json({ error: "Missing TxLINE API path" });
  }

  try {
    const result = await proxyTxlineGet(apiPath, normalizeQuery(req.query));
    return res.status(result.status).json(result.body);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[api/txline]", apiPath, message);
    return res.status(500).json({ error: message });
  }
}
