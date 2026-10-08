"""Normal account-console OIDC and self-service authorization on deployed dev."""
import base64
import hashlib
import json
import os
from pathlib import Path
import secrets
import unittest
from urllib.parse import parse_qs, urlencode, urlparse
from urllib.request import HTTPCookieProcessor, HTTPRedirectHandler, build_opener

from test_dev_contract import DevClient


class AccountCallback(HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, new_url):
        target = urlparse(new_url)
        if target.path == "/auth/realms/helmglass/account/" and "code" in parse_qs(target.query):
            return None
        return super().redirect_request(request, response, code, message, headers, new_url)


class AccountConsoleTest(unittest.TestCase):
    def test_managed_users_can_manage_only_their_own_account(self):
        settings = dict(line.split("=", 1) for line in Path(
            os.environ.get("HELM_TEST_ENV", "deploy/.env.dev")).read_text(encoding="utf-8").splitlines()
            if line and not line.startswith("#") and "=" in line)
        for username, password_key in (("test", "KEYCLOAK_TEST_PASSWORD"),
                                       ("admin", "KEYCLOAK_APP_ADMIN_PASSWORD")):
            with self.subTest(username=username):
                client = DevClient(settings, username, password_key)
                client.http = build_opener(HTTPCookieProcessor(client.cookies), AccountCallback())
                issuer = client.base + "/auth/realms/helmglass"
                redirect = issuer + "/account/"
                verifier, state = secrets.token_urlsafe(48), secrets.token_urlsafe(24)
                challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
                query = urlencode({"client_id": "account-console", "redirect_uri": redirect,
                    "response_type": "code", "scope": "openid", "state": state,
                    "code_challenge": challenge, "code_challenge_method": "S256"})
                status, html, _ = client.request(issuer + "/protocol/openid-connect/auth?" + query)
                self.assertEqual(200, status)
                status, _, headers = client.submit_login(html)
                self.assertIn(status, (302, 303))
                callback = parse_qs(urlparse(headers.get("Location", "")).query)
                self.assertEqual([state], callback.get("state"))
                self.assertIn("code", callback)
                status, raw, _ = client.request(issuer + "/protocol/openid-connect/token", "POST",
                    urlencode({"client_id": "account-console", "grant_type": "authorization_code",
                        "redirect_uri": redirect, "code": callback["code"][0],
                        "code_verifier": verifier}).encode(),
                    {"Content-Type": "application/x-www-form-urlencoded"})
                self.assertEqual(200, status)
                token = json.loads(raw)["access_token"]
                headers = {"Authorization": "Bearer " + token, "Accept": "application/json"}
                status, raw, _ = client.request(redirect, headers=headers)
                self.assertEqual(200, status, "Account self-service must accept the normal account-console grant")
                self.assertEqual(username, json.loads(raw)["username"])
                claims_part = token.split(".")[1]
                claims = json.loads(base64.urlsafe_b64decode(claims_part + "=" * (-len(claims_part) % 4)))
                roles = claims.get("resource_access", {})
                self.assertIn("manage-account", roles.get("account", {}).get("roles", []))
                self.assertNotIn("realm-management", roles, "Application ADMIN is not a Keycloak administrator")
                for path in ("credentials", "sessions"):
                    self.assertEqual(200, client.request(redirect + path, headers=headers)[0])
                anonymous = DevClient(settings, username, password_key)
                self.assertEqual(401, anonymous.request(redirect, headers={"Accept": "application/json"})[0])
                self.assertEqual(404, client.request(client.base + "/auth/admin/realms/helmglass/users", headers=headers)[0])


if __name__ == "__main__":
    unittest.main(verbosity=2)
