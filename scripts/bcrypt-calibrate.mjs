/**
 * scripts/bcrypt-calibrate.mjs -- choose BCRYPT_COST_FACTOR by measurement.
 *
 * D4 makes the work factor a load-bearing constant rather than a preference: one hash
 * should cost 150-250 ms on the machine that will actually run it. That number is a
 * trade with a specific opponent (an attacker with a stolen password file and a GPU
 * farm) and a specific witness (a person on a phone at a gate, waiting), and both of
 * them depend on hardware this repository does not know. So the factor is not decided
 * here -- it is measured, and the answer is printed.
 *
 * The measurement input is a 44-character base64 string, which is what lib/auth/hash.ts
 * feeds bcrypt after its SHA-256 pre-hash. Hashing a raw password instead would measure
 * something the server never does; bcrypt's cost depends only on the number of rounds,
 * so the difference would be invisible here and misleading everywhere else.
 *
 * Usage:
 *   node scripts/bcrypt-calibrate.mjs
 *   node scripts/bcrypt-calibrate.mjs --check        # non-zero exit when the current
 *                                                    # factor is outside the band
 *   node scripts/bcrypt-calibrate.mjs --target=150,250 --samples=5
 *
 * On the deploy host, run it inside the app image so the measurement includes the
 * container's own CPU limit -- which is the point of the exercise:
 *
 *   docker run --rm --cpus=1 -v "$PWD":/app -w /app node:20-alpine \
 *     node scripts/bcrypt-calibrate.mjs
 */

import { createHash } from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const bcrypt = require("bcryptjs");

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const CHECK = argv.includes("--check");
const [TARGET_MIN, TARGET_MAX] = flag("target", "150,250").split(",").map(Number);
const SAMPLES = Number(flag("samples", "5"));
const COSTS = flag("costs", "8,9,10,11,12,13").split(",").map(Number);
const CURRENT = Number(process.env.BCRYPT_COST_FACTOR || 11);

/** The same pre-hash lib/auth/hash.ts applies. Keep the two in step. */
const preHash = (password) => createHash("sha256").update(password, "utf8").digest("base64");

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

async function timeCost(cost) {
  const input = preHash(`calibration-${cost}-${Date.now()}-${Math.random()}`);
  const times = [];
  for (let i = 0; i < SAMPLES; i++) {
    const t0 = performance.now();
    const hash = await bcrypt.hash(input, cost);
    times.push(performance.now() - t0);
    if (i === 0) {
      // One comparison too: sign-in compares, so it is on the request path as well.
      const c0 = performance.now();
      await bcrypt.compare(input, hash);
      times.push(performance.now() - c0);
    }
  }
  return Math.round(median(times));
}

async function main() {
  const node = process.version;
  const cpus = (await import("node:os")).cpus().length;
  console.log(`bcryptjs calibration -- node ${node}, ${cpus} logical CPUs, ${SAMPLES} samples per factor`);
  console.log(`target band: ${TARGET_MIN}-${TARGET_MAX} ms per hash\n`);

  const results = [];
  for (const cost of COSTS) {
    const ms = await timeCost(cost);
    const inBand = ms >= TARGET_MIN && ms <= TARGET_MAX;
    const fits = ms <= TARGET_MAX;
    results.push({ cost, ms, inBand, fits });
    console.log(`  cost ${cost}: ${String(ms).padStart(6)} ms` +
      `${inBand ? "   <- in band" : fits ? "   (faster than the band)" : "   (slower than the band)"}`);
  }

  const best = results.filter((r) => r.inBand).pop()
    || [...results].reverse().find((r) => r.fits)
    || results[0];

  console.log(`\nrecommendation: BCRYPT_COST_FACTOR=${best.cost} (${best.ms} ms here)`);

  const current = results.find((r) => r.cost === CURRENT);
  if (CHECK) {
    if (!current) {
      console.error(`--check: cost ${CURRENT} was not measured; add it to --costs`);
      process.exit(2);
    }
    if (!current.inBand) {
      console.error(`--check: cost ${CURRENT} costs ${current.ms} ms here, outside ${TARGET_MIN}-${TARGET_MAX} ms.`);
      console.error(`          Set BCRYPT_COST_FACTOR=${best.cost} in the environment this measurement came from.`);
      process.exit(1);
    }
    console.log(`--check: cost ${CURRENT} is inside the band on this machine.`);
  } else {
    console.log(`current setting would be cost ${CURRENT}` +
      `${current ? ` (${current.ms} ms here)` : " (not measured)"}.`);
    console.log("Run this on the deploy host, inside the app container, before signing off a deploy.");
  }
}

main().catch((err) => {
  console.error("[calibrate] failed:", err.message);
  process.exit(1);
});
