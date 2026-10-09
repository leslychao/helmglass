-- Confirmations already requested remain pending; only the blanket task policy is removed.
ALTER TABLE tasks DROP COLUMN require_confirmation;
CREATE INDEX mcp_task_chats_origin ON mcp_task_chats(owner_id,chat_id);

-- Keep operation keys and request hashes intact while projecting old receipts to the current DTO.
UPDATE idempotency_records r SET response=(r.response-'requireConfirmation') ||
  jsonb_build_object('chatBound',EXISTS(
    SELECT 1 FROM mcp_task_chats c WHERE c.task_id::text=r.response->>'id'))
WHERE jsonb_exists(r.response,'requireConfirmation');

UPDATE idempotency_records r SET response=jsonb_set(r.response,'{task}',
  ((r.response->'task')-'requireConfirmation') || jsonb_build_object('chatBound',EXISTS(
    SELECT 1 FROM mcp_task_chats c WHERE c.task_id::text=r.response->'task'->>'id')))
WHERE jsonb_exists(r.response->'task','requireConfirmation');

UPDATE idempotency_records r SET response=jsonb_set(r.response,'{allowedCommands}',
  coalesce((SELECT jsonb_agg(command ORDER BY position)
    FROM jsonb_array_elements(r.response->'allowedCommands') WITH ORDINALITY AS c(command,position)
    WHERE command #>> '{}' NOT IN ('COPY','END_SESSION')
      AND NOT (r.response->>'status'='STOPPED' AND command #>> '{}'='RESUME')), '[]'::jsonb))
WHERE jsonb_typeof(r.response->'allowedCommands')='array';

UPDATE idempotency_records r SET response=jsonb_set(r.response,'{task,allowedCommands}',
  coalesce((SELECT jsonb_agg(command ORDER BY position)
    FROM jsonb_array_elements(r.response->'task'->'allowedCommands') WITH ORDINALITY AS c(command,position)
    WHERE command #>> '{}' NOT IN ('COPY','END_SESSION')
      AND NOT (r.response->'task'->>'status'='STOPPED' AND command #>> '{}'='RESUME')), '[]'::jsonb))
WHERE jsonb_typeof(r.response->'task'->'allowedCommands')='array';
