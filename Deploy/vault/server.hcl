ui = false
api_addr = "https://vault:8200"
cluster_addr = "https://vault:8201"

# Raft maps its database into memory. Locking that map can exhaust container memory;
# the deployment instead forbids swap for this container and its sensitive tmpfs.
disable_mlock = true

storage "raft" {
  path = "/vault/data"
  node_id = "helm-dev"
}

listener "tcp" {
  address = "0.0.0.0:8200"
  cluster_address = "0.0.0.0:8201"
  tls_cert_file = "/run/helm/vault.crt"
  tls_key_file = "/run/helm/vault.key"
  tls_min_version = "tls12"
}

log_level = "warn"
log_format = "json"
disable_cache = true
