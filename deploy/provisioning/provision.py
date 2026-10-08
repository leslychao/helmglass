"""Idempotently maintain this deployment's explicitly managed identity records."""
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request

base = os.environ["KEYCLOAK_INTERNAL_URL"].rstrip("/")


def request(path, method="GET", payload=None, token=None, form=False):
    data = None
    headers = {}
    if payload is not None:
        data = (urllib.parse.urlencode(payload) if form else json.dumps(payload)).encode()
        headers["Content-Type"] = (
            "application/x-www-form-urlencoded" if form else "application/json"
        )
    if token:
        headers["Authorization"] = "Bearer " + token
    req = urllib.request.Request(base + path, data=data, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=20) as response:
        body = response.read(2 * 1024 * 1024 + 1)
        if len(body) > 2 * 1024 * 1024:
            raise RuntimeError("Identity response exceeded its safe bound")
        return json.loads(body) if body else None


def main():
    token = None
    for attempt in range(60):
        try:
            token = request(
                "/realms/master/protocol/openid-connect/token", "POST",
                {"grant_type": "password", "client_id": "admin-cli",
                 "username": os.environ["KC_BOOTSTRAP_ADMIN_USERNAME"],
                 "password": os.environ["KC_BOOTSTRAP_ADMIN_PASSWORD"]}, form=True
            )["access_token"]
            break
        except (urllib.error.URLError, TimeoutError):
            if attempt == 59:
                raise RuntimeError("Keycloak did not become ready for provisioning") from None
            time.sleep(2)

    with open("/app/realm.json", encoding="utf-8") as source:
        template = source.read()
    # Substitute JSON string content, never shell commands or executable templates.
    for name in ("PUBLIC_URL", "OAUTH2_CLIENT_SECRET", "KEYCLOAK_TEST_PASSWORD",
                 "KEYCLOAK_APP_ADMIN_PASSWORD", "KEYCLOAK_LIFECYCLE_SECRET"):
        template = template.replace("${" + name + "}", json.dumps(os.environ[name])[1:-1])
    realm = json.loads(template)
    prefix = "/admin/realms/helmglass"
    request(prefix, "PUT", {key: value for key, value in realm.items()
                           if key not in ("clients", "users", "roles", "defaultRoles")}, token)
    profile = request(prefix + "/users/profile", token=token)
    managed_attribute = {"name": "helmglass-managed", "multivalued": False,
                         "permissions": {"view": ["admin"], "edit": ["admin"]}}
    attributes = profile.setdefault("attributes", [])
    attributes[:] = [item for item in attributes if item["name"] != "helmglass-managed"]
    attributes.append(managed_attribute)
    request(prefix + "/users/profile", "PUT", profile, token)
    # MCP reconnect must authenticate afresh even while the cabinet's SSO is alive.
    flows = request(prefix + "/authentication/flows", token=token)
    flow = next((item for item in flows if item["alias"] == "helmglass-mcp"), None)
    if flow is None:
        request(prefix + "/authentication/flows/browser/copy", "POST",
                {"newName": "helmglass-mcp"}, token)
        flows = request(prefix + "/authentication/flows", token=token)
        flow = next(item for item in flows if item["alias"] == "helmglass-mcp")
    for flow_alias in ("browser", "helmglass-mcp"):
        execution_path = prefix + "/authentication/flows/" + flow_alias + "/executions"
        executions = request(execution_path, token=token)
        for execution in executions:
            if execution.get("providerId") == "auth-otp-form" or (
                flow_alias == "helmglass-mcp" and execution.get("providerId") == "auth-cookie"
            ):
                execution["requirement"] = "DISABLED"
                request(execution_path, "PUT", execution, token)
        for index, execution in enumerate(executions):
            if execution.get("providerId") != "auth-otp-form":
                continue
            parent_index = next((position for position in range(index - 1, -1, -1)
                                 if executions[position]["level"] < execution["level"]), None)
            if parent_index is None:
                raise RuntimeError("The managed OTP execution has no parent flow")
            parent = executions[parent_index]
            descendants = []
            for child in executions[parent_index + 1:]:
                if child["level"] <= parent["level"]:
                    break
                descendants.append(child)
            active_authenticators = [child for child in descendants
                                     if child.get("providerId")
                                     and not child["providerId"].startswith("conditional-")
                                     and child["requirement"] != "DISABLED"]
            # An empty conditional 2FA flow rejects otherwise valid password authentication.
            if parent["requirement"] == "CONDITIONAL" and not active_authenticators:
                parent["requirement"] = "DISABLED"
                request(execution_path, "PUT", parent, token)
    required_otp_path = prefix + "/authentication/required-actions/CONFIGURE_TOTP"
    required_otp = request(required_otp_path, token=token)
    required_otp["enabled"] = False
    required_otp["defaultAction"] = False
    request(required_otp_path, "PUT", required_otp, token)
    for expected in realm["clients"]:
        if expected["clientId"] == "helmglass-chatgpt":
            expected["authenticationFlowBindingOverrides"] = {"browser": flow["id"]}
        found = request(prefix + "/clients?clientId=" + expected["clientId"], token=token)
        if not found:
            request(prefix + "/clients", "POST", expected, token)
            found = request(prefix + "/clients?clientId=" + expected["clientId"], token=token)
        if len(found) != 1:
            raise RuntimeError("Expected exactly one managed application client")
        client = found[0]
        if client.get("name") != expected["name"]:
            raise RuntimeError("Application client belongs to another configuration")
        client.update(expected)
        request(prefix + "/clients/" + client["id"], "PUT", client, token)

    lifecycle = request(prefix + "/clients?clientId=helmglass-lifecycle", token=token)[0]
    service_account = request(prefix + "/clients/" + lifecycle["id"] + "/service-account-user", token=token)
    management = request(prefix + "/clients?clientId=realm-management", token=token)[0]
    role = request(prefix + "/clients/" + management["id"] + "/roles/manage-users", token=token)
    request(prefix + "/users/" + service_account["id"] + "/role-mappings/clients/" + management["id"],
            "POST", [role], token)
    request(prefix + "/clients/" + lifecycle["id"] + "/scope-mappings/clients/" + management["id"],
            "POST", [role], token)

    roles = {role["name"]: role for role in request(prefix + "/roles", token=token)}
    for expected in realm["users"]:
        found = request(prefix + "/users?exact=true&username=" + expected["username"], token=token)
        if len(found) != 1:
            raise RuntimeError("Expected exactly one managed initial user")
        user = request(prefix + "/users/" + found[0]["id"], token=token)
        if user.get("attributes", {}).get("helmglass-managed") != ["true"]:
            raise RuntimeError("Refusing to replace an unmanaged user")
        credentials = expected["credentials"][0]
        fields = {key: value for key, value in expected.items()
                  if key not in ("credentials", "realmRoles")}
        user.update(fields)
        user_path = prefix + "/users/" + user["id"]
        request(user_path, "PUT", user, token)
        request(user_path + "/reset-password", "PUT", credentials, token)
        request(user_path + "/role-mappings/realm", "POST",
                [roles[name] for name in expected["realmRoles"]], token)
        if expected["username"] == "test":
            request(user_path + "/role-mappings/realm", "DELETE", [roles["ADMIN"]], token)
    print("Managed users and application clients are ready.")


if __name__ == "__main__":
    try:
        main()
    except urllib.error.HTTPError as error:
        raise SystemExit(f"Identity provisioning failed with HTTP {error.code}") from None
