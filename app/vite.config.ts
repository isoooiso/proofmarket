import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { nodePolyfills } from "vite-plugin-node-polyfills";
import { config as dotenvConfig } from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { proxyTxlineGet } from "./api/txline/proxyCore";

const appDir = path.dirname(fileURLToPath(import.meta.url));
dotenvConfig({ path: path.resolve(appDir, "../.env") });
dotenvConfig({ path: path.resolve(appDir, ".env") });

function txlineDevProxyPlugin(): Plugin {
  return {
    name: "txline-dev-proxy",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url ?? "";
        if (!url.startsWith("/api/txline")) {
          next();
          return;
        }

        if (req.method !== "GET") {
          res.statusCode = 405;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: "Method not allowed", method: req.method }));
          return;
        }

        const parsed = new URL(url, "http://localhost");
        const prefix = "/api/txline/";
        const apiPath = parsed.pathname.startsWith(prefix)
          ? parsed.pathname.slice(prefix.length)
          : parsed.pathname.replace(/^\/api\/txline\/?/, "");

        if (!apiPath) {
          res.statusCode = 400;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: "Missing TxLINE API path" }));
          return;
        }

        const query: Record<string, string> = {};
        parsed.searchParams.forEach((value, key) => {
          query[key] = value;
        });

        proxyTxlineGet(apiPath, query)
          .then((result) => {
            res.statusCode = result.status;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify(result.body));
          })
          .catch((e: unknown) => {
            const message = e instanceof Error ? e.message : String(e);
            console.error("[dev txline proxy]", apiPath, message);
            res.statusCode = 500;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: message }));
          });
      });
    },
  };
}

export default defineConfig({
  plugins: [
    nodePolyfills({
      include: ["buffer", "process"],
      globals: {
        Buffer: true,
        global: true,
        process: true,
      },
    }),
    react(),
    txlineDevProxyPlugin(),
  ],
  define: {
    global: "globalThis",
  },
  resolve: {
    alias: {
      buffer: "buffer",
    },
  },
});
