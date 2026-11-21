#
# Web image with the embedded archiver (ARCHIVER_MODE=embedded): Next.js on Bun, the supervised
# archiver worker as a child process (src/app/server-functions/orders/archiverSupervisor.js) and
# the projecto-compress binary. There is no separate archiver-worker container in this setup.
#
# Build from the repo root, from a clean checkout. Every ARG below is required and has no default:
#
#   set -a; . docker/versions.env; set +a
#   GIT_SHA=$(git rev-parse HEAD)
#   docker build -f docker/web-supervised.Dockerfile \
#     --build-arg BUN_VERSION --build-arg BUN_ALPINE_DIGEST \
#     --build-arg ALPINE_VERSION --build-arg ALPINE_DIGEST \
#     --build-arg NEXT_PUBLIC_KRATOS_PUBLIC_URL=https://example.com/kratos \
#     --build-arg GIT_SHA="$GIT_SHA" \
#     -t "projecto-web:$GIT_SHA" .
#
# NEXT_PUBLIC_KRATOS_PUBLIC_URL is compiled into the client bundle, so it must be set here, at build time.
# The native stage downloads zstd and doctest (SHA256-checked by CMake) and fetches the pinned brotli
# commit with git, so it needs network.

ARG BUN_VERSION
ARG BUN_ALPINE_DIGEST
ARG ALPINE_VERSION
ARG ALPINE_DIGEST

# ---- native: build and test projecto-compress -------------------------------------------------
FROM alpine:${ALPINE_VERSION}@${ALPINE_DIGEST} AS native
# git: the pinned brotli commit is fetched from git at CMake configure time, so the configure step
# needs git and network access at build time (as do the zstd and doctest downloads).
RUN apk add --no-cache build-base cmake ninja linux-headers perl git
WORKDIR /src
COPY native/compressor/ native/compressor/
# ctest failing fails the build: the && chain stops and the RUN step exits non-zero.
# The last two checks prove the hardened link: no PT_INTERP and no NEEDED entry means a static binary.
RUN cmake -S native/compressor -B build -G Ninja -DCMAKE_BUILD_TYPE=Release \
 && cmake --build build \
 && ctest --test-dir build --output-on-failure \
 && strip build/projecto-compress \
 && readelf -lW build/projecto-compress >/dev/null \
 && readelf -dW build/projecto-compress >/dev/null \
 && ! readelf -lW build/projecto-compress | grep -q INTERP \
 && ! readelf -dW build/projecto-compress | grep -q NEEDED \
 && build/projecto-compress --version

# ---- builder: full install and next build -----------------------------------------------------
FROM oven/bun:${BUN_VERSION}-alpine@${BUN_ALPINE_DIGEST} AS builder
ARG NEXT_PUBLIC_KRATOS_PUBLIC_URL
ENV NEXT_PUBLIC_KRATOS_PUBLIC_URL=${NEXT_PUBLIC_KRATOS_PUBLIC_URL}
WORKDIR /app
COPY package.json bun.lock jsconfig.json next.config.mjs postcss.config.mjs eslint.config.mjs ./
RUN bun install --frozen-lockfile
COPY . .
RUN test -n "$NEXT_PUBLIC_KRATOS_PUBLIC_URL" || { echo "build arg NEXT_PUBLIC_KRATOS_PUBLIC_URL is required" >&2; exit 1; }
RUN bun run build

# ---- deps: production node_modules from the lockfile ------------------------------------------
FROM oven/bun:${BUN_VERSION}-alpine@${BUN_ALPINE_DIGEST} AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# ---- runtime ----------------------------------------------------------------------------------
FROM oven/bun:${BUN_VERSION}-alpine@${BUN_ALPINE_DIGEST}
RUN addgroup -S -g 10001 app \
 && adduser -S -D -H -s /sbin/nologin -u 10001 -G app app \
 && mkdir -p /work/tmp /work/recovery /work/run \
 && chown -R 10001:10001 /work
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json jsconfig.json next.config.mjs ./
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
# src/ holds the web app and the code the embedded worker imports (src/app/lib, server-functions).
COPY src ./src
COPY worker ./worker
COPY docker/web-healthcheck.js ./docker/web-healthcheck.js
COPY --from=native /src/build/projecto-compress /usr/local/bin/projecto-compress
# Next.js writes its image and fetch cache under .next/cache at runtime. The builder's cache must not
# travel into the image: the path is a VOLUME below, and a fresh volume is seeded from the image.
RUN rm -rf .next/cache && mkdir -p .next/cache && chown -R 10001:10001 .next/cache

