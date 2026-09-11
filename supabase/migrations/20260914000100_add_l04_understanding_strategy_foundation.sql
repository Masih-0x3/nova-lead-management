-- L-04 durable foundation for business understanding, adaptive questions,
-- and ICP/lead-play strategy lifecycle. All records are tenant-scoped,
-- hash-bound, and review-gated. Raw tables stay closed; member reads pass
-- through RLS policies bound to the T-030 app.* GUCs and all writes pass
-- through the narrowly exposed SECURITY DEFINER capabilities below.
--
-- Authorization note: the definer gate accepts every role whose D-002 cell is
-- capable ('A' or 'C') for the action's permission. The conditional ('C')
-- decision itself is evaluated by the application boundary
-- (requireTenantPermission with an injected policy evaluator) inside the same
-- transaction; this layer verifies durable facts only (member context,
-- binding, scope, integrity).
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';
SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('novatrade:l04:understanding-strategy-foundation'));

-- All L-04 table bypass is concentrated in a non-login, non-superuser owner of
-- the narrowly exposed SECURITY DEFINER capabilities below.
DO $block$
DECLARE
  role_attributes pg_catalog.record;
BEGIN
  SELECT rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolinherit,rolreplication,rolbypassrls
    INTO role_attributes
  FROM pg_catalog.pg_roles
  WHERE rolname='novatrade_l04_strategy_definer';

  IF NOT FOUND THEN
    CREATE ROLE novatrade_l04_strategy_definer
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION BYPASSRLS;
  ELSIF role_attributes.rolcanlogin OR role_attributes.rolsuper OR role_attributes.rolcreatedb
     OR role_attributes.rolcreaterole OR role_attributes.rolinherit OR role_attributes.rolreplication
     OR NOT role_attributes.rolbypassrls
  THEN
    RAISE EXCEPTION 'novatrade_l04_strategy_definer has unsafe attributes';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_auth_members AS membership
    JOIN pg_catalog.pg_roles AS protected_role
      ON protected_role.oid IN (membership.roleid,membership.member)
    WHERE protected_role.rolname='novatrade_l04_strategy_definer'
  ) THEN
    RAISE EXCEPTION 'novatrade_l04_strategy_definer must have no role memberships';
  END IF;
