#!/bin/sh
set -eu
cd "$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)"
exec node --test Deploy/coturn/tests/transport.integration.mjs
