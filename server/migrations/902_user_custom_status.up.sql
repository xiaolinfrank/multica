-- Fork-only (900-999 range): free-form presence status shown above a user's
-- figure in the Agent Office. Stored on the global user row (like timezone /
-- language) because a status is a property of the person, not of any one
-- membership; every office reads it through ListMembersWithUser.
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS custom_status text NOT NULL DEFAULT '';
