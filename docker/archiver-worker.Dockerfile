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
# The native stage downloads zstd, brotli and doctest (SHA256-checked by CMake), so it needs network.

ARG BUN_VERSION
ARG BUN_ALPINE_DIGEST
ARG ALPINE_VERSION
ARG ALPINE_DIGEST

# ---- native: build and test projecto-compress -------------------------------------------------
FROM alpine:${ALPINE_VERSION}@${ALPINE_DIGEST} AS native
RUN apk add --no-cache build-base cmake ninja linux-headers
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
 && mkdir -p /work/tmp /work/recovery \
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
    ARCHIVER_VERSION=${GIT_SHA} \
    PROJECTO_COMPRESSOR_BIN=/usr/local/bin/projecto-compress \
    BUN_RUNTIME_TRANSPILER_CACHE_PATH=0

# Smoke check on the final base image (still root, before USER): the binary starts here.
RUN /usr/local/bin/projecto-compress --version

USER 10001:10001
ENTRYPOINT ["bun", "--conditions", "react-server", "worker/archiver/main.js"]
