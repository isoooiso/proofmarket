export type RpcOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; rateLimited: boolean; error: string };

const loggedLabels = new Set<string>();

export function isRateLimitedError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  const lower = msg.toLowerCase();
  return msg.includes("429") || lower.includes("rate limit") || lower.includes("rate limited");
}

export function isTimeoutError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.toLowerCase().includes("timeout");
}

export function isAccountNotFoundError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  const lower = msg.toLowerCase();
  return lower.includes("account does not exist") || lower.includes("could not find account");
}

/** Wrap Solana RPC reads — never retries; logs once per label. */
export async function safeRpc<T>(label: string, fn: () => Promise<T>): Promise<RpcOutcome<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    const rateLimited = isRateLimitedError(e);
    if (!loggedLabels.has(label)) {
      console.debug(`[RPC] ${label} failed`, { error, rateLimited });
      loggedLabels.add(label);
    }
    return { ok: false, rateLimited, error };
  }
}

export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms);
    promise
      .then((v) => {
        clearTimeout(timer);
        resolve(v);
      })
      .catch((e) => {
        clearTimeout(timer);
        reject(e);
      });
  });
}