END;
$block$;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.business_understanding_versions (
  version_id pg_catalog.text CONSTRAINT business_understanding_versions_pkey PRIMARY KEY
    CONSTRAINT business_understanding_versions_id_chk
    CHECK (version_id ~ '^understanding-version:[a-f0-9]{64}$'),
  tenant_id pg_catalog.uuid NOT NULL,
  workspace_id pg_catalog.uuid,
  proposal_ref pg_catalog.text NOT NULL
    CONSTRAINT business_understanding_versions_proposal_ref_chk
    CHECK (proposal_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$'),
  revision pg_catalog.int4 NOT NULL
    CONSTRAINT business_understanding_versions_revision_chk CHECK (revision BETWEEN 1 AND 1000000),
  supersedes_proposal_ref pg_catalog.text,
  supersedes_version_id pg_catalog.text,
  content_hash pg_catalog.text NOT NULL
    CONSTRAINT business_understanding_versions_content_hash_chk CHECK (content_hash ~ '^sha256:[a-f0-9]{64}$'),
  claim_set_hash pg_catalog.text NOT NULL
    CONSTRAINT business_understanding_versions_claim_set_hash_chk CHECK (claim_set_hash ~ '^sha256:[a-f0-9]{64}$'),
  review_hash pg_catalog.text NOT NULL
    CONSTRAINT business_understanding_versions_review_hash_chk CHECK (review_hash ~ '^sha256:[a-f0-9]{64}$'),
  status pg_catalog.text NOT NULL
    CONSTRAINT business_understanding_versions_status_chk
    CHECK (status IN ('draft','in_review','approved','rejected','superseded')),
  source pg_catalog.jsonb NOT NULL,
  review pg_catalog.jsonb NOT NULL,
  created_at pg_catalog.timestamptz(3) NOT NULL,
  updated_at pg_catalog.timestamptz(3) NOT NULL,
  CONSTRAINT business_understanding_versions_tenant_fkey
    FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT business_understanding_versions_workspace_fkey
    FOREIGN KEY (tenant_id,workspace_id) REFERENCES public.workspaces(tenant_id,id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT business_understanding_versions_supersedes_fkey
    FOREIGN KEY (supersedes_version_id) REFERENCES public.business_understanding_versions(version_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT business_understanding_versions_supersede_chk CHECK (
    (revision=1 AND supersedes_proposal_ref IS NULL AND supersedes_version_id IS NULL)
    OR (revision>1 AND supersedes_proposal_ref IS NOT NULL AND supersedes_version_id IS NOT NULL)
  ),
  CONSTRAINT business_understanding_versions_time_chk CHECK (updated_at >= created_at)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_business_understanding_versions_lineage
  ON public.business_understanding_versions(
    tenant_id, coalesce(workspace_id,'00000000-0000-4000-8000-000000000000'::pg_catalog.uuid),
    proposal_ref, revision);
CREATE INDEX IF NOT EXISTS idx_business_understanding_versions_scope
  ON public.business_understanding_versions(tenant_id,workspace_id,proposal_ref,revision);

CREATE TABLE IF NOT EXISTS public.business_understanding_review_events (
  id bigint GENERATED ALWAYS AS IDENTITY CONSTRAINT business_understanding_review_events_pkey PRIMARY KEY,
  tenant_id pg_catalog.uuid NOT NULL,
  workspace_id pg_catalog.uuid,
  version_id pg_catalog.text NOT NULL,
  sequence pg_catalog.int4 NOT NULL,
  from_status pg_catalog.text NOT NULL,
  to_status pg_catalog.text NOT NULL,
  actor pg_catalog.jsonb NOT NULL,
  at pg_catalog.timestamptz(3) NOT NULL,
  reason pg_catalog.text NOT NULL,
  replacement_version_id pg_catalog.text,
  event pg_catalog.jsonb NOT NULL,
  created_at pg_catalog.timestamptz(3) NOT NULL DEFAULT pg_catalog.statement_timestamp(),
  CONSTRAINT business_understanding_review_events_version_fkey
    FOREIGN KEY (version_id) REFERENCES public.business_understanding_versions(version_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT business_understanding_review_events_status_chk CHECK (
    from_status IN ('draft','in_review','approved','rejected','superseded')
    AND to_status IN ('draft','in_review','approved','rejected','superseded')
    AND (
      (from_status='draft' AND to_status='in_review')
      OR (from_status='in_review' AND to_status IN ('approved','rejected'))
      OR (from_status='approved' AND to_status='superseded')
    )
  ),
  CONSTRAINT business_understanding_review_events_sequence_chk CHECK (sequence BETWEEN 1 AND 4096),
  CONSTRAINT business_understanding_review_events_unique UNIQUE (version_id,sequence)
);
CREATE INDEX IF NOT EXISTS idx_business_understanding_review_events_scope
  ON public.business_understanding_review_events(tenant_id,workspace_id,version_id,sequence);

CREATE TABLE IF NOT EXISTS public.adaptive_question_sessions (
  id bigint GENERATED ALWAYS AS IDENTITY CONSTRAINT adaptive_question_sessions_pkey PRIMARY KEY,
  tenant_id pg_catalog.uuid NOT NULL,
  workspace_id pg_catalog.uuid,
  session_ref pg_catalog.text NOT NULL
    CONSTRAINT adaptive_question_sessions_ref_chk CHECK (session_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'),
  tenant_ref pg_catalog.text NOT NULL
    CONSTRAINT adaptive_question_sessions_tenant_ref_chk CHECK (tenant_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'),
  understanding_version_id pg_catalog.text NOT NULL,
  session pg_catalog.jsonb NOT NULL,
  session_hash pg_catalog.text NOT NULL
    CONSTRAINT adaptive_question_sessions_hash_chk CHECK (session_hash ~ '^sha256:[a-f0-9]{64}$'),
  created_at pg_catalog.timestamptz(3) NOT NULL,
  CONSTRAINT adaptive_question_sessions_tenant_fkey
    FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT adaptive_question_sessions_workspace_fkey
    FOREIGN KEY (tenant_id,workspace_id) REFERENCES public.workspaces(tenant_id,id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT adaptive_question_sessions_understanding_fkey
    FOREIGN KEY (understanding_version_id) REFERENCES public.business_understanding_versions(version_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_adaptive_question_sessions_scope_ref
  ON public.adaptive_question_sessions(
    tenant_id, coalesce(workspace_id,'00000000-0000-4000-8000-000000000000'::pg_catalog.uuid),
    session_ref);
ALTER TABLE public.adaptive_question_sessions
  ADD CONSTRAINT adaptive_question_sessions_tenant_ref_unique
  UNIQUE (tenant_id,session_ref);

CREATE TABLE IF NOT EXISTS public.adaptive_question_answers (
  id bigint GENERATED ALWAYS AS IDENTITY CONSTRAINT adaptive_question_answers_pkey PRIMARY KEY,
  tenant_id pg_catalog.uuid NOT NULL,
  workspace_id pg_catalog.uuid,
  session_ref pg_catalog.text NOT NULL,
  tenant_ref pg_catalog.text NOT NULL,
  understanding_version_id pg_catalog.text NOT NULL,
  answer_id pg_catalog.text NOT NULL
    CONSTRAINT adaptive_question_answers_id_chk CHECK (answer_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'),
  question_ref pg_catalog.text NOT NULL,
  uncertainty_id pg_catalog.text NOT NULL,
  disposition pg_catalog.text NOT NULL
    CONSTRAINT adaptive_question_answers_disposition_chk
    CHECK (disposition IN ('answered','corrected','deferred','unknown')),
  answer pg_catalog.jsonb NOT NULL,
  claim_update pg_catalog.jsonb,
  recorded_at pg_catalog.timestamptz(3) NOT NULL,
  CONSTRAINT adaptive_question_answers_session_fkey
    FOREIGN KEY (tenant_id,session_ref)
    REFERENCES public.adaptive_question_sessions(tenant_id,session_ref)
    ON UPDATE RESTRICT ON DELETE RESTRICT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_adaptive_question_answers_answer_id
  ON public.adaptive_question_answers(
    tenant_id, coalesce(workspace_id,'00000000-0000-4000-8000-000000000000'::pg_catalog.uuid),
    answer_id);
CREATE INDEX IF NOT EXISTS idx_adaptive_question_answers_session
  ON public.adaptive_question_answers(tenant_id,workspace_id,session_ref,recorded_at);

CREATE TABLE IF NOT EXISTS public.icp_versions (
  version_id pg_catalog.text CONSTRAINT icp_versions_pkey PRIMARY KEY
    CONSTRAINT icp_versions_id_chk CHECK (version_id ~ '^icp-version:[a-f0-9]{64}$'),
  tenant_id pg_catalog.uuid NOT NULL,
  workspace_id pg_catalog.uuid,
  stable_key pg_catalog.text NOT NULL
    CONSTRAINT icp_versions_stable_key_chk CHECK (stable_key ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$'),
  revision pg_catalog.int4 NOT NULL
    CONSTRAINT icp_versions_revision_chk CHECK (revision BETWEEN 1 AND 1000000),
  supersedes_version_id pg_catalog.text,
  content_hash pg_catalog.text NOT NULL
    CONSTRAINT icp_versions_content_hash_chk CHECK (content_hash ~ '^sha256:[a-f0-9]{64}$'),
  understanding_version_id pg_catalog.text NOT NULL,
  review_hash pg_catalog.text NOT NULL
    CONSTRAINT icp_versions_review_hash_chk CHECK (review_hash ~ '^sha256:[a-f0-9]{64}$'),
  status pg_catalog.text NOT NULL
    CONSTRAINT icp_versions_status_chk
    CHECK (status IN ('draft','in_review','approved','rejected','superseded')),
  source pg_catalog.jsonb NOT NULL,
  review pg_catalog.jsonb NOT NULL,
  created_at pg_catalog.timestamptz(3) NOT NULL,
  updated_at pg_catalog.timestamptz(3) NOT NULL,
  CONSTRAINT icp_versions_tenant_fkey
    FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT icp_versions_workspace_fkey
    FOREIGN KEY (tenant_id,workspace_id) REFERENCES public.workspaces(tenant_id,id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT icp_versions_supersedes_fkey
    FOREIGN KEY (supersedes_version_id) REFERENCES public.icp_versions(version_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT icp_versions_understanding_fkey
    FOREIGN KEY (understanding_version_id) REFERENCES public.business_understanding_versions(version_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT icp_versions_supersede_chk CHECK (
    (revision=1 AND supersedes_version_id IS NULL)
    OR (revision>1 AND supersedes_version_id IS NOT NULL)
  ),
  CONSTRAINT icp_versions_time_chk CHECK (updated_at >= created_at)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_icp_versions_lineage
  ON public.icp_versions(
    tenant_id, coalesce(workspace_id,'00000000-0000-4000-8000-000000000000'::pg_catalog.uuid),
    stable_key, revision);

CREATE TABLE IF NOT EXISTS public.icp_review_events (
  id bigint GENERATED ALWAYS AS IDENTITY CONSTRAINT icp_review_events_pkey PRIMARY KEY,
  tenant_id pg_catalog.uuid NOT NULL,
  workspace_id pg_catalog.uuid,
  version_id pg_catalog.text NOT NULL,
  sequence pg_catalog.int4 NOT NULL,
  from_status pg_catalog.text NOT NULL,
  to_status pg_catalog.text NOT NULL,
  actor pg_catalog.jsonb NOT NULL,
  at pg_catalog.timestamptz(3) NOT NULL,
  reason pg_catalog.text NOT NULL,
  replacement_version_id pg_catalog.text,
  event pg_catalog.jsonb NOT NULL,
  created_at pg_catalog.timestamptz(3) NOT NULL DEFAULT pg_catalog.statement_timestamp(),
  CONSTRAINT icp_review_events_version_fkey
    FOREIGN KEY (version_id) REFERENCES public.icp_versions(version_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT icp_review_events_status_chk CHECK (
    from_status IN ('draft','in_review','approved','rejected','superseded')
    AND to_status IN ('draft','in_review','approved','rejected','superseded')
    AND (
      (from_status='draft' AND to_status='in_review')
      OR (from_status='in_review' AND to_status IN ('approved','rejected'))
      OR (from_status='approved' AND to_status='superseded')
    )
  ),
  CONSTRAINT icp_review_events_unique UNIQUE (version_id,sequence)
);

CREATE TABLE IF NOT EXISTS public.lead_play_versions (
  version_id pg_catalog.text CONSTRAINT lead_play_versions_pkey PRIMARY KEY
    CONSTRAINT lead_play_versions_id_chk CHECK (version_id ~ '^lead-play-version:[a-f0-9]{64}$'),
  tenant_id pg_catalog.uuid NOT NULL,
  workspace_id pg_catalog.uuid,
  stable_key pg_catalog.text NOT NULL
    CONSTRAINT lead_play_versions_stable_key_chk CHECK (stable_key ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$'),
  revision pg_catalog.int4 NOT NULL
    CONSTRAINT lead_play_versions_revision_chk CHECK (revision BETWEEN 1 AND 1000000),
  supersedes_version_id pg_catalog.text,
  icp_version_id pg_catalog.text NOT NULL,
  understanding_version_id pg_catalog.text NOT NULL,
  content_hash pg_catalog.text NOT NULL
    CONSTRAINT lead_play_versions_content_hash_chk CHECK (content_hash ~ '^sha256:[a-f0-9]{64}$'),
  review_hash pg_catalog.text NOT NULL
    CONSTRAINT lead_play_versions_review_hash_chk CHECK (review_hash ~ '^sha256:[a-f0-9]{64}$'),
  status pg_catalog.text NOT NULL
    CONSTRAINT lead_play_versions_status_chk
    CHECK (status IN ('draft','in_review','approved','rejected','superseded')),
  source pg_catalog.jsonb NOT NULL,
  review pg_catalog.jsonb NOT NULL,
  created_at pg_catalog.timestamptz(3) NOT NULL,
  updated_at pg_catalog.timestamptz(3) NOT NULL,
  CONSTRAINT lead_play_versions_tenant_fkey
    FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT lead_play_versions_workspace_fkey
    FOREIGN KEY (tenant_id,workspace_id) REFERENCES public.workspaces(tenant_id,id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT lead_play_versions_supersedes_fkey
    FOREIGN KEY (supersedes_version_id) REFERENCES public.lead_play_versions(version_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT lead_play_versions_icp_fkey
    FOREIGN KEY (icp_version_id) REFERENCES public.icp_versions(version_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT lead_play_versions_understanding_fkey
    FOREIGN KEY (understanding_version_id) REFERENCES public.business_understanding_versions(version_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT lead_play_versions_supersede_chk CHECK (
    (revision=1 AND supersedes_version_id IS NULL)
    OR (revision>1 AND supersedes_version_id IS NOT NULL)
  ),
  CONSTRAINT lead_play_versions_time_chk CHECK (updated_at >= created_at)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_lead_play_versions_lineage
  ON public.lead_play_versions(
    tenant_id, coalesce(workspace_id,'00000000-0000-4000-8000-000000000000'::pg_catalog.uuid),
    stable_key, revision);

CREATE TABLE IF NOT EXISTS public.lead_play_review_events (
  id bigint GENERATED ALWAYS AS IDENTITY CONSTRAINT lead_play_review_events_pkey PRIMARY KEY,
  tenant_id pg_catalog.uuid NOT NULL,
  workspace_id pg_catalog.uuid,
  version_id pg_catalog.text NOT NULL,
  sequence pg_catalog.int4 NOT NULL,
  from_status pg_catalog.text NOT NULL,
  to_status pg_catalog.text NOT NULL,
  actor pg_catalog.jsonb NOT NULL,
  at pg_catalog.timestamptz(3) NOT NULL,
  reason pg_catalog.text NOT NULL,
  replacement_version_id pg_catalog.text,
  event pg_catalog.jsonb NOT NULL,
  created_at pg_catalog.timestamptz(3) NOT NULL DEFAULT pg_catalog.statement_timestamp(),
  CONSTRAINT lead_play_review_events_version_fkey
    FOREIGN KEY (version_id) REFERENCES public.lead_play_versions(version_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT lead_play_review_events_status_chk CHECK (
    from_status IN ('draft','in_review','approved','rejected','superseded')
    AND to_status IN ('draft','in_review','approved','rejected','superseded')
    AND (
      (from_status='draft' AND to_status='in_review')
      OR (from_status='in_review' AND to_status IN ('approved','rejected'))
      OR (from_status='approved' AND to_status='superseded')
    )
  ),
  CONSTRAINT lead_play_review_events_unique UNIQUE (version_id,sequence)
);

CREATE TABLE IF NOT EXISTS public.lead_play_simulations (
  simulation_id pg_catalog.text CONSTRAINT lead_play_simulations_pkey PRIMARY KEY
    CONSTRAINT lead_play_simulations_id_chk CHECK (simulation_id ~ '^lead-play-simulation:[a-f0-9]{64}$'),
  tenant_id pg_catalog.uuid NOT NULL,
  workspace_id pg_catalog.uuid,
  play_version_id pg_catalog.text NOT NULL,
  play_review_hash pg_catalog.text NOT NULL
    CONSTRAINT lead_play_simulations_review_hash_chk CHECK (play_review_hash ~ '^sha256:[a-f0-9]{64}$'),
  simulation_hash pg_catalog.text NOT NULL
    CONSTRAINT lead_play_simulations_hash_chk CHECK (simulation_hash ~ '^sha256:[a-f0-9]{64}$'),
  input pg_catalog.jsonb NOT NULL,
  simulation pg_catalog.jsonb NOT NULL,
  created_at pg_catalog.timestamptz(3) NOT NULL,
  CONSTRAINT lead_play_simulations_tenant_fkey
    FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT lead_play_simulations_workspace_fkey
    FOREIGN KEY (tenant_id,workspace_id) REFERENCES public.workspaces(tenant_id,id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT lead_play_simulations_play_fkey
    FOREIGN KEY (play_version_id) REFERENCES public.lead_play_versions(version_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_lead_play_simulations_play
  ON public.lead_play_simulations(tenant_id,workspace_id,play_version_id,created_at);

CREATE TABLE IF NOT EXISTS public.lead_play_simulation_reviews (
  id bigint GENERATED ALWAYS AS IDENTITY CONSTRAINT lead_play_simulation_reviews_pkey PRIMARY KEY,
  tenant_id pg_catalog.uuid NOT NULL,
  workspace_id pg_catalog.uuid,
  play_version_id pg_catalog.text NOT NULL,
  simulation_id pg_catalog.text NOT NULL,
  eligibility_hash pg_catalog.text NOT NULL
    CONSTRAINT lead_play_simulation_reviews_hash_chk CHECK (eligibility_hash ~ '^sha256:[a-f0-9]{64}$'),
  decision pg_catalog.text NOT NULL
    CONSTRAINT lead_play_simulation_reviews_decision_chk CHECK (decision IN ('eligible','ineligible')),
  review pg_catalog.jsonb NOT NULL,
  created_at pg_catalog.timestamptz(3) NOT NULL,
  CONSTRAINT lead_play_simulation_reviews_simulation_fkey
    FOREIGN KEY (simulation_id) REFERENCES public.lead_play_simulations(simulation_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT lead_play_simulation_reviews_play_fkey
    FOREIGN KEY (play_version_id) REFERENCES public.lead_play_versions(version_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT lead_play_simulation_reviews_unique UNIQUE (play_version_id,simulation_id,eligibility_hash)
);
CREATE INDEX IF NOT EXISTS idx_lead_play_simulation_reviews_play
  ON public.lead_play_simulation_reviews(tenant_id,workspace_id,play_version_id,simulation_id,created_at);

CREATE TABLE IF NOT EXISTS public.lead_play_activation_states (
  id bigint GENERATED ALWAYS AS IDENTITY CONSTRAINT lead_play_activation_states_pkey PRIMARY KEY,
  tenant_id pg_catalog.uuid NOT NULL,
  workspace_id pg_catalog.uuid,
  stable_key pg_catalog.text NOT NULL
    CONSTRAINT lead_play_activation_states_key_chk CHECK (stable_key ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$'),
  state_hash pg_catalog.text NOT NULL
    CONSTRAINT lead_play_activation_states_hash_chk CHECK (state_hash ~ '^sha256:[a-f0-9]{64}$'),
  state pg_catalog.jsonb NOT NULL,
  created_at pg_catalog.timestamptz(3) NOT NULL,
  updated_at pg_catalog.timestamptz(3) NOT NULL,
  CONSTRAINT lead_play_activation_states_tenant_fkey
    FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT lead_play_activation_states_workspace_fkey
    FOREIGN KEY (tenant_id,workspace_id) REFERENCES public.workspaces(tenant_id,id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT lead_play_activation_states_time_chk CHECK (updated_at >= created_at)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_lead_play_activation_states_scope_key
  ON public.lead_play_activation_states(
    tenant_id, coalesce(workspace_id,'00000000-0000-4000-8000-000000000000'::pg_catalog.uuid),
    stable_key);

-- ---------------------------------------------------------------------------
-- Trigger guards: identity immutability, legal review transitions, append-only
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.novatrade_l04_append_only()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $fn$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE='P0001';
END;
$fn$;

CREATE OR REPLACE FUNCTION public.novatrade_l04_review_version_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $fn$
BEGIN
  IF ROW(NEW.version_id,NEW.tenant_id,NEW.workspace_id,NEW.revision,NEW.content_hash,
    NEW.source,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.version_id,OLD.tenant_id,OLD.workspace_id,OLD.revision,
    OLD.content_hash,OLD.source,OLD.created_at) THEN
    RAISE EXCEPTION '% identity is immutable', TG_TABLE_NAME USING ERRCODE='P0001';
  END IF;
  IF NOT (
    (OLD.status='draft' AND NEW.status='in_review')
    OR (OLD.status='in_review' AND NEW.status IN ('approved','rejected'))
    OR (OLD.status='approved' AND NEW.status='superseded')
  ) THEN
    RAISE EXCEPTION '% review transition is invalid', TG_TABLE_NAME USING ERRCODE='P0001';
  END IF;
  IF NEW.review_hash !~ '^sha256:[a-f0-9]{64}$' OR NEW.review IS NULL
     OR NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION '% review payload is invalid', TG_TABLE_NAME USING ERRCODE='P0001';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.novatrade_l04_understanding_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $fn$
BEGIN
  IF ROW(NEW.version_id,NEW.tenant_id,NEW.workspace_id,NEW.proposal_ref,NEW.revision,
    NEW.supersedes_proposal_ref,NEW.supersedes_version_id,NEW.content_hash,NEW.claim_set_hash,
    NEW.source,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.version_id,OLD.tenant_id,OLD.workspace_id,OLD.proposal_ref,OLD.revision,
    OLD.supersedes_proposal_ref,OLD.supersedes_version_id,OLD.content_hash,OLD.claim_set_hash,
    OLD.source,OLD.created_at) THEN
    RAISE EXCEPTION 'understanding version identity is immutable' USING ERRCODE='P0001';
  END IF;
  IF NOT (
    (OLD.status='draft' AND NEW.status='in_review')
    OR (OLD.status='in_review' AND NEW.status IN ('approved','rejected'))
    OR (OLD.status='approved' AND NEW.status='superseded')
  ) THEN
    RAISE EXCEPTION 'understanding review transition is invalid' USING ERRCODE='P0001';
  END IF;
  IF NEW.review_hash !~ '^sha256:[a-f0-9]{64}$' OR NEW.review IS NULL
     OR NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'understanding review payload is invalid' USING ERRCODE='P0001';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.novatrade_l04_activation_state_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $fn$
BEGIN
  IF ROW(NEW.tenant_id,NEW.workspace_id,NEW.stable_key,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.tenant_id,OLD.workspace_id,OLD.stable_key,OLD.created_at) THEN
    RAISE EXCEPTION 'activation state identity is immutable' USING ERRCODE='P0001';
  END IF;
  IF NEW.state_hash !~ '^sha256:[a-f0-9]{64}$' OR NEW.state IS NULL
     OR NEW.updated_at <= OLD.updated_at THEN
    RAISE EXCEPTION 'activation state transition is invalid' USING ERRCODE='P0001';
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS trg_l04_understanding_guard ON public.business_understanding_versions;
CREATE TRIGGER trg_l04_understanding_guard BEFORE UPDATE ON public.business_understanding_versions
  FOR EACH ROW EXECUTE FUNCTION public.novatrade_l04_understanding_guard();
DROP TRIGGER IF EXISTS trg_l04_understanding_delete ON public.business_understanding_versions;
CREATE TRIGGER trg_l04_understanding_delete BEFORE DELETE ON public.business_understanding_versions
  FOR EACH ROW EXECUTE FUNCTION public.novatrade_l04_append_only();

DROP TRIGGER IF EXISTS trg_l04_understanding_events_append_only ON public.business_understanding_review_events;
CREATE TRIGGER trg_l04_understanding_events_append_only BEFORE UPDATE OR DELETE
  ON public.business_understanding_review_events
  FOR EACH ROW EXECUTE FUNCTION public.novatrade_l04_append_only();

DROP TRIGGER IF EXISTS trg_l04_question_sessions_append_only ON public.adaptive_question_sessions;
CREATE TRIGGER trg_l04_question_sessions_append_only BEFORE UPDATE OR DELETE
  ON public.adaptive_question_sessions
  FOR EACH ROW EXECUTE FUNCTION public.novatrade_l04_append_only();
DROP TRIGGER IF EXISTS trg_l04_question_answers_append_only ON public.adaptive_question_answers;
CREATE TRIGGER trg_l04_question_answers_append_only BEFORE UPDATE OR DELETE
  ON public.adaptive_question_answers
  FOR EACH ROW EXECUTE FUNCTION public.novatrade_l04_append_only();

DROP TRIGGER IF EXISTS trg_l04_icp_guard ON public.icp_versions;
CREATE TRIGGER trg_l04_icp_guard BEFORE UPDATE ON public.icp_versions
  FOR EACH ROW EXECUTE FUNCTION public.novatrade_l04_review_version_guard();
DROP TRIGGER IF EXISTS trg_l04_icp_delete ON public.icp_versions;
CREATE TRIGGER trg_l04_icp_delete BEFORE DELETE ON public.icp_versions
  FOR EACH ROW EXECUTE FUNCTION public.novatrade_l04_append_only();
DROP TRIGGER IF EXISTS trg_l04_icp_events_append_only ON public.icp_review_events;
CREATE TRIGGER trg_l04_icp_events_append_only BEFORE UPDATE OR DELETE
  ON public.icp_review_events
  FOR EACH ROW EXECUTE FUNCTION public.novatrade_l04_append_only();

DROP TRIGGER IF EXISTS trg_l04_play_guard ON public.lead_play_versions;
CREATE TRIGGER trg_l04_play_guard BEFORE UPDATE ON public.lead_play_versions
  FOR EACH ROW EXECUTE FUNCTION public.novatrade_l04_review_version_guard();
DROP TRIGGER IF EXISTS trg_l04_play_delete ON public.lead_play_versions;
CREATE TRIGGER trg_l04_play_delete BEFORE DELETE ON public.lead_play_versions
  FOR EACH ROW EXECUTE FUNCTION public.novatrade_l04_append_only();
DROP TRIGGER IF EXISTS trg_l04_play_events_append_only ON public.lead_play_review_events;
CREATE TRIGGER trg_l04_play_events_append_only BEFORE UPDATE OR DELETE
  ON public.lead_play_review_events
  FOR EACH ROW EXECUTE FUNCTION public.novatrade_l04_append_only();

DROP TRIGGER IF EXISTS trg_l04_simulations_append_only ON public.lead_play_simulations;
CREATE TRIGGER trg_l04_simulations_append_only BEFORE UPDATE OR DELETE
  ON public.lead_play_simulations
  FOR EACH ROW EXECUTE FUNCTION public.novatrade_l04_append_only();
DROP TRIGGER IF EXISTS trg_l04_simulation_reviews_append_only ON public.lead_play_simulation_reviews;
CREATE TRIGGER trg_l04_simulation_reviews_append_only BEFORE UPDATE OR DELETE
  ON public.lead_play_simulation_reviews
  FOR EACH ROW EXECUTE FUNCTION public.novatrade_l04_append_only();

DROP TRIGGER IF EXISTS trg_l04_activation_guard ON public.lead_play_activation_states;
CREATE TRIGGER trg_l04_activation_guard BEFORE UPDATE ON public.lead_play_activation_states
  FOR EACH ROW EXECUTE FUNCTION public.novatrade_l04_activation_state_guard();
DROP TRIGGER IF EXISTS trg_l04_activation_delete ON public.lead_play_activation_states;
CREATE TRIGGER trg_l04_activation_delete BEFORE DELETE ON public.lead_play_activation_states
  FOR EACH ROW EXECUTE FUNCTION public.novatrade_l04_append_only();

-- ---------------------------------------------------------------------------
-- Shared member-context gate for the definer capabilities. Returns false for
-- anything that is not a complete, consistent member context whose bound role
-- is in the supplied capable set.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.novatrade_l04_member_gate(
  p_tenant_id pg_catalog.text,
  p_workspace_id pg_catalog.text,
  p_allowed_roles pg_catalog.text[]
)
RETURNS pg_catalog.bool
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  tenant_uuid pg_catalog.uuid;
  workspace_uuid pg_catalog.uuid;
  actor_uuid pg_catalog.uuid;
  membership_uuid pg_catalog.uuid;
  binding_uuid pg_catalog.uuid;
BEGIN
  IF p_tenant_id IS NULL
     OR p_tenant_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR (p_workspace_id IS NOT NULL AND p_workspace_id <> ''
         AND p_workspace_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
  THEN
    RETURN false;
  END IF;
  tenant_uuid := p_tenant_id::pg_catalog.uuid;
  workspace_uuid := nullif(p_workspace_id,'')::pg_catalog.uuid;

  IF NULLIF(pg_catalog.current_setting('app.tenant_id',true),'') IS DISTINCT FROM tenant_uuid::pg_catalog.text
     OR NULLIF(pg_catalog.current_setting('app.workspace_id',true),'')
        IS DISTINCT FROM coalesce(workspace_uuid::pg_catalog.text,'')
     OR NULLIF(pg_catalog.current_setting('app.actor_id',true),'') IS NULL
     OR NULLIF(pg_catalog.current_setting('app.membership_id',true),'') IS NULL
     OR NULLIF(pg_catalog.current_setting('app.role_binding_id',true),'') IS NULL
     OR NULLIF(pg_catalog.current_setting('app.role',true),'') IS NULL
     OR NOT (pg_catalog.current_setting('app.role',true) = ANY (p_allowed_roles))
     OR NULLIF(pg_catalog.current_setting('app.correlation_id',true),'') !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$'
     OR coalesce(pg_catalog.current_setting('app.support_grant_id',true),'') <> ''
     OR coalesce(pg_catalog.current_setting('app.job_id',true),'') <> ''
     OR coalesce(pg_catalog.current_setting('app.run_id',true),'') <> ''
     OR coalesce(pg_catalog.current_setting('app.lease_id',true),'') <> ''
     OR coalesce(pg_catalog.current_setting('app.lease_generation',true),'') <> ''
     OR coalesce(pg_catalog.current_setting('app.worker_name',true),'') <> ''
     OR coalesce(pg_catalog.current_setting('app.worker_action',true),'') <> ''
     OR coalesce(pg_catalog.current_setting('app.worker_principal_kind',true),'') <> ''
  THEN
    RETURN false;
  END IF;

  BEGIN
    actor_uuid := pg_catalog.current_setting('app.actor_id',true)::pg_catalog.uuid;
    membership_uuid := pg_catalog.current_setting('app.membership_id',true)::pg_catalog.uuid;
    binding_uuid := pg_catalog.current_setting('app.role_binding_id',true)::pg_catalog.uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RETURN false;
  END;

  RETURN EXISTS (
    SELECT true
    FROM public.tenants AS tenant
    LEFT JOIN public.workspaces AS workspace
      ON workspace.tenant_id=tenant.id AND workspace.id=workspace_uuid AND workspace.status='active'
    JOIN public.tenant_memberships AS membership
      ON membership.tenant_id=tenant.id AND membership.id=membership_uuid
     AND membership.auth_identity_id=actor_uuid AND membership.pending_identity_ref_hash IS NULL
     AND membership.status='active'
     AND (membership.workspace_id IS NULL OR membership.workspace_id=workspace_uuid)
    JOIN public.tenant_role_bindings AS binding
      ON binding.tenant_id=tenant.id AND binding.id=binding_uuid AND binding.membership_id=membership.id
     AND binding.role=pg_catalog.current_setting('app.role',true)
     AND binding.role = ANY (p_allowed_roles)
     AND binding.valid_from<=pg_catalog.statement_timestamp() AND binding.revoked_at IS NULL
    WHERE tenant.id=tenant_uuid AND tenant.status='active'
      AND (workspace_uuid IS NULL OR workspace.id IS NOT NULL)
  );
EXCEPTION WHEN others THEN
  RETURN false;
END;
$function$;

-- ---------------------------------------------------------------------------
-- Member write capabilities. Every function is default-denied: it returns no
-- row unless the member gate passes and every parameter validates.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.novatrade_l04_append_understanding_version(
  p_tenant_id pg_catalog.text,
  p_workspace_id pg_catalog.text,
  p_version_id pg_catalog.text,
  p_proposal_ref pg_catalog.text,
  p_revision pg_catalog.text,
  p_supersedes_proposal_ref pg_catalog.text,
  p_supersedes_version_id pg_catalog.text,
  p_content_hash pg_catalog.text,
  p_claim_set_hash pg_catalog.text,
  p_review_hash pg_catalog.text,
  p_status pg_catalog.text,
  p_source pg_catalog.text,
  p_review pg_catalog.text,
  p_created_at pg_catalog.text,
  p_updated_at pg_catalog.text
)
RETURNS TABLE (kind pg_catalog.text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE
  v_source pg_catalog.jsonb;
  v_review pg_catalog.jsonb;
  v_revision pg_catalog.int4;
  v_created pg_catalog.timestamptz;
  v_updated pg_catalog.timestamptz;
BEGIN
  IF p_version_id IS NULL OR p_version_id !~ '^understanding-version:[a-f0-9]{64}$'
     OR p_proposal_ref IS NULL OR p_proposal_ref !~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$'
     OR p_revision IS NULL OR p_revision !~ '^[1-9][0-9]{0,5}$'
     OR p_content_hash IS NULL OR p_content_hash !~ '^sha256:[a-f0-9]{64}$'
     OR p_claim_set_hash IS NULL OR p_claim_set_hash !~ '^sha256:[a-f0-9]{64}$'
     OR p_review_hash IS NULL OR p_review_hash !~ '^sha256:[a-f0-9]{64}$'
     OR p_status IS NULL OR p_status <> 'draft'
     OR p_created_at IS NULL OR p_updated_at IS NULL THEN
    RETURN;
  END IF;
  IF (p_supersedes_proposal_ref IS NULL) <> (p_supersedes_version_id IS NULL)
     OR (p_supersedes_version_id IS NOT NULL
         AND p_supersedes_version_id !~ '^understanding-version:[a-f0-9]{64}$')
     OR (p_supersedes_proposal_ref IS NOT NULL
         AND p_supersedes_proposal_ref !~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$') THEN
    RETURN;
  END IF;
  BEGIN
    v_source := p_source::pg_catalog.jsonb;
    v_review := p_review::pg_catalog.jsonb;
    v_revision := p_revision::pg_catalog.int4;
    v_created := p_created_at::pg_catalog.timestamptz;
    v_updated := p_updated_at::pg_catalog.timestamptz;
  EXCEPTION WHEN others THEN
    RETURN;
  END;
  IF v_revision < 1 OR v_updated < v_created THEN RETURN; END IF;

  IF NOT public.novatrade_l04_member_gate(p_tenant_id,p_workspace_id,
    ARRAY['owner','admin','strategist_manager','researcher','reviewer']) THEN
    RETURN;
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_tenant_id || ':' || coalesce(p_workspace_id,'') || ':' || p_version_id, 0));

  IF EXISTS (SELECT 1 FROM public.business_understanding_versions AS existing
    WHERE existing.version_id=p_version_id) THEN
    IF EXISTS (SELECT 1 FROM public.business_understanding_versions AS existing
      WHERE existing.version_id=p_version_id
        AND existing.tenant_id=p_tenant_id::pg_catalog.uuid
        AND existing.workspace_id IS NOT DISTINCT FROM nullif(p_workspace_id,'')::pg_catalog.uuid
        AND existing.proposal_ref=p_proposal_ref
        AND existing.revision=v_revision
        AND existing.supersedes_proposal_ref IS NOT DISTINCT FROM p_supersedes_proposal_ref
        AND existing.supersedes_version_id IS NOT DISTINCT FROM p_supersedes_version_id
        AND existing.content_hash=p_content_hash
        AND existing.claim_set_hash=p_claim_set_hash
        AND existing.review_hash=p_review_hash
        AND existing.status=p_status
        AND existing.source=v_source
        AND existing.review=v_review) THEN
      RETURN QUERY SELECT 'replay'::pg_catalog.text;
    ELSE
      RETURN QUERY SELECT 'conflict'::pg_catalog.text;
    END IF;
    RETURN;
  END IF;

  INSERT INTO public.business_understanding_versions(
    version_id,tenant_id,workspace_id,proposal_ref,revision,supersedes_proposal_ref,
    supersedes_version_id,content_hash,claim_set_hash,review_hash,status,source,review,
    created_at,updated_at)
  VALUES (p_version_id,p_tenant_id::pg_catalog.uuid,nullif(p_workspace_id,'')::pg_catalog.uuid,
    p_proposal_ref,v_revision,p_supersedes_proposal_ref,p_supersedes_version_id,
    p_content_hash,p_claim_set_hash,p_review_hash,p_status,v_source,v_review,v_created,v_updated);
  RETURN QUERY SELECT 'created'::pg_catalog.text;
END;
$function$;

CREATE OR REPLACE FUNCTION public.novatrade_l04_transition_understanding_review(
  p_tenant_id pg_catalog.text,
  p_workspace_id pg_catalog.text,
  p_version_id pg_catalog.text,
  p_expected_review_hash pg_catalog.text,
  p_to pg_catalog.text,
  p_review_hash pg_catalog.text,
  p_review pg_catalog.text,
  p_event pg_catalog.text,
  p_updated_at pg_catalog.text
)
RETURNS TABLE (kind pg_catalog.text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE
  v_review pg_catalog.jsonb;
  v_event pg_catalog.jsonb;
  v_updated pg_catalog.timestamptz;
  v_current public.business_understanding_versions%ROWTYPE;
  v_sequence pg_catalog.int4;
  v_allowed pg_catalog.text[];
BEGIN
  IF p_version_id IS NULL OR p_version_id !~ '^understanding-version:[a-f0-9]{64}$'
     OR p_expected_review_hash IS NULL OR p_expected_review_hash !~ '^sha256:[a-f0-9]{64}$'
     OR p_review_hash IS NULL OR p_review_hash !~ '^sha256:[a-f0-9]{64}$'
     OR p_to IS NULL OR p_to NOT IN ('in_review','approved','rejected','superseded')
     OR p_updated_at IS NULL THEN
    RETURN;
  END IF;
  BEGIN
    v_review := p_review::pg_catalog.jsonb;
    v_event := p_event::pg_catalog.jsonb;
    v_updated := p_updated_at::pg_catalog.timestamptz;
  EXCEPTION WHEN others THEN
    RETURN;
  END;

  v_allowed := CASE WHEN p_to='in_review'
    THEN ARRAY['owner','admin','strategist_manager','researcher','reviewer']
    ELSE ARRAY['owner','admin','strategist_manager','reviewer'] END;
  IF NOT public.novatrade_l04_member_gate(p_tenant_id,p_workspace_id,v_allowed) THEN
    RETURN;
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('l04:ureview:' || p_version_id, 0));

  SELECT * INTO v_current FROM public.business_understanding_versions
    WHERE version_id=p_version_id
      AND tenant_id=p_tenant_id::pg_catalog.uuid
      AND workspace_id IS NOT DISTINCT FROM nullif(p_workspace_id,'')::pg_catalog.uuid
    FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::pg_catalog.text;
    RETURN;
  END IF;
  IF v_current.review_hash <> p_expected_review_hash THEN
    RETURN QUERY SELECT 'stale'::pg_catalog.text;
    RETURN;
  END IF;
  IF NOT (
    (v_current.status='draft' AND p_to='in_review')
    OR (v_current.status='in_review' AND p_to IN ('approved','rejected'))
    OR (v_current.status='approved' AND p_to='superseded')
  ) THEN
    RETURN QUERY SELECT 'stale'::pg_catalog.text;
    RETURN;
  END IF;

  v_sequence := v_event->>'sequence';
  UPDATE public.business_understanding_versions
    SET status=p_to, review=v_review, review_hash=p_review_hash, updated_at=v_updated
    WHERE version_id=p_version_id;
  INSERT INTO public.business_understanding_review_events(
    tenant_id,workspace_id,version_id,sequence,from_status,to_status,actor,at,reason,
    replacement_version_id,event)
  VALUES (
    v_current.tenant_id,v_current.workspace_id,p_version_id,
    coalesce(v_sequence,1),v_current.status,p_to,
    coalesce(v_event->'actor','null'::pg_catalog.jsonb),
    coalesce((v_event->>'at')::pg_catalog.timestamptz,v_updated),
    coalesce(v_event->>'reason',''),
    v_event->>'replacementVersionId',
    v_event);
  RETURN QUERY SELECT 'updated'::pg_catalog.text;
END;
$function$;

CREATE OR REPLACE FUNCTION public.novatrade_l04_append_question_session(
  p_tenant_id pg_catalog.text,
  p_workspace_id pg_catalog.text,
  p_session_ref pg_catalog.text,
  p_tenant_ref pg_catalog.text,
  p_understanding_version_id pg_catalog.text,
  p_session pg_catalog.text,
  p_session_hash pg_catalog.text,
  p_created_at pg_catalog.text
)
RETURNS TABLE (kind pg_catalog.text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE
  v_session pg_catalog.jsonb;
  v_created pg_catalog.timestamptz;
BEGIN
  IF p_session_ref IS NULL OR p_session_ref !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'
     OR p_tenant_ref IS NULL OR p_tenant_ref !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'
     OR p_understanding_version_id IS NULL
        OR p_understanding_version_id !~ '^understanding-version:[a-f0-9]{64}$'
     OR p_session_hash IS NULL OR p_session_hash !~ '^sha256:[a-f0-9]{64}$'
     OR p_created_at IS NULL THEN
    RETURN;
  END IF;
  BEGIN
    v_session := p_session::pg_catalog.jsonb;
    v_created := p_created_at::pg_catalog.timestamptz;
  EXCEPTION WHEN others THEN
    RETURN;
  END;

  IF NOT public.novatrade_l04_member_gate(p_tenant_id,p_workspace_id,
    ARRAY['owner','admin','strategist_manager','researcher','reviewer']) THEN
    RETURN;
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('l04:qsession:' || p_tenant_id || ':' || coalesce(p_workspace_id,'')
      || ':' || p_session_ref, 0));

  IF EXISTS (SELECT 1 FROM public.adaptive_question_sessions AS existing
    WHERE existing.tenant_id=p_tenant_id::pg_catalog.uuid
      AND existing.workspace_id IS NOT DISTINCT FROM nullif(p_workspace_id,'')::pg_catalog.uuid
      AND existing.session_ref=p_session_ref) THEN
    IF EXISTS (SELECT 1 FROM public.adaptive_question_sessions AS existing
      WHERE existing.tenant_id=p_tenant_id::pg_catalog.uuid
        AND existing.workspace_id IS NOT DISTINCT FROM nullif(p_workspace_id,'')::pg_catalog.uuid
        AND existing.session_ref=p_session_ref
        AND existing.tenant_ref=p_tenant_ref
        AND existing.understanding_version_id=p_understanding_version_id
        AND existing.session=v_session
        AND existing.session_hash=p_session_hash) THEN
      RETURN QUERY SELECT 'replay'::pg_catalog.text;
    ELSE
      RETURN QUERY SELECT 'conflict'::pg_catalog.text;
    END IF;
    RETURN;
  END IF;

  INSERT INTO public.adaptive_question_sessions(
    tenant_id,workspace_id,session_ref,tenant_ref,understanding_version_id,session,session_hash,created_at)
  VALUES (p_tenant_id::pg_catalog.uuid,nullif(p_workspace_id,'')::pg_catalog.uuid,
    p_session_ref,p_tenant_ref,p_understanding_version_id,v_session,p_session_hash,v_created);
  RETURN QUERY SELECT 'created'::pg_catalog.text;
END;
$function$;

CREATE OR REPLACE FUNCTION public.novatrade_l04_append_question_answer(
  p_tenant_id pg_catalog.text,
  p_workspace_id pg_catalog.text,
  p_session_ref pg_catalog.text,
  p_tenant_ref pg_catalog.text,
  p_understanding_version_id pg_catalog.text,
  p_answer_id pg_catalog.text,
  p_question_ref pg_catalog.text,
  p_uncertainty_id pg_catalog.text,
  p_disposition pg_catalog.text,
  p_answer pg_catalog.text,
  p_claim_update pg_catalog.text,
  p_recorded_at pg_catalog.text
)
RETURNS TABLE (kind pg_catalog.text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE
  v_answer pg_catalog.jsonb;
  v_claim_update pg_catalog.jsonb;
  v_recorded pg_catalog.timestamptz;
BEGIN
  IF p_session_ref IS NULL OR p_session_ref !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'
     OR p_tenant_ref IS NULL OR p_tenant_ref !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'
     OR p_understanding_version_id IS NULL
        OR p_understanding_version_id !~ '^understanding-version:[a-f0-9]{64}$'
     OR p_answer_id IS NULL OR p_answer_id !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'
     OR p_question_ref IS NULL OR p_uncertainty_id IS NULL
     OR p_disposition IS NULL
        OR p_disposition NOT IN ('answered','corrected','deferred','unknown')
     OR p_recorded_at IS NULL THEN
    RETURN;
  END IF;
  BEGIN
    v_answer := p_answer::pg_catalog.jsonb;
    v_claim_update := CASE WHEN p_claim_update IS NULL THEN NULL ELSE p_claim_update::pg_catalog.jsonb END;
    v_recorded := p_recorded_at::pg_catalog.timestamptz;
  EXCEPTION WHEN others THEN
    RETURN;
  END;

  IF NOT public.novatrade_l04_member_gate(p_tenant_id,p_workspace_id,
    ARRAY['owner','admin','strategist_manager','researcher','reviewer','outreach_operator']) THEN
    RETURN;
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('l04:qanswer:' || p_tenant_id || ':' || p_session_ref, 0));

  -- The answer must bind to a session in the exact same workspace scope; the
  -- two-column foreign key alone cannot see workspace identity.
  IF NOT EXISTS (SELECT 1 FROM public.adaptive_question_sessions AS session_row
    WHERE session_row.tenant_id=p_tenant_id::pg_catalog.uuid
      AND session_row.session_ref=p_session_ref
      AND session_row.workspace_id IS NOT DISTINCT FROM nullif(p_workspace_id,'')::pg_catalog.uuid
      AND session_row.understanding_version_id=p_understanding_version_id
      AND session_row.tenant_ref=p_tenant_ref) THEN
    RETURN;
  END IF;

  IF EXISTS (SELECT 1 FROM public.adaptive_question_answers AS existing
    WHERE existing.tenant_id=p_tenant_id::pg_catalog.uuid
      AND existing.workspace_id IS NOT DISTINCT FROM nullif(p_workspace_id,'')::pg_catalog.uuid
      AND existing.answer_id=p_answer_id) THEN
    IF EXISTS (SELECT 1 FROM public.adaptive_question_answers AS existing
      WHERE existing.tenant_id=p_tenant_id::pg_catalog.uuid
        AND existing.workspace_id IS NOT DISTINCT FROM nullif(p_workspace_id,'')::pg_catalog.uuid
        AND existing.answer_id=p_answer_id
        AND existing.session_ref=p_session_ref
        AND existing.answer=v_answer
        AND existing.claim_update IS NOT DISTINCT FROM v_claim_update) THEN
      RETURN QUERY SELECT 'appended'::pg_catalog.text;
    ELSE
      RETURN QUERY SELECT 'conflict'::pg_catalog.text;
    END IF;
    RETURN;
  END IF;

  INSERT INTO public.adaptive_question_answers(
    tenant_id,workspace_id,session_ref,tenant_ref,understanding_version_id,answer_id,
    question_ref,uncertainty_id,disposition,answer,claim_update,recorded_at)
  VALUES (p_tenant_id::pg_catalog.uuid,nullif(p_workspace_id,'')::pg_catalog.uuid,
    p_session_ref,p_tenant_ref,p_understanding_version_id,p_answer_id,
    p_question_ref,p_uncertainty_id,p_disposition,v_answer,v_claim_update,v_recorded);
  RETURN QUERY SELECT 'appended'::pg_catalog.text;
END;
$function$;

CREATE OR REPLACE FUNCTION public.novatrade_l04_append_icp_version(
  p_tenant_id pg_catalog.text,
  p_workspace_id pg_catalog.text,
  p_version_id pg_catalog.text,
  p_stable_key pg_catalog.text,
  p_revision pg_catalog.text,
  p_supersedes_version_id pg_catalog.text,
  p_content_hash pg_catalog.text,
  p_understanding_version_id pg_catalog.text,
  p_review_hash pg_catalog.text,
  p_status pg_catalog.text,
  p_source pg_catalog.text,
  p_review pg_catalog.text,
  p_created_at pg_catalog.text,
  p_updated_at pg_catalog.text
)
RETURNS TABLE (kind pg_catalog.text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE
  v_source pg_catalog.jsonb;
  v_review pg_catalog.jsonb;
  v_revision pg_catalog.int4;
  v_created pg_catalog.timestamptz;
  v_updated pg_catalog.timestamptz;
BEGIN
  IF p_version_id IS NULL OR p_version_id !~ '^icp-version:[a-f0-9]{64}$'
     OR p_stable_key IS NULL OR p_stable_key !~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$'
     OR p_revision IS NULL OR p_revision !~ '^[1-9][0-9]{0,5}$'
     OR p_content_hash IS NULL OR p_content_hash !~ '^sha256:[a-f0-9]{64}$'
     OR p_understanding_version_id IS NULL
        OR p_understanding_version_id !~ '^understanding-version:[a-f0-9]{64}$'
     OR p_review_hash IS NULL OR p_review_hash !~ '^sha256:[a-f0-9]{64}$'
     OR p_status IS NULL OR p_status <> 'draft'
     OR (p_supersedes_version_id IS NOT NULL
         AND p_supersedes_version_id !~ '^icp-version:[a-f0-9]{64}$')
     OR p_created_at IS NULL OR p_updated_at IS NULL THEN
    RETURN;
  END IF;
  BEGIN
    v_source := p_source::pg_catalog.jsonb;
    v_review := p_review::pg_catalog.jsonb;
    v_revision := p_revision::pg_catalog.int4;
    v_created := p_created_at::pg_catalog.timestamptz;
    v_updated := p_updated_at::pg_catalog.timestamptz;
  EXCEPTION WHEN others THEN
    RETURN;
  END;
  IF v_revision < 1 OR v_updated < v_created
     OR (v_revision=1 AND p_supersedes_version_id IS NOT NULL)
     OR (v_revision>1 AND p_supersedes_version_id IS NULL) THEN RETURN; END IF;

  IF NOT public.novatrade_l04_member_gate(p_tenant_id,p_workspace_id,
    ARRAY['owner','admin','strategist_manager','researcher','reviewer']) THEN
    RETURN;
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('l04:icp:' || p_version_id, 0));

  IF EXISTS (SELECT 1 FROM public.icp_versions AS existing
    WHERE existing.version_id=p_version_id) THEN
    IF EXISTS (SELECT 1 FROM public.icp_versions AS existing
      WHERE existing.version_id=p_version_id
        AND existing.tenant_id=p_tenant_id::pg_catalog.uuid
        AND existing.workspace_id IS NOT DISTINCT FROM nullif(p_workspace_id,'')::pg_catalog.uuid
        AND existing.stable_key=p_stable_key
        AND existing.revision=v_revision
        AND existing.supersedes_version_id IS NOT DISTINCT FROM p_supersedes_version_id
        AND existing.content_hash=p_content_hash
        AND existing.understanding_version_id=p_understanding_version_id
        AND existing.review_hash=p_review_hash
        AND existing.status=p_status
        AND existing.source=v_source
        AND existing.review=v_review) THEN
      RETURN QUERY SELECT 'replay'::pg_catalog.text;
    ELSE
      RETURN QUERY SELECT 'conflict'::pg_catalog.text;
    END IF;
    RETURN;
  END IF;

  INSERT INTO public.icp_versions(
    version_id,tenant_id,workspace_id,stable_key,revision,supersedes_version_id,
    content_hash,understanding_version_id,review_hash,status,source,review,created_at,updated_at)
  VALUES (p_version_id,p_tenant_id::pg_catalog.uuid,nullif(p_workspace_id,'')::pg_catalog.uuid,
    p_stable_key,v_revision,p_supersedes_version_id,p_content_hash,p_understanding_version_id,
    p_review_hash,p_status,v_source,v_review,v_created,v_updated);
  RETURN QUERY SELECT 'created'::pg_catalog.text;
END;
$function$;

CREATE OR REPLACE FUNCTION public.novatrade_l04_transition_icp_review(
  p_tenant_id pg_catalog.text,
  p_workspace_id pg_catalog.text,
  p_version_id pg_catalog.text,
  p_expected_review_hash pg_catalog.text,
  p_to pg_catalog.text,
  p_review_hash pg_catalog.text,
  p_review pg_catalog.text,
  p_event pg_catalog.text,
  p_updated_at pg_catalog.text
)
RETURNS TABLE (kind pg_catalog.text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE
  v_review pg_catalog.jsonb;
  v_event pg_catalog.jsonb;
  v_updated pg_catalog.timestamptz;
  v_current public.icp_versions%ROWTYPE;
  v_sequence pg_catalog.int4;
  v_allowed pg_catalog.text[];
BEGIN
  IF p_version_id IS NULL OR p_version_id !~ '^icp-version:[a-f0-9]{64}$'
     OR p_expected_review_hash IS NULL OR p_expected_review_hash !~ '^sha256:[a-f0-9]{64}$'
     OR p_review_hash IS NULL OR p_review_hash !~ '^sha256:[a-f0-9]{64}$'
     OR p_to IS NULL OR p_to NOT IN ('in_review','approved','rejected','superseded')
     OR p_updated_at IS NULL THEN
    RETURN;
  END IF;
  BEGIN
    v_review := p_review::pg_catalog.jsonb;
    v_event := p_event::pg_catalog.jsonb;
    v_updated := p_updated_at::pg_catalog.timestamptz;
  EXCEPTION WHEN others THEN
    RETURN;
  END;

  v_allowed := CASE WHEN p_to='in_review'
    THEN ARRAY['owner','admin','strategist_manager','researcher','reviewer']
    ELSE ARRAY['owner','admin','strategist_manager','reviewer'] END;
  IF NOT public.novatrade_l04_member_gate(p_tenant_id,p_workspace_id,v_allowed) THEN
    RETURN;
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('l04:icprev:' || p_version_id, 0));

  SELECT * INTO v_current FROM public.icp_versions
    WHERE version_id=p_version_id
      AND tenant_id=p_tenant_id::pg_catalog.uuid
      AND workspace_id IS NOT DISTINCT FROM nullif(p_workspace_id,'')::pg_catalog.uuid
    FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::pg_catalog.text;
    RETURN;
  END IF;
  IF v_current.review_hash <> p_expected_review_hash
     OR NOT (
       (v_current.status='draft' AND p_to='in_review')
       OR (v_current.status='in_review' AND p_to IN ('approved','rejected'))
       OR (v_current.status='approved' AND p_to='superseded')
     ) THEN
    RETURN QUERY SELECT 'stale'::pg_catalog.text;
    RETURN;
  END IF;

  v_sequence := v_event->>'sequence';
  UPDATE public.icp_versions
    SET status=p_to, review=v_review, review_hash=p_review_hash, updated_at=v_updated
    WHERE version_id=p_version_id;
  INSERT INTO public.icp_review_events(
    tenant_id,workspace_id,version_id,sequence,from_status,to_status,actor,at,reason,
    replacement_version_id,event)
  VALUES (
    v_current.tenant_id,v_current.workspace_id,p_version_id,
    coalesce(v_sequence,1),v_current.status,p_to,
    coalesce(v_event->'actor','null'::pg_catalog.jsonb),
    coalesce((v_event->>'at')::pg_catalog.timestamptz,v_updated),
    coalesce(v_event->>'reason',''),
    v_event->>'replacementVersionId',
    v_event);
  RETURN QUERY SELECT 'updated'::pg_catalog.text;
END;
$function$;

CREATE OR REPLACE FUNCTION public.novatrade_l04_append_lead_play_version(
  p_tenant_id pg_catalog.text,
  p_workspace_id pg_catalog.text,
  p_version_id pg_catalog.text,
  p_stable_key pg_catalog.text,
  p_revision pg_catalog.text,
  p_supersedes_version_id pg_catalog.text,
  p_icp_version_id pg_catalog.text,
  p_understanding_version_id pg_catalog.text,
  p_content_hash pg_catalog.text,
  p_review_hash pg_catalog.text,
  p_status pg_catalog.text,
  p_source pg_catalog.text,
  p_review pg_catalog.text,
  p_created_at pg_catalog.text,
  p_updated_at pg_catalog.text
)
RETURNS TABLE (kind pg_catalog.text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE
  v_source pg_catalog.jsonb;
  v_review pg_catalog.jsonb;
  v_revision pg_catalog.int4;
  v_created pg_catalog.timestamptz;
  v_updated pg_catalog.timestamptz;
BEGIN
  IF p_version_id IS NULL OR p_version_id !~ '^lead-play-version:[a-f0-9]{64}$'
     OR p_stable_key IS NULL OR p_stable_key !~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$'
     OR p_revision IS NULL OR p_revision !~ '^[1-9][0-9]{0,5}$'
     OR p_icp_version_id IS NULL OR p_icp_version_id !~ '^icp-version:[a-f0-9]{64}$'
     OR p_understanding_version_id IS NULL
        OR p_understanding_version_id !~ '^understanding-version:[a-f0-9]{64}$'
     OR p_content_hash IS NULL OR p_content_hash !~ '^sha256:[a-f0-9]{64}$'
     OR p_review_hash IS NULL OR p_review_hash !~ '^sha256:[a-f0-9]{64}$'
     OR p_status IS NULL OR p_status <> 'draft'
     OR (p_supersedes_version_id IS NOT NULL
         AND p_supersedes_version_id !~ '^lead-play-version:[a-f0-9]{64}$')
     OR p_created_at IS NULL OR p_updated_at IS NULL THEN
    RETURN;
  END IF;
  BEGIN
    v_source := p_source::pg_catalog.jsonb;
    v_review := p_review::pg_catalog.jsonb;
    v_revision := p_revision::pg_catalog.int4;
    v_created := p_created_at::pg_catalog.timestamptz;
    v_updated := p_updated_at::pg_catalog.timestamptz;
  EXCEPTION WHEN others THEN
    RETURN;
  END;
  IF v_revision < 1 OR v_updated < v_created
     OR (v_revision=1 AND p_supersedes_version_id IS NOT NULL)
     OR (v_revision>1 AND p_supersedes_version_id IS NULL) THEN RETURN; END IF;

  IF NOT public.novatrade_l04_member_gate(p_tenant_id,p_workspace_id,
    ARRAY['owner','admin','strategist_manager','researcher','reviewer']) THEN
    RETURN;
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('l04:play:' || p_version_id, 0));

  IF EXISTS (SELECT 1 FROM public.lead_play_versions AS existing
    WHERE existing.version_id=p_version_id) THEN
    IF EXISTS (SELECT 1 FROM public.lead_play_versions AS existing
      WHERE existing.version_id=p_version_id
        AND existing.tenant_id=p_tenant_id::pg_catalog.uuid
        AND existing.workspace_id IS NOT DISTINCT FROM nullif(p_workspace_id,'')::pg_catalog.uuid
        AND existing.stable_key=p_stable_key
        AND existing.revision=v_revision
        AND existing.supersedes_version_id IS NOT DISTINCT FROM p_supersedes_version_id
        AND existing.icp_version_id=p_icp_version_id
        AND existing.understanding_version_id=p_understanding_version_id
        AND existing.content_hash=p_content_hash
        AND existing.review_hash=p_review_hash
        AND existing.status=p_status
        AND existing.source=v_source
        AND existing.review=v_review) THEN
      RETURN QUERY SELECT 'replay'::pg_catalog.text;
    ELSE
      RETURN QUERY SELECT 'conflict'::pg_catalog.text;
    END IF;
    RETURN;
  END IF;

  INSERT INTO public.lead_play_versions(
    version_id,tenant_id,workspace_id,stable_key,revision,supersedes_version_id,
    icp_version_id,understanding_version_id,content_hash,review_hash,status,source,review,
    created_at,updated_at)
  VALUES (p_version_id,p_tenant_id::pg_catalog.uuid,nullif(p_workspace_id,'')::pg_catalog.uuid,
    p_stable_key,v_revision,p_supersedes_version_id,p_icp_version_id,p_understanding_version_id,
    p_content_hash,p_review_hash,p_status,v_source,v_review,v_created,v_updated);
  RETURN QUERY SELECT 'created'::pg_catalog.text;
END;
$function$;

CREATE OR REPLACE FUNCTION public.novatrade_l04_transition_lead_play_review(
  p_tenant_id pg_catalog.text,
  p_workspace_id pg_catalog.text,
  p_version_id pg_catalog.text,
  p_expected_review_hash pg_catalog.text,
  p_to pg_catalog.text,
  p_review_hash pg_catalog.text,
  p_review pg_catalog.text,
  p_event pg_catalog.text,
  p_updated_at pg_catalog.text
)
RETURNS TABLE (kind pg_catalog.text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE
  v_review pg_catalog.jsonb;
  v_event pg_catalog.jsonb;
  v_updated pg_catalog.timestamptz;
  v_current public.lead_play_versions%ROWTYPE;
  v_sequence pg_catalog.int4;
  v_allowed pg_catalog.text[];
BEGIN
  IF p_version_id IS NULL OR p_version_id !~ '^lead-play-version:[a-f0-9]{64}$'
     OR p_expected_review_hash IS NULL OR p_expected_review_hash !~ '^sha256:[a-f0-9]{64}$'
     OR p_review_hash IS NULL OR p_review_hash !~ '^sha256:[a-f0-9]{64}$'
     OR p_to IS NULL OR p_to NOT IN ('in_review','approved','rejected','superseded')
     OR p_updated_at IS NULL THEN
    RETURN;
  END IF;
  BEGIN
    v_review := p_review::pg_catalog.jsonb;
    v_event := p_event::pg_catalog.jsonb;
    v_updated := p_updated_at::pg_catalog.timestamptz;
  EXCEPTION WHEN others THEN
    RETURN;
  END;

  v_allowed := CASE WHEN p_to='in_review'
    THEN ARRAY['owner','admin','strategist_manager','researcher','reviewer']
    ELSE ARRAY['owner','admin','strategist_manager','reviewer'] END;
  IF NOT public.novatrade_l04_member_gate(p_tenant_id,p_workspace_id,v_allowed) THEN
    RETURN;
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('l04:playrev:' || p_version_id, 0));

  SELECT * INTO v_current FROM public.lead_play_versions
    WHERE version_id=p_version_id
      AND tenant_id=p_tenant_id::pg_catalog.uuid
      AND workspace_id IS NOT DISTINCT FROM nullif(p_workspace_id,'')::pg_catalog.uuid
    FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::pg_catalog.text;
    RETURN;
  END IF;
  IF v_current.review_hash <> p_expected_review_hash
     OR NOT (
       (v_current.status='draft' AND p_to='in_review')
       OR (v_current.status='in_review' AND p_to IN ('approved','rejected'))
       OR (v_current.status='approved' AND p_to='superseded')
     ) THEN
    RETURN QUERY SELECT 'stale'::pg_catalog.text;
    RETURN;
  END IF;

  v_sequence := v_event->>'sequence';
  UPDATE public.lead_play_versions
    SET status=p_to, review=v_review, review_hash=p_review_hash, updated_at=v_updated
    WHERE version_id=p_version_id;
  INSERT INTO public.lead_play_review_events(
    tenant_id,workspace_id,version_id,sequence,from_status,to_status,actor,at,reason,
    replacement_version_id,event)
  VALUES (
    v_current.tenant_id,v_current.workspace_id,p_version_id,
    coalesce(v_sequence,1),v_current.status,p_to,
    coalesce(v_event->'actor','null'::pg_catalog.jsonb),
    coalesce((v_event->>'at')::pg_catalog.timestamptz,v_updated),
    coalesce(v_event->>'reason',''),
    v_event->>'replacementVersionId',
    v_event);
  RETURN QUERY SELECT 'updated'::pg_catalog.text;
END;
$function$;

CREATE OR REPLACE FUNCTION public.novatrade_l04_append_lead_play_simulation(
  p_tenant_id pg_catalog.text,
  p_workspace_id pg_catalog.text,
  p_simulation_id pg_catalog.text,
  p_play_version_id pg_catalog.text,
  p_play_review_hash pg_catalog.text,
  p_simulation_hash pg_catalog.text,
  p_input pg_catalog.text,
  p_simulation pg_catalog.text,
  p_created_at pg_catalog.text
)
RETURNS TABLE (kind pg_catalog.text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE
  v_input pg_catalog.jsonb;
  v_simulation pg_catalog.jsonb;
  v_created pg_catalog.timestamptz;
BEGIN
  IF p_simulation_id IS NULL OR p_simulation_id !~ '^lead-play-simulation:[a-f0-9]{64}$'
     OR p_play_version_id IS NULL OR p_play_version_id !~ '^lead-play-version:[a-f0-9]{64}$'
     OR p_play_review_hash IS NULL OR p_play_review_hash !~ '^sha256:[a-f0-9]{64}$'
     OR p_simulation_hash IS NULL OR p_simulation_hash !~ '^sha256:[a-f0-9]{64}$'
     OR p_created_at IS NULL THEN
    RETURN;
  END IF;
  BEGIN
    v_input := p_input::pg_catalog.jsonb;
    v_simulation := p_simulation::pg_catalog.jsonb;
    v_created := p_created_at::pg_catalog.timestamptz;
  EXCEPTION WHEN others THEN
    RETURN;
  END;

  IF NOT public.novatrade_l04_member_gate(p_tenant_id,p_workspace_id,
    ARRAY['owner','admin','strategist_manager','researcher','reviewer']) THEN
    RETURN;
  END IF;

  IF EXISTS (SELECT 1 FROM public.lead_play_simulations AS existing
    WHERE existing.simulation_id=p_simulation_id) THEN
    IF EXISTS (SELECT 1 FROM public.lead_play_simulations AS existing
      WHERE existing.simulation_id=p_simulation_id
        AND existing.tenant_id=p_tenant_id::pg_catalog.uuid
        AND existing.workspace_id IS NOT DISTINCT FROM nullif(p_workspace_id,'')::pg_catalog.uuid
        AND existing.play_version_id=p_play_version_id
        AND existing.play_review_hash=p_play_review_hash
        AND existing.simulation_hash=p_simulation_hash
        AND existing.input=v_input
        AND existing.simulation=v_simulation) THEN
      RETURN QUERY SELECT 'replay'::pg_catalog.text;
    ELSE
      RETURN QUERY SELECT 'conflict'::pg_catalog.text;
    END IF;
    RETURN;
  END IF;

  INSERT INTO public.lead_play_simulations(
    simulation_id,tenant_id,workspace_id,play_version_id,play_review_hash,simulation_hash,
    input,simulation,created_at)
  VALUES (p_simulation_id,p_tenant_id::pg_catalog.uuid,nullif(p_workspace_id,'')::pg_catalog.uuid,
    p_play_version_id,p_play_review_hash,p_simulation_hash,v_input,v_simulation,v_created);
  RETURN QUERY SELECT 'created'::pg_catalog.text;
END;
$function$;

CREATE OR REPLACE FUNCTION public.novatrade_l04_append_lead_play_simulation_review(
  p_tenant_id pg_catalog.text,
  p_workspace_id pg_catalog.text,
  p_play_version_id pg_catalog.text,
  p_simulation_id pg_catalog.text,
  p_eligibility_hash pg_catalog.text,
  p_decision pg_catalog.text,
  p_review pg_catalog.text,
  p_created_at pg_catalog.text
)
RETURNS TABLE (kind pg_catalog.text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE
  v_review pg_catalog.jsonb;
  v_created pg_catalog.timestamptz;
BEGIN
  IF p_play_version_id IS NULL OR p_play_version_id !~ '^lead-play-version:[a-f0-9]{64}$'
     OR p_simulation_id IS NULL OR p_simulation_id !~ '^lead-play-simulation:[a-f0-9]{64}$'
     OR p_eligibility_hash IS NULL OR p_eligibility_hash !~ '^sha256:[a-f0-9]{64}$'
     OR p_decision IS NULL OR p_decision NOT IN ('eligible','ineligible')
     OR p_created_at IS NULL THEN
    RETURN;
  END IF;
  BEGIN
    v_review := p_review::pg_catalog.jsonb;
    v_created := p_created_at::pg_catalog.timestamptz;
  EXCEPTION WHEN others THEN
    RETURN;
  END;

  IF NOT public.novatrade_l04_member_gate(p_tenant_id,p_workspace_id,
    ARRAY['owner','admin','strategist_manager','reviewer']) THEN
    RETURN;
  END IF;

  IF EXISTS (SELECT 1 FROM public.lead_play_simulation_reviews AS existing
    WHERE existing.play_version_id=p_play_version_id
      AND existing.simulation_id=p_simulation_id
      AND existing.eligibility_hash=p_eligibility_hash) THEN
    IF EXISTS (SELECT 1 FROM public.lead_play_simulation_reviews AS existing
      WHERE existing.play_version_id=p_play_version_id
        AND existing.simulation_id=p_simulation_id
        AND existing.eligibility_hash=p_eligibility_hash
        AND existing.tenant_id=p_tenant_id::pg_catalog.uuid
        AND existing.workspace_id IS NOT DISTINCT FROM nullif(p_workspace_id,'')::pg_catalog.uuid
        AND existing.decision=p_decision
        AND existing.review=v_review) THEN
      RETURN QUERY SELECT 'replay'::pg_catalog.text;
    ELSE
      RETURN QUERY SELECT 'conflict'::pg_catalog.text;
    END IF;
    RETURN;
  END IF;

  INSERT INTO public.lead_play_simulation_reviews(
    tenant_id,workspace_id,play_version_id,simulation_id,eligibility_hash,decision,review,created_at)
  VALUES (p_tenant_id::pg_catalog.uuid,nullif(p_workspace_id,'')::pg_catalog.uuid,
    p_play_version_id,p_simulation_id,p_eligibility_hash,p_decision,v_review,v_created);
  RETURN QUERY SELECT 'created'::pg_catalog.text;
END;
$function$;

CREATE OR REPLACE FUNCTION public.novatrade_l04_append_activation_state(
  p_tenant_id pg_catalog.text,
  p_workspace_id pg_catalog.text,
  p_stable_key pg_catalog.text,
  p_state_hash pg_catalog.text,
  p_state pg_catalog.text,
  p_created_at pg_catalog.text
)
RETURNS TABLE (kind pg_catalog.text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE
  v_state pg_catalog.jsonb;
  v_created pg_catalog.timestamptz;
BEGIN
  IF p_stable_key IS NULL OR p_stable_key !~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$'
     OR p_state_hash IS NULL OR p_state_hash !~ '^sha256:[a-f0-9]{64}$'
     OR p_created_at IS NULL THEN
    RETURN;
  END IF;
  BEGIN
    v_state := p_state::pg_catalog.jsonb;
    v_created := p_created_at::pg_catalog.timestamptz;
  EXCEPTION WHEN others THEN
    RETURN;
  END;

  IF NOT public.novatrade_l04_member_gate(p_tenant_id,p_workspace_id,
    ARRAY['owner','admin','strategist_manager','reviewer']) THEN
    RETURN;
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('l04:activation:' || p_tenant_id || ':'
      || coalesce(p_workspace_id,'') || ':' || p_stable_key, 0));

  INSERT INTO public.lead_play_activation_states(
    tenant_id,workspace_id,stable_key,state_hash,state,created_at,updated_at)
  VALUES (p_tenant_id::pg_catalog.uuid,nullif(p_workspace_id,'')::pg_catalog.uuid,
    p_stable_key,p_state_hash,v_state,v_created,v_created)
  ON CONFLICT DO NOTHING;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'conflict'::pg_catalog.text;
    RETURN;
  END IF;
  RETURN QUERY SELECT 'created'::pg_catalog.text;
END;
$function$;

CREATE OR REPLACE FUNCTION public.novatrade_l04_transition_activation_state(
  p_tenant_id pg_catalog.text,
  p_workspace_id pg_catalog.text,
  p_stable_key pg_catalog.text,
  p_expected_state_hash pg_catalog.text,
  p_state_hash pg_catalog.text,
  p_state pg_catalog.text,
  p_updated_at pg_catalog.text
)
RETURNS TABLE (kind pg_catalog.text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE
  v_state pg_catalog.jsonb;
  v_updated pg_catalog.timestamptz;
  v_current public.lead_play_activation_states%ROWTYPE;
BEGIN
  IF p_stable_key IS NULL OR p_stable_key !~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$'
     OR p_expected_state_hash IS NULL OR p_expected_state_hash !~ '^sha256:[a-f0-9]{64}$'
     OR p_state_hash IS NULL OR p_state_hash !~ '^sha256:[a-f0-9]{64}$'
     OR p_updated_at IS NULL THEN
    RETURN;
  END IF;
  BEGIN
    v_state := p_state::pg_catalog.jsonb;
    v_updated := p_updated_at::pg_catalog.timestamptz;
  EXCEPTION WHEN others THEN
    RETURN;
  END;

  IF NOT public.novatrade_l04_member_gate(p_tenant_id,p_workspace_id,
    ARRAY['owner','admin','strategist_manager','reviewer']) THEN
    RETURN;
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('l04:activation:' || p_tenant_id || ':'
      || coalesce(p_workspace_id,'') || ':' || p_stable_key, 0));

  SELECT * INTO v_current FROM public.lead_play_activation_states
    WHERE tenant_id=p_tenant_id::pg_catalog.uuid
      AND workspace_id IS NOT DISTINCT FROM nullif(p_workspace_id,'')::pg_catalog.uuid
      AND stable_key=p_stable_key
    FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::pg_catalog.text;
    RETURN;
  END IF;
  IF v_current.state_hash <> p_expected_state_hash THEN
    RETURN QUERY SELECT 'stale'::pg_catalog.text;
    RETURN;
  END IF;

  UPDATE public.lead_play_activation_states
    SET state=v_state, state_hash=p_state_hash, updated_at=v_updated
    WHERE id=v_current.id;
  RETURN QUERY SELECT 'updated'::pg_catalog.text;
END;
$function$;

-- ---------------------------------------------------------------------------
-- RLS + grants
-- ---------------------------------------------------------------------------

DO $security$
DECLARE t text; f text;
BEGIN
  FOREACH t IN ARRAY ARRAY['business_understanding_versions','business_understanding_review_events',
    'adaptive_question_sessions','adaptive_question_answers','icp_versions','icp_review_events',
    'lead_play_versions','lead_play_review_events','lead_play_simulations',
    'lead_play_simulation_reviews','lead_play_activation_states'] LOOP
    EXECUTE pg_catalog.format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE pg_catalog.format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
    EXECUTE pg_catalog.format('REVOKE ALL ON TABLE public.%I FROM PUBLIC',t);
    IF pg_catalog.to_regrole('anon') IS NOT NULL THEN EXECUTE pg_catalog.format('REVOKE ALL ON TABLE public.%I FROM anon',t); END IF;
    IF pg_catalog.to_regrole('authenticated') IS NOT NULL THEN EXECUTE pg_catalog.format('REVOKE ALL ON TABLE public.%I FROM authenticated',t); END IF;

    EXECUTE pg_catalog.format(
      'CREATE POLICY l04_%I_member_select ON public.%I FOR SELECT TO PUBLIC USING (
        public.novatrade_rls_member_context()
        AND tenant_id::text = pg_catalog.current_setting(''app.tenant_id'', true)
        AND (
          coalesce(pg_catalog.current_setting(''app.workspace_id'', true), '''') = ''''
          OR workspace_id IS NULL
          OR workspace_id::text = pg_catalog.current_setting(''app.workspace_id'', true)
        )
      )', t, t);
    EXECUTE pg_catalog.format(
      'CREATE POLICY l04_%I_deny_mutations ON public.%I FOR ALL TO PUBLIC USING (false) WITH CHECK (false)', t, t);
  END LOOP;

  FOREACH f IN ARRAY ARRAY['novatrade_l04_append_only','novatrade_l04_review_version_guard',
    'novatrade_l04_understanding_guard','novatrade_l04_activation_state_guard',
    'novatrade_l04_member_gate','novatrade_l04_append_understanding_version',
    'novatrade_l04_transition_understanding_review','novatrade_l04_append_question_session',
    'novatrade_l04_append_question_answer','novatrade_l04_append_icp_version',
    'novatrade_l04_transition_icp_review','novatrade_l04_append_lead_play_version',
    'novatrade_l04_transition_lead_play_review','novatrade_l04_append_lead_play_simulation',
    'novatrade_l04_append_lead_play_simulation_review','novatrade_l04_append_activation_state',
    'novatrade_l04_transition_activation_state'] LOOP
    EXECUTE pg_catalog.format(
      'REVOKE ALL ON FUNCTION public.%I FROM PUBLIC', f);
    IF pg_catalog.to_regrole('anon') IS NOT NULL THEN
      EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION public.%I FROM anon', f);
    END IF;
    IF pg_catalog.to_regrole('authenticated') IS NOT NULL THEN
      EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION public.%I FROM authenticated', f);
    END IF;
  END LOOP;
END;
$security$;

-- Concentrate all write authority in the definer role; the definer functions
-- above re-verify member context, scope, and integrity on every call.
ALTER FUNCTION public.novatrade_l04_member_gate(pg_catalog.text,pg_catalog.text,pg_catalog.text[])
  OWNER TO novatrade_l04_strategy_definer;
ALTER FUNCTION public.novatrade_l04_append_understanding_version(pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text)
  OWNER TO novatrade_l04_strategy_definer;
ALTER FUNCTION public.novatrade_l04_transition_understanding_review(pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text)
  OWNER TO novatrade_l04_strategy_definer;
ALTER FUNCTION public.novatrade_l04_append_question_session(pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text)
  OWNER TO novatrade_l04_strategy_definer;
ALTER FUNCTION public.novatrade_l04_append_question_answer(pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text)
  OWNER TO novatrade_l04_strategy_definer;
ALTER FUNCTION public.novatrade_l04_append_icp_version(pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text)
  OWNER TO novatrade_l04_strategy_definer;
ALTER FUNCTION public.novatrade_l04_transition_icp_review(pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text)
  OWNER TO novatrade_l04_strategy_definer;
ALTER FUNCTION public.novatrade_l04_append_lead_play_version(pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text)
  OWNER TO novatrade_l04_strategy_definer;
ALTER FUNCTION public.novatrade_l04_transition_lead_play_review(pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text)
  OWNER TO novatrade_l04_strategy_definer;
ALTER FUNCTION public.novatrade_l04_append_lead_play_simulation(pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text)
  OWNER TO novatrade_l04_strategy_definer;
ALTER FUNCTION public.novatrade_l04_append_lead_play_simulation_review(pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text)
  OWNER TO novatrade_l04_strategy_definer;
ALTER FUNCTION public.novatrade_l04_append_activation_state(pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text)
  OWNER TO novatrade_l04_strategy_definer;
ALTER FUNCTION public.novatrade_l04_transition_activation_state(pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text)
  OWNER TO novatrade_l04_strategy_definer;

GRANT USAGE ON SCHEMA public TO novatrade_l04_strategy_definer;
GRANT SELECT ON TABLE public.tenants,public.workspaces,public.tenant_memberships,public.tenant_role_bindings
  TO novatrade_l04_strategy_definer;
GRANT SELECT,INSERT,UPDATE ON TABLE public.business_understanding_versions TO novatrade_l04_strategy_definer;
GRANT SELECT,INSERT ON TABLE public.business_understanding_review_events TO novatrade_l04_strategy_definer;
GRANT SELECT,INSERT ON TABLE public.adaptive_question_sessions TO novatrade_l04_strategy_definer;
GRANT SELECT,INSERT ON TABLE public.adaptive_question_answers TO novatrade_l04_strategy_definer;
GRANT SELECT,INSERT,UPDATE ON TABLE public.icp_versions TO novatrade_l04_strategy_definer;
GRANT SELECT,INSERT ON TABLE public.icp_review_events TO novatrade_l04_strategy_definer;
GRANT SELECT,INSERT,UPDATE ON TABLE public.lead_play_versions TO novatrade_l04_strategy_definer;
GRANT SELECT,INSERT ON TABLE public.lead_play_review_events TO novatrade_l04_strategy_definer;
GRANT SELECT,INSERT ON TABLE public.lead_play_simulations TO novatrade_l04_strategy_definer;
GRANT SELECT,INSERT ON TABLE public.lead_play_simulation_reviews TO novatrade_l04_strategy_definer;
GRANT SELECT,INSERT,UPDATE ON TABLE public.lead_play_activation_states TO novatrade_l04_strategy_definer;
GRANT USAGE ON SEQUENCE public.business_understanding_review_events_id_seq,
  public.adaptive_question_sessions_id_seq,public.adaptive_question_answers_id_seq,
  public.icp_review_events_id_seq,public.lead_play_review_events_id_seq,
  public.lead_play_simulation_reviews_id_seq,public.lead_play_activation_states_id_seq
  TO novatrade_l04_strategy_definer;

COMMENT ON FUNCTION public.novatrade_l04_member_gate(pg_catalog.text,pg_catalog.text,pg_catalog.text[]) IS
  'L-04 shared member gate: complete member GUC context plus durable binding whose role is in the supplied D-002 capable set.';
COMMENT ON FUNCTION public.novatrade_l04_append_understanding_version(pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text) IS
  'L-04 default-denied understanding version append; identical replay returns replay and divergent reuse returns conflict without mutating.';
COMMENT ON FUNCTION public.novatrade_l04_transition_activation_state(pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text) IS
  'L-04 expected-state-hash CAS for lead-play activation/rollback; stale hashes mutate nothing.';

COMMIT;
