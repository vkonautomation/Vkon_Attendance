-- 0009_audit_allow_actor_null.sql -- let a departed employee's audit rows be anonymised.
--
-- 0005 declared, and its column comment explains why, that removing an employee must not remove
-- the record of what they did: audit_log.actor_employee_id is ON DELETE SET NULL. But the
-- append-only trigger from 0005 fires for *every* UPDATE -- including the one Postgres runs to
-- carry out that SET NULL cascade. The net effect was that no employee who had ever performed an
-- audited action could be deleted at all, so the roster's "remove employee" was impossible against
-- real data (it only ever worked on a brand-new account that had done nothing).
--
-- This narrows the trigger to its actual purpose: history is immutable, but the actor pointer on a
-- removed employee may be nulled. It permits exactly one shape of UPDATE -- the whole row identical
-- except actor_employee_id going from a value to NULL -- and still refuses DELETE, TRUNCATE (the
-- separate statement trigger is untouched), and any other change. Nothing that alters what
-- happened, when, to which entity, or its stored detail is ever allowed through.

CREATE OR REPLACE FUNCTION audit_log_is_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.actor_employee_id IS NULL
     AND OLD.actor_employee_id IS NOT NULL
     AND NEW.id          = OLD.id
     AND NEW.at          = OLD.at
     AND NEW.action      = OLD.action
     AND NEW.entity_type IS NOT DISTINCT FROM OLD.entity_type
     AND NEW.entity_id   IS NOT DISTINCT FROM OLD.entity_id
     AND NEW.detail      IS NOT DISTINCT FROM OLD.detail
     AND NEW.ip          IS NOT DISTINCT FROM OLD.ip
     AND NEW.created_at  = OLD.created_at
  THEN
    -- The FK's SET NULL for a deleted employee: an anonymisation, not a rewrite of history.
    RETURN NEW;
  END IF;
  RAISE EXCEPTION
    'audit_log is append-only: % is not permitted (attempted by %)',
    TG_OP, current_user
    USING ERRCODE = 'insufficient_privilege', HINT = 'Insert a new entry describing the correction instead of changing history.';
END
$$;

COMMENT ON FUNCTION audit_log_is_append_only() IS
  'Refuses every change to audit_log except nulling actor_employee_id when its employee is deleted; see 0005 and 0009.';
