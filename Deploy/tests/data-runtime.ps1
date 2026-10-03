$ErrorActionPreference = 'Stop'
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$scratchRoot = Join-Path $repo '.cache'
$testId = [Guid]::NewGuid().ToString('N').Substring(0, 12)
$scratch = Join-Path $scratchRoot "data-runtime-$testId"
$null = New-Item -ItemType Directory -Path $scratch
$encoding = [Text.UTF8Encoding]::new($false)
function Write-PrivateJson($name, $value) {
  [IO.File]::WriteAllText((Join-Path $scratch $name), ($value | ConvertTo-Json -Compress), $encoding)
}
function New-Password {
  return [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLowerInvariant()
}
function Run-Docker([string[]] $Arguments) {
  $output = & docker @Arguments 2>&1
  if ($LASTEXITCODE -ne 0) { throw "Docker check failed: $($Arguments[0]) ($output)" }
  return "$output".Trim()
}
function Expect-Denied([string[]] $Arguments, [string] $Pattern) {
  $output = & docker @Arguments 2>&1
  if ($LASTEXITCODE -eq 0 -or "$output" -notmatch $Pattern) { throw 'Expected permission refusal did not occur' }
}
function Wait-Healthy($name) {
  for ($attempt = 0; $attempt -lt 30; $attempt++) {
    & docker exec $name /opt/helm/bin/healthcheck 2>$null
    if ($LASTEXITCODE -eq 0) { return }
    Start-Sleep -Seconds 1
  }
  throw "Readiness deadline exceeded for $name"
}
$pg = "helm-pg-check-$testId"
$redis = "helm-redis-check-$testId"
$pgVolume = "$pg-data"
$redisVolume = "$redis-data"
$passwords = @{ schemaVersion = 1; rootPassword = (New-Password); migrationPassword = (New-Password); apiPassword = (New-Password); keycloakPassword = (New-Password) }
$redisPasswords = @{ schemaVersion = 1; health = (New-Password); api = (New-Password); oauth = (New-Password) }
Write-PrivateJson 'postgres.json' $passwords
Write-PrivateJson 'redis-health.json' @{ schemaVersion = 1; username = 'helm_health'; password = $redisPasswords.health }
Write-PrivateJson 'redis-verification.json' $redisPasswords
$acl = [IO.File]::ReadAllText((Join-Path $repo 'Deploy/redis/users.acl.template'))
foreach ($pair in @(@('HEALTH', 'health'), @('API', 'api'), @('OAUTH', 'oauth'))) {
  $hash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($redisPasswords[$pair[1]]))).ToLowerInvariant()
  $acl = $acl.Replace("$($pair[0])_PASSWORD_SHA256", $hash)
}
[IO.File]::WriteAllText((Join-Path $scratch 'users.acl'), $acl, $encoding)
try {
  $null = Run-Docker @('volume', 'create', $pgVolume)
  $null = Run-Docker @('volume', 'create', $redisVolume)
  $null = Run-Docker @('run', '-d', '--name', $pg, '--network', 'none', '--mount', "type=bind,src=$scratch/postgres.json,dst=/run/secrets/postgres_identity,readonly", '--mount', "type=volume,src=$pgVolume,dst=/var/lib/postgresql", 'helmglass-postgres:0.1.0')
  $null = Run-Docker @('run', '-d', '--name', $redis, '--network', 'none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges:true', '--tmpfs', '/run:uid=10001,gid=10001,mode=0700', '--tmpfs', '/tmp:uid=10001,gid=10001,mode=1777', '--mount', "type=bind,src=$scratch/users.acl,dst=/run/secrets/redis_acl,readonly", '--mount', "type=bind,src=$scratch/redis-health.json,dst=/run/secrets/redis_health_identity,readonly", '--mount', "type=bind,src=$scratch/redis-verification.json,dst=/run/secrets/verification,readonly", '--mount', "type=volume,src=$redisVolume,dst=/data", 'helmglass-redis:0.1.0')
  Wait-Healthy $pg
  Wait-Healthy $redis
  $pgMigration = 'PGPASSWORD=$(jq -r .migrationPassword /run/secrets/postgres_identity); export PGPASSWORD; exec psql -X -q -t -A -h 127.0.0.1 -U helm_migration -d helm -v ON_ERROR_STOP=1 -c '
  $pgApi = 'PGPASSWORD=$(jq -r .apiPassword /run/secrets/postgres_identity); export PGPASSWORD; exec psql -X -q -t -A -h 127.0.0.1 -U helm_api -d helm -v ON_ERROR_STOP=1 -c '
  $pgKeycloak = 'PGPASSWORD=$(jq -r .keycloakPassword /run/secrets/postgres_identity); export PGPASSWORD; exec psql -X -q -t -A -h 127.0.0.1 -U keycloak -d keycloak -v ON_ERROR_STOP=1 -c '
  $null = Run-Docker @('exec', $pg, 'sh', '-c', ($pgMigration + "'CREATE TABLE acceptance_value (id integer PRIMARY KEY)'"))
  $null = Run-Docker @('exec', $pg, 'sh', '-c', ($pgApi + "'INSERT INTO acceptance_value VALUES (42)'"))
  $null = Run-Docker @('exec', $pg, 'sh', '-c', ($pgKeycloak + "'CREATE TABLE acceptance_value (id integer PRIMARY KEY)'"))
  Expect-Denied @('exec', $pg, 'sh', '-c', ($pgApi + "'CREATE TABLE forbidden_table (id integer)'")) 'permission denied'
  Expect-Denied @('exec', $pg, 'sh', '-c', ($pgApi + "'DROP TABLE acceptance_value'")) 'must be owner'
  Expect-Denied @('exec', $pg, 'sh', '-c', ($pgApi.Replace('-d helm', '-d keycloak') + "'SELECT 1'")) 'permission denied for database'
  $redisApi = 'REDISCLI_AUTH=$(jq -r .api /run/secrets/verification); export REDISCLI_AUTH; exec redis-cli -e --no-auth-warning --user helm_api '
  $redisOAuth = 'REDISCLI_AUTH=$(jq -r .oauth /run/secrets/verification); export REDISCLI_AUTH; exec redis-cli -e --no-auth-warning --user helm_oauth '
  $null = Run-Docker @('exec', $redis, 'sh', '-c', ($redisApi + 'set helm:csrf:acceptance persisted EX 300'))
  $null = Run-Docker @('exec', $redis, 'sh', '-c', ($redisApi + 'info server'))
  $null = Run-Docker @('exec', $redis, 'sh', '-c', ($redisOAuth + 'set __Host-helm_session-acceptance persisted EX 300'))
  Expect-Denied @('exec', $redis, 'redis-cli', '-e', 'ping') 'NOAUTH'
  Expect-Denied @('exec', $redis, 'sh', '-c', ($redisApi + 'get __Host-helm_session-acceptance')) 'NOPERM'
  Expect-Denied @('exec', $redis, 'sh', '-c', ($redisOAuth + 'get helm:csrf:acceptance')) 'NOPERM'
  $null = Run-Docker @('exec', $redis, 'sh', '-c', ($redisOAuth + 'set __Host-helm_session-owned-acceptance disposable EX 300'))
  $null = Run-Docker @('exec', $redis, 'sh', '-c', ($redisApi + 'sadd helm:user-state:acceptance __Host-helm_session-owned-acceptance'))
  if ((Run-Docker @('exec', $redis, 'sh', '-c', ($redisApi + 'del __Host-helm_session-owned-acceptance'))) -ne '1') { throw 'API must delete its indexed OAuth session without reading it' }
  if ((Run-Docker @('exec', $redis, 'sh', '-c', ($redisOAuth + 'exists __Host-helm_session-owned-acceptance'))) -ne '0') { throw 'Indexed OAuth session cleanup failed' }
  Expect-Denied @('exec', $redis, 'sh', '-c', ($redisApi + 'CONFIG GET maxmemory')) 'NOPERM'
  $null = Run-Docker @('restart', $pg, $redis)
  Wait-Healthy $pg
  Wait-Healthy $redis
  if ((Run-Docker @('exec', $pg, 'sh', '-c', ($pgApi + "'SELECT id FROM acceptance_value'"))) -ne '42') { throw 'PostgreSQL persistence failed' }
  if ((Run-Docker @('exec', $redis, 'sh', '-c', ($redisApi + 'get helm:csrf:acceptance'))) -ne 'persisted') { throw 'Redis AOF persistence failed' }
  if ((Run-Docker @('exec', $redis, 'sh', '-c', ($redisOAuth + 'get __Host-helm_session-acceptance'))) -ne 'persisted') { throw 'Redis OAuth namespace persistence failed' }
  Write-Output 'PASS: PostgreSQL role separation, cross-database isolation, fresh initialization and persisted restart; Redis default denied, namespace/command ACLs, authenticated health and AOF persisted restart.'
} catch {
  foreach ($name in @($pg, $redis)) {
    $log = "$(docker logs --tail 45 $name 2>&1)"
    foreach ($password in @($passwords.Values) + @($redisPasswords.Values)) {
      if ($password -is [string]) { $log = $log.Replace($password, '[redacted]') }
    }
    Write-Output "$name diagnostics: $log"
  }
  throw
} finally {
  & docker rm -f $pg $redis 2>$null | Out-Null
  & docker volume rm $pgVolume $redisVolume 2>$null | Out-Null
  $resolvedScratch = [IO.Path]::GetFullPath($scratch)
  $allowedRoot = [IO.Path]::GetFullPath($scratchRoot) + [IO.Path]::DirectorySeparatorChar
  if (!$resolvedScratch.StartsWith($allowedRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'Refusing cleanup outside acceptance directory' }
  Remove-Item -LiteralPath $resolvedScratch -Recurse -Force
}
