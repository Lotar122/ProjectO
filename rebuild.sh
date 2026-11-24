#!/usr/bin/env bash
# Builds the web image from the current commit and replaces the running container.
set -euo pipefail

cd "$(dirname "$0")"

set -a
. docker/versions.env
set +a

GIT_SHA=$(git rev-parse HEAD)
KRATOS_URL=$(grep '^NEXT_PUBLIC_KRATOS_PUBLIC_URL=' .env | cut -d= -f2- | tr -d "\"'")

sudo docker build -f docker/web-supervised.Dockerfile \
  --build-arg BUN_VERSION="$BUN_VERSION" \
  --build-arg BUN_ALPINE_DIGEST="$BUN_ALPINE_DIGEST" \
  --build-arg ALPINE_VERSION="$ALPINE_VERSION" \
  --build-arg ALPINE_DIGEST="$ALPINE_DIGEST" \
  --build-arg NEXT_PUBLIC_KRATOS_PUBLIC_URL="$KRATOS_URL" \
  --build-arg GIT_SHA="$GIT_SHA" \
  -t "projecto-web:$GIT_SHA" .

# Self-signed MinIO: put its public.crt next to this script as minio-ca.pem and the
# client will trust it (and only it) for MinIO connections.
CA_ARGS=()
if [ -f minio-ca.pem ]; then
  CA_ARGS=(-v "$PWD/minio-ca.pem:/work/minio-ca.pem:ro" -e MINIO_CA_FILE=/work/minio-ca.pem)
fi

sudo docker rm -f projecto >/dev/null 2>&1 || true
sudo docker run -d --name projecto --restart unless-stopped --network projecto -p 3000:3000 \
  --env-file .env "${CA_ARGS[@]}" -v archiver-work:/work/tmp -v archiver-recovery:/work/recovery \
  "projecto-web:$GIT_SHA"
