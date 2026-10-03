CREATE INDEX pending_worker_control_delivery ON transactional_outbox(retry_at,id)
  WHERE event_type='worker.control' AND published_at IS NULL AND delivery_attempts<8;
