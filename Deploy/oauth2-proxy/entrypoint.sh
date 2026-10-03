#!/bin/sh
set -eu
umask 077
: "${PUBLIC_ORIGIN:?PUBLIC_ORIGIN is required}"
: "${NGINX_INTERNAL_ADDRESS:?NGINX_INTERNAL_ADDRESS is required}"
node -e 'const {isIP}=require("node:net");try{const value=process.env.PUBLIC_ORIGIN,url=new URL(value);if(url.protocol!=="https:"||url.origin!==value||url.username||url.password||url.pathname!=="/"||url.search||url.hash||isIP(process.env.NGINX_INTERNAL_ADDRESS)!==4)process.exit(1);}catch{process.exit(1);}' || {
  printf '%s\n' 'PUBLIC_ORIGIN or NGINX_INTERNAL_ADDRESS is invalid.' >&2
  exit 1
}
. /opt/helm/bin/vault-bootstrap
helm_vault_read /run/secrets/oauth_identity oauth2-proxy
identity=/run/helm/service-secrets.json
if ! jq -e '
  def secret: type == "string" and length >= 16 and length <= 4096 and (explode | all(.[]; . != 0));
  (.clientId | type == "string" and test("^[A-Za-z0-9_-]{1,100}$"))
  and (.clientSecret | secret)
  and (.cookieSecret | type == "string" and test("^[A-Za-z0-9_-]{43}=?$"))
  and (.redisUsername | type == "string" and test("^[A-Za-z0-9_-]{1,100}$"))
  and (.redisPassword | secret)' "$identity" >/dev/null; then
  printf '%s\n' 'OAuth2 Proxy service secrets are incomplete or invalid.' >&2
  exit 1
fi
cat > /run/helm/oauth2-proxy.cfg <<'CONFIG'
provider = "oidc"
provider_display_name = "Helm Glass"
http_address = "0.0.0.0:4180"
proxy_prefix = "/oauth2"
reverse_proxy = true
real_client_ip_header = "X-Real-IP"
upstreams = ["static://202"]
email_domains = ["*"]
scope = "openid profile email"
code_challenge_method = "S256"
# New authorization must prove fresh authentication after account revocation.
# Existing Redis sessions and token refresh do not start this flow.
prompt = "login"
skip_provider_button = true
skip_oidc_discovery = true
redeem_url = "http://keycloak:8080/auth/realms/helm/protocol/openid-connect/token"
oidc_jwks_url = "http://keycloak:8080/auth/realms/helm/protocol/openid-connect/certs"
profile_url = "http://keycloak:8080/auth/realms/helm/protocol/openid-connect/userinfo"
session_store_type = "redis"
redis_connection_url = "redis://redis:6379/0"
cookie_name = "__Host-helm_session"
cookie_path = "/"
cookie_secure = true
cookie_httponly = true
cookie_samesite = "lax"
cookie_expire = "8h"
# Refresh before the five-minute access token expires. Session age begins after OIDC exchange.
cookie_refresh = "2m"
cookie_csrf_per_request = true
cookie_csrf_per_request_limit = 5
cookie_csrf_expire = "5m"
set_xauthrequest = true
pass_access_token = true
pass_authorization_header = false
set_authorization_header = false
pass_basic_auth = false
pass_user_headers = false
request_logging = false
auth_logging = false
standard_logging = true
silence_ping_logging = true
show_debug_on_error = false
CONFIG
jq -r --arg origin "$PUBLIC_ORIGIN" --arg proxy "$NGINX_INTERNAL_ADDRESS" '
  "client_id = \(.clientId | tojson)",
  "client_secret = \(.clientSecret | tojson)",
  "cookie_secret = \(.cookieSecret | tojson)",
  "redis_username = \(.redisUsername | tojson)",
  "redis_password = \(.redisPassword | tojson)",
  "oidc_issuer_url = \(($origin + "/auth/realms/helm") | tojson)",
  "login_url = \(($origin + "/auth/realms/helm/protocol/openid-connect/auth") | tojson)",
  "redirect_url = \(($origin + "/oauth2/callback") | tojson)",
  "trusted_proxy_ips = \([$proxy] | tojson)"
' "$identity" >> /run/helm/oauth2-proxy.cfg
rm -f "$identity"
exec /usr/local/bin/oauth2-proxy --config=/run/helm/oauth2-proxy.cfg
