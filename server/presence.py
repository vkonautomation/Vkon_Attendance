"""Where and when a punch happened, as the server determines it.

Both answers have to be computed here rather than trusted from the client:
the attendance day decides payroll, and the distance decides whether someone was
actually at the office.
"""

from datetime import datetime, timedelta, timezone
from math import asin, cos, radians, sin, sqrt

from . import config

# India has no DST, so a fixed offset is correct and avoids shipping the tz
# database. Pinned explicitly rather than read from the host, because the host of
# a container is usually UTC and a UTC "today" is 5.5 hours wrong for this app.
IST = timezone(timedelta(hours=5, minutes=30))


def to_ist(moment: datetime | None = None) -> datetime:
    """Interpret a naive datetime as UTC, then move it into IST."""
    if moment is None:
        moment = datetime.now(timezone.utc)
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    return moment.astimezone(IST)


def ist_date(moment: datetime | None = None) -> str:
    """The attendance day for an instant, as YYYY-MM-DD in IST."""
    return to_ist(moment).strftime("%Y-%m-%d")


def ist_clock(moment: datetime | None = None) -> str:
    """Display time matching the client's formatTimeString output, e.g. 10:42 AM."""
    return to_ist(moment).strftime("%I:%M %p").lstrip("0")


def distance_in_meters(lat1: float, lon1: float, lat2: float, lon2: float) -> int:
    """Haversine. Mirrors calculateDistanceInMeters() in shared.js so the two
    sides agree to the metre and a punch is not rejected by one engine and
    accepted by the other."""
    r = 6371e3
    phi1, phi2 = radians(lat1), radians(lat2)
    d_phi = radians(lat2 - lat1)
    d_lambda = radians(lon2 - lon1)
    a = (sin(d_phi / 2) ** 2
         + cos(phi1) * cos(phi2) * sin(d_lambda / 2) ** 2)
    return round(r * 2 * asin(sqrt(a)))


def geofence_verdict(latitude, longitude, accuracy_m, radius_m=None):
    """Return (distance, inside, note).

    Fail-closed on a missing or unreadable fix, matching the client's gate: no
    evidence is not the same as evidence of absence, so the punch is still
    recorded but flagged for review rather than silently blessed or thrown away.
    """
    if latitude is None or longitude is None:
        return None, False, "No coordinates supplied; presence unverified."
    if accuracy_m is None:
        return None, False, "No accuracy figure supplied; presence unverified."
    if accuracy_m > config.MAX_TRUSTED_ACCURACY_M:
        return None, False, (
            f"GPS accuracy {accuracy_m}m is coarser than the "
            f"{config.MAX_TRUSTED_ACCURACY_M}m trust limit; the fix cannot place "
            "you at the office."
        )
    limit = config.OFFICE_RADIUS_M if radius_m is None else radius_m
    dist = distance_in_meters(latitude, longitude, config.OFFICE_LAT, config.OFFICE_LNG)
    # The accuracy circle has to clear the boundary, not just its centre: a fix
    # that reads 490m away with 100m of error may well be outside.
    inside = (dist + min(accuracy_m, limit)) <= limit
    if inside:
        return dist, True, None
    return dist, False, f"{dist}m from the office, outside the {limit}m fence."
