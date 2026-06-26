export default async function handler(req: any, res: any) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const base = process.env.TXLINE_API_BASE || "https://txline-dev.txodds.com/api";
  const jwt = process.env.TXLINE_JWT;
  const apiToken = process.env.TXLINE_API_TOKEN;

  if (!jwt || !apiToken) {
    return res.status(500).json({
      error: "Missing TxLINE environment variables",
      required: ["TXLINE_JWT", "TXLINE_API_TOKEN"],
    });
  }

  const query = req.query || {};
  const params = new URLSearchParams();

  for (const key of ["fixtureId", "seq", "statKey", "statKey2"]) {
    const value = query[key];
    if (Array.isArray(value)) {
      if (value[0]) params.set(key, value[0]);
    } else if (value !== undefined && value !== null) {
      params.set(key, String(value));
    }
  }

  if (!params.get("fixtureId") || !params.get("seq") || !params.get("statKey")) {
    return res.status(400).json({
      error: "Missing required query params",
      required: ["fixtureId", "seq", "statKey"],
      optional: ["statKey2"],
    });
  }

  const upstreamUrl = `${base.replace(/\/$/, "")}/scores/stat-validation?${params.toString()}`;

  try {
    const upstream = await fetch(upstreamUrl, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${jwt}`,
        "X-Api-Token": apiToken,
        Accept: "application/json",
      },
    });

    const contentType = upstream.headers.get("content-type") || "application/json";
    const body = await upstream.text();

    res.setHeader("content-type", contentType);
    return res.status(upstream.status).send(body);
  } catch (error: any) {
    return res.status(500).json({
      error: "TxLINE proxy failed",
      message: error?.message || String(error),
    });
  }
}
