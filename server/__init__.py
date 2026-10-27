"""VKON Attendance backend.

Presence of this package is what distinguishes the deployed build from the pure
static one: the front end probes /api/health on boot and, when the API is absent,
falls back to localStorage exactly as it always has. Nothing here is imported by
the browser bundle, and the static Dockerfile never copies this directory into
the served docroot.
"""
