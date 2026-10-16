-- Offer acceptance + admin-confirmed repayments.
-- Each ALTER is a single change because TiDB rejects multi-change ALTERs.
-- Assumes finance_facility_applications already has the 'disbursed' status
-- and disbursed_* columns (applied separately).

ALTER TABLE finance_facility_applications
  MODIFY COLUMN status ENUM(
    'submitted',
    'under_review',
    'additional_information_required',
    'approved',
    'declined',
    'disbursed',
    'offer_accepted',
    'offer_declined',
    'completed'
  ) NOT NULL DEFAULT 'submitted';

ALTER TABLE finance_facility_applications ADD COLUMN offer_accepted_at DATETIME NULL;
ALTER TABLE finance_facility_applications ADD COLUMN offer_declined_at DATETIME NULL;

ALTER TABLE finance_facility_repayments ADD COLUMN failure_reason VARCHAR(255) NULL;
ALTER TABLE finance_facility_repayments ADD COLUMN decline_reason VARCHAR(500) NULL;
ALTER TABLE finance_facility_repayments ADD COLUMN confirmed_by BIGINT UNSIGNED NULL;
ALTER TABLE finance_facility_repayments ADD COLUMN confirmed_at DATETIME NULL;

-- Backfill: fully repaid disbursed facilities become 'completed'.
UPDATE finance_facility_applications a
   SET a.status = 'completed'
 WHERE a.status = 'disbursed'
   AND EXISTS (SELECT 1 FROM finance_facility_repayment_schedules s WHERE s.facility_id = a.id)
   AND NOT EXISTS (
     SELECT 1 FROM finance_facility_repayment_schedules s
      WHERE s.facility_id = a.id AND s.status <> 'paid'
   );
