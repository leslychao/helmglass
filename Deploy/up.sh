#!/bin/sh
set -eu
if [ "$#" -ne 1 ] || [ "$1" != dev ]; then
  printf '%s\n' 'Usage: ./Deploy/up.sh dev' >&2
  exit 2
fi
script_directory=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec node "$script_directory/up.mjs" dev
