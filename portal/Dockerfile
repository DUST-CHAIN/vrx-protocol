# VRX portal — production image for the Coolify box.
# Multi-stage + Next.js standalone output = small image (box disk is tight, ~9.7GB free).
# Serves on :3011 (the portal's canonical port). .data is a writable VOLUME on the box (catalog/
# snapshot/onboarding stores live there; the catalog re-seeds from the committed seed on first read).

# ---- deps: install node_modules against the lockfile-less package.json ----
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# Lockfile IS committed → npm ci for a reproducible install. Alpine needs libc6-compat for some native deps.
RUN apk add --no-cache libc6-compat && npm ci

# ---- build: compile Next.js to standalone ----
FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
# Copy the heavy, rarely-changing static media FIRST, in its own layer. A code-only change
# leaves public/ byte-identical, so Docker reuses this cached layer and the ~135 MB of floor plans /
# renderings are NOT re-shipped on a redeploy. Only a change under public/ busts it.
COPY public ./public
# the GATED media (floor plans). NON-PUBLIC: served ONLY through /api/floorplan (requireCaller +
# opened-to-buyer), NOT statically under /public, so a layout can't leak to a random URL (: "plans are not
# for anyone"). Its own cached layer (heavy + rarely-changing, like public/). Hardlinked into src at unpack from
# the persistent /opt/vrx-portal/media dir (the media split). The dir is committed (with a README) so the build
# context always has it; a plain local build has only the README (the route 404s locally — fine).
COPY private-media ./private-media
# Then the rest of the source (the layer that actually changes on a code deploy).
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
# NEXT_PUBLIC_* vars are INLINED into the client bundle at `next build` time (not read at runtime), so any
# public flag the browser needs MUST be present HERE, during the build — passing it only via `docker run
# --env-file` is too late (that's runtime). The public demo role-picker + the chain config are client-read,
# so they come in as build ARGs. Pass them with `docker build --build-arg NEXT_PUBLIC_VRX_DEMO=1 …` (the
# redeploy script sources vrx.env and forwards these). Defaults keep a plain build working (demo off).
ARG NEXT_PUBLIC_VRX_DEMO=
ARG NEXT_PUBLIC_NEAR_NETWORK=
ARG NEXT_PUBLIC_VRX_CONTRACT=
ARG NEXT_PUBLIC_NEAR_RPC=
ARG NEXT_PUBLIC_NEAR_ARCHIVAL_RPC=
ENV NEXT_PUBLIC_VRX_DEMO=$NEXT_PUBLIC_VRX_DEMO \
    NEXT_PUBLIC_NEAR_NETWORK=$NEXT_PUBLIC_NEAR_NETWORK \
    NEXT_PUBLIC_VRX_CONTRACT=$NEXT_PUBLIC_VRX_CONTRACT \
    NEXT_PUBLIC_NEAR_RPC=$NEXT_PUBLIC_NEAR_RPC \
    NEXT_PUBLIC_NEAR_ARCHIVAL_RPC=$NEXT_PUBLIC_NEAR_ARCHIVAL_RPC
RUN npm run build

# ---- runner: minimal runtime ----
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3011
ENV HOSTNAME=0.0.0.0

# Non-root runtime user.
RUN addgroup -g 1001 -S nodejs && adduser -u 1001 -S nextjs -G nodejs

# Standalone server + its trimmed node_modules.
COPY --from=build /app/.next/standalone ./
# Standalone does NOT include these — copy them explicitly or you get 404s on static assets + images.
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
# the gated media (floor plans), served by /api/floorplan from cwd/private-media (NOT statically).
# Standalone doesn't auto-include it, so copy it explicitly (like public/).
COPY --from=build /app/private-media ./private-media
# the Control Center suite (/control "▶ Run suite" / "▶ Present" spawns `node scripts/control-center/
# suite.mjs`). Next standalone TRACES suite.mjs but NOT its siblings (emit.mjs, scenarios/*.mjs are loaded via a
# dynamic import(pathToFileURL(...)) the tracer can't) → only suite.mjs shipped → the spawn crashed
# ERR_MODULE_NOT_FOUND, silently (stdio:ignore). Copy the whole tree explicitly, like public/private-media.
COPY --from=build /app/scripts ./scripts

# Writable data dir (mounted as a persistent volume on the box; owned by the runtime user so the
# app can write catalog/snapshot/onboarding stores).
RUN mkdir -p /app/.data && chown -R nextjs:nodejs /app/.data

USER nextjs
EXPOSE 3011
# server.js is emitted by Next standalone at the app root.
CMD ["node", "server.js"]
