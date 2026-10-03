import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  readdir,
  unlink,
  rmdir,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { VaultCli } from "../../provision/src/vault-cli.mjs";
import { startWorkerFixture } from "./worker.mjs";
import {
  provisionVaultServices,
  VAULT_ROLES,
  VAULT_SERVICES,
} from "../../provision/src/vault-services.mjs";

const fixtureId = randomUUID();
const origin = "https://helm.integration.test:8443";
const workerAcceptance = process.env.HELM_WORKER_ACCEPTANCE === "1";
const scratchRoot = resolve(".cache");
await mkdir(scratchRoot, { recursive: true });
const directory = await mkdtemp(join(scratchRoot, "auth-runtime-"));
const verification = await mkdtemp(join(scratchRoot, "auth-verification-"));
const evidenceRoot = resolve(".cache/auth-browser-evidence");
const evidence = join(evidenceRoot, fixtureId);
await mkdir(evidence, { recursive: true });
await writeFile(join(evidenceRoot, "latest.json"), JSON.stringify({ fixtureId, directory: evidence }));
process.stdout.write(`Isolated browser acceptance; evidence ${evidence}\n`);
const containers = [];
const images = [];
const volumes = [];
const network = `helm-auth-${fixtureId}`;
let networkCreated = false;
let workerFixture;
const secretValues = [];
const secret = () => {
  const value = randomBytes(32).toString("hex");
  secretValues.push(value);
  return value;
};
const passwords = {
  schemaVersion: 1,
  rootPassword: secret(),
  migrationPassword: secret(),
  apiPassword: secret(),
  keycloakPassword: secret(),
};
const redisPasswords = { api: secret(), oauth: secret(), health: secret() };
const bootstrapSecret = secret(),
  webSecret = secret(),
  apiSecret = secret();
const users = {
  installationId: "auth-integration-fixture",
  admin: {
    email: "admin@example.test",
    lastName: "Fixture",
    password: secret(),
  },
  angelina: {
    email: "angelina@example.test",
    lastName: "Fixture",
    password: secret(),
  },
};
const openssl =
  process.env.OPENSSL_BIN ??
  (process.platform === "win32"
    ? "C:\\Program Files\\Git\\usr\\bin\\openssl.exe"
    : "openssl");

function docker(
  args,
  {
    input,
    token,
    environment = {},
    allowFailure = false,
    timeout = 120000,
  } = {},
) {
  const result = spawnSync("docker", args, {
    encoding: "utf8",
    input,
    env: {
      ...process.env,
      ...environment,
      ...(token ? { VAULT_TOKEN: token } : {}),
    },
    timeout,
    maxBuffer: 8388608,
  });
  if (!allowFailure && result.status !== 0)
    throw new Error(
      `Docker ${args[0]} ${args[1] ?? ""} failed (${result.status})`,
    );
  return allowFailure ? result : result.stdout.trim();
}
async function file(name, value) {
  const path = join(directory, name);
  await writeFile(
    path,
    typeof value === "string" ? value : JSON.stringify(value),
    { mode: 0o600 },
  );
  return path;
}
function cert(args) {
  const result = spawnSync(openssl, args, { encoding: "utf8", timeout: 15000 });
  assert.equal(result.status, 0, "Fixture certificate generation");
}
function mount(name, target) {
  return [
    "--mount",
    `type=bind,source=${join(directory, name)},target=${target},readonly`,
  ];
}
function isolated(user = "10001:10001") {
  const uid = user.split(":")[0];
  return [
    "--user",
    user,
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges:true",
    "--tmpfs",
    "/tmp:size=128m,mode=1777",
    "--tmpfs",
    `/run:size=32m,uid=${uid},gid=${uid},mode=0700`,
  ];
}
function start(service, image, args = []) {
  const name = `helm-auth-${service}-${fixtureId}`;
  const id = docker([
    "run",
    "-d",
    "--name",
    name,
    "--label",
    `helmglass.acceptance=${fixtureId}`,
    "--network",
    network,
    "--network-alias",
    service,
    ...args,
    image,
  ]);
  containers.push(id);
  images.push({ service, requestedImage: image,
    imageId: docker(["inspect", "--format", "{{.Image}}", id]) });
  writeFileSync(join(evidence, "images.json"), JSON.stringify(images, null, 2));
  return id;
}
function volume(service, target) {
  const name = `helm-auth-${service}-${fixtureId}`;
  docker([
    "volume",
    "create",
    "--label",
    `helmglass.acceptance=${fixtureId}`,
    name,
  ]);
  volumes.push(name);
  return ["--mount", `type=volume,source=${name},target=${target}`];
}
async function healthy(id, timeout = 90000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (
      docker(["exec", id, "/opt/helm/bin/healthcheck"], { allowFailure: true })
        .status === 0
    )
      return;
    if (docker(["inspect", "--format", "{{.State.Running}}", id]) !== "true")
      throw new Error("Service exited before readiness");
    await delay(500);
  }
  throw new Error("Service readiness deadline exceeded");
}

