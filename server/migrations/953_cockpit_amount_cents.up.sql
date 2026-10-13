-- Amounts on the board are tracked in 万元. Four decimal places only reach
-- whole yuan (0.0001 万 = 1 元), so a real invoice total like 29,100.55 元
-- (2.910055 万) was rounded on every write and jiao/fen could never be
-- entered. Six places reach fen (0.01 元).

ALTER TABLE cockpit_node ALTER COLUMN budget_amount TYPE NUMERIC(14,6);
ALTER TABLE cockpit_payment ALTER COLUMN amount TYPE NUMERIC(14,6);
