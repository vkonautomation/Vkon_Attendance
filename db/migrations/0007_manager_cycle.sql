-- 0007_manager_cycle.sql -- the manager chain is a tree, and a tree has no cycles.

-- 0002_core.sql refuses the depth-1 case -- `CHECK (manager_id IS NULL OR manager_id <> id)`
-- stops an employee being their own manager -- but a cycle needs at least two rows: A reports
-- to B, B reports to A, and neither check fires because each individual pointer is legal. A
-- cycle is not a data-entry curiosity here; it is a hang. The approval router in M8 walks up
-- `manager_id` to find who decides a request, and admin-fallback logic that keeps a visited
-- set is a bug waiting for the first manager who reorganises their team wrong. Refusing the
-- cycle at write time is the only place it can be refused cheaply.
--
-- A CONSTRAINT trigger, not a plain one: it runs after the row lands so the walk sees the
-- value being committed, and it is DEFERRABLE so a bulk re-parenting in one transaction
-- (the import path, M11) can defer it to commit and temporarily stand an intermediate graph
-- that would otherwise be refused mid-statement. INITIALLY IMMEDIATE keeps the ordinary
-- single write honest -- a PATCH that closes a loop fails on that PATCH, which is what M7's
-- test asserts.
--
-- It fires only when `manager_id` actually changes, so an unrelated PATCH (a job title, the
-- active flag) does not re-walk the chain and cannot fail on a rule it never touched.
CREATE FUNCTION employees_refuse_manager_cycle() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  cursor uuid;
  hops   integer := 0;
BEGIN
  -- Walk up from the proposed manager. If we ever arrive back at the employee whose pointer
  -- is changing, the graph has a loop. `hops` bounds the walk so a cycle written by another
  -- transaction -- or a chain someone has grown past sanity -- cannot hang the trigger; a
  -- chain deeper than the bound is itself refused rather than trusted.
  cursor := NEW.manager_id;
  WHILE cursor IS NOT NULL LOOP
    IF cursor = NEW.id THEN
      RAISE EXCEPTION 'employee % cannot report into a chain that leads back to itself', NEW.id
        USING ERRCODE = 'check_violation';
    END IF;

    SELECT manager_id INTO cursor FROM employees WHERE id = cursor;
    -- SELECT INTO leaves `cursor` NULL when the row is gone or has no manager: the chain
    -- terminated, so it cannot return to NEW.id. That is the success case, not an error.
    IF cursor IS NULL THEN
      EXIT;
    END IF;

    hops := hops + 1;
    IF hops > 64 THEN
      RAISE EXCEPTION 'employee % has a manager chain deeper than 64 levels; refusing to accept it', NEW.id
        USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;

  RETURN NEW;
END
$$;

CREATE CONSTRAINT TRIGGER employees_manager_no_cycle
  AFTER INSERT OR UPDATE OF manager_id ON employees
  DEFERRABLE INITIALLY IMMEDIATE
  FOR EACH ROW EXECUTE FUNCTION employees_refuse_manager_cycle();

COMMENT ON FUNCTION employees_refuse_manager_cycle() IS
  'Constraint trigger body: refuses a manager_id write that would put an employee in a cycle. The depth-1 self-reference is still caught by the 0002 CHECK; this catches loops of any length.';
