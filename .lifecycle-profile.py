from pathlib import Path
p=Path('backend/browser-node/src/server.ts')
s=p.read_text(encoding='utf-8')
s=s.replace('operationId: z.string().min(1).max(200).optional() }).parse(await body(request));\n      if (input.ownerId', 'operationId: z.string().min(1).max(200).optional(), deadlineAt: z.string().datetime().optional() }).parse(await body(request));\n      if (input.ownerId')
s=s.replace('''      try { reply(response, 200, await exportSavedProfile(session, input.connectionId, input.origins, input.includeLoginOrigins, input.operationId)); }''', '''      const operationId = input.operationId ?? `profile:${session.policy.controlEpoch}`;
      const previous = saved(session.id).pendingOperation;
      if (previous && previous.id !== operationId) throw new HttpError(409, "Operation in progress");
      const deadlineAt = previous?.deadlineAt ?? input.deadlineAt ?? new Date(Date.now() + 360_000).toISOString();
      if (Date.parse(deadlineAt) <= Date.now()) throw new HttpError(408, "Profile deadline exceeded");
      save({ ...saved(session.id), pendingOperation: { id: operationId, deadlineAt, kind: "PROFILE" } });
      try {
        const result = await exportSavedProfile(session, input.connectionId, input.origins, input.includeLoginOrigins, operationId);
        if (!saved(session.id).closeRequested) save({ ...saved(session.id), pendingOperation: undefined });
        reply(response, 200, result);
      }''')
p.write_text(s,encoding='utf-8',newline='\n')
