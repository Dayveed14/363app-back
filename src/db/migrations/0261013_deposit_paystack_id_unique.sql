-- Database-level guard against crediting one Paystack transaction to two
-- deposits. NULLs (not yet verified) are allowed any number of times.
-- If this fails with a duplicate-entry error, you already have two deposits
-- pointing at the same Paystack transaction: investigate those rows first.
ALTER TABLE deposits ADD UNIQUE INDEX uq_deposits_paystack_ref_id (paystack_ref_id);
