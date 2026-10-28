/**
 * lib/rules/geofence.ts -- where a punch happened, decided by the server.
 *
 * The plan makes the geofence a server-side verdict (M6) rather than the browser's: the
 * client's own "I was inside the fence" is the single thing an interested user can edit,
 * and a radius change (an office relocation, a fairer threshold for a network-positioned
 * phone) has to apply to punches already stored, not only to future ones. So the route
 * stores the coordinates and reads THIS to decide, and the browser's claim is ignored.
 *
 * The distance formula is shared.js `calculateDistanceInMeters` verbatim -- the same
 * `atan2` form, the same rounding -- so the two engines agree to the metre and a punch is
 * never rejected by one and accepted by the other. The verdict policy is presence.py's:
 * fail CLOSED on an unusable fix. No coordinates, no accuracy figure, or a fix coarser
 * than the trust limit is "presence unverified" -- the punch is still recorded and flagged
 * for review, because the absence of evidence is not evidence of absence.
 */

/** The office the fence is drawn around, as read from the `geofence.office` setting. */
export interface OfficePoint {
  lat: number;
  lng: number;
  radiusMeters: number;
}

export interface GeofenceVerdict {
  /** Great-circle metres from the office, or null when there was no usable fix. */
  distance: number | null;
  /** True only when the accuracy circle clears the boundary, not just its centre. */
  inside: boolean;
  /** Why it is not inside, or null when it is. Shown for review, never a hard reject. */
  note: string | null;
}

/** Haversine, mirroring calculateDistanceInMeters() so both sides round identically. */
export function distanceInMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371e3;
  const phi1 = (lat1 * Math.PI) / 180;
  const phi2 = (lat2 * Math.PI) / 180;
  const deltaPhi = ((lat2 - lat1) * Math.PI) / 180;
  const deltaLambda = ((lon2 - lon1) * Math.PI) / 180;

  const a =
    Math.sin(deltaPhi / 2) * Math.sin(deltaPhi / 2) +
    Math.cos(phi1) * Math.cos(phi2) * Math.sin(deltaLambda / 2) * Math.sin(deltaLambda / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return Math.round(R * c);
}

/**
 * The server's verdict for one fix. `latitude`/`longitude`/`accuracyM` are what the device
 * reported; they are trusted as measurements, and the CONCLUSION is drawn here rather than
 * accepted from the client.
 */
export function geofenceVerdict(
  latitude: number | null | undefined,
  longitude: number | null | undefined,
  accuracyM: number | null | undefined,
  office: OfficePoint,
  maxTrustedAccuracyM: number,
): GeofenceVerdict {
  if (latitude == null || longitude == null) {
    return { distance: null, inside: false, note: "No coordinates supplied; presence unverified." };
  }
  if (accuracyM == null) {
    return { distance: null, inside: false, note: "No accuracy figure supplied; presence unverified." };
  }
  if (accuracyM > maxTrustedAccuracyM) {
    return {
      distance: null,
      inside: false,
      note:
        `GPS accuracy ${accuracyM}m is coarser than the ${maxTrustedAccuracyM}m trust limit; ` +
        "the fix cannot place you at the office.",
    };
  }
  const limit = office.radiusMeters;
  const dist = distanceInMeters(latitude, longitude, office.lat, office.lng);
  // The accuracy circle has to clear the boundary, not just its centre: a fix that reads
  // 490 m away with 100 m of error may well be outside. min(accuracy, limit) keeps a wildly
  // coarse fix from making the fence negative.
  const inside = dist + Math.min(accuracyM, limit) <= limit;
  if (inside) return { distance: dist, inside: true, note: null };
  return { distance: dist, inside: false, note: `${dist}m from the office, outside the ${limit}m fence.` };
}
