-- Pending-question snapshots already contain the task instruction revision. Project
-- that same revision into the new request field without changing keys or request hashes.
UPDATE idempotency_records SET response=jsonb_set(
  response,'{request,instructionRevision}',response->'instructionRevision')
WHERE jsonb_typeof(response->'request')='object'
  AND NOT jsonb_exists(response->'request','instructionRevision');

UPDATE idempotency_records SET response=jsonb_set(
  response,'{task,request,instructionRevision}',response->'task'->'instructionRevision')
WHERE jsonb_typeof(response->'task'->'request')='object'
  AND NOT jsonb_exists(response->'task'->'request','instructionRevision');
