-- Browser closure/control used to cancel an operation while retaining its unanswered request.
UPDATE operations o SET status='AWAITING_CONFIRMATION',completed_at=NULL
FROM task_requests r,tasks t
WHERE r.operation_id=o.id AND r.task_id=t.id AND o.task_id=t.id
  AND r.type='CONFIRMATION' AND r.status='PENDING' AND o.status='CANCELLED'
  AND r.instruction_revision=t.instruction_revision
  AND o.instruction_revision=t.instruction_revision
  AND t.status NOT IN ('STOPPING','STOPPED','SUCCEEDED','PARTIAL','NOT_ACHIEVED','FAILED');
