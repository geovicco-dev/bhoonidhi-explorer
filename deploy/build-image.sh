#!/usr/bin/env bash
# Builds the explorer image and pushes it to a registry.
#
#   deploy/build-image.sh <image> <version>
#   deploy/build-image.sh ghcr.io/geovicco-dev/bhoonidhi-explorer 0.1.0
#
# Tags the image <version> and <major>.<minor>, and writes the commit and
# the version into its labels, so two builds of one release can be compared.
# Run from a clean checkout of the release's commit; the build context is
# the repository root.
#
# It uses `docker build` and `docker push` through the Docker daemon, which
# also reaches a registry the daemon is set up to trust over plain HTTP.
set -euo pipefail

if [ $# -ne 2 ]; then
  echo "usage: deploy/build-image.sh <image> <version>" >&2
  exit 2
fi
image=$1
version=$2
if ! [[ $version =~ ^([0-9]+)\.([0-9]+)\.[0-9]+$ ]]; then
  echo "build-image: version must look like 1.2.3, got '$version'" >&2
  exit 2
fi
minor="${BASH_REMATCH[1]}.${BASH_REMATCH[2]}"

cd "$(git rev-parse --show-toplevel)"
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "build-image: the checkout has uncommitted changes; build from a clean commit" >&2
  exit 1
fi
commit=$(git rev-parse HEAD)

docker build \
  --file deploy/explorer.Dockerfile \
  --tag "$image:$version" \
  --tag "$image:$minor" \
  --label org.opencontainers.image.title=bhoonidhi-explorer \
  --label "org.opencontainers.image.description=Find Bhoonidhi satellite scenes by asking in plain words" \
  --label org.opencontainers.image.source=https://github.com/geovicco-dev/bhoonidhi-explorer \
  --label org.opencontainers.image.licenses=MIT \
  --label "org.opencontainers.image.version=$version" \
  --label "org.opencontainers.image.revision=$commit" \
  --label "org.opencontainers.image.created=$(git show -s --format=%cI "$commit")" \
  .

docker push "$image:$version"
docker push "$image:$minor"
echo "build-image: pushed $image:$version and $image:$minor from $commit"
