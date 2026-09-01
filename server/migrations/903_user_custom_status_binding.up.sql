-- Fork-only (900-999 range): binds a user's office presence status to a
-- floor zone. `custom_status_key` stores the editor preset key
-- (focus/meeting/gym/coffee/away/vacation) rather than the localized label,
-- so zone routing survives language switches; free-text statuses store ''.
-- `custom_status_expires_at` is stamped by UpdateMe (now + 2h) and resolved
-- at read time — an expired status reads back as empty everywhere, so no
-- client ever needs expiry logic or a trusted clock.
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS custom_status_key text NOT NULL DEFAULT '';
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS custom_status_expires_at timestamptz;
