ALTER TABLE operations
  ADD COLUMN deadline_handled boolean NOT NULL DEFAULT false,
  ADD COLUMN receipt_archived boolean NOT NULL DEFAULT false;
