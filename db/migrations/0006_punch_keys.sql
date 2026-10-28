-- 0006_punch_keys.sql -- the punch's idempotency key has to hold what the browser sends.
--
-- 0003 declared punch_id as `uuid` because the offline queue's key was assumed to be a
-- crypto.randomUUID. The queue that actually ships does not send one: app.js stamps every
-- punch with a deterministic `${employeeCode}_${attendanceDay}_${kind}` so that a replay of
-- the same half of a shift is recognisable as the same event even after a tab reload. That
-- string is not a uuid, and an idempotency key that rejects the value the client is built to
-- send is not an idempotency key. Widening it to text keeps the UNIQUE rule -- which is the
-- part that makes a double queue-flush one row -- and lets the real browser value land.
--
-- It is a widening, not a rename: a uuid-shaped value is still text, so 0005-era rows and
-- the integration test that inserts a uuid punch_id (and expects a replay to be refused)
-- are unaffected. The column stays nullable -- materialised and imported rows have no queue
-- entry -- and stays unique where present, exactly as before.
ALTER TABLE records ALTER COLUMN punch_id TYPE text USING punch_id::text;

-- The queue's key is looked up directly on every replay ("have I already recorded this
-- punch?"), and the day-key uniqueness does not serve that lookup when a punch is re-sent
-- after its attendance day has been re-derived. A plain index on the idempotency key is the
-- difference between an O(1) existence check and a scan of the punch table on every flush.
CREATE INDEX records_punch_id_idx ON records (punch_id) WHERE punch_id IS NOT NULL;

-- One row carries both halves of a shift, but the browser queues each half as its own
-- event with its own key (`..._in` and `..._out`). A single column cannot remember two keys,
-- so the check-in keeps `punch_id` and the check-out gets its own. `punch_id` alone would
-- make a replayed check-out indistinguishable from a fresh one -- the whole point of the
-- idempotency key is that it is not. Same rules as punch_id: nullable, unique where present,
-- indexed for the O(1) replay lookup.
ALTER TABLE records ADD COLUMN check_out_punch_id text;
ALTER TABLE records ADD CONSTRAINT records_check_out_punch_id_key UNIQUE (check_out_punch_id);
CREATE INDEX records_check_out_punch_id_idx ON records (check_out_punch_id) WHERE check_out_punch_id IS NOT NULL;

COMMENT ON COLUMN records.punch_id IS
  'The offline queue''s idempotency key for the CHECK-IN: the browser''s `${code}_${day}_in`, or a uuid. Unique where present so a replayed flush cannot create a second row.';
COMMENT ON COLUMN records.check_out_punch_id IS
  'The queue''s idempotency key for the CHECK-OUT (`${code}_${day}_out`). Kept apart from punch_id because one row spans two queued events.';
