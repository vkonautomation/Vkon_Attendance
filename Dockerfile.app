# syntax=docker/dockerfile:1
# VKON Attendance -- the Next.js app: the API and the front end in one container.
#
# This is the M12 image. It replaces the two that came before it for production:
# the static image (Dockerfile), which serves only browser files and cannot run the
# API, and the outgoing FastAPI image (Dockerfile.backend). The reason it exists is
# the exposure those two cannot close: production currently serves the git working
# tree through nginx, so /.git and /server are fetchable by URL. This image ships a
# single self-contained directory -- Next's standalone output -- and nothing above
# it is reachable, because nothing above it is in the image.
#
# Build context is the repository root; .dockerignore keeps .git, .env, server/,
# db/, scripts/ and tests/ out of it. `next build` reads none of those, so the
# image is smaller and a stray secret cannot ride in on a COPY . . layer.

# --- deps ---------------------------------------------------------------------
# `npm ci` from the lockfile into its own layer. Cached separately from the source
# COPY below so editing a route handler does not re-resolve every dependency.
FROM node:22-slim AS deps

WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# --- build --------------------------------------------------------------------
FROM node:22-slim AS build

WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1 \
    NODE_ENV=production

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# `output: "standalone"` (next.config.mjs) emits .next/standalone/ with server.js,
# a pruned node_modules and a package.json. It deliberately does NOT include
# .next/static or public/ -- the runner stage places those inside it, which is what
# scripts/start-standalone.mjs does locally. Building here means the image and the
# probe test run against the same assembled artifact.
RUN npm run build

# --- runner -------------------------------------------------------------------
# Distroless would be smaller, but node:slim keeps `node -e` available for the
# compose healthcheck and `docker exec` debuggable on a host nobody wants to
# re-bake an image for. The trade is a few MB against an operational lifeline.
FROM node:22-slim AS runner

WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    # server.js binds to HOSTNAME || 0.0.0.0. Docker sets HOSTNAME to the container
    # name, which resolves to one interface; pinning it to 0.0.0.0 keeps the loopback
    # healthcheck and the published port both working regardless of the container name.
    HOSTNAME=0.0.0.0 \
    PORT=8000

# A named, non-root uid. 1001 rather than reusing 10001 so this container cannot
# accidentally write a volume owned by the old static/backend image's user.
RUN addgroup --system --gid 1001 nodejs \
 && adduser --system --uid 1001 --ingroup nodejs nextjs

# The three directories Next expects to find side by side. Copying them in this
# order is the documented standalone layout; anything not listed here simply is not
# in the image, which is the whole security property.
COPY --from=build --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=build --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=build --chown=nextjs:nodejs /app/public ./public

# Next drops the project's .env beside server.js so `next start` keeps working. The
# container is configured by the orchestrator instead, so a build that happened to
# see a .env in the context must not leave one baked into a layer.
RUN rm -f ./.env ./.env.local ./.env.production

USER nextjs
EXPOSE 8000

# PID 1 takes SIGTERM from `docker stop` directly: no shell wrapper, no leaked
# listener on shutdown. Host/port come from the environment above.
CMD ["node", "server.js"]
