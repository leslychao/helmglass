// Generated from canonical OpenAPI. Do not edit.
export const responseContracts = [
  {
    "method": "GET",
    "path": "/me",
    "validator": "response0"
  },
  {
    "method": "GET",
    "path": "/me/policy",
    "validator": "response1"
  },
  {
    "method": "PATCH",
    "path": "/me/policy",
    "validator": "response2"
  },
  {
    "method": "GET",
    "path": "/tasks",
    "validator": "response3"
  },
  {
    "method": "POST",
    "path": "/tasks",
    "validator": "response2"
  },
  {
    "method": "GET",
    "path": "/tasks/{id}",
    "validator": "response4"
  },
  {
    "method": "PATCH",
    "path": "/tasks/{id}",
    "validator": "response2"
  },
  {
    "method": "DELETE",
    "path": "/tasks/{id}",
    "validator": "response2"
  },
  {
    "method": "POST",
    "path": "/tasks/{id}/prepare",
    "validator": "response2"
  },
  {
    "method": "POST",
    "path": "/tasks/{id}/pause",
    "validator": "response2"
  },
  {
    "method": "POST",
    "path": "/tasks/{id}/resume",
    "validator": "response2"
  },
  {
    "method": "POST",
    "path": "/tasks/{id}/stop",
    "validator": "response2"
  },
  {
    "method": "POST",
    "path": "/tasks/{id}/copy",
    "validator": "response2"
  },
  {
    "method": "POST",
    "path": "/tasks/{id}/clarifications",
    "validator": "response2"
  },
  {
    "method": "POST",
    "path": "/tasks/{id}/completion",
    "validator": "response2"
  },
  {
    "method": "GET",
    "path": "/connections",
    "validator": "response5"
  },
  {
    "method": "POST",
    "path": "/connections",
    "validator": "response2"
  },
  {
    "method": "GET",
    "path": "/connections/{id}",
    "validator": "response6"
  },
  {
    "method": "PATCH",
    "path": "/connections/{id}",
    "validator": "response2"
  },
  {
    "method": "DELETE",
    "path": "/connections/{id}",
    "validator": "response2"
  },
  {
    "method": "GET",
    "path": "/operations/{id}",
    "validator": "response7"
  },
  {
    "method": "GET",
    "path": "/browser-sessions/{id}",
    "validator": "response8"
  },
  {
    "method": "POST",
    "path": "/browser-sessions/{id}/control/acquire",
    "validator": "response2"
  },
  {
    "method": "POST",
    "path": "/browser-sessions/{id}/control/release",
    "validator": "response2"
  },
  {
    "method": "POST",
    "path": "/browser-sessions/{id}/control/renew",
    "validator": "response9"
  },
  {
    "method": "POST",
    "path": "/browser-sessions/{id}/view-tickets",
    "validator": "response10"
  },
  {
    "method": "POST",
    "path": "/browser-sessions/{id}/control/input-tickets",
    "validator": "response10"
  },
  {
    "method": "POST",
    "path": "/browser-sessions/{id}/close",
    "validator": "response2"
  },
  {
    "method": "GET",
    "path": "/tasks/summary",
    "validator": "response11"
  },
  {
    "method": "POST",
    "path": "/connections/{id}/login",
    "validator": "response2"
  },
  {
    "method": "GET",
    "path": "/login-operations/{id}",
    "validator": "response12"
  },
  {
    "method": "POST",
    "path": "/login-operations/{id}/complete",
    "validator": "response2"
  },
  {
    "method": "POST",
    "path": "/login-operations/{id}/cancel",
    "validator": "response2"
  },
  {
    "method": "GET",
    "path": "/admin/overview",
    "validator": "response13"
  },
  {
    "method": "GET",
    "path": "/admin/users",
    "validator": "response14"
  },
  {
    "method": "GET",
    "path": "/admin/users/{id}",
    "validator": "response15"
  },
  {
    "method": "GET",
    "path": "/admin/users/{id}/tasks",
    "validator": "response16"
  },
  {
    "method": "GET",
    "path": "/admin/browsers",
    "validator": "response17"
  },
  {
    "method": "GET",
    "path": "/admin/audit",
    "validator": "response18"
  },
  {
    "method": "GET",
    "path": "/admin/users/{id}/audit",
    "validator": "response18"
  },
  {
    "method": "PATCH",
    "path": "/admin/users/{id}/limits",
    "validator": "response2"
  },
  {
    "method": "POST",
    "path": "/admin/users/{id}/block",
    "validator": "response2"
  },
  {
    "method": "POST",
    "path": "/admin/users/{id}/unblock",
    "validator": "response2"
  },
  {
    "method": "POST",
    "path": "/admin/users/{id}/deletion-requests",
    "validator": "response2"
  },
  {
    "method": "POST",
    "path": "/admin/deletion-requests/{id}/cancel",
    "validator": "response2"
  },
  {
    "method": "POST",
    "path": "/admin/users/{id}/stop-all",
    "validator": "response2"
  },
  {
    "method": "PATCH",
    "path": "/admin/platform/admission",
    "validator": "response2"
  },
  {
    "method": "POST",
    "path": "/admin/workers/{id}/drain",
    "validator": "response2"
  },
  {
    "method": "POST",
    "path": "/admin/workers/{id}/enable",
    "validator": "response2"
  },
  {
    "method": "GET",
    "path": "/me/client-grants",
    "validator": "response19"
  },
  {
    "method": "POST",
    "path": "/me/client-grants/{id}/revoke",
    "validator": "response2"
  },
  {
    "method": "POST",
    "path": "/action-requests/{id}/answer",
    "validator": "response2"
  },
  {
    "method": "GET",
    "path": "/operations/lookup",
    "validator": "response2"
  },
  {
    "method": "GET",
    "path": "/usage",
    "validator": "response20"
  },
  {
    "method": "POST",
    "path": "/me/client-grants/{id}/check",
    "validator": "response2"
  },
  {
    "method": "POST",
    "path": "/notifications/{id}/read",
    "validator": "response2"
  },
  {
    "method": "POST",
    "path": "/auth/logout",
    "validator": "response21"
  },
  {
    "method": "GET",
    "path": "/artifacts/{id}",
    "validator": "response22"
  },
  {
    "method": "DELETE",
    "path": "/artifacts/{id}",
    "validator": "response2"
  },
  {
    "method": "GET",
    "path": "/audio/{id}",
    "validator": "response23"
  },
  {
    "method": "GET",
    "path": "/audio/{id}/segments",
    "validator": "response24"
  },
  {
    "method": "POST",
    "path": "/tasks/{id}/reconcile",
    "validator": "response2"
  },
  {
    "method": "POST",
    "path": "/tasks/{id}/connection-resolution",
    "validator": "response25"
  },
  {
    "method": "GET",
    "path": "/tasks/{id}/events",
    "validator": "response26"
  },
  {
    "method": "GET",
    "path": "/notifications",
    "validator": "response27"
  },
  {
    "method": "GET",
    "path": "/usage/sites",
    "validator": "response28"
  },
  {
    "method": "GET",
    "path": "/tasks/{id}/result",
    "validator": "response29"
  },
  {
    "method": "GET",
    "path": "/results/{id}/rows",
    "validator": "response30"
  },
  {
    "method": "GET",
    "path": "/results/{id}/rows/{rowId}",
    "validator": "response31"
  },
  {
    "method": "POST",
    "path": "/tasks/{id}/results",
    "validator": "response2"
  },
  {
    "method": "GET",
    "path": "/sites/suggestions",
    "validator": "response32"
  },
  {
    "method": "POST",
    "path": "/admin/operations/{id}/retry",
    "validator": "response2"
  },
  {
    "method": "GET",
    "path": "/admin/operations/{id}",
    "validator": "response33"
  },
  {
    "method": "POST",
    "path": "/browser-sessions/{id}/navigation",
    "validator": "response2"
  },
  {
    "method": "POST",
    "path": "/browser-sessions/{id}/save",
    "validator": "response2"
  },
  {
    "method": "GET",
    "path": "/tasks/{id}/usage",
    "validator": "response34"
  },
  {
    "method": "GET",
    "path": "/admin/users/{id}/usage",
    "validator": "response35"
  },
  {
    "method": "POST",
    "path": "/tasks/{id}/browser-sessions",
    "validator": "response2"
  },
  {
    "method": "PATCH",
    "path": "/browser-sessions/{id}/save-policy",
    "validator": "response2"
  },
  {
    "method": "POST",
    "path": "/browser-sessions/{id}/snapshots",
    "validator": "response2"
  }
] as const;
