import type { MiddlewareHandler } from "hono";

/** Fixed-window in-memory limiter (per instance). Put a real limiter at the edge for multi-instance deployments. */
export function rateLimit(max: number, windowMs: number, key: (c: Parameters<MiddlewareHandler>[0]) => string): MiddlewareHandler {
  const hits = new Map<string, { n: number; reset: number }>();
  return async (c, next) => {
    const now = Date.now();
    const k = key(c);
    let h = hits.get(k);
    if (!h || h.reset < now) hits.set(k, (h = { n: 0, reset: now + windowMs }));
    if (++h.n > max) {
      c.header("Retry-After", String(Math.ceil((h.reset - now) / 1000)));
      return c.json({ error: "rate_limited" }, 429);
    }
    if (hits.size > 10_000) for (const [kk, v] of hits) if (v.reset < now) hits.delete(kk);
    await next();
  };
}
