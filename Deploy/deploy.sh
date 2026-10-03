#!/bin/sh
set -eu
cd -- "$(dirname -- "$0")/.."

if [ ! -f Deploy/.env.dev ]; then
  printf '%s\n' 'Create Deploy/.env.dev from Deploy/.env.example and fill in the dev 107 configuration.' >&2
  exit 1
fi

node --input-type=module <<'NODE'
import { readEnvironmentFile } from './Deploy/configuration.mjs';

const configuration = await readEnvironmentFile('./Deploy/.env.dev');
if (configuration.DOCKER_HOST !== 'tcp://192.168.0.107:2375') {
  throw new Error('Deploy/.env.dev must set DOCKER_HOST=tcp://192.168.0.107:2375');
}
NODE

node Deploy/build.mjs dev-107
exec node Deploy/up.mjs dev
