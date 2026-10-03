param(
  [string]$ReleaseFile,
  [string]$WorkerDist,
  [ValidateSet('smoke', 'selftest', 'baseline')][string]$Mode = 'smoke',
  [ValidateSet('720p', '1080p')][string]$Viewport = '720p'
)
$ErrorActionPreference = 'Stop'
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
$context = if ($env:HELM_TEST_DOCKER_CONTEXT) { $env:HELM_TEST_DOCKER_CONTEXT } else { 'desktop-linux' }
$release = @{}
if (!$ReleaseFile) { $ReleaseFile = Join-Path $repo 'Deploy/release.env' }
Get-Content -LiteralPath $ReleaseFile | ForEach-Object {
  if ($_ -match '^(WORKER|TURN|EGRESS|NGINX)_IMAGE=(sha256:[a-f0-9]{64})$') { $release[$Matches[1]] = $Matches[2] }
}
foreach ($component in @('WORKER', 'TURN', 'EGRESS', 'NGINX')) {
  if (!$release.ContainsKey($component)) { throw "Missing immutable $component fixture image" }
  docker --context $context image inspect $release[$component] --format '{{.Id}}' | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Load the selected $component image into the local fixture daemon" }
}
if (!$WorkerDist) {
  npm --prefix "$repo/backend/browser-worker" run build
  if ($LASTEXITCODE -ne 0) { throw 'Worker compilation failed' }
  $WorkerDist = Join-Path $repo 'backend/browser-worker/dist'
}
$WorkerDist = (Resolve-Path -LiteralPath $WorkerDist).Path
if (!(Test-Path -LiteralPath (Join-Path $WorkerDist 'src/session.js'))) { throw 'Compiled worker missing' }
$testId = 'helm-media-' + [Guid]::NewGuid().ToString('N').Substring(0, 12)
$fixture = Join-Path ([IO.Path]::GetTempPath()) $testId
$null = New-Item -ItemType Directory -Path $fixture
$workerNetwork = "$testId-worker"
$relayNetwork = "$testId-relay"
$turnAddress = '172.29.41.2'
$credentials = @{
  turn = [Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
  proxy = [Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
  turnAddress = $turnAddress
}
[IO.File]::WriteAllText((Join-Path $fixture 'credentials.json'), ($credentials | ConvertTo-Json -Compress))
[IO.File]::WriteAllText((Join-Path $fixture 'turn.json'), (@{schemaVersion=2;turnSharedSecret=$credentials.turn} | ConvertTo-Json -Compress))
[IO.File]::WriteAllText((Join-Path $fixture 'egress.json'), (@{schemaVersion=1;mediaProxyUsername='helm-media';mediaProxyPassword=$credentials.proxy} | ConvertTo-Json -Compress))
$helperWrapper = @'
#!/bin/sh
GST_DEBUG=webrtc*:5,nice*:5 exec /usr/local/bin/helm-media-helper 2>/runtime/helper.log
'@
if ($Mode -ne 'smoke') {
  $helperWrapper = "#!/bin/sh`nexec /usr/local/bin/helm-media-helper 2>/runtime/helper.log"
}
[IO.File]::WriteAllText((Join-Path $fixture 'helm-media-helper'), $helperWrapper.Replace([string][char]13, '') + [char]10)
$gatewayConfiguration = @'
events {}
stream {
    server {
        listen 3478;
        proxy_pass coturn:3478;
        proxy_timeout 2m;
    }
}
'@
[IO.File]::WriteAllText((Join-Path $fixture 'gateway.conf'), $gatewayConfiguration.Replace([string][char]13, ''))
try {
  docker --context $context network create --internal $workerNetwork | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Could not create isolated worker network' }
  docker --context $context network create --internal --subnet 172.29.41.0/24 --ip-range 172.29.41.128/25 $relayNetwork | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Could not create isolated relay network' }
  docker --context $context run -d --name "$testId-turn" --network $relayNetwork --ip $turnAddress --network-alias coturn --read-only --cap-drop=ALL --tmpfs /run:uid=10001,gid=10001,mode=0700 --tmpfs /tmp --env TURN_REALM=media-acceptance --env TURN_RELAY_MIN=49160 --env TURN_RELAY_MAX=49200 --mount "type=bind,source=$fixture/turn.json,target=/run/secrets/turn_identity,readonly" $release.TURN | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Could not start canonical TURN fixture' }
  docker --context $context run -d --name "$testId-proxy" --network $relayNetwork --network-alias egress-proxy --read-only --cap-drop=ALL --tmpfs /run:uid=10001,gid=10001,mode=0700 --tmpfs /tmp --mount "type=bind,source=$fixture/egress.json,target=/run/secrets/egress_identity,readonly" $release.EGRESS | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Could not start canonical Squid fixture' }
  docker --context $context network connect --alias egress-proxy $workerNetwork "$testId-proxy"
  if ($LASTEXITCODE -ne 0) { throw 'Could not attach proxy to the worker network' }
  # Only the test viewer uses this public-listener equivalent. The producer must use Squid.
  docker --context $context run -d --name "$testId-gateway" --network $relayNetwork --read-only --cap-drop=ALL --tmpfs /tmp --user 101:101 --mount "type=bind,source=$fixture/gateway.conf,target=/fixture/gateway.conf,readonly" --entrypoint nginx $release.NGINX -c /fixture/gateway.conf -e /dev/stderr -g 'pid /tmp/nginx.pid; daemon off;' | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Could not start viewer TURN gateway' }
  docker --context $context network connect --alias viewer-gateway $workerNetwork "$testId-gateway"
  if ($LASTEXITCODE -ne 0) { throw 'Could not attach viewer gateway' }
  foreach ($component in @('turn', 'proxy')) {
    $ready = $false
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
      docker --context $context exec "$testId-$component" /opt/helm/bin/healthcheck 2>$null | Out-Null
      if ($LASTEXITCODE -eq 0) { $ready = $true; break }
      Start-Sleep -Milliseconds 100
    }
    if (!$ready) { throw "$component fixture not ready" }
  }
  $workerArgs = @('run', '--rm', '--name', "$testId-worker", '--network', $workerNetwork,
    '--read-only', '--cap-drop=ALL', '--env', 'PATH=/fixture:/usr/local/bin:/usr/bin:/bin',
    '--env', "HELM_MEDIA_MODE=$Mode", '--env', "HELM_MEDIA_VIEWPORT=$Viewport",
    '--security-opt', "seccomp=$repo/Deploy/security/chromium-seccomp.json",
    '--tmpfs', '/runtime:uid=10001,gid=10001,mode=0700', '--tmpfs', '/tmp:mode=1777',
    '--mount', "type=bind,source=$fixture,target=/fixture,readonly",
    '--mount', "type=bind,source=$repo/backend/browser-worker/tests,target=/app/tests,readonly",
    '--mount', "type=bind,source=$WorkerDist,target=/app/dist,readonly",
    '--mount', "type=bind,source=$repo/frontend/node_modules/gstwebrtc-api/src,target=/sdk,readonly",
    '--entrypoint', 'node')
  if ($Mode -ne 'smoke') {
    # Includes the local receiver Chromium: report this shared CPU budget explicitly.
    $workerArgs += @('--cpus', '2', '--memory', '2g', '--memory-swap', '2g', '--shm-size', '512m')
  }
  # Reproduce the missing-resolution failure before applying the one-name mapping.
  $baseline = @(docker --context $context @workerArgs $release.WORKER /app/tests/webrtc-smoke.mjs 2>&1)
  if ($LASTEXITCODE -eq 0 -or ($baseline -join [char]10) -notmatch 'EAI_AGAIN|ENOTFOUND') {
    throw 'The isolated baseline did not reproduce the TURN hostname resolution failure'
  }
  Write-Host 'Baseline rejected: coturn is not resolvable from the isolated worker network'
  docker --context $context @workerArgs --add-host "coturn:$turnAddress" $release.WORKER /app/tests/webrtc-smoke.mjs
  if ($LASTEXITCODE -ne 0) { throw 'Isolated TURN WebRTC acceptance failed' }
} finally {
  docker --context $context rm -f "$testId-worker" "$testId-gateway" "$testId-turn" "$testId-proxy" 2>$null | Out-Null
  docker --context $context network rm $workerNetwork $relayNetwork 2>$null | Out-Null
  $resolvedFixture = [IO.Path]::GetFullPath($fixture)
  if (!$resolvedFixture.StartsWith([IO.Path]::GetFullPath([IO.Path]::GetTempPath()), [StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($resolvedFixture) -ne $testId) { throw 'Unsafe fixture cleanup path' }
  Remove-Item -LiteralPath $resolvedFixture -Recurse -Force
}
