"""Public MCP discovery and OAuth authorization through both deployed proxies."""
import json
import os
from pathlib import Path
import re
import unittest
from urllib.parse import urlsplit
from test_dev_contract import DevClient


class OAuthDiscoveryTest(unittest.TestCase):
    def test_current_status_is_owned_by_the_live_widget(self):
        settings = dict(line.split("=", 1) for line in Path(os.environ.get(
            "HELM_TEST_ENV", "deploy/.env.dev")).read_text(encoding="utf-8").splitlines()
                        if line and not line.startswith("#") and "=" in line)
        client = DevClient(settings, "test", "KEYCLOAK_TEST_PASSWORD")
        try:
            client.login_mcp()
            initialized = client.rpc("initialize", {"protocolVersion": "2025-11-25",
                "capabilities": client.mcp_capabilities,
                "clientInfo": {"name": "helm-widget-status-regression", "version": "1"}})
            resource = next(resource for resource in client.rpc("resources/list", {})["resources"]
                            if resource["uri"].startswith("ui://helmglass/task-"))
            contents = client.rpc("resources/read", {"uri": resource["uri"]})["contents"][0]
            guidance = contents["_meta"]["openai/widgetDescription"]
            self.assertIn("только в обновляемом виджете", guidance)
            self.assertIn("Не добавляйте статические статусные плашки", guidance)
            self.assertIn("устаревают", guidance)
            self.assertIn(guidance, initialized["instructions"])
            tools = {tool["name"]: tool for tool in client.rpc("tools/list", {})["tools"]}
            for name in ("tasks.create", "tasks.view"):
                self.assertIn(guidance, tools[name]["description"], name)
        finally:
            client.close_mcp()

    def test_anonymous_discovery_pkce_and_bearer_challenge(self):
        settings = dict(line.split("=", 1) for line in Path(os.environ.get("HELM_TEST_ENV", "deploy/.env.dev")).read_text(encoding="utf-8").splitlines()
                        if line and not line.startswith("#") and "=" in line)
        client = DevClient(settings, "test", "KEYCLOAK_TEST_PASSWORD")
        metadata_url = client.base + "/.well-known/oauth-protected-resource/mcp"
        status, _, _ = client.request(client.base + "/.well-known/oauth-authorization-server")
        self.assertEqual(404, status, "Absent discovery locations must allow the client to continue discovery")
        responses = []
        for suffix in ("", "/mcp"):
            status, raw, _ = client.request(client.base + "/.well-known/oauth-protected-resource" + suffix)
            self.assertEqual(200, status)
            metadata = json.loads(raw)
            self.assertEqual(client.base + "/mcp", metadata["resource"])
            self.assertEqual([client.base + "/auth/realms/helmglass"], metadata["authorization_servers"])
            self.assertEqual(["header"], metadata["bearer_methods_supported"])
            self.assertFalse(metadata.get("tls_client_certificate_bound_access_tokens", False))
            self.assertEqual({"openid", "profile", "email", "offline_access"}, set(metadata["scopes_supported"]))
            responses.append(metadata)
        self.assertEqual(responses[0], responses[1])
        issuer = responses[0]["authorization_servers"][0]
        issuer_parts = urlsplit(issuer)
        status, raw, _ = client.request(
            issuer_parts.scheme + "://" + issuer_parts.netloc
            + "/.well-known/oauth-authorization-server" + issuer_parts.path)
        self.assertEqual(200, status, "RFC 8414 discovery must work for an issuer with a path")
        authorization_metadata = json.loads(raw)
        self.assertEqual(issuer, authorization_metadata["issuer"])
        self.assertTrue(authorization_metadata["authorization_response_iss_parameter_supported"])
        status, raw, _ = client.request(issuer + "/.well-known/openid-configuration")
        self.assertEqual(200, status)
        discovery = json.loads(raw)
        self.assertEqual(issuer, discovery["issuer"])
        self.assertIn("S256", discovery["code_challenge_methods_supported"])
        for endpoint in ("authorization_endpoint", "token_endpoint", "jwks_uri"):
            self.assertTrue(discovery[endpoint].startswith(issuer + "/"))
            self.assertTrue(discovery[endpoint].startswith("https://"))
        headers = {"Accept": "application/json, text/event-stream", "Content-Type": "application/json"}
        body = json.dumps({"jsonrpc": "2.0", "id": "discovery-authorization", "method": "tools/list", "params": {}}).encode()
        for bearer in (None, "invalid.jwt.signature"):
            request_headers = dict(headers)
            if bearer:
                request_headers["Authorization"] = "Bearer " + bearer
            status, _, response_headers = client.request(client.base + "/mcp", "POST", body, request_headers)
            self.assertEqual(401, status)
            self.assertEqual(1, len(response_headers.get_all("WWW-Authenticate", [])),
                             "OAuth discovery must receive exactly one canonical challenge")
            challenge = response_headers.get("WWW-Authenticate", "")
            self.assertTrue(challenge.startswith("Bearer "))
            self.assertEqual(metadata_url, re.search(r'resource_metadata="([^"]+)"', challenge).group(1))
        client.login_mcp()
        initialized = client.rpc("initialize", {"protocolVersion": "2025-11-25", "capabilities": {},
            "clientInfo": {"name": "public-discovery-contract", "version": "1"}})
        self.assertIn("serverInfo", initialized)
        self.assertIn("tasks.create", {tool["name"] for tool in client.rpc("tools/list", {})["tools"]})
        valid = client.token
        parts = valid.split(".")
        parts[2] = ("A" if parts[2][0] != "A" else "B") + parts[2][1:]
        status, _, response_headers = client.request(client.base + "/mcp", "POST", body,
            {**headers, "Authorization": "Bearer " + ".".join(parts)})
        self.assertEqual(401, status)
        self.assertIn('resource_metadata="' + metadata_url + '"', response_headers.get("WWW-Authenticate", ""))
        self.assertIn("tools", client.rpc("tools/list", {}), "Rejected token must not invalidate the valid grant")


if __name__ == "__main__":
    unittest.main(verbosity=2)
