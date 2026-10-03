// Generated from canonical OpenAPI x-operation-kind. Do not edit.
export const operationKinds = [
  {
    "method": "PATCH",
    "path": "/me/policy",
    "kind": "policy.update"
  },
  {
    "method": "POST",
    "path": "/tasks",
    "kind": "tasks.create"
  },
  {
    "method": "PATCH",
    "path": "/tasks/{id}",
    "kind": "tasks.edit:{id}"
  },
  {
    "method": "DELETE",
    "path": "/tasks/{id}",
    "kind": "tasks.delete:{id}"
  },
  {
    "method": "POST",
    "path": "/tasks/{id}/prepare",
    "kind": "tasks.prepare:{id}"
  },
  {
    "method": "POST",
    "path": "/tasks/{id}/pause",
    "kind": "tasks.pause:{id}"
  },
  {
    "method": "POST",
    "path": "/tasks/{id}/resume",
    "kind": "tasks.resume:{id}"
  },
  {
    "method": "POST",
    "path": "/tasks/{id}/stop",
    "kind": "tasks.stop:{id}"
  },
  {
    "method": "POST",
    "path": "/tasks/{id}/copy",
    "kind": "tasks.copy:{id}"
  },
  {
    "method": "POST",
    "path": "/tasks/{id}/clarifications",
    "kind": "tasks.clarify:{id}"
  },
  {
    "method": "POST",
    "path": "/tasks/{id}/completion",
    "kind": "tasks.complete:{id}"
  },
  {
    "method": "POST",
    "path": "/connections",
    "kind": "connections.create"
  },
  {
    "method": "PATCH",
    "path": "/connections/{id}",
    "kind": "connections.rename:{id}"
  },
  {
    "method": "DELETE",
    "path": "/connections/{id}",
    "kind": "connections.delete:{id}"
  },
  {
    "method": "POST",
    "path": "/browser-sessions/{id}/control/acquire",
    "kind": "control.acquire:{id}"
  },
  {
    "method": "POST",
    "path": "/browser-sessions/{id}/control/release",
    "kind": "control.release:{id}"
  },
  {
    "method": "POST",
    "path": "/browser-sessions/{id}/close",
    "kind": "browser.close:{id}"
  },
  {
    "method": "POST",
    "path": "/connections/{id}/login",
    "kind": "connections.login:{id}"
  },
  {
    "method": "POST",
    "path": "/login-operations/{id}/complete",
    "kind": "login.complete:{id}"
  },
  {
    "method": "POST",
    "path": "/login-operations/{id}/cancel",
    "kind": "login.cancel:{id}"
  },
  {
    "method": "PATCH",
    "path": "/admin/users/{id}/limits",
    "kind": "admin.limits:{id}"
  },
  {
    "method": "POST",
    "path": "/admin/users/{id}/block",
    "kind": "admin.account.block:{id}"
  },
  {
    "method": "POST",
    "path": "/admin/users/{id}/unblock",
    "kind": "admin.account.unblock:{id}"
  },
  {
    "method": "POST",
    "path": "/admin/users/{id}/deletion-requests",
    "kind": "admin.account.delete:{id}"
  },
  {
    "method": "POST",
    "path": "/admin/deletion-requests/{id}/cancel",
    "kind": "admin.deletion.cancel:{id}"
  },
  {
    "method": "POST",
    "path": "/admin/users/{id}/stop-all",
    "kind": "admin.stopAll:{id}"
  },
  {
    "method": "PATCH",
    "path": "/admin/platform/admission",
    "kind": "admin.admission"
  },
  {
    "method": "POST",
    "path": "/admin/workers/{id}/drain",
    "kind": "admin.worker.drain:{id}"
  },
  {
    "method": "POST",
    "path": "/admin/workers/{id}/enable",
    "kind": "admin.worker.enable:{id}"
  },
  {
    "method": "POST",
    "path": "/me/client-grants/{id}/revoke",
    "kind": "grants.revoke:{id}"
  },
  {
    "method": "POST",
    "path": "/action-requests/{id}/answer",
    "kind": "requests.answer:{id}"
  },
  {
    "method": "POST",
    "path": "/me/client-grants/{id}/check",
    "kind": "grants.check:{id}"
  },
  {
    "method": "POST",
    "path": "/notifications/{id}/read",
    "kind": "notifications.read:{id}"
  },
  {
    "method": "POST",
    "path": "/auth/logout",
    "kind": "auth.logout"
  },
  {
    "method": "POST",
    "path": "/tasks/{id}/reconcile",
    "kind": "tasks.reconcile:{id}"
  },
  {
    "method": "POST",
    "path": "/tasks/{id}/continue",
    "kind": "tasks.continue:{id}"
  },
  {
    "method": "POST",
    "path": "/tasks/{id}/connection-resolution",
    "kind": "connections.resolve:{id}"
  },
  {
    "method": "POST",
    "path": "/tasks/{id}/results",
    "kind": "results.publish:{id}"
  },
  {
    "method": "POST",
    "path": "/admin/operations/{id}/retry",
    "kind": "admin.cleanup.retry:{id}"
  },
  {
    "method": "POST",
    "path": "/browser-sessions/{id}/navigation",
    "kind": "browser.navigation:{id}"
  },
  {
    "method": "POST",
    "path": "/browser-sessions/{id}/save",
    "kind": "browser.save:{id}"
  },
  {
    "method": "POST",
    "path": "/tasks/{id}/browser-sessions",
    "kind": "browser.open"
  },
  {
    "method": "PATCH",
    "path": "/browser-sessions/{id}/save-policy",
    "kind": "browser.save-policy:{id}"
  },
  {
    "method": "POST",
    "path": "/browser-sessions/{id}/snapshots",
    "kind": "browser.snapshot:{id}"
  }
] as const;