try {
  cert([
    "req",
    "-x509",
    "-newkey",
    "rsa:3072",
    "-nodes",
    "-keyout",
    join(directory, "ca.key"),
    "-out",
    join(directory, "ca.crt"),
    "-subj",
    "/CN=Helm isolated browser fixture",
    "-days",
    "1",
    "-addext",
    "basicConstraints=critical,CA:TRUE",
    "-addext",
    "keyUsage=critical,keyCertSign,cRLSign",
  ]);
  cert([
    "req",
    "-new",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    join(directory, "server.key"),
    "-out",
    join(directory, "server.csr"),
    "-subj",
    "/CN=helm.integration.test",
  ]);
  await file(
    "server.ext",
    "basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:helm.integration.test,DNS:vault,DNS:api\n",
  );
  cert([
    "x509",
    "-req",
    "-in",
    join(directory, "server.csr"),
    "-CA",
    join(directory, "ca.crt"),
    "-CAkey",
    join(directory, "ca.key"),
    "-set_serial",
    "0x" + randomBytes(16).toString("hex"),
    "-days",
    "1",
    "-extfile",
    join(directory, "server.ext"),
    "-out",
    join(directory, "server.crt"),
  ]);
  const caPem = await readFile(join(directory, "ca.crt"), "utf8");
  const certificatePem = await readFile(join(directory, "server.crt"), "utf8");
  const privateKeyPem = await readFile(join(directory, "server.key"), "utf8");
  await file("edge.pem", certificatePem + caPem + privateKeyPem);
  await file("vault.json", {
    schemaVersion: 1,
    tls: { certificatePem, privateKeyPem, caPem },
  });
  await file("postgres.json", passwords);
  await file("redis-health.json", {
    schemaVersion: 1,
    username: "helm_health",
    password: redisPasswords.health,
  });
  const { createHash } = await import("node:crypto");
  let acl = await readFile("Deploy/redis/users.acl.template", "utf8");
  for (const [name, password] of Object.entries(redisPasswords))
    acl = acl.replace(
      name.toUpperCase() + "_PASSWORD_SHA256",
      createHash("sha256").update(password).digest("hex"),
    );
  await file("redis.acl", acl);
  await file("users.json", users);
  await file("browser.json", {
    origin,
    workerAcceptance,
    admin: users.admin,
    angelina: users.angelina,
  });
  docker([
    "network",
    "create",
    "--internal",
    "--label",
    `helmglass.acceptance=${fixtureId}`,
    network,
  ]);
  networkCreated = true;
  if (workerAcceptance) {
    // Docker allocates an unused subnet, but static relay addresses require an
    // explicitly configured subnet. Recreate only this still-empty fixture network.
    const [description] = JSON.parse(docker(["network", "inspect", network]));
    const subnet = description.IPAM.Config.find((config) =>
      /^\d+\.\d+\.\d+\.\d+\/\d+$/.test(config.Subnet),
    )?.Subnet;
    assert.ok(subnet, "Docker assigned the isolated IPv4 subnet");
    assert.equal(Object.keys(description.Containers).length, 0);
    docker(["network", "rm", network]);
    networkCreated = false;
    docker([
      "network",
      "create",
      "--internal",
      "--subnet",
      subnet,
      "--label",
      `helmglass.acceptance=${fixtureId}`,
      network,
    ]);
    networkCreated = true;
  }
  const nginx = start("nginx", "helmglass-nginx:0.1.0", [
    ...isolated("101:101"),
    "--network-alias",
    "helm.integration.test",
    "--env",
    `PUBLIC_ORIGIN=${origin}`,
    ...mount("edge.pem", "/run/secrets/edge_tls_identity"),
  ]);
  await healthy(nginx);
  const nginxAddress = docker([
    "inspect",
    "--format",
    "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}",
    nginx,
  ]);
  const pg = start("postgres", "helmglass-postgres:0.1.0", [
    ...volume("postgres", "/var/lib/postgresql"),
    ...mount("postgres.json", "/run/secrets/postgres_identity"),
  ]);
  const redis = start("redis", "helmglass-redis:0.1.0", [
    ...isolated(),
    ...volume("redis", "/data"),
    ...mount("redis.acl", "/run/secrets/redis_acl"),
    ...mount("redis-health.json", "/run/secrets/redis_health_identity"),
  ]);
  const vault = start("vault", "helmglass-vault:0.1.0", [
    ...isolated(),
    "--hostname",
    "vault",
    ...volume("vault", "/vault/data"),
    ...mount("vault.json", "/run/secrets/vault_tls_identity"),
  ]);
  const vaultArgs = [
    "exec",
    "-i",
    "-e",
    "VAULT_TOKEN",
    "-e",
    "VAULT_ADDR=https://vault:8200",
    "-e",
    "VAULT_CACERT=/run/helm/ca.crt",
    "-e",
    "VAULT_MAX_RETRIES=0",
    vault,
    "vault",
  ];
  let vaultListening = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    const result = docker([...vaultArgs, "status", "-format=json"], {
      allowFailure: true,
    });
    if (result.status === 2 && result.stdout.includes("initialized")) {
      vaultListening = true;
      break;
    }
    await delay(300);
  }
  assert.ok(vaultListening, "Vault TLS listener must become ready");
  const initialized = JSON.parse(
    docker([
      ...vaultArgs,
      "operator",
      "init",
      "-format=json",
      "-key-shares=3",
      "-key-threshold=2",
    ]),
  );
  const token = initialized.root_token;
  secretValues.push(token, ...initialized.unseal_keys_b64);
  for (const key of initialized.unseal_keys_b64.slice(0, 2))
    docker([...vaultArgs, "write", "sys/unseal", "-"], {
      input: JSON.stringify({ key }),
    });
  const credentials = Object.fromEntries(
    VAULT_ROLES.map((service) => [
      service,
      { roleId: secret(), secretId: secret() },
    ]),
  );
  const services = Object.fromEntries(
    VAULT_SERVICES.map((service) => [service, {}]),
  );
  services.keycloak = {
    databaseUrl: "jdbc:postgresql://postgres:5432/keycloak",
    databaseUsername: "keycloak",
    databasePassword: passwords.keycloakPassword,
    bootstrapClientId: "helm-bootstrap",
    bootstrapClientSecret: bootstrapSecret,
  };
  const cookieSecret = randomBytes(32).toString("base64url");
  secretValues.push(cookieSecret);
  services["oauth2-proxy"] = {
    clientId: "helm-web",
    clientSecret: webSecret,
    cookieSecret,
    redisUsername: "helm_oauth",
    redisPassword: redisPasswords.oauth,
  };
  services.provision = {
    installationId: users.installationId,
    keycloak: {
      realm: "master",
      clientId: "helm-bootstrap",
      clientSecret: bootstrapSecret,
    },
    webClientSecret: webSecret,
    apiClientSecret: apiSecret,
    mcpRedirectUris: [
      "https://chatgpt.com/connector_platform_oauth_redirect",
      ...(workerAcceptance ? [origin + "/mcp-test/callback"] : []),
    ],
  };
  services.migration = {
    databaseUrl: "jdbc:postgresql://postgres:5432/helm",
    databaseUsername: "helm_migration",
    databasePassword: passwords.migrationPassword,
  };
  services.api = {
    databaseUrl: "jdbc:postgresql://postgres:5432/helm",
    databaseUsername: "helm_api",
    databasePassword: passwords.apiPassword,
    redisUsername: "helm_api",
    redisPassword: redisPasswords.api,
    s3AccessKey: secret(),
    s3SecretKey: secret(),
    keycloakClientId: "helm-api-service",
    keycloakClientSecret: apiSecret,
    turnSharedSecret: secret(),
    mediaProxyUsername: "helm-media",
    mediaProxyPassword: secret(),
    installationId: users.installationId,
    workerEnrollmentToken: secret(),
  };
  const installation = {
    schemaVersion: 1,
    installationId: users.installationId,
    caPem,
    services,
    credentials,
  };
  const cli = new VaultCli(
    { ...process.env, VAULT_TOKEN: token },
    "docker",
    vaultArgs,
  );
  const pending = provisionVaultServices(cli, installation);
  assert.equal(pending.status, "CERTIFICATE_REQUIRED");
  await file("worker.csr", pending.csrPem);
  await file(
    "worker.ext",
    "basicConstraints=critical,CA:TRUE,pathlen:0\nkeyUsage=critical,keyCertSign,cRLSign\n",
  );
  cert([
    "x509",
    "-req",
    "-in",
    join(directory, "worker.csr"),
    "-CA",
    join(directory, "ca.crt"),
    "-CAkey",
    join(directory, "ca.key"),
    "-set_serial",
    "0x" + randomBytes(16).toString("hex"),
    "-days",
    "1",
    "-extfile",
    join(directory, "worker.ext"),
    "-out",
    join(directory, "worker.crt"),
  ]);
  installation.workerCertificateChainPem =
    (await readFile(join(directory, "worker.crt"), "utf8")) + caPem;
  assert.equal(provisionVaultServices(cli, installation).status, "READY");
  for (const service of VAULT_ROLES)
    await file(service + ".json", {
      schemaVersion: 1,
      vault: { address: "https://vault:8200", caPem, ...credentials[service] },
      ...(service === "api"
        ? { tls: { certificatePem, privateKeyPem, caPem } }
        : {}),
    });
  await Promise.all([healthy(pg), healthy(redis), healthy(vault)]);
  const keycloak = start("keycloak", "helmglass-keycloak:0.1.0", [
    ...isolated(),
    "--env",
    `PUBLIC_ORIGIN=${origin}`,
    "--env",
    `NGINX_INTERNAL_ADDRESS=${nginxAddress}`,
    ...mount("keycloak.json", "/run/secrets/keycloak_identity"),
  ]);
  await healthy(keycloak);
  const provision = start("provision", "helmglass-provision:0.1.0", [
    ...isolated(),
    "--env",
    "DEPLOY_ENVIRONMENT=dev",
    "--env",
    `PUBLIC_ORIGIN=${origin}`,
    ...mount("provision.json", "/run/secrets/provision_identity"),
    ...mount("users.json", "/run/secrets/predefined_users_input"),
  ]);
  assert.equal(
    docker(["wait", provision]),
    "0",
    "Canonical realm provisioning",
  );
  const migrate = start(
    "migrate",
    process.env.API_IMAGE ?? "helmglass-api:integration",
    [
      ...isolated(),
      "--env",
      "HELM_PROCESS_ROLE=migration",
      ...mount("migration.json", "/run/secrets/migration_identity"),
    ],
  );
  assert.equal(docker(["wait", migrate]), "0", "Canonical Liquibase migration");
  const api = start(
    "api",
    process.env.API_IMAGE ?? "helmglass-api:integration",
    [
      ...isolated(),
      "--env",
      `HELM_ISSUER_URI=${origin}/auth/realms/helm`,
      "--env",
      "HELM_JWK_SET_URI=http://keycloak:8080/auth/realms/helm/protocol/openid-connect/certs",
      "--env",
      `HELM_PUBLIC_ORIGIN=${origin}`,
      "--env",
      "HELM_REDIS_HOST=redis",
      "--env",
      "HELM_WORKER_REGISTRATION_LIMIT=1",
      ...(workerAcceptance
        ? [
            "--env",
            "HELM_TURN_PUBLIC_URLS=turn:coturn:3478?transport=tcp",
            "--env",
            "HELM_TURN_INTERNAL_URL=turn:coturn:3478?transport=tcp",
          ]
        : []),
      ...mount("api.json", "/run/secrets/api_identity"),
    ],
  );
  const oauth = start("oauth2-proxy", "helmglass-oauth2-proxy:0.1.0", [
    ...isolated(),
    "--env",
    `PUBLIC_ORIGIN=${origin}`,
    "--env",
    `NGINX_INTERNAL_ADDRESS=${nginxAddress}`,
    ...mount("oauth2-proxy.json", "/run/secrets/oauth_identity"),
  ]);
  await healthy(oauth);
  const readyDeadline = Date.now() + 90000;
  while (true) {
    const check = docker(
      [
        "exec",
        oauth,
        "curl",
        "--fail",
        "--silent",
        "--max-time",
        "2",
        "http://api:8080/actuator/health",
      ],
      { allowFailure: true },
    );
    if (check.status === 0) break;
    if (
      Date.now() > readyDeadline ||
      docker(["inspect", "--format", "{{.State.Running}}", api]) !== "true"
    )
      throw new Error("Real API failed readiness");
    await delay(500);
  }
  workerFixture = await startWorkerFixture({
    start,
    file,
    mount,
    isolated,
    healthy,
    docker,
    network,
    installationId: users.installationId,
    apiSecrets: services.api,
    tls: { certificatePem, privateKeyPem, caPem },
  });
  if (workerAcceptance) {
    cert([
      "req",
      "-new",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      join(directory, "mcp.key"),
      "-out",
      join(directory, "mcp.csr"),
      "-subj",
      "/CN=mcp-adapter",
    ]);
    await file(
      "mcp.ext",
      "basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=clientAuth\n",
    );
    cert([
      "x509",
      "-req",
      "-in",
      join(directory, "mcp.csr"),
      "-CA",
      join(directory, "ca.crt"),
      "-CAkey",
      join(directory, "ca.key"),
      "-set_serial",
      "0x" + randomBytes(16).toString("hex"),
      "-days",
      "1",
      "-extfile",
      join(directory, "mcp.ext"),
      "-out",
      join(directory, "mcp.crt"),
    ]);
    await file("mcp.json", {
      schemaVersion: 1,
      tls: {
        caPem,
        certificatePem: await readFile(join(directory, "mcp.crt"), "utf8"),
        privateKeyPem: await readFile(join(directory, "mcp.key"), "utf8"),
      },
    });
    const adapter = start("mcp-adapter", "helmglass-mcp-adapter:0.1.0", [
      ...isolated(),
      ...mount("mcp.json", "/run/secrets/mcp_adapter_identity"),
      "--env",
      `PUBLIC_ORIGIN=${origin}`,
      "--env",
      `OIDC_ISSUER=${origin}/auth/realms/helm`,
      "--env",
      "OIDC_JWKS_URL=http://keycloak:8080/auth/realms/helm/protocol/openid-connect/certs",
      "--env",
      "API_MCP_ENDPOINT=https://api:8446/internal/mcp",
      "--env",
      "WIDGET_HTML_PATH=/opt/helm/widget/index.html",
    ]);
    await healthy(adapter);
  }
  const browser = start("browser-test", "helmglass-auth-browser-test:0.1.0", [
    ...isolated(),
    "--security-opt",
    `seccomp=${resolve("Deploy/security/chromium-seccomp.json")}`,
    "--tmpfs",
    "/runtime:size=128m,uid=10001,gid=10001,mode=0700",
    "--shm-size",
    "256m",
    "--env",
    "NODE_EXTRA_CA_CERTS=/fixture/ca.crt",
    "--mount",
    `type=bind,source=${directory},target=/fixture,readonly`,
    "--mount",
    `type=bind,source=${evidence},target=/evidence`,
    "--mount",
    `type=bind,source=${verification},target=/verification`,
  ]);
  const browserExit = docker(["wait", browser], { timeout: 300_000 });
  if (browserExit !== "0") {
    const admittedLogins = docker(
      [
        "exec",
        "-e",
        "PGPASSWORD",
        pg,
        "psql",
        "-X",
        "-q",
        "-t",
        "-A",
        "-h",
        "127.0.0.1",
        "-U",
        "helm_api",
        "-d",
        "helm",
        "-c",
        "SELECT count(*) FROM application_logins",
      ],
      { environment: { PGPASSWORD: passwords.apiPassword } },
    );
    await writeFile(
      join(evidence, "login-diagnostic.json"),
      JSON.stringify({ admittedLogins: Number(admittedLogins) }),
    );
  }
  assert.equal(browserExit, "0", "Real Chromium authenticated route");
  const sessionKeys = JSON.parse(
    await readFile(join(verification, "session-keys.json"), "utf8"),
  );
  for (const [username, expected] of [
    ["admin", "1"],
    ["angelina", "0"],
  ]) {
    assert.match(sessionKeys[username], /^__Host-helm_session-[0-9a-f]{32}$/);
    const exists = docker(
      [
        "exec",
        "-e",
        "REDISCLI_AUTH",
        redis,
        "redis-cli",
        "-e",
        "--no-auth-warning",
        "--user",
        "helm_oauth",
        "exists",
        sessionKeys[username],
      ],
      { environment: { REDISCLI_AUTH: redisPasswords.oauth } },
    );
    assert.equal(exists, expected, username + " actual Redis session lifetime");
  }
  await writeFile(
    join(evidence, "redis-result.json"),
    JSON.stringify(
      {
        authenticatedSessionStored: true,
        loggedOutSessionRemoved: true,
        status: "PASS",
      },
      null,
      2,
    ),
  );
  process.stdout.write(
    `PASS: real browser authentication; evidence ${evidence}\n`,
  );
} catch (error) {
  await writeFile(join(evidence, "runtime-failure.txt"), String(error.message));
  for (const id of containers) {
    const name = docker(["inspect", "--format", "{{.Name}}", id]);
    const log = docker(["logs", "--tail", "80", id], { allowFailure: true });
    // Secrets remain inside the disposable fixture. Publish only safe failure categories.
    let diagnostics = log.stdout + log.stderr;
    for (const value of secretValues)
      diagnostics = diagnostics.replaceAll(value, "[redacted]");
    diagnostics = diagnostics.replace(
      /-----BEGIN[^-]*PRIVATE KEY-----[\s\S]*?-----END[^-]*PRIVATE KEY-----/g,
      "[private key redacted]",
    );
    await writeFile(
      join(evidence, name.replace(/^\//, "") + ".log"),
      diagnostics.slice(-32768),
    );
  }
  throw error;
} finally {
  await workerFixture?.cleanup();
  for (const id of containers.reverse()) {
    assert.equal(
      docker([
        "inspect",
        "--format",
        '{{index .Config.Labels "helmglass.acceptance"}}',
        id,
      ]),
      fixtureId,
    );
    docker(["rm", "--force", "--volumes", id]);
  }
  for (const name of volumes) {
    assert.equal(
      docker([
        "volume",
        "inspect",
        "--format",
        '{{index .Labels "helmglass.acceptance"}}',
        name,
      ]),
      fixtureId,
    );
    docker(["volume", "rm", name]);
  }
  if (networkCreated) docker(["network", "rm", network]);
  for (const name of await readdir(directory))
    await unlink(join(directory, name));
  await rmdir(directory);
  for (const name of await readdir(verification))
    await unlink(join(verification, name));
  await rmdir(verification);
}
