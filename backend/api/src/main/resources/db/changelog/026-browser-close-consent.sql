ALTER TABLE browser_session_operations ADD COLUMN initiator varchar(10) NOT NULL DEFAULT 'WEB'
  CHECK (initiator IN ('WEB','SYSTEM'));
ALTER TABLE browser_session_operations ADD COLUMN failure_code varchar(80);
ALTER TABLE browser_session_operations ALTER COLUMN login_id DROP NOT NULL;
ALTER TABLE browser_session_operations ALTER COLUMN controller_instance_id DROP NOT NULL;
ALTER TABLE browser_session_operations ADD CONSTRAINT browser_operation_initiator_binding CHECK (
  (initiator='WEB' AND login_id IS NOT NULL AND controller_instance_id IS NOT NULL)
  OR (initiator='SYSTEM' AND login_id IS NULL AND controller_instance_id IS NULL AND intent<>'SAVE'));
CREATE UNIQUE INDEX browser_session_one_automatic_close ON browser_session_operations(session_id)
  WHERE initiator='SYSTEM';
