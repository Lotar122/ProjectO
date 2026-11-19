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
RUN cmake -S native/compressor -B build -G Ninja -DCMAKE_BUILD_TYPE=Release \
 && cmake --build build \
 && ctest --test-dir build --output-on-failure \
 && strip build/projecto-compress \
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
 && mkdir -p /work/tmp /work/recovery \
 && chown -R 10001:10001 /work
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json jsconfig.json next.config.mjs ./
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
# src/ holds the web app and the code the embedded worker imports (src/app/lib, server-functions).
COPY src ./src
COPY worker ./worker
COPY --from=native /src/build/projecto-compress /usr/local/bin/projecto-compress
# Next.js writes its image and fetch cache under .next/cache at runtime.
RUN mkdir -p .next/cache && chown -R 10001:10001 .next/cache

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
    ARCHIVER_VERSION=${GIT_SHA} \
    PROJECTO_COMPRESSOR_BIN=/usr/local/bin/projecto-compress \
    BUN_RUNTIME_TRANSPILER_CACHE_PATH=0

# Smoke check: the compressor starts on the final base image.
RUN /usr/local/bin/projecto-compress --version

USER 10001:10001
EXPOSE 3000
# Next.js on Bun, so the supervised child is started with the same Bun as the web server
# (ARCHIVER_BUN_BIN is not needed). Untested here: confirm `next start` runs under --bun.
ENTRYPOINT ["bun", "--bun", "node_modules/next/dist/bin/next", "start"]