# The revision goes in last so a new commit does not invalidate the layers above.
ARG GIT_SHA
RUN test -n "$GIT_SHA" || { echo "build arg GIT_SHA is required" >&2; exit 1; }
LABEL org.opencontainers.image.title="projecto-web" \
      org.opencontainers.image.revision="${GIT_SHA}"
ENV NODE_ENV=production \
    HOSTNAME=0.0.0.0 \
    PORT=3000 \
    HOME=/work/tmp \
    TMPDIR=/work/tmp \
    ARCHIVER_MODE=embedded \
    ARCHIVER_RECOVERY_DIR=/work/recovery \
    ARCHIVER_LIVENESS_FILE=/work/run/archiver-alive \
    ARCHIVER_VERSION=${GIT_SHA} \
    PROJECTO_COMPRESSOR_BIN=/usr/local/bin/projecto-compress \
    BUN_RUNTIME_TRANSPILER_CACHE_PATH=0

# Smoke check: the compressor starts on the final base image.
RUN /usr/local/bin/projecto-compress --version

# Every path the web server and the embedded archiver write at runtime is a volume, so the
# container also starts with `read_only: true` (the rootfs stays read-only, volumes and tmpfs mounts
# stay writable). The directories are created and owned by 10001 above; declared after every RUN
# that writes to them: later build steps cannot change a volume's contents.
#   /work/tmp         TMPDIR and HOME: downloaded originals and compressor output (several GiB per
#                     file), kept out of the container's writable layer. Mount a named volume in
#                     production, so the temp originals the crash journal references survive a
#                     container replacement.
#   /work/recovery    ARCHIVER_RECOVERY_DIR: originals that could not be verified or restored.
#                     Mount a named volume in production; an anonymous volume is not
#                     removed with the container unless it ran with `--rm` (or `docker rm -v`).
#   /work/run         ARCHIVER_LIVENESS_FILE for HEALTHCHECK, rewritten every 10 s. Small and
#                     disposable: mount a tmpfs with uid=10001,gid=10001 over it.
#   /app/.next/cache  Next.js image and fetch cache. Disposable: a tmpfs with uid=10001,gid=10001
#                     works as well.
VOLUME ["/work/tmp", "/work/recovery", "/work/run", "/app/.next/cache"]

USER 10001:10001
EXPOSE 3000
# Web answers /api/ping and, in embedded mode, the archiver worker sent a heartbeat in the last
# 60 s. The start period covers Next.js start-up and the worker's first registration.
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD ["bun", "docker/web-healthcheck.js"]
# Next.js on Bun, so the supervised child is started with the same Bun as the web server
# (ARCHIVER_BUN_BIN is not needed). Untested here: confirm `next start` runs under --bun.
#
# NEXT_MANUAL_SIG_HANDLE=1 is exported only when ARCHIVER_MODE=embedded (the default above; a
# runtime -e ARCHIVER_MODE=off turns it off too). With it, `next start` installs no SIGTERM / SIGINT
# handler of its own (that would exit at once and kill the archiver mid-job); the archiver
# supervisor handles both signals and exits only after the worker has stopped
# (archiverSupervisor.js, up to ARCHIVER_STOP_GRACE_MS, default 100 s, so keep the container's stop
# timeout above that, e.g. `docker stop -t 120` or compose `stop_grace_period: 2m`). Without the
# embedded archiver nothing else would handle those signals, so Next.js keeps its own handlers.
# `exec` makes bun replace the shell, so signals reach it directly; CMD / run arguments are passed
# on to `next start`.
#
# Run the container with an init as PID 1: `docker run --init` or compose `init: true` (both use
# tini). bun as PID 1 does not reap orphaned grandchildren, so a projecto-compress left behind by a
# SIGKILLed archiver worker (it exits on its own through --watch-stdin) would stay a zombie; tini
# reaps it and forwards SIGTERM / SIGINT to bun.
ENTRYPOINT ["/bin/sh", "-c", "if [ \"$ARCHIVER_MODE\" = embedded ]; then export NEXT_MANUAL_SIG_HANDLE=1; fi; exec bun --bun node_modules/next/dist/bin/next start \"$@\"", "web-entrypoint"]
