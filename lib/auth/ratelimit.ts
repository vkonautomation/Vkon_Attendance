/**
 * lib/auth/ratelimit.ts -- brute-force relief on sign-in, in two independent buckets.
 *
 * The threat this answers is a password list: somebody with "employee@..." names and one
 * common password, trying them in turn. Two limits narrow it from different sides, and
 * both are needed because each is blind to what the other sees:
 *
 *   Per account   protects a person whose name the attacker already knows. It follows the
 *                 account, so the attacker cannot dodge it by changing source address.
 *   Per address   protects the whole roster from one machine working down a list. It
 *                 follows the client, so a single fumbled password on many accounts is
 *                 throttled at the source rather than locking each victim in turn.
 *
 * Keeping them separate is the reason a shared limit would be wrong. Behind the Cloudflare
 * Tunnel every request arrives from one socket peer, so a single IP-only bucket would let
 * one person's three bad guesses lock the entire office -- the exact denial of service the
 * plan calls out. And with `trustProxyHeaders` off there is no honest per-client key at
 * all, so the address bucket is simply not applied (null key) while the account bucket
 * still works, because that one needs no address.
 *
 * The state is in-process memory, not the database. That is deliberate: a throttling
 * counter that must survive a restart is a load-bearing table, and the cost of losing
 * these buckets on a redeploy is that one attacker gets a fresh fifteen minutes -- not a
 * correctness problem. `records.failed_attempts`/`locked_until` (the durable, per-account
 * columns) are the M3+ place a lockout outlives the process; this module is the fast,
 * cheap front line that also covers the address axis a per-row column cannot.
 *
 * A fixed window keyed from the first failure, not a rolling one: a rolling window would
 * let a patient attacker extend their own lockout on the account they are trying to
 * protect nothing on, and a fixed one is a smaller surface for a timing side channel.
 */

import { config } from "../config";

interface Bucket {
  /** Failures counted in the current window. */
  count: number;
  /** Epoch ms after which the window ends and `count` resets. */
  resetAt: number;
}

// Module-level, so the singleton survives across requests in one standalone process.
const accountBuckets = new Map<string, Bucket>();
const ipBuckets = new Map<string, Bucket>();

/** A resolved limit decision: allowed, or refused with how long until the window clears. */
export interface RateDecision {
  allowed: boolean;
  retryAfterSeconds: number;
}

/** The keys a request touches. `ip` is null when the address cannot be honestly attributed. */
export interface RateKeys {
  account: string;
  ip: string | null;
}

/** Drop an expired window so a stale key costs memory forever rather than until restart. */
function live(store: Map<string, Bucket>, key: string, now: number): Bucket | undefined {
  const existing = store.get(key);
  if (!existing) return undefined;
  if (existing.resetAt <= now) {
    store.delete(key);
    return undefined;
  }
  return existing;
}

function retryAfter(bucket: Bucket, now: number): number {
  return Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
}

/**
 * Is this request allowed to attempt a sign-in right now?
 *
 * Checked before the password is verified, so a throttled flood never pays a bcrypt cost
 * -- that is the point of refusing early. The stricter of the two buckets wins, and the
 * reported retry window is the longer one, so a client is never told to come back sooner
 * than some bucket will actually be ready.
 */
export function checkRateLimit(keys: RateKeys): RateDecision {
  const now = Date.now();
  const account = live(accountBuckets, keys.account, now);
  const ip = keys.ip ? live(ipBuckets, keys.ip, now) : undefined;

  const limit = config().rateLimit.maxFailures;
  let blocked = false;
  let retry = 0;

  if (account && account.count >= limit) {
    blocked = true;
    retry = Math.max(retry, retryAfter(account, now));
  }
  if (ip && ip.count >= limit) {
    blocked = true;
    retry = Math.max(retry, retryAfter(ip, now));
  }

  return blocked ? { allowed: false, retryAfterSeconds: retry } : { allowed: true, retryAfterSeconds: 0 };
}

/**
 * Record one failed attempt in both buckets. The window starts at the first failure and
 * does not slide, so repeated attempts cannot extend a lockout that is already running.
 */
export function recordFailure(keys: RateKeys): void {
  const { windowMs } = config().rateLimit;
  const now = Date.now();

  const bump = (store: Map<string, Bucket>, key: string) => {
    const b = live(store, key, now);
    if (!b) store.set(key, { count: 1, resetAt: now + windowMs });
    else b.count += 1;
  };

  bump(accountBuckets, keys.account);
  if (keys.ip) bump(ipBuckets, keys.ip);
}

/**
 * A verified sign-in clears the account's failures, and the address's too when the
 * address is attributed. A person who proves the password has earned the next window
 * clean, so an earlier typo does not stack against them.
 */
export function recordSuccess(keys: RateKeys): void {
  accountBuckets.delete(keys.account);
  if (keys.ip) ipBuckets.delete(keys.ip);
}

/** Test seam: forget every bucket. */
export function resetRateLimits(): void {
  accountBuckets.clear();
  ipBuckets.clear();
}
