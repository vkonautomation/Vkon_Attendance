/**
 * vitest.config.mts -- the conformance harness runner.
 *
 * Only one thing is expected of Vitest here: run tests/conformance, which compares the
 * compiled TypeScript rule engine (lib/rules) against public/shared.js executed for real in
 * a vm, over the SAME JSON fixtures. That is decision D2 made executable -- two
 * implementations, one truth, and a red build the moment they diverge.
 *
 * The harness is deliberately the ONLY Vitest suite: every other check in the repo is a
 * plain Node/Python file that exits non-zero (see scripts/run-tests.mjs), and this config
 * includes nothing that would accidentally run those through a second, parallel runner.
 */

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    include: ["tests/conformance/**/*.spec.ts"],
  },
});
