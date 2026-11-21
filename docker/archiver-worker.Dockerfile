#
# Archiver worker: Bun + the archiver JS + the projecto-compress binary (phases-bugfix/phase4.md 10.3).
#
# Build from the repo root, from a clean checkout. Every ARG below is required and has no default,
# so a forgotten one fails the build instead of silently using something else:
#
#   set -a; . docker/versions.env; set +a
#   GIT_SHA=$(git rev-parse HEAD)
#   docker build -f docker/archiver-worker.Dockerfile \
#     --build-arg BUN_VERSION --build-arg BUN_ALPINE_DIGEST \
#     --build-arg ALPINE_VERSION --build-arg ALPINE_DIGEST \
#     --build-arg GIT_SHA="$GIT_SHA" \
#     -t "projecto-archiver-worker:$GIT_SHA" .
#
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

# ---- deps: production node_modules from the lockfile ------------------------------------------
FROM oven/bun:${BUN_VERSION}-alpine@${BUN_ALPINE_DIGEST} AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# ---- runtime ----------------------------------------------------------------------------------
FROM oven/bun:${BUN_VERSION}-alpine@${BUN_ALPINE_DIGEST}
RUN addgroup -S -g 10001 archiver \
 && adduser -S -D -H -s /sbin/nologin -u 10001 -G archiver archiver \
 && mkdir -p /work/tmp /work/recovery /work/run \
 && chown -R 10001:10001 /work
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json jsconfig.json ./
COPY src/app/lib ./src/app/lib
COPY src/app/server-functions ./src/app/server-functions
COPY worker ./worker
COPY --from=native /src/build/projecto-compress /usr/local/bin/projecto-compress

# The revision goes in last so a new commit does not invalidate the layers above.
ARG GIT_SHA
RUN test -n "$GIT_SHA" || { echo "build arg GIT_SHA is required" >&2; exit 1; }
LABEL org.opencontainers.image.title="projecto-archiver-worker" \
      org.opencontainers.image.revision="${GIT_SHA}"
ENV NODE_ENV=production \
    HOME=/work/tmp \
    TMPDIR=/work/tmp \
    ARCHIVER_RECOVERY_DIR=/work/recovery \
    ARCHIVER_LIVENESS_FILE=/work/run/archiver-alive \
    ARCHIVER_VERSION=${GIT_SHA} \
    PROJECTO_COMPRESSOR_BIN=/usr/local/bin/projecto-compress \
    BUN_RUNTIME_TRANSPILER_CACHE_PATH=0

# Smoke check on the final base image (still root, before USER): the binary starts here.
RUN /usr/local/bin/projecto-compress --version

# Every path the worker writes at runtime is a volume, so the container also starts with
# `read_only: true` (the rootfs stays read-only, volumes and tmpfs mounts stay writable). The
# directories are created and owned by 10001 above; declared after every RUN that writes to them:
# later build steps cannot change a volume's contents.
#   /work/tmp       TMPDIR and HOME: downloaded originals and compressor output (several GiB per
#                   file), kept out of the container's writable layer. Mount a named volume in
#                   production, so the temp originals the crash journal references survive a
#                   container replacement.
#   /work/recovery  ARCHIVER_RECOVERY_DIR: originals that could not be verified or restored. Mount
#                   a named volume in production; the anonymous volume is lost with the container.
#   /work/run       ARCHIVER_LIVENESS_FILE for HEALTHCHECK, rewritten every 10 s. Small and
#                   disposable: mount a tmpfs with uid=10001,gid=10001 over it.
VOLUME ["/work/tmp", "/work/recovery", "/work/run"]

USER 10001:10001
# Healthy while the worker has sent a database heartbeat in the last 60 s (worker/archiver/healthcheck.js).
# Unhealthy when it is hung, crash-looping or cannot reach Postgres.
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD ["bun", "worker/archiver/healthcheck.js"]
# Run the container with an init as PID 1: `docker run --init` or compose `init: true` (both use
# tini). bun as PID 1 does not reap orphaned children, so a projecto-compress left behind by a
# SIGKILLed or OOM-killed worker (it exits on its own through --watch-stdin) would stay a zombie;
# tini reaps it and forwards SIGTERM to the worker. Keep the stop timeout (e.g. compose
# `stop_grace_period: 2m`) above the worker's stop deadline: ARCHIVER_STOP_GRACE_MS (default
# 100 s) minus its margin, 90 s by default (worker/archiver/shutdown.js).
ENTRYPOINT ["bun", "--conditions", "react-server", "worker/archiver/main.js"]
