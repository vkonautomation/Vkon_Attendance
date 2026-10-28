/**
 * lib/config.ts -- the environment, read once, validated once.
 *
 * Every route handler that needs a knob goes through here rather than touching
 * process.env, for two reasons. The first is typing: `process.env X` is
 * `string | undefined` and a typo in a variable name is `undefined` at runtime,
 * which for a security constant means "silently off". The second is that a bad
 * production configuration has to fail at boot, in the deploy log, rather than at
 * the first request that happens to read the knob.
 *
 * Defaults are the values that are safe when nobody has configured anything. A
 * cookie that is not marked Secure on an HTTPS host leaks the session to any
 * proxy that logs headers, so COOKIE_SECURE defaults to true and only an explicit
 * false turns it off -- and production refuses to start with it off.
 */

export interface AppConfig {
  /** "production" | "development" | "test". Drives the assertions below. */
  environment: string;
  isProduction: boolean;

  /** bcrypt cost factor. D4: one hash should cost 150-250 ms on the machine that runs
   *  it. Measured by scripts/bcrypt-calibrate.mjs -- 11 is the 1-CPU-container value for
   *  the low-end deploy host; re-measure in the container before a deploy is signed off. */
  bcryptCost: number;

  /** Lifetime of the idle deadline, extended on activity. */
  sessionIdleMs: number;
  /** Lifetime from creation, never extended. An unattended tab dies at this. */
  sessionAbsoluteMs: number;

  /** `Secure` on the session cookie. */
  cookieSecure: boolean;
  cookieName: string;

  /**
   * Whether `cf-connecting-ip` may be believed. False by default: trusting it from
   * an untrusted network lets anyone forge an address and dodge an IP bucket, and
   * behind the tunnel `request.ip` is the tunnel container -- collapsing everyone
   * onto one value turns brute-force relief into a denial of service. The deploy
   * step sets this explicitly.
   */
  trustProxyHeaders: boolean;

  /** Scheme + host the portal is served from, for the Origin check (M4). */
  publicOrigin: string | null;

  /** Request body ceiling in bytes. Auth bodies are two short strings. */
  maxBodyBytes: {
    auth: number;
    state: number;
  };

  /**
   * Sign-in brute-force relief (M4). Two independent buckets -- per account and per
   * client address -- each allowing `maxFailures` failures inside `windowMs` before the
   * key is refused until the window passes. Keeping them separate is the point: one
   * person fumbling their password must not lock the whole office out (which is what a
   * single shared-IP limit does behind a tunnel), and one attacker must not be able to
   * sit on a valid account's limit forever by rotating source addresses.
   */
  rateLimit: {
    maxFailures: number;
    windowMs: number;
  };

  /** Pool sizing. The database's max_connections is 40 and the app role's own
   *  connection limit is 20, so a pool larger than that is a queue that times out
   *  with a confusing error rather than a capacity setting. */
  dbPoolMax: number;
  dbStatementTimeoutMs: number;
}

const DEFAULTS = {
  cookieName: "vkon_attendance_session",
  bcryptCost: 11,
  sessionIdleHours: 12,
  sessionAbsoluteHours: 36,
  dbPoolMax: 8,
  dbStatementTimeoutMs: 15000,
  // A login body is an identifier and a password. 8 KiB is generous by three orders
  // of magnitude and small enough that a flood of them is not a memory exhaustion.
  authBodyBytes: 8192,
  // The document facade (D1) puts a whole roster or a month of records in one body.
  // This is the ceiling until M11 retires it; it is not a limit nobody hits.
  stateBodyBytes: 2 * 1024 * 1024,
  // 5 failures / 15 minutes: enough that a genuine person mistyping twice is untouched,
  // low enough that a password list makes no headway. The window is a floor on how long
  // an account is protected, not how long a person is locked out -- a success clears it.
  rateLimitMaxFailures: 5,
  rateLimitWindowMinutes: 15,
};

