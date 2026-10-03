export interface paths {
    "/api/v1/me": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["get__api_v1_me"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/me/policy": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["get__api_v1_me_policy"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch: operations["patch__api_v1_me_policy"];
        trace?: never;
    };
    "/api/v1/tasks": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["get__api_v1_tasks"];
        put?: never;
        post: operations["post__api_v1_tasks"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/tasks/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["get__api_v1_tasks_id"];
        put?: never;
        post?: never;
        delete: operations["delete__tasks_id"];
        options?: never;
        head?: never;
        patch: operations["patch__api_v1_tasks_id"];
        trace?: never;
    };
    "/api/v1/tasks/{id}/prepare": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["post__api_v1_tasks_id_prepare"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/tasks/{id}/pause": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["post__api_v1_tasks_id_pause"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/tasks/{id}/resume": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["post__api_v1_tasks_id_resume"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/tasks/{id}/stop": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["post__api_v1_tasks_id_stop"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/tasks/{id}/copy": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["post__api_v1_tasks_id_copy"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/tasks/{id}/clarifications": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["post__api_v1_tasks_id_clarifications"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/tasks/{id}/completion": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["post__api_v1_tasks_id_completion"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/connections": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["get__api_v1_connections"];
        put?: never;
        post: operations["post__api_v1_connections"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/connections/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["get__api_v1_connections_id"];
        put?: never;
        post?: never;
        delete: operations["delete__api_v1_connections_id"];
        options?: never;
        head?: never;
        patch: operations["patch__api_v1_connections_id"];
        trace?: never;
    };
    "/api/v1/operations/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["get__api_v1_operations_id"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/browser-sessions/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["get__api_v1_browser-sessions_id"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/browser-sessions/{id}/control/acquire": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["post__api_v1_browser-sessions_id_control_acquire"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/browser-sessions/{id}/control/release": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["post__api_v1_browser-sessions_id_control_release"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/browser-sessions/{id}/control/renew": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["post__api_v1_browser-sessions_id_control_renew"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/browser-sessions/{id}/view-tickets": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["post__api_v1_browser-sessions_id_view-tickets"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/browser-sessions/{id}/control/input-tickets": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["post__api_v1_browser-sessions_id_control_input-tickets"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/browser-sessions/{id}/close": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["closeBrowserSession"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/tasks/summary": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["get__tasks_summary"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/connections/{id}/login": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["post__connections_id_login"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/login-operations/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["get__login-operations_id"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/login-operations/{id}/complete": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["post__login-operations_id_complete"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/login-operations/{id}/cancel": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["post__login-operations_id_cancel"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/admin/overview": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["get__admin_overview"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/admin/users": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["get__admin_users"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/admin/users/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["get__admin_users_id"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/admin/users/{id}/tasks": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["get__admin_users_id_tasks"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/admin/browsers": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["get__admin_browsers"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/admin/audit": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["get__admin_audit"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/admin/users/{id}/audit": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["get__admin_users_id_audit"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/admin/users/{id}/limits": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch: operations["patch__admin_users_id_limits"];
        trace?: never;
    };
    "/api/v1/admin/users/{id}/block": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["post__admin_users_id_block"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/admin/users/{id}/unblock": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["post__admin_users_id_unblock"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/admin/users/{id}/deletion-requests": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["post__admin_users_id_deletion-requests"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/admin/deletion-requests/{id}/cancel": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["post__admin_deletion-requests_id_cancel"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/admin/users/{id}/stop-all": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["post__admin_users_id_stop-all"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/admin/platform/admission": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch: operations["patch__admin_platform_admission"];
        trace?: never;
    };
    "/api/v1/admin/workers/{id}/drain": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["post__admin_workers_id_drain"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/admin/workers/{id}/enable": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["post__admin_workers_id_enable"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/me/client-grants": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["get__me_client-grants"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/me/client-grants/{id}/revoke": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["post__me_client-grants_id_revoke"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/action-requests/{id}/answer": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["post__action-requests_id_answer"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/operations/lookup": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["get__operations_lookup"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/usage": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["get__api_v1_usage"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/me/client-grants/{id}/check": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Success */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["MutationReceipt"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/notifications/{id}/read": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Success */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["MutationReceipt"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/auth/logout": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Login revoked */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["LogoutResult"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/artifacts/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        get: operations["getArtifact"];
        put?: never;
        post?: never;
        delete: operations["deleteArtifact"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/artifacts/{id}/content": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        get: operations["getArtifactContent"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/audio/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        get: operations["getAudio"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/audio/{id}/segments": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        get: operations["getAudioSegments"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/tasks/{id}/reconcile": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["reconcileTask"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/tasks/{id}/connection-resolution": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["resolveTaskConnection"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/tasks/{id}/events": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["get_TaskEventPage"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/notifications": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["get_Notifications"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/usage/sites": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["get__api_v1_usage_sites"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/tasks/{id}/result": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["get__api_v1_tasks__id__result"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/results/{id}/rows": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["get__api_v1_results__id__rows"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/results/{id}/rows/{rowId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["get__api_v1_results__id__rows__rowId_"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/tasks/{id}/results": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["publishTaskResult"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/sites/suggestions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getSiteSuggestions"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/admin/operations/{id}/retry": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["retryAccountCleanup"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/admin/operations/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getAdminCleanupOperation"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/browser-sessions/{id}/navigation": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["navigateBrowserSession"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/browser-sessions/{id}/save": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["saveBrowserSession"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/tasks/{id}/usage": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getTaskUsage"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/admin/users/{id}/usage": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getAdminCalendarUsage"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/tasks/{id}/browser-sessions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["openTaskBrowser"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/browser-sessions/{id}/save-policy": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch: operations["patch_browser_save_policy"];
        trace?: never;
    };
    "/api/v1/browser-sessions/{id}/snapshots": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["browserSnapshot"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
}
export type webhooks = Record<string, never>;
export interface components {
    schemas: {
        Capability: {
            allowed: boolean;
            visible: boolean;
            reason: string | null;
        };
        MutationReceipt: {
            /** Format: uuid */
            operationId: string;
            resource: {
                type: string;
                /** Format: uuid */
                id: string;
                version: number;
            };
            statusUrl: string;
            /** Format: uuid */
            requestId: string;
        };
        TaskCreate: {
            goal: string;
            startUrl: string | null;
            connectionIds: string[];
            /** @enum {unknown} */
            outputFormat: "TABLE" | "FILE" | "TEXT";
            confirmImportantActions: boolean;
            browserTimeLimitSeconds: number;
            /** @enum {unknown} */
            intent: "DRAFT" | "PREPARE";
        };
        TaskEdit: {
            goal: string;
            startUrl: string | null;
            connectionIds: string[];
            /** @enum {unknown} */
            outputFormat: "TABLE" | "FILE" | "TEXT";
            confirmImportantActions: boolean;
            browserTimeLimitSeconds: number;
            expectedVersion: number;
        };
        ExpectedVersion: {
            expectedVersion: number;
        };
        TaskResume: {
            expectedTaskVersion: number;
            resolutionId?: string | null;
        };
        TaskClarification: {
            /** Format: uuid */
            clarificationId: string;
            text: string;
            expectedInstructionRevision: number;
            expectedTaskVersion: number;
        };
        TaskCompletion: {
            expectedTaskVersion: number;
            /** Format: uuid */
            resultId: string;
            resultRevision: number;
            /** @enum {unknown} */
            outcome: "SUCCESS" | "PARTIAL" | "NOT_ACHIEVED";
        };
        Task: {
            /** Format: uuid */
            id: string;
            displayNumber: number;
            version: number;
            instructionRevision: number;
            goal: string;
            title: string;
            startUrl: string | null;
            /** @enum {string} */
            outputFormat: "TABLE" | "FILE" | "TEXT";
            confirmImportantActions: boolean;
            browserTimeLimitSeconds: number;
            state: string;
            outcome: string | null;
            origin: string;
            waitReason: string | null;
            failureCode: string | null;
            mutationBarrier: boolean;
            /** Format: date-time */
            createdAt: string;
            /** Format: date-time */
            updatedAt: string;
            connectionIds: string[];
            currentSession: components["schemas"]["TaskSessionBinding"] | null;
            capabilities: {
                [key: string]: components["schemas"]["Capability"];
            };
            contextRef: string;
            activeRequest?: components["schemas"]["TaskActionRequest"] | null;
            outstandingCommand?: components["schemas"]["TaskCommandSummary"] | null;
            lastCommand?: components["schemas"]["TaskCommandSummary"] | null;
            usage?: components["schemas"]["TaskUsageSummary"];
            lastSessionId?: string | null;
            continuation: components["schemas"]["Continuation"] | null;
            /** Format: uuid */
            unresolvedHumanOperationId: string | null;
        };
        Policy: {
            version: number;
            /** @enum {unknown} */
            siteMode: "ALL" | "ALLOW_LIST" | "DENY_LIST";
            /** @enum {unknown} */
            connectionMode: "AUTO" | "EXPLICIT" | "PUBLIC_ONLY";
            blockedActions: string[];
            requireConfirmationBeforeChanges: boolean;
            origins: string[];
            maxCommandsPerRun: number | null;
            maxActiveSecondsPerRun: number | null;
            maxParallelRuns: number | null;
            maxQueuedRuns: number | null;
            maxRetainedMediaBytes: number | null;
            maxBrowserSessions: number | null;
            quotas: components["schemas"]["Quotas"];
        };
        PolicyUpdate: {
            /** @enum {unknown} */
            siteMode: "ALL" | "ALLOW_LIST" | "DENY_LIST";
            /** @enum {unknown} */
            connectionMode: "AUTO" | "EXPLICIT" | "PUBLIC_ONLY";
            blockedActions: string[];
            requireConfirmationBeforeChanges: boolean;
            origins: string[];
            maxCommandsPerRun: number | null;
            maxActiveSecondsPerRun: number | null;
            maxParallelRuns: number | null;
            maxQueuedRuns: number | null;
            maxRetainedMediaBytes: number | null;
            expectedVersion: number;
            maxBrowserSessions: number | null;
        };
        ConnectionCreate: {
            displayName: string;
            startUrl: string;
            /** @enum {unknown} */
            savePreference: "ASK" | "SAVE" | "SESSION_ONLY";
        };
        ConnectionRename: {
            expectedVersion: number;
            displayName: string;
        };
        Connection: {
            /** Format: uuid */
            id: string;
            /** Format: uuid */
            siteId: string;
            displayName: string;
            startUrl: string;
            origin: string;
            accountLabel: string | null;
            status: string;
            savePreference: string;
            scopeVersion: number;
            version: number;
            /** Format: date-time */
            createdAt: string;
            /** Format: date-time */
            updatedAt: string;
            lastSuccessfulLoginAt: string | null;
            lastCheckedAt: string | null;
            lastUsedAt: string | null;
            host: string;
            capabilities: {
                [key: string]: components["schemas"]["Capability"];
            };
            currentTaskId: string | null;
            loginOperationId: string | null;
            sessionId: string | null;
        };
        Profile: {
            /** Format: uuid */
            id: string;
            displayName: string;
            email: string;
            accountState: string;
            permissions: string[];
            policy: components["schemas"]["Policy"];
            /** Format: date-time */
            serverTime: string;
        };
        Operation: {
            /** Format: uuid */
            id: string;
            kind: string;
            targetType: string;
            /** Format: uuid */
            targetId: string;
            state: string;
            version: number;
            progress: number;
            failureCode: string | null;
            /** Format: date-time */
            createdAt: string;
            /** Format: date-time */
            updatedAt: string;
            /** @enum {string|null} */
            reconciliationOutcome?: "APPLIED" | "NOT_APPLIED" | "UNRESOLVED" | null;
            /** Format: uuid */
            sourceCommandId?: string | null;
            /** Format: uuid */
            sourceHumanOperationId?: string | null;
        };
        TakeControl: {
            expectedVersion: number;
            /** Format: uuid */
            controllerInstanceId: string;
            privateLogin: boolean;
            transferExistingController: boolean;
            controlEpoch: number;
        };
        ReleaseControl: {
            controlEpoch: number;
            /** Format: uuid */
            controllerInstanceId: string;
            /** @enum {unknown} */
            intent: "CONTINUE_IF_ALLOWED" | "KEEP_PAUSED";
        };
        ControlRenew: {
            controlEpoch: number;
            /** Format: uuid */
            controllerInstanceId: string;
        };
        ControlRenewResponse: {
            controlEpoch: number;
            /** Format: date-time */
            expiresAt: string;
        };
        ViewRequest: {
            taskId?: string | null;
            expectedVersion: number;
            /** Format: uuid */
            viewerInstanceId: string;
            /** Format: uuid */
            controllerInstanceId?: string;
        };
        InputTicketRequest: {
            /** Format: uuid */
            controllerInstanceId: string;
            controlEpoch: number;
        };
        BrowserSession: {
            /** Format: uuid */
            id: string;
            taskId: string | null;
            version: number;
            state: string;
            controlMode: string;
            controlState: string;
            /** @enum {unknown} */
            controllerRelation: "SELF" | "OTHER" | "NONE";
            controlEpoch: number;
            pageEpoch: number;
            privacyEpoch: number;
            viewport: {
                width: number;
                height: number;
            };
            capabilities: {
                [key: string]: components["schemas"]["Capability"];
            };
            privacyMode: string;
            currentUrl: string | null;
            connectionId: string | null;
            purpose: string;
            mediaGeneration: number;
            profileVersion: string | null;
            /** @enum {unknown} */
            savePolicy: "SAVE_ON_CLOSE" | "DISCARD_CHANGES";
            /** Format: date-time */
            budgetDeadlineAt: string;
            /** Format: date-time */
            idleDeadlineAt: string | null;
            /** Format: date-time */
            lastActivityAt: string | null;
            allocationEpoch: number;
            loginOperationId: string | null;
            siteAccess: string;
            currentProfileVersion: string | null;
            connectionVersion: number | null;
            /** Format: uuid */
            operationId: string | null;
            closeReason: string | null;
        };
        ChannelTicket: {
            ticket: string;
            /** Format: date-time */
            expiresAt: string;
            viewGeneration: number;
            signalingUrl?: string;
            inputUrl?: string;
            /** Format: date-time */
            viewerAuthorizationExpiresAt?: string;
        };
        TaskPage: {
            items: components["schemas"]["TaskListItem"][];
            total: number;
            page: number;
            pageSize: number;
            sort: {
                field: string;
                /** @enum {unknown} */
                direction: "asc" | "desc";
            } | null;
            snapshot: string;
        };
        ConnectionPage: {
            items: components["schemas"]["Connection"][];
            total: number;
            page: number;
            pageSize: number;
            sort: {
                field: string;
                /** @enum {unknown} */
                direction: "asc" | "desc";
            } | null;
            snapshot: string;
        };
        TaskSummary: {
            total: number;
            active: number;
            waitingUser: number;
            successCount: number;
            successDenominator: number;
            savedConnections: number;
            totalConnections: number;
        };
        LoginBegin: {
            taskId?: string | null;
            /** Format: uuid */
            controllerInstanceId: string;
        };
        LoginComplete: {
            expectedVersion: number;
            /** @enum {unknown} */
            mode: "SAVE_PROFILE" | "SESSION_ONLY";
            accountLabel: string;
            confirmedOrigins: string[];
            expectedProfileVersion?: string | null;
            /** @enum {unknown} */
            continuationIntent: "CONTINUE" | "KEEP_PAUSED";
            userAsserted: boolean;
            /** Format: uuid */
            controllerInstanceId: string;
            controlEpoch: number;
            pageEpoch: number;
        };
        LoginOperation: {
            /** Format: uuid */
            id: string;
            /** Format: uuid */
            connectionId: string;
            taskId: string | null;
            sessionId: string | null;
            version: number;
            state: string;
            verification: string | null;
            origins: string[];
            /** Format: date-time */
            expiresAt: string;
            capabilities: {
                [key: string]: components["schemas"]["Capability"];
            };
        };
        AdminReason: {
            expectedVersion: number;
            reason: string;
        };
        AdminStop: {
            reason: string;
        };
        AdminLimits: {
            expectedVersion: number;
            reason: string;
            /** @enum {unknown} */
            browserMode: "STANDARD" | "CUSTOM" | "POOL";
            browserCustom?: number | null;
            /** @enum {unknown} */
            queuedMode: "UNLIMITED" | "CUSTOM";
            queuedCustom?: number | null;
        };
        AdminAdmission: {
            expectedVersion: number;
            reason: string;
            acceptingAllocations: boolean;
        };
        AdminOverview: {
            confirmedBusy: number;
            unconfirmedOccupied: number;
            waitingTasks: number;
            queuedForBrowser: number;
            unavailableWorkers: number;
            pendingOperations: number;
            blockedUsers: number;
            version: number;
            standardBrowserLimit: number;
            physicalFree: number;
            allocatableFree: number;
            acceptingAllocations: boolean;
            /** Format: date-time */
            observedAt: string;
            completeness: string;
            totalUsers: number;
        };
        UserLimits: {
            version: number;
            browserMode: string;
            browserCustom: number | null;
            queuedMode: string;
            queuedCustom: number | null;
            personalBrowserLimit: number | null;
            personalQueuedLimit: number | null;
            quotas: components["schemas"]["Quotas"];
        };
        AdminUser: {
            /** Format: uuid */
            id: string;
            displayName: string;
            email: string;
            accountState: string;
            version: number;
            accessEpoch: number;
            /** Format: date-time */
            createdAt: string;
            /** Format: date-time */
            lastActivityAt: string;
            limits: components["schemas"]["UserLimits"] | null;
            occupiedBrowsers: number;
            queuedTasks: number;
            deletionRequestId: string | null;
            deletionDeadline: string | null;
            deletionRequestVersion: number | null;
            usage: {
                [key: string]: unknown;
            };
            /** Format: uuid */
            purgeOperationId?: string | null;
        };
        AdminTask: {
            /** Format: uuid */
            id: string;
            state: string;
            waitReason: string | null;
            failureCode: string | null;
            /** Format: date-time */
            createdAt: string;
            browserSessionId: string | null;
            workerId: string | null;
        };
        Worker: {
            /** Format: uuid */
            id: string;
            /** Format: uuid */
            bootId: string;
            capacity: number;
            version: number;
            desiredMode: string;
            observedState: string;
            imageVersion: string;
            /** Format: date-time */
            heartbeatAt: string;
            state: string;
            lastKnownOccupied: number;
            occupied: number | null;
            free: number | null;
        };
        Allocation: {
            /** Format: uuid */
            id: string;
            /** Format: uuid */
            sessionId: string;
            /** Format: uuid */
            userId: string;
            /** Format: uuid */
            workerId: string;
            slotIndex: number;
            state: string;
            version: number;
            userName: string;
            /** Format: uuid */
            taskId: string | null;
            sessionState: string;
        };
        BrowserPool: {
            workers: components["schemas"]["AdminWorkerPage"];
            allocations: components["schemas"]["AdminAllocationPage"];
            queue: components["schemas"]["AdminBrowserQueuePage"];
        };
        AuditEntry: {
            /** Format: uuid */
            id: string;
            /** Format: uuid */
            actorId: string;
            actorName: string;
            /** Format: uuid */
            targetId: string;
            targetType: string;
            action: string;
            reason: string;
            /** Format: uuid */
            operationId: string;
            /** Format: date-time */
            occurredAt: string;
            targetName: string;
            previousValue: components["schemas"]["AdminAuditValues"];
            newValue: components["schemas"]["AdminAuditValues"];
            operationState: string | null;
        };
        AdminUserPage: {
            items: components["schemas"]["AdminUserListItem"][];
            total: number;
            page: number;
            pageSize: number;
            sort: {
                field: string;
                /** @enum {unknown} */
                direction: "asc" | "desc";
            } | null;
            snapshot: string;
        };
        AuditEntryPage: {
            items: components["schemas"]["AuditEntry"][];
            total: number;
            page: number;
            pageSize: number;
            sort: {
                field: string;
                /** @enum {unknown} */
                direction: "asc" | "desc";
            } | null;
            snapshot: string;
        };
        ClientGrant: {
            /** Format: uuid */
            id: string;
            clientId: string;
            scopes: string[];
            status: string;
            version: number;
            /** Format: date-time */
            createdAt: string;
            /** Format: date-time */
            lastUsedAt: string;
            revokedAt: string | null;
        };
        ActionAnswer: {
            expectedVersion: number;
            intentHash: string;
            /** @enum {unknown} */
            decision: "APPROVE" | "DENY" | "ANSWER";
            text?: string | null;
            selectedConnectionId?: string | null;
        };
        AdminUserListItem: {
            /** Format: uuid */
            id: string;
            displayName: string;
            email: string;
            accountState: string;
            version: number;
            /** Format: date-time */
            createdAt: string;
            /** Format: date-time */
            lastActivityAt: string;
            occupiedBrowsers: number;
            queuedTasks: number;
            limits: components["schemas"]["UserLimits"] | null;
            pendingOperations: number;
        };
        TaskListItem: {
            /** Format: uuid */
            id: string;
            displayNumber: number;
            version: number;
            instructionRevision: number;
            goal: string;
            title: string;
            startUrl: string | null;
            /** @enum {string} */
            outputFormat: "TABLE" | "FILE" | "TEXT";
            state: string;
            outcome: string | null;
            origin: string;
            waitReason: string | null;
            failureCode: string | null;
            /** Format: date-time */
            createdAt: string;
            /** Format: date-time */
            updatedAt: string;
            confirmImportantActions: boolean;
            browserTimeLimitSeconds: number;
            site: string | null;
            reason: string | null;
            currentStep: string;
            summary: string | null;
            usage: components["schemas"]["TaskUsageSummary"];
        };
        TaskActionRequest: {
            /** Format: uuid */
            id: string;
            kind: string;
            intentHash: string;
            prompt: string;
            version: number;
            status: string;
            /** Format: date-time */
            expiresAt: string;
            purpose: string;
            choices: {
                /** Format: uuid */
                id: string;
                label: string;
                accountLabel: string | null;
            }[];
            hasMoreChoices: boolean;
            /** Format: uuid */
            connectionId: string | null;
        };
        TaskCommandSummary: {
            /** Format: uuid */
            id: string;
            kind: string;
            state: string;
            version: number;
            instructionRevision: number;
        };
        TaskSessionBinding: {
            /** Format: uuid */
            id: string;
            version: number;
            state: string;
            privacy: string;
            pageEpoch: number;
            privacyEpoch: number;
            /** Format: date-time */
            idleDeadlineAt: string | null;
            /** Format: date-time */
            budgetDeadlineAt: string;
            closeReason: string | null;
            controlEpoch: number;
            controlOwner: string;
        };
        TaskUsageSummary: {
            /** @enum {string} */
            completeness: "COMPLETE" | "PARTIAL" | "UNKNOWN";
            browserSeconds: number | null;
            executionSeconds: number | null;
            activeSeconds: number | null;
            humanSeconds: number | null;
            humanControlSeconds: number | null;
            mediaSeconds: number | null;
            mediaBytes: number | null;
            commandCount: number | null;
            metrics: components["schemas"]["UsageMetrics"];
        };
        ArtifactCaptureMetadata: {
            /** @constant */
            schemaVersion: 1;
            /** Format: uuid */
            commandId: string;
            /** Format: uuid */
            attemptId: string;
            /** Format: uuid */
            browserSessionId: string;
            allocationEpoch: number;
            pageEpoch: number;
            privacyEpoch: number;
            /** @constant */
            kind: "AUDIO";
            mimeType: string;
            byteLength: number;
            sha256: string;
            /** @enum {string} */
            sourceKind: "FILE" | "STREAM_SEGMENTS" | "PLAYBACK_CAPTURE";
            /** @enum {string} */
            coverage: "FULL" | "PARTIAL" | "UNKNOWN";
            coveredIntervals: {
                startSeconds: number;
                endSeconds: number;
            }[];
            durationSeconds: number;
            codec: string;
            channels: number;
            sampleRate: number;
            quality: ("MIXED_AUDIO" | "LATE_CAPTURE" | "LIMIT_REACHED" | "PLAYBACK_CHANGED")[];
            captureTimeline?: {
                recordingSeconds: number;
                sourceSeconds: number;
                /** @enum {string} */
                state: "PLAYING" | "PAUSED" | "ENDED";
                playbackRate: number;
                muted: boolean;
                volume: number;
            }[];
        };
        ArtifactMetadata: {
            /** Format: uuid */
            id: string;
            /** Format: uuid */
            taskId: string;
            /** @constant */
            state: "READY";
            mimeType: string;
            byteLength: number;
            sha256: string;
            filename: string;
            version: number;
            provenance: components["schemas"]["ArtifactCaptureMetadata"];
        };
        AudioObservation: {
            /** @constant */
            type: "audio_observation";
            /** @constant */
            schemaVersion: 1;
            /** Format: uuid */
            artifactId: string;
            /** Format: uuid */
            taskId: string;
            /** @constant */
            artifactState: "READY";
            sha256: string;
            mimeType: string;
            byteLength: number;
            durationMs: number;
            codec: string;
            channels: number;
            sampleRate: number;
            /** @constant */
            timeOrigin: "ARTIFACT_START";
            source: {
                /** @enum {string} */
                kind: "FILE" | "STREAM_SEGMENTS" | "PLAYBACK_CAPTURE";
                /** @enum {string} */
                coverage: "FULL" | "PARTIAL" | "UNKNOWN";
                coveredIntervals: {
                    startSeconds: number;
                    endSeconds: number;
                }[];
                /** @constant */
                intervalTimeOrigin: "SOURCE_START";
            };
            qualityFlags: ("MIXED_AUDIO" | "LATE_CAPTURE" | "LIMIT_REACHED" | "PLAYBACK_CHANGED")[];
            captureTimeline?: {
                recordingSeconds: number;
                sourceSeconds: number;
                /** @enum {string} */
                state: "PLAYING" | "PAUSED" | "ENDED";
                playbackRate: number;
                muted: boolean;
                volume: number;
            }[];
            contentPath: string;
            delivery: {
                /** @constant */
                status: "UNVERIFIED";
                /** @constant */
                reason: "HOST_AUDIO_ACCESS_NOT_VERIFIED";
            };
            captions: {
                /** @constant */
                status: "UNAVAILABLE";
                /** @constant */
                reason: "NO_SAVED_CAPTIONS";
            };
            acoustics: {
                /** @constant */
                status: "NOT_REQUESTED";
            };
        };
        AudioSegments: {
            /** Format: uuid */
            artifactId: string;
            /** @enum {unknown} */
            component: "CAPTIONS" | "ACOUSTICS";
            items: unknown[];
            /** @constant */
            hasMore: false;
            /** @constant */
            status: "UNAVAILABLE";
            /** @enum {unknown} */
            reason: "NO_SAVED_CAPTIONS" | "ACOUSTICS_NOT_REQUESTED";
        };
        Continuation: {
            /** Format: uuid */
            id: string;
            state: string;
            reason: string;
            /** @enum {string} */
            mode: "MANUAL" | "WIDGET_RETURN";
            version: number;
            instructionRevision: number;
            /** Format: date-time */
            expiresAt: string;
            /** Format: uuid */
            observedSessionId: string | null;
        };
        ReconcileRequest: {
            expectedTaskVersion: number;
            /** Format: uuid */
            commandId?: string;
            /** Format: uuid */
            humanOperationId?: string;
            /** Format: uuid */
            evidenceId?: string;
        } & (unknown | unknown);
        ContinuationClaimRequest: {
            /** Format: uuid */
            continuationId: string;
            expectedInstructionRevision: number;
        };
        LogoutResult: {
            receipt: components["schemas"]["MutationReceipt"];
            /** @enum {string} */
            redirect: "/sign-in";
        };
        ConnectionResolutionRequest: {
            url: string;
            loginRequired: boolean;
            expectedTaskVersion: number;
            instructionRevision: number;
        };
        ConnectionResolution: {
            /** @enum {unknown} */
            state: "PUBLIC" | "READY" | "LOGIN_REQUIRED" | "ACCOUNT_SELECTION_REQUIRED" | "SCOPE_CONFIRMATION_REQUIRED" | "WAITING_RESOURCE" | "UNAVAILABLE" | "DENIED";
            reason: string;
            /** Format: uuid */
            connectionId?: string;
            startUrl?: string;
            scopeVersion?: number;
            profileVersionId?: string | null;
            /** Format: uuid */
            requestId?: string;
        };
        ConnectionResolutionResult: {
            receipt: components["schemas"]["MutationReceipt"];
            resolution: components["schemas"]["ConnectionResolution"];
        };
        TaskEvent: {
            /** Format: uuid */
            id: string;
            sequence: number;
            type: string;
            code: string;
            summary: string;
            /** Format: date-time */
            occurredAt: string;
        };
        TaskEventPage: {
            items: components["schemas"]["TaskEvent"][];
            total: number;
            page: number;
            pageSize: number;
            sort: {
                field: string;
                /** @enum {unknown} */
                direction: "asc" | "desc";
            } | null;
            snapshot: string;
        };
        Notification: {
            /** Format: uuid */
            id: string;
            taskId: string | null;
            kind: string;
            version: number;
            /** Format: date-time */
            createdAt: string;
            readAt: string | null;
        };
        Notifications: {
            items: components["schemas"]["Notification"][];
            hasMore: boolean;
            nextCursor: string | null;
            unreadCount: number;
        };
        UsageMetric: {
            value: number | null;
            knownValue: number | null;
            /** @enum {string} */
            completeness: "COMPLETE" | "PARTIAL" | "UNKNOWN";
            /** Format: int64 */
            measuredCount: number;
            /** Format: int64 */
            expectedCount: number;
        };
        UsageMetrics: {
            browser_seconds: components["schemas"]["UsageMetric"];
            execution_seconds: components["schemas"]["UsageMetric"];
            human_login_seconds: components["schemas"]["UsageMetric"];
            human_control_seconds: components["schemas"]["UsageMetric"];
            media_seconds: components["schemas"]["UsageMetric"];
            media_bytes: components["schemas"]["UsageMetric"];
            audio_analyzed_seconds: components["schemas"]["UsageMetric"];
            active_agent_seconds: components["schemas"]["UsageMetric"];
            command_count: components["schemas"]["UsageMetric"];
        };
        UsageDaily: {
            /** Format: date */
            date: string;
            /** Format: int64 */
            taskCount: number;
            metrics: components["schemas"]["UsageMetrics"];
        };
        UsageState: {
            state: string;
            /** Format: int64 */
            count: number;
        };
        UsageSummary: {
            /** @enum {string} */
            scope: "TASK_COHORT";
            /** @enum {string} */
            basis: "TASK_CREATED";
            /** Format: date-time */
            from: string;
            /** Format: date-time */
            to: string;
            timezone: string;
            /** Format: date-time */
            asOf: string;
            /** Format: int64 */
            taskCount: number;
            /** Format: int64 */
            terminalCount: number;
            /** Format: int64 */
            successfulCount: number;
            successRate: number | null;
            metrics: components["schemas"]["UsageMetrics"];
            daily: components["schemas"]["UsageDaily"][];
            states: components["schemas"]["UsageState"][];
        };
        UsageSite: {
            id: string | null;
            host: string | null;
            /** Format: int64 */
            taskCount: number;
            /** Format: int64 */
            terminalCount: number;
            /** Format: int64 */
            successfulCount: number;
            successRate: number | null;
            metrics: components["schemas"]["UsageMetrics"];
        };
        UsageSitePage: {
            items: components["schemas"]["UsageSite"][];
            /** Format: int64 */
            total: number;
            page: number;
            pageSize: number;
            sort: {
                field: string;
                /** @enum {string} */
                direction: "asc" | "desc";
            } | null;
            snapshot: string;
        };
        ResultColumn: {
            key: string;
            label: string;
            /** @enum {string} */
            type: "TEXT" | "NUMBER" | "BOOLEAN" | "DATE" | "URL";
        };
        ResultSection: {
            title: string;
            text: string;
        };
        ResultSource: {
            title: string;
            /**
             * Format: uri
             * @description HTTP(S) URL without credentials.
             */
            url: string;
        };
        ResultFile: {
            /** Format: uuid */
            id: string;
            filename: string;
            mimeType: string;
            /** Format: int64 */
            bytes: number;
            /** @enum {string} */
            state: "UPLOADING" | "READY" | "DELETING" | "DELETED";
        };
        ResultRow: {
            /** Format: uuid */
            id: string;
            /** Format: int64 */
            rowOrder: number;
            data: {
                [key: string]: string | number | boolean | null;
            };
        };
        TaskResult: {
            /** Format: uuid */
            id: string;
            /** Format: uuid */
            taskId: string;
            /** Format: int64 */
            revision: number;
            final: boolean;
            conclusion: string;
            limitations: string[];
            missing: string[];
            columns: components["schemas"]["ResultColumn"][];
            coverage: {
                [key: string]: unknown;
            };
            sections: components["schemas"]["ResultSection"][];
            sources: components["schemas"]["ResultSource"][];
            files: components["schemas"]["ResultFile"][];
            /** Format: date-time */
            createdAt: string;
            /** @enum {string} */
            outputFormat: "TEXT" | "TABLE" | "FILE";
        };
        ResultPublish: {
            /** Format: int64 */
            expectedTaskVersion: number;
            /** Format: int64 */
            instructionRevision: number;
            continuationClaimId?: string | null;
            conclusion: string;
            limitations: string[];
            missing: string[];
            columns: components["schemas"]["ResultColumn"][];
            rows: {
                [key: string]: string | number | boolean | null;
            }[];
            coverage: {
                [key: string]: unknown;
            };
            artifactIds: string[];
            sections?: components["schemas"]["ResultSection"][];
            sources?: components["schemas"]["ResultSource"][];
        };
        ResultRowPage: {
            items: components["schemas"]["ResultRow"][];
            /** Format: int64 */
            total: number;
            page: number;
            pageSize: number;
            sort: {
                field: string;
                /** @enum {string} */
                direction: "asc" | "desc";
            } | null;
            snapshot: string;
        };
        Site: {
            /** Format: uuid */
            id: string;
            displayName: string;
            host: string;
        };
        SiteSuggestions: {
            items: components["schemas"]["Site"][];
            hasMore: boolean;
            selected: components["schemas"]["Site"][];
        };
        AdminCleanupOperation: {
            /** Format: uuid */
            id: string;
            kind: string;
            /** @enum {string} */
            state: "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELLED" | "NEEDS_ATTENTION";
            version: number;
            progress: number;
            failureCode?: string | null;
            /** Format: date-time */
            updatedAt: string;
            totalItems: number;
            hasMoreItems: boolean;
            items: {
                key: string;
                phase: string;
                state: string;
                /** Format: date-time */
                updatedAt: string;
            }[];
        };
        BrowserNavigation: {
            expectedVersion: number;
            controlEpoch: number;
            pageEpoch: number;
            url?: string;
            /** Format: uuid */
            controllerInstanceId: string;
            /** @enum {string} */
            action: "BACK" | "FORWARD" | "RELOAD" | "GOTO";
        };
        BrowserSave: {
            /** Format: int64 */
            expectedVersion: number;
            /** Format: int64 */
            controlEpoch: number;
            /** Format: int64 */
            pageEpoch: number;
            /** Format: uuid */
            controllerInstanceId: string;
            /** Format: uuid */
            expectedProfileVersion: string | null;
        };
        BrowserClose: {
            /** Format: int64 */
            expectedVersion: number;
            /** Format: int64 */
            controlEpoch: number;
            /** Format: int64 */
            pageEpoch: number;
            /** Format: uuid */
            controllerInstanceId: string;
            /** Format: uuid */
            expectedProfileVersion: string | null;
            saveChanges: boolean;
        };
        UsageMeasurement: {
            /** Format: uuid */
            id: string;
            sessionId: string | null;
            attemptId: string | null;
            metric: string;
            value: number | null;
            unit: string;
            /** @enum {string} */
            completeness: "COMPLETE" | "PARTIAL" | "UNKNOWN";
            /** Format: date-time */
            intervalStart: string;
            /** Format: date-time */
            intervalEnd: string;
            /** Format: date-time */
            recordedAt: string;
        };
        UsageUnknownInterval: {
            /** Format: uuid */
            sessionId: string;
            from: string | null;
            /** Format: date-time */
            to: string;
            reason: string;
        };
        UsageMeasurementPage: {
            items: components["schemas"]["UsageMeasurement"][];
            /** Format: int64 */
            total: number;
            page: number;
            pageSize: number;
            sort: {
                field: string;
                /** @enum {string} */
                direction: "asc" | "desc";
            } | null;
            snapshot: string;
        };
        UsageUnknownIntervalPage: {
            items: components["schemas"]["UsageUnknownInterval"][];
            /** Format: int64 */
            total: number;
            page: number;
            pageSize: number;
            sort: {
                field: string;
                /** @enum {string} */
                direction: "asc" | "desc";
            } | null;
            snapshot: string;
        };
        TaskUsage: {
            /** Format: uuid */
            taskId: string;
            /** Format: date-time */
            asOf: string;
            metrics: components["schemas"]["UsageMetrics"];
            measurements: components["schemas"]["UsageMeasurementPage"];
            unknownIntervals: components["schemas"]["UsageUnknownIntervalPage"];
        };
        CalendarUsageMetrics: {
            browser_seconds: components["schemas"]["UsageMetric"];
            command_count: components["schemas"]["UsageMetric"];
        };
        CalendarUsageDay: {
            /** Format: date */
            date: string;
            /** Format: date-time */
            from: string;
            /** Format: date-time */
            to: string;
            metrics: components["schemas"]["CalendarUsageMetrics"];
        };
        CalendarUsage: {
            /** @enum {string} */
            scope: "USER_CALENDAR";
            /** @enum {string} */
            basis: "INTERVAL";
            /** Format: uuid */
            userId: string;
            /** Format: date-time */
            from: string;
            /** Format: date-time */
            to: string;
            timezone: string;
            /** Format: date-time */
            asOf: string;
            metrics: components["schemas"]["CalendarUsageMetrics"];
            daily: components["schemas"]["CalendarUsageDay"][];
        };
        BrowserOpen: {
            expectedVersion: number;
            /** @constant */
            purpose: "TASK";
            /** @enum {unknown} */
            savePolicy: "SAVE_ON_CLOSE" | "DISCARD_CHANGES";
            observedPreviousSessionId?: string | null;
            consentNewBrowser: boolean;
        };
        Quotas: {
            assignedBrowserLimit: number | null;
            assignedQueuedLimit: number | null;
            effectiveBrowserLimit: number | null;
            effectiveQueuedLimit: number | null;
        };
        BrowserSavePolicy: {
            expectedVersion: number;
            expectedConnectionVersion: number;
            /** @enum {string} */
            policy: "SAVE_ON_CLOSE" | "DISCARD_CHANGES";
        };
        BrowserSnapshot: {
            expectedVersion: number;
            controlEpoch: number;
            pageEpoch: number;
            /** Format: uuid */
            controllerInstanceId: string;
        };
        AdminTaskPage: {
            items: components["schemas"]["AdminTask"][];
            total: number;
            page: number;
            pageSize: number;
            sort: {
                field: string;
                /** @enum {unknown} */
                direction: "asc" | "desc";
            } | null;
            snapshot: string;
        };
        AdminBrowserQueueItem: {
            /** Format: uuid */
            taskId: string;
            /** Format: uuid */
            userId: string;
            userName: string;
            waitReason: string | null;
            /** Format: date-time */
            createdAt: string;
            /** Format: uuid */
            id: string;
        };
        AdminAuditValues: {
            accountState?: string;
            browserMode?: string;
            browserCustom?: number;
            queuedMode?: string;
            queuedCustom?: number;
            acceptingAllocations?: boolean;
            desiredMode?: string;
            state?: string;
        };
        AdminWorkerPage: {
            items: components["schemas"]["Worker"][];
            total: number;
            page: number;
            pageSize: number;
            sort: {
                field: string;
                /** @enum {unknown} */
                direction: "asc" | "desc";
            } | null;
            snapshot: string;
        };
        AdminAllocationPage: {
            items: components["schemas"]["Allocation"][];
            total: number;
            page: number;
            pageSize: number;
            sort: {
                field: string;
                /** @enum {unknown} */
                direction: "asc" | "desc";
            } | null;
            snapshot: string;
        };
        AdminBrowserQueuePage: {
            items: components["schemas"]["AdminBrowserQueueItem"][];
            total: number;
            page: number;
            pageSize: number;
            sort: {
                field: string;
                /** @enum {unknown} */
                direction: "asc" | "desc";
            } | null;
            snapshot: string;
        };
    };
    responses: never;
    parameters: never;
    requestBodies: never;
    headers: never;
    pathItems: never;
}
export type $defs = Record<string, never>;
export interface operations {
    get__api_v1_me: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Profile"];
                };
            };
        };
    };
    get__api_v1_me_policy: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Policy"];
                };
            };
        };
    };
    patch__api_v1_me_policy: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": string;
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["PolicyUpdate"];
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MutationReceipt"];
                };
            };
        };
    };
    get__api_v1_tasks: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["TaskPage"];
                };
            };
        };
    };
    post__api_v1_tasks: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": string;
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["TaskCreate"];
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MutationReceipt"];
                };
            };
        };
    };
    get__api_v1_tasks_id: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Task"];
                };
            };
        };
    };
    delete__tasks_id: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MutationReceipt"];
                };
            };
            /** @description Invalid request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Authentication required */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    patch__api_v1_tasks_id: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": string;
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["TaskEdit"];
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MutationReceipt"];
                };
            };
        };
    };
    post__api_v1_tasks_id_prepare: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": string;
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ExpectedVersion"];
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MutationReceipt"];
                };
            };
        };
    };
    post__api_v1_tasks_id_pause: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": string;
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MutationReceipt"];
                };
            };
        };
    };
    post__api_v1_tasks_id_resume: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": string;
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["TaskResume"];
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MutationReceipt"];
                };
            };
        };
    };
    post__api_v1_tasks_id_stop: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": string;
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MutationReceipt"];
                };
            };
        };
    };
    post__api_v1_tasks_id_copy: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": string;
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MutationReceipt"];
                };
            };
        };
    };
    post__api_v1_tasks_id_clarifications: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": string;
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["TaskClarification"];
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MutationReceipt"];
                };
            };
        };
    };
    post__api_v1_tasks_id_completion: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": string;
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["TaskCompletion"];
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MutationReceipt"];
                };
            };
        };
    };
    get__api_v1_connections: {
        parameters: {
            query?: {
                /** @description Exclude connections being deleted from selectable connections. */
                excludeStatus?: "DELETING";
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ConnectionPage"];
                };
            };
        };
    };
    post__api_v1_connections: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": string;
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ConnectionCreate"];
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MutationReceipt"];
                };
            };
        };
    };
    get__api_v1_connections_id: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Connection"];
                };
            };
        };
    };
    delete__api_v1_connections_id: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": string;
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MutationReceipt"];
                };
            };
        };
    };
    patch__api_v1_connections_id: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": string;
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ConnectionRename"];
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MutationReceipt"];
                };
            };
        };
    };
    get__api_v1_operations_id: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Operation"];
                };
            };
        };
    };
    "get__api_v1_browser-sessions_id": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["BrowserSession"];
                };
            };
        };
    };
    "post__api_v1_browser-sessions_id_control_acquire": {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": string;
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["TakeControl"];
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MutationReceipt"];
                };
            };
        };
    };
    "post__api_v1_browser-sessions_id_control_release": {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": string;
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ReleaseControl"];
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MutationReceipt"];
                };
            };
        };
    };
    "post__api_v1_browser-sessions_id_control_renew": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ControlRenew"];
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ControlRenewResponse"];
                };
            };
        };
    };
    "post__api_v1_browser-sessions_id_view-tickets": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ViewRequest"];
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ChannelTicket"];
                };
            };
        };
    };
    "post__api_v1_browser-sessions_id_control_input-tickets": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["InputTicketRequest"];
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ChannelTicket"];
                };
            };
        };
    };
    closeBrowserSession: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": string;
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["BrowserClose"];
            };
        };
        responses: {
            /** @description Success */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MutationReceipt"];
                };
            };
        };
    };
    get__tasks_summary: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["TaskSummary"];
                };
            };
            /** @description Invalid request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Authentication required */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    post__connections_id_login: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["LoginBegin"];
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MutationReceipt"];
                };
            };
            /** @description Invalid request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Authentication required */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    "get__login-operations_id": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LoginOperation"];
                };
            };
            /** @description Invalid request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Authentication required */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    "post__login-operations_id_complete": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["LoginComplete"];
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MutationReceipt"];
                };
            };
            /** @description Invalid request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Authentication required */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    "post__login-operations_id_cancel": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MutationReceipt"];
                };
            };
            /** @description Invalid request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Authentication required */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    get__admin_overview: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AdminOverview"];
                };
            };
            /** @description Invalid request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Authentication required */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    get__admin_users: {
        parameters: {
            query?: {
                accountState?: ("ACTIVE" | "BLOCKED" | "DELETING" | "PURGING" | "DELETED")[];
                pending?: boolean;
                waiting?: boolean;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AdminUserPage"];
                };
            };
            /** @description Invalid request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Authentication required */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    get__admin_users_id: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AdminUser"];
                };
            };
            /** @description Invalid request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Authentication required */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    get__admin_users_id_tasks: {
        parameters: {
            query?: {
                page?: number;
                pageSize?: number;
                q?: string;
                state?: string[];
                sort?: string;
                direction?: "asc" | "desc";
                snapshot?: string;
            };
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AdminTaskPage"];
                };
            };
            /** @description Invalid request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Authentication required */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    get__admin_browsers: {
        parameters: {
            query?: {
                "workers.page"?: number;
                "workers.pageSize"?: number;
                "workers.q"?: string;
                "workers.sort"?: "id" | "state" | "occupied" | "capacity" | "free";
                "workers.direction"?: "asc" | "desc";
                "workers.snapshot"?: string;
                "allocations.page"?: number;
                "allocations.pageSize"?: number;
                "allocations.q"?: string;
                "allocations.sort"?: "sessionId" | "userName" | "workerId" | "sessionState" | "taskId";
                "allocations.direction"?: "asc" | "desc";
                "allocations.snapshot"?: string;
                "queue.page"?: number;
                "queue.pageSize"?: number;
                "queue.q"?: string;
                "queue.sort"?: "taskId" | "userName" | "waitReason" | "createdAt";
                "queue.direction"?: "asc" | "desc";
                "queue.snapshot"?: string;
                "workers.state"?: ("READY" | "DRAINING" | "OFFLINE")[];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["BrowserPool"];
                };
            };
            /** @description Invalid request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Authentication required */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    get__admin_audit: {
        parameters: {
            query?: {
                action?: string;
                sort?: "occurredAt" | "actorName" | "targetName" | "action" | "reason";
                direction?: "asc" | "desc";
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AuditEntryPage"];
                };
            };
            /** @description Invalid request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Authentication required */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    get__admin_users_id_audit: {
        parameters: {
            query?: {
                action?: string;
                sort?: "occurredAt" | "actorName" | "targetName" | "action" | "reason";
                direction?: "asc" | "desc";
            };
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AuditEntryPage"];
                };
            };
            /** @description Invalid request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Authentication required */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    patch__admin_users_id_limits: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["AdminLimits"];
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MutationReceipt"];
                };
            };
            /** @description Invalid request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Authentication required */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    post__admin_users_id_block: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["AdminReason"];
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MutationReceipt"];
                };
            };
            /** @description Invalid request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Authentication required */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    post__admin_users_id_unblock: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["AdminReason"];
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MutationReceipt"];
                };
            };
            /** @description Invalid request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Authentication required */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    "post__admin_users_id_deletion-requests": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["AdminReason"];
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MutationReceipt"];
                };
            };
            /** @description Invalid request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Authentication required */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    "post__admin_deletion-requests_id_cancel": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["AdminReason"];
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MutationReceipt"];
                };
            };
            /** @description Invalid request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Authentication required */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    "post__admin_users_id_stop-all": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["AdminStop"];
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MutationReceipt"];
                };
            };
            /** @description Invalid request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Authentication required */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    patch__admin_platform_admission: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["AdminAdmission"];
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MutationReceipt"];
                };
            };
            /** @description Invalid request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Authentication required */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    post__admin_workers_id_drain: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["AdminReason"];
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MutationReceipt"];
                };
            };
            /** @description Invalid request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Authentication required */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    post__admin_workers_id_enable: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["AdminReason"];
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MutationReceipt"];
                };
            };
            /** @description Invalid request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Authentication required */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    "get__me_client-grants": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ClientGrant"][];
                };
            };
            /** @description Invalid request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Authentication required */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    "post__me_client-grants_id_revoke": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MutationReceipt"];
                };
            };
            /** @description Invalid request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Authentication required */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    "post__action-requests_id_answer": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ActionAnswer"];
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MutationReceipt"];
                };
            };
            /** @description Invalid request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Authentication required */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    get__operations_lookup: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MutationReceipt"];
                };
            };
            /** @description Invalid request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Authentication required */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    get__api_v1_usage: {
        parameters: {
            query: {
                from: string;
                to: string;
                timezone?: string;
                basis?: "TASK_CREATED";
                state?: string[];
                siteId?: string[];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["UsageSummary"];
                };
            };
            /** @description Invalid request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Authentication required */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Resource not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Conflict or expired list snapshot */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    getArtifact: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ArtifactMetadata"];
                };
            };
        };
    };
    deleteArtifact: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": string;
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    expectedVersion: number;
                };
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MutationReceipt"];
                };
            };
        };
    };
    getArtifactContent: {
        parameters: {
            query?: never;
            header?: {
                Range?: string;
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Authorized immutable file bytes */
            200: {
                headers: {
                    "Content-Range"?: string;
                    "Accept-Ranges"?: "bytes";
                    "Content-Disposition"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/octet-stream": string;
                };
            };
            /** @description Authorized immutable file bytes */
            206: {
                headers: {
                    "Content-Range"?: string;
                    "Accept-Ranges"?: "bytes";
                    "Content-Disposition"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/octet-stream": string;
                };
            };
            /** @description Requested range is invalid or unsatisfiable */
            416: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    getAudio: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AudioObservation"];
                };
            };
        };
    };
    getAudioSegments: {
        parameters: {
            query: {
                component: "CAPTIONS" | "ACOUSTICS";
                cursor?: string;
                limit?: number;
            };
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AudioSegments"];
                };
            };
        };
    };
    reconcileTask: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": string;
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ReconcileRequest"];
            };
        };
        responses: {
            /** @description Durable receipt */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MutationReceipt"];
                };
            };
        };
    };
    resolveTaskConnection: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": string;
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ConnectionResolutionRequest"];
            };
        };
        responses: {
            /** @description Durable connection selection and resolution */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ConnectionResolutionResult"];
                };
            };
        };
    };
    get_TaskEventPage: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["TaskEventPage"];
                };
            };
        };
    };
    get_Notifications: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Notifications"];
                };
            };
        };
    };
    get__api_v1_usage_sites: {
        parameters: {
            query: {
                from: string;
                to: string;
                timezone?: string;
                basis?: "TASK_CREATED";
                state?: string[];
                siteId?: string[];
                page?: number;
                pageSize?: number;
                sort?: string;
                direction?: "asc" | "desc";
                snapshot?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["UsageSitePage"];
                };
            };
            /** @description Invalid request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Authentication required */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Resource not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Conflict or expired list snapshot */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    get__api_v1_tasks__id__result: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["TaskResult"] | null;
                };
            };
            /** @description Invalid request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Authentication required */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Resource not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Conflict or expired list snapshot */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    get__api_v1_results__id__rows: {
        parameters: {
            query?: {
                page?: number;
                pageSize?: number;
                sort?: string;
                direction?: "asc" | "desc";
                snapshot?: string;
                q?: string;
            };
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ResultRowPage"];
                };
            };
            /** @description Invalid request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Authentication required */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Resource not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Conflict or expired list snapshot */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    get__api_v1_results__id__rows__rowId_: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                rowId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ResultRow"];
                };
            };
            /** @description Invalid request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Authentication required */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Resource not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Conflict or expired list snapshot */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    publishTaskResult: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": string;
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ResultPublish"];
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MutationReceipt"];
                };
            };
            /** @description Invalid request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Authentication required */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Resource not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Conflict or expired list snapshot */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    getSiteSuggestions: {
        parameters: {
            query: {
                scope: "tasks" | "connections";
                q?: string;
                limit?: number;
                selectedId?: string[];
                excludeId?: string[];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Owned site suggestions; hasMore requires a narrower query */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SiteSuggestions"];
                };
            };
        };
    };
    retryAccountCleanup: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["AdminReason"];
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MutationReceipt"];
                };
            };
            /** @description Invalid request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Authentication required */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    getAdminCleanupOperation: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Safe bounded cleanup progress */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AdminCleanupOperation"];
                };
            };
        };
    };
    navigateBrowserSession: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": string;
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["BrowserNavigation"];
            };
        };
        responses: {
            /** @description Success */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MutationReceipt"];
                };
            };
        };
    };
    saveBrowserSession: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": string;
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["BrowserSave"];
            };
        };
        responses: {
            /** @description Success */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MutationReceipt"];
                };
            };
        };
    };
    getTaskUsage: {
        parameters: {
            query?: {
                page?: number;
                pageSize?: number;
                sort?: "intervalStart" | "metric";
                direction?: "asc" | "desc";
                snapshot?: string;
            };
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Task totals and bounded measured/unknown interval pages. Unknown start remains null without a source checkpoint. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["TaskUsage"];
                };
            };
        };
    };
    getAdminCalendarUsage: {
        parameters: {
            query: {
                from: string;
                to: string;
                timezone?: string;
            };
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Actual calendar intervals including standalone sessions; daily bounds clipped at asOf */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CalendarUsage"];
                };
            };
        };
    };
    openTaskBrowser: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": string;
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["BrowserOpen"];
            };
        };
        responses: {
            /** @description Success */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MutationReceipt"];
                };
            };
        };
    };
    patch_browser_save_policy: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": string;
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["BrowserSavePolicy"];
            };
        };
        responses: {
            /** @description Preference applied to the current browser and future connection sessions */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MutationReceipt"];
                };
            };
        };
    };
    browserSnapshot: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": string;
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["BrowserSnapshot"];
            };
        };
        responses: {
            /** @description Success */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MutationReceipt"];
                };
            };
        };
    };
}
