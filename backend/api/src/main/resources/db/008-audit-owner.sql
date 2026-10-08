-- The target remains the acted-on object; owner survives deletion of a task or account data.
ALTER TABLE administrative_audit ADD COLUMN owner_id uuid;
UPDATE administrative_audit a SET owner_id=a.target_id
WHERE EXISTS(SELECT 1 FROM accounts u WHERE u.id=a.target_id);
UPDATE administrative_audit a SET owner_id=t.owner_id
FROM tasks t WHERE a.target_id=t.id AND a.owner_id IS NULL;
CREATE INDEX audit_owner ON administrative_audit(owner_id,created_at DESC);
