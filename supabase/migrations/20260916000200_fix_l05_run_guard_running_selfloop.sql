-- ============================================================================
-- L-08 acceptance fix: permit running->running discovery-run updates.
--
-- novatrade_l05_run_guard allowed planned->running|cancelled and
-- running->completed|failed|cancelled, but appendDiscoveryObservationBatch
-- keeps status 'running' while progressing tasks/totals/events, so every
-- observation-batch append was rejected with L05_RUN_INVALID_TRANSITION.
-- The self-loop is still fenced by the staleness rule directly above it
-- (NEW.updated_at > OLD.updated_at AND NEW.run_sha256 <> OLD.run_sha256),
-- which makes every permitted self-update a strictly-progressing ledger write.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.novatrade_l05_run_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $function$
BEGIN
  IF NEW.run_id IS DISTINCT FROM OLD.run_id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id OR NEW.plan_id IS DISTINCT FROM OLD.plan_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='L05_RUN_IDENTITY_IMMUTABLE';
  END IF;
  IF NEW.updated_at <= OLD.updated_at OR NEW.run_sha256 = OLD.run_sha256 THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='L05_RUN_STALE_UPDATE';
  END IF;
  IF OLD.status IN ('completed', 'failed', 'cancelled') THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='L05_RUN_TERMINAL';
  END IF;
  IF NOT ((OLD.status = 'planned' AND NEW.status IN ('running', 'cancelled'))
    OR (OLD.status = 'running' AND NEW.status IN ('running', 'completed', 'failed', 'cancelled'))) THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='L05_RUN_INVALID_TRANSITION';
  END IF;
  RETURN NEW;
END;
$function$;
