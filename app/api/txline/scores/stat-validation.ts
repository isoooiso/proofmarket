export default {
  async fetch(request: Request) {
    if (request.method !== "GET") {
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }

    const base = process.env.TXLINE_API_BASE || "https://txline-dev.txodds.com/api";
    const jwt = process.env.TXLINE_JWT;
    const apiToken = process.env.TXLINE_API_TOKEN;

    if (!jwt || !apiToken) {
      return Response.json(
        {
          error: "Missing TxLINE environment variables",
          required: ["TXLINE_JWT", "TXLINE_API_TOKEN"],
          hasJwt: Boolean(jwt),
          hasApiToken: Boolean(apiToken),
        },
        { status: 500 },
      );
    }

    const url = new URL(request.url);
    const params = new URLSearchParams();

    for (const key of ["fixtureId", "seq", "statKey", "statKey2"]) {
      const value = url.searchParams.get(key);
      if (value) params.set(key, value);
    }

    if (!params.get("fixtureId") || !params.get("seq") || !params.get("statKey")) {
      return Response.json(
        {
          error: "Missing required query params",
          required: ["fixtureId", "seq", "statKey"],
          optional: ["statKey2"],
        },
        { status: 400 },
      );
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

      return new Response(body, {
        status: upstream.status,
        headers: {
          "content-type": contentType,
        },
      });
    } catch (error: any) {
      return Response.json(
        {
          error: "TxLINE proxy failed",
          message: error?.message || String(error),
        },
        { status: 500 },
      );
    }
  },
};