function num(raw: string | undefined, fallback: number, min: number, max: number, name: string): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number, got ${JSON.stringify(raw)}`);
  if (n < min || n > max) throw new Error(`${name} must be between ${min} and ${max}, got ${n}`);
  return n;
}

/** "true"/"1"/"yes" and their opposites. Anything else is a configuration typo and
 *  a typo in a security switch must not quietly mean "the other thing". */
function bool(raw: string | undefined, fallback: boolean, name: string): boolean {
  if (raw === undefined || raw === "") return fallback;
  const v = raw.trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(v)) return true;
  if (["false", "0", "no", "off"].includes(v)) return false;
  throw new Error(`${name} must be a boolean, got ${JSON.stringify(raw)}`);
}

let cached: AppConfig | null = null;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const environment = (env.VKON_ENV || "development").toLowerCase();
  const isProduction = environment === "production";

  const cookieSecure = bool(env.COOKIE_SECURE, true, "COOKIE_SECURE");
  if (isProduction && !cookieSecure) {
    throw new Error(
      "COOKIE_SECURE=false is refused in production. attendance.vkon.in is HTTPS; a session " +
      "cookie without Secure is sent in the clear to anything between the client and the tunnel.",
    );
  }

  const origin = (env.PUBLIC_ORIGIN || "").trim().replace(/\/+$/, "") || null;
  if (isProduction && !origin) {
    throw new Error(
      "PUBLIC_ORIGIN is required in production. The Origin check (M4) has nothing to compare " +
      "against without it, and guessing it from the Host header is how a spoofed host becomes " +
      "a same-origin request.",
    );
  }

  return {
    environment,
    isProduction,
    bcryptCost: num(env.BCRYPT_COST_FACTOR, DEFAULTS.bcryptCost, 8, 14, "BCRYPT_COST_FACTOR"),
    sessionIdleMs: num(env.SESSION_IDLE_HOURS, DEFAULTS.sessionIdleHours, 1, 24 * 7, "SESSION_IDLE_HOURS") * 3600_000,
    sessionAbsoluteMs: num(env.SESSION_ABSOLUTE_HOURS, DEFAULTS.sessionAbsoluteHours, 1, 24 * 30, "SESSION_ABSOLUTE_HOURS") * 3600_000,
    cookieSecure,
    cookieName: env.SESSION_COOKIE_NAME || DEFAULTS.cookieName,
    trustProxyHeaders: bool(env.VKON_TRUST_PROXY_HEADERS, false, "VKON_TRUST_PROXY_HEADERS"),
    publicOrigin: origin,
    maxBodyBytes: {
      auth: num(env.MAX_AUTH_BODY_BYTES, DEFAULTS.authBodyBytes, 256, 1024 * 1024, "MAX_AUTH_BODY_BYTES"),
      state: num(env.MAX_STATE_BODY_BYTES, DEFAULTS.stateBodyBytes, 1024, 16 * 1024 * 1024, "MAX_STATE_BODY_BYTES"),
    },
    rateLimit: {
      maxFailures: num(env.RATE_LIMIT_MAX_FAILURES, DEFAULTS.rateLimitMaxFailures, 1, 1000, "RATE_LIMIT_MAX_FAILURES"),
      windowMs: num(env.RATE_LIMIT_WINDOW_MINUTES, DEFAULTS.rateLimitWindowMinutes, 1, 120, "RATE_LIMIT_WINDOW_MINUTES") * 60_000,
    },
    dbPoolMax: num(env.DB_POOL_MAX, DEFAULTS.dbPoolMax, 1, 20, "DB_POOL_MAX"),
    dbStatementTimeoutMs: num(env.DB_STATEMENT_TIMEOUT_MS, DEFAULTS.dbStatementTimeoutMs, 500, 120000, "DB_STATEMENT_TIMEOUT_MS"),
  };
}

/** The process configuration, read on first use and then frozen. */
export function config(): AppConfig {
  if (!cached) cached = loadConfig();
  return cached;
}

/** Test seam: replace the frozen configuration with one built from `env`. */
export function resetConfig(env?: NodeJS.ProcessEnv): AppConfig {
  cached = loadConfig(env);
  return cached;
}
