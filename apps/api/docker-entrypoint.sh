#!/bin/sh
# Refreshes the portal's product list before the API starts.
#
# The API reads every satellite, sensor and product level from the cache
# `bhd archive` writes (~/.bhoonidhi/archive.json, kept on a volume). The
# refresh is one request to the Bhoonidhi portal and needs no login. When the
# portal cannot be reached, the API still starts: with the copy the volume
# already holds, or, on a first start with none, by sampling product levels
# from the catalogue's scenes (which can miss a level; see archive.py).
set -eu

if timeout "${ARCHIVE_REFRESH_TIMEOUT:-60}" bhd archive export --refresh --out /tmp/archive.json >/dev/null 2>&1; then
  echo "bhd archive: product list refreshed from the portal"
elif [ -s "$HOME/.bhoonidhi/archive.json" ]; then
  echo "bhd archive: portal unreachable; using the product list from the last start"
else
  echo "bhd archive: portal unreachable and no saved product list; levels will be sampled from the catalogue"
fi

exec "$@"
