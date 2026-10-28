/**
 * lib/rules/index.ts -- the public surface of the extracted rule engine.
 *
 * Route handlers (M6+) import from here; the conformance harness imports from here. Both
 * the server and the browser compile against THIS module, which is the whole point of D2 --
 * there is exactly one implementation of every rule, and the harness proves shared.js still
 * agrees with it. Nothing here reads a store or a database; every function is a pure function
 * of RuleInputs (+ a `now` where the clock is genuinely part of the answer).
 */

export * from "./types";
export * from "./money";
export * from "./ist";
export * from "./holidays";
export * from "./lop";
export * from "./wfh";
export * from "./geofence";
export * from "./quotas";
export * from "./day-status";
export * from "./alerts";
