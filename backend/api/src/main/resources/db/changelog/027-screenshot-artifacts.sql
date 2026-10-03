ALTER TABLE human_browser_commands ADD CONSTRAINT human_command_attempt_identity UNIQUE(id,attempt_id);
ALTER TABLE artifact_transfers ALTER COLUMN attempt_id DROP NOT NULL;
ALTER TABLE artifact_transfers ALTER COLUMN command_id DROP NOT NULL;
ALTER TABLE artifact_transfers ADD COLUMN human_command_id uuid;
ALTER TABLE artifact_transfers ADD COLUMN human_attempt_id uuid UNIQUE;
ALTER TABLE artifact_transfers ADD CONSTRAINT artifact_human_attempt
  FOREIGN KEY(human_command_id,human_attempt_id) REFERENCES human_browser_commands(id,attempt_id);
ALTER TABLE artifact_transfers ADD CONSTRAINT artifact_capture_owner CHECK (
  (attempt_id IS NOT NULL AND command_id IS NOT NULL AND human_command_id IS NULL AND human_attempt_id IS NULL)
  OR (attempt_id IS NULL AND command_id IS NULL AND human_command_id IS NOT NULL AND human_attempt_id IS NOT NULL));
