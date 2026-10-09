#!/bin/sh
set -eu
export DISPLAY=:99
export BROWSER_SCREEN_WIDTH=1440
export BROWSER_SCREEN_HEIGHT=900
Xvfb :99 -screen 0 "${BROWSER_SCREEN_WIDTH}x${BROWSER_SCREEN_HEIGHT}x24" -nolisten tcp &
display_pid=$!
cleanup() {
  kill "$display_pid" "${view_pid:-}" "${control_pid:-}" "${node_pid:-}" 2>/dev/null || true
}
trap cleanup EXIT INT TERM
attempt=0
until xdpyinfo -display :99 >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 50 ]; then exit 1; fi
  sleep 0.1
done
x11vnc -display :99 -localhost -rfbport 5900 -forever -shared -viewonly -nopw -noxdamage -quiet &
view_pid=$!
x11vnc -display :99 -localhost -rfbport 5901 -forever -shared -nopw -noxdamage -quiet &
control_pid=$!
node /app/dist/server.js &
node_pid=$!
wait "$node_pid"
