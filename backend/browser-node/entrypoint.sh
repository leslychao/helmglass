#!/bin/sh
set -eu
# Only the session parent needs bootstrap privileges; permanent API files keep their owner.
[ ! -L /artifacts ]
if [ "$(stat -c '%u:%g' /artifacts)" = '0:0' ]; then
  chown 10001:10001 /artifacts
fi
[ "$(stat -c '%u:%g' /artifacts)" = '10001:10001' ]
if [ ! -e /artifacts/sessions ]; then
  mkdir /artifacts/sessions
  chown 1000:10001 /artifacts/sessions
  chmod 2770 /artifacts/sessions
fi
[ -d /artifacts/sessions ] && [ ! -L /artifacts/sessions ]
[ "$(stat -c '%u:%g:%a' /artifacts/sessions)" = '1000:10001:2770' ]
exec setpriv --reuid=1000 --regid=1000 --groups=1000,10001 --inh-caps=-all --ambient-caps=-all --bounding-set=-all "$@"
