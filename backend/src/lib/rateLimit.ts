import type { NextFunction, Request, Response } from 'express';

interface Bucket {
  tokens: number;
  updatedAt: number;
}

export interface RateLimitOptions {
  /** Sustained requests allowed per window. */
  max: number;
  windowMs: number;
  message?: string;
}

/**
 * Small in-process token bucket. This exists to keep one impatient browser tab
 * from hammering Nominatim/Overpass on our behalf and getting the deployment
 * banned — it is not a defence against a distributed attacker. Put a real
 * limiter (nginx, Cloudflare, express-rate-limit + Redis) in front in prod.
 */
export function rateLimit(options: RateLimitOptions) {
  const { max, windowMs, message = 'Too many requests, please slow down.' } = options;
  const buckets = new Map<string, Bucket>();

  // Bounded cleanup so a churn of IPs can't grow the map forever.
  const sweep = setInterval(() => {
    const cutoff = Date.now() - windowMs * 2;
    for (const [key, bucket] of buckets) if (bucket.updatedAt < cutoff) buckets.delete(key);
  }, windowMs);
  sweep.unref?.();

  return (req: Request, res: Response, next: NextFunction): void => {
    const key = req.ip ?? req.socket.remoteAddress ?? 'unknown';
    const now = Date.now();
    const bucket = buckets.get(key) ?? { tokens: max, updatedAt: now };

    // Refill proportionally to elapsed time.
    const refill = ((now - bucket.updatedAt) / windowMs) * max;
    bucket.tokens = Math.min(max, bucket.tokens + refill);
    bucket.updatedAt = now;

    if (bucket.tokens < 1) {
      buckets.set(key, bucket);
      res.setHeader('Retry-After', Math.ceil(windowMs / 1000));
      res.status(429).json({ error: message });
      return;
    }

    bucket.tokens -= 1;
    buckets.set(key, bucket);
    next();
  };
}
