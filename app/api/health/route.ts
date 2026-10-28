import { NextResponse } from "next/server";

/**
 * GET /api/health -- the liveness probe and the thing the portal actually reads.
 *
 * js/api.js boot() calls this before it does anything else: a 200 puts the portal
 * in server mode, anything else leaves it on the device's own localStorage copy.
 * So the two fields below are a contract with the front end, not diagnostics.
 *
 * `api` is the discriminator. attendance.vkon.in and vkon.in sit behind one
 * Cloudflare account and the store also answers /api/health, so "something
 * returned 200 here" is not evidence that this is the attendance API. A tunnel
 * ingress that drifts onto the store would otherwise put every device into server
 * mode against an API that has no idea what a punch record is, and the person
 * would see an empty roster rather than an offline portal. If this value changes,
 * js/api.js changes with it.
 *
 * Nothing else belongs here. No row count, no version, no database shape: this
 * endpoint is reachable without a session and is served to whoever asks.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ status: "ok", api: "v1" });
}
