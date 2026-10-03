$ErrorActionPreference = 'Stop'
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
npm --prefix "$repo/backend/browser-worker" run build
if ($LASTEXITCODE -ne 0) { throw 'Worker compilation failed' }
$testId = 'helm-media-' + [Guid]::NewGuid().ToString('N').Substring(0, 12)
$fixture = Join-Path ([IO.Path]::GetTempPath()) $testId
$null = New-Item -ItemType Directory -Path $fixture
$credentials = @{ turn = [Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)); proxy = [Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)) }
[IO.File]::WriteAllText((Join-Path $fixture 'credentials.json'), ($credentials | ConvertTo-Json -Compress))
$squidScript = @'
#!/bin/sh
set -eu
umask 077
mkdir -p /run/helm
password_hash=$(jq -r .proxy /fixture/credentials.json | openssl passwd -6 -stdin)
printf 'helm-media:%s\n' "$password_hash" > /run/helm/media-proxy.htpasswd
unset password_hash
exec /usr/local/sbin/squid -N -f /fixture/squid.conf
'@
$turnScript = @'
#!/bin/sh
set -eu
umask 077
mkdir -p /run/helm
cat > /run/helm/turn.conf <<EOF
listening-port=3478
listening-ip=$(hostname -i | awk '{print $1}')
relay-ip=$(hostname -i | awk '{print $1}')
realm=media-acceptance
use-auth-secret
fingerprint
no-tls
no-cli
no-multicast-peers
no-tcp-relay
min-port=49160
max-port=49200
log-file=stdout
pidfile=/run/helm/turn.pid
EOF
printf 'static-auth-secret=%s\n' "$(jq -r .turn /fixture/credentials.json)" >> /run/helm/turn.conf
exec /usr/bin/turnserver -c /run/helm/turn.conf
'@
[IO.File]::WriteAllText((Join-Path $fixture 'squid.sh'), $squidScript.Replace("`r`n", "`n"))
[IO.File]::WriteAllText((Join-Path $fixture 'turn.sh'), $turnScript.Replace("`r`n", "`n"))
[IO.File]::WriteAllText((Join-Path $fixture 'helm-media-helper'), "#!/bin/sh`nGST_DEBUG=webrtc*:5,nice*:5 exec /usr/local/bin/helm-media-helper 2>/runtime/helper.log`n")
[IO.File]::WriteAllText((Join-Path $fixture 'squid.conf'), [IO.File]::ReadAllText((Join-Path $repo 'Deploy/egress-proxy/squid.conf')).Replace('access_log none', 'access_log stdio:/run/helm/access.log squid'))
try {
  docker network create $testId | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Could not create acceptance network' }
  docker run -d --name "$testId-turn" --network $testId --network-alias coturn --read-only --cap-drop=ALL --tmpfs /run:uid=10001,gid=10001,mode=0700 --mount "type=bind,source=$fixture,target=/fixture,readonly" --entrypoint /bin/sh helmglass-coturn:0.1.0 /fixture/turn.sh | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Could not start TURN fixture' }
  docker run -d --name "$testId-proxy" --network $testId --network-alias egress-proxy --read-only --cap-drop=ALL --tmpfs /run:uid=10001,gid=10001,mode=0700 --mount "type=bind,source=$fixture,target=/fixture,readonly" --entrypoint /bin/sh helmglass-egress-proxy:0.1.0 /fixture/squid.sh | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Could not start Squid fixture' }
  docker run --rm --network $testId --read-only --cap-drop=ALL --env PATH=/fixture:/usr/local/bin:/usr/bin:/bin --security-opt "seccomp=$repo/Deploy/security/chromium-seccomp.json" --tmpfs /runtime:uid=10001,gid=10001,mode=0700 --tmpfs /tmp:mode=1777 --mount "type=bind,source=$fixture,target=/fixture,readonly" --mount "type=bind,source=$repo/backend/browser-worker/tests,target=/app/tests,readonly" --mount "type=bind,source=$repo/backend/browser-worker/dist,target=/app/dist,readonly" --mount "type=bind,source=$repo/frontend/node_modules/gstwebrtc-api/src,target=/sdk,readonly" --entrypoint node helmglass-browser-worker:0.1.0 /app/tests/webrtc-smoke.mjs
  if ($LASTEXITCODE -ne 0) { throw 'WebRTC acceptance failed' }
} catch {
  docker logs --tail 35 "$testId-turn"
  docker exec "$testId-proxy" cat /run/helm/access.log
  throw
} finally {
  docker rm -f "$testId-turn" "$testId-proxy" | Out-Null
  docker network rm $testId | Out-Null
  $resolvedFixture = [IO.Path]::GetFullPath($fixture)
  if (!$resolvedFixture.StartsWith([IO.Path]::GetFullPath([IO.Path]::GetTempPath()), [StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($resolvedFixture) -ne $testId) { throw 'Unsafe fixture cleanup path' }
  Remove-Item -LiteralPath $resolvedFixture -Recurse -Force
}
