-- Payment methods a school offers, and how each payment was actually paid.

-- Which ways of paying students see. Online methods (ideal, card, bancontact)
-- go through the school's payment provider; the others are paid outside the
-- app and recorded by staff with "Mark paid".
ALTER TABLE school_settings
  ADD COLUMN payment_methods text[] NOT NULL DEFAULT ARRAY['ideal','card','bank_transfer','cash']
    CHECK (cardinality(payment_methods) BETWEEN 1 AND 6
           AND payment_methods <@ ARRAY['ideal','card','bancontact','bank_transfer','cash','pin']),
  -- Shown to students next to cash / PIN, e.g. "Pay your instructor in the car" (optional).
  ADD COLUMN offline_payment_note text CHECK (offline_payment_note IS NULL OR length(offline_payment_note) <= 300);

-- How a payment was settled. NULL for payments made before this column existed.
-- 'online' = paid through the provider's checkout (the provider knows the exact method).
ALTER TABLE payments
  ADD COLUMN method text CHECK (method IS NULL OR method IN ('online','bank_transfer','cash','pin'));
UPDATE payments SET method = 'online' WHERE status IN ('paid','refunded','disputed') AND recorded_by IS NULL;

-- Stripe Connect onboarding state, refreshed from Stripe when the owner
-- returns from onboarding or presses "Check status".
ALTER TABLE school_payment_accounts
  ADD COLUMN charges_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN payouts_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN details_submitted boolean NOT NULL DEFAULT false,
  ADD COLUMN status_checked_at timestamptz,
  -- 'manual' = the owner pasted an existing acct_… id; 'onboarding' = created through the Connect button.
  ADD COLUMN source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','onboarding'));
-- Accounts entered by hand before onboarding existed were already trusted as active.
UPDATE school_payment_accounts SET charges_enabled = true, payouts_enabled = true, details_submitted = true WHERE status = 'active';
