ui = false
disable_mlock = true
api_addr = "https://vault:8200"
cluster_addr = "https://vault:8201"
storage "raft" {
  path = "/vault/data/raft"
  node_id = "helmglass"
}
listener "tcp" {
  address = "0.0.0.0:8200"
  tls_cert_file = "/vault/tls/server.crt"
  tls_key_file = "/vault/tls/server.key"
}
