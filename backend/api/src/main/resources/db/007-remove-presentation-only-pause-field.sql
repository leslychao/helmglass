-- Remove only the withdrawn presentation field; retain receipt identity and original outcome.
UPDATE idempotency_records
SET response=response-'pauseRequested'
WHERE (scope IN ('tasks:create','tasks.command','tasks.ask','results.publish','connections.select')
       OR scope ~ '^tasks:[0-9a-f-]{36}$')
  AND jsonb_exists(response,'instructionRevision')
  AND jsonb_exists(response,'pauseRequested');

UPDATE idempotency_records
SET response=response #- '{task,pauseRequested}'
WHERE scope IN ('tasks.create','tasks.view')
  AND jsonb_exists(response->'task','instructionRevision')
  AND jsonb_exists(response->'task','pauseRequested');
