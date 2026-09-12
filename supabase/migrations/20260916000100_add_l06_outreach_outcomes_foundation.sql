-- L-06 cited outreach, suppression, outcomes, and learning proposals.
--
-- Persists the immutable version documents produced by src/lib/outreach,
-- src/lib/outcomes, src/lib/learning, and src/lib/suppressions. Handoff
-- attempts record copy/export release decisions only; no column, payload
-- branch, or constraint admits delivery, provider, or send state. Indexed
-- columns are projections of hash-verified payloads and must match them
-- exactly.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';
SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtext('novatrade:l06:outreach-outcomes')
);

/* ---------- outreach drafts ---------- */

CREATE TABLE IF NOT EXISTS public.outreach_draft_versions (
  version_id text CONSTRAINT outreach_draft_versions_pkey PRIMARY KEY,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  account_id uuid NOT NULL CONSTRAINT outreach_draft_versions_account_fkey
    REFERENCES public.canonical_accounts (account_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  stable_key text NOT NULL,
  revision integer NOT NULL,
  supersedes_version_id text CONSTRAINT outreach_draft_versions_supersedes_fkey
    REFERENCES public.outreach_draft_versions (version_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  draft_kind text NOT NULL,
  play_version_id text CONSTRAINT outreach_draft_versions_play_fkey
    REFERENCES public.lead_play_versions (version_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  contact_version_id text CONSTRAINT outreach_draft_versions_contact_fkey
    REFERENCES public.contact_record_versions (version_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  agent_run_id text CONSTRAINT outreach_draft_versions_run_fkey
    REFERENCES public.agent_runs (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  agent_result_ref text,
  created_by uuid NOT NULL,
  review_status text NOT NULL,
  content_sha256 text NOT NULL,
  validation_sha256 text NOT NULL,
  evidence_sha256 text NOT NULL,
  version_sha256 text NOT NULL,
  review_sha256 text NOT NULL,
  payload jsonb NOT NULL,
  evidence_payload jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  CONSTRAINT outreach_draft_versions_tenant_workspace_fkey
    FOREIGN KEY (tenant_id, workspace_id) REFERENCES public.workspaces (tenant_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT outreach_draft_versions_account_scope_fkey
    FOREIGN KEY (tenant_id, workspace_id, account_id)
    REFERENCES public.canonical_accounts (tenant_id, workspace_id, account_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT outreach_draft_versions_revision_unique
    UNIQUE (tenant_id, workspace_id, account_id, stable_key, revision),
  CONSTRAINT outreach_draft_versions_id_format_chk
    CHECK (version_id ~ '^outreach-draft-version:[0-9a-f]{64}$'),
  CONSTRAINT outreach_draft_versions_revision_chk CHECK (
    revision > 0
    AND ((revision = 1 AND supersedes_version_id IS NULL)
      OR (revision > 1 AND supersedes_version_id IS NOT NULL))
  ),
  CONSTRAINT outreach_draft_versions_kind_chk
    CHECK (draft_kind IN ('initial', 'follow_up', 'call_brief', 'objection')),
  CONSTRAINT outreach_draft_versions_review_chk
    CHECK (review_status IN ('draft', 'in_review', 'approved', 'rejected')),
  CONSTRAINT outreach_draft_versions_hashes_chk CHECK (
    content_sha256 ~ '^[0-9a-f]{64}$'
    AND validation_sha256 ~ '^[0-9a-f]{64}$'
    AND evidence_sha256 ~ '^[0-9a-f]{64}$'
    AND version_sha256 ~ '^[0-9a-f]{64}$'
    AND review_sha256 ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT outreach_draft_versions_payload_chk CHECK (
    pg_catalog.jsonb_typeof(payload) = 'object'
    AND pg_catalog.jsonb_typeof(evidence_payload) = 'object'
    AND payload->>'versionId' = version_id
    AND payload->>'tenantId' = tenant_id::text
    AND payload->>'workspaceId' = workspace_id::text
    AND payload->>'accountId' = account_id::text
    AND payload->>'stableKey' = stable_key
    AND (payload->>'revision')::numeric = revision
    AND coalesce(payload->>'supersedesVersionId', '') = coalesce(supersedes_version_id, '')
    AND payload->'review'->>'status' = review_status
    AND payload->>'contentHash' = 'sha256:' || content_sha256
    AND payload->>'validationHash' = 'sha256:' || validation_sha256
    AND payload->>'evidenceDigest' = 'sha256:' || evidence_sha256
    AND payload->>'versionHash' = 'sha256:' || version_sha256
    AND payload->'review'->>'reviewHash' = 'sha256:' || review_sha256
    AND payload->>'createdAt'
      = pg_catalog.to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  )
);
CREATE INDEX IF NOT EXISTS idx_outreach_draft_versions_scope
  ON public.outreach_draft_versions
  (tenant_id, workspace_id, account_id, stable_key, revision DESC);
CREATE INDEX IF NOT EXISTS idx_outreach_draft_versions_review
  ON public.outreach_draft_versions (tenant_id, workspace_id, review_status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_outreach_draft_versions_run
  ON public.outreach_draft_versions (tenant_id, agent_run_id);

/* ---------- outreach current-state projection ---------- */

CREATE TABLE IF NOT EXISTS public.outreach_draft_current (
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  account_id uuid NOT NULL,
  stable_key text NOT NULL,
  state_sha256 text NOT NULL,
  payload jsonb NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT outreach_draft_current_pkey
    PRIMARY KEY (tenant_id, workspace_id, account_id, stable_key),
  CONSTRAINT outreach_draft_current_tenant_workspace_fkey
    FOREIGN KEY (tenant_id, workspace_id) REFERENCES public.workspaces (tenant_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT outreach_draft_current_account_scope_fkey
    FOREIGN KEY (tenant_id, workspace_id, account_id)
    REFERENCES public.canonical_accounts (tenant_id, workspace_id, account_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT outreach_draft_current_hash_chk
    CHECK (state_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT outreach_draft_current_payload_chk CHECK (
    pg_catalog.jsonb_typeof(payload) = 'object'
    AND payload->>'tenantId' = tenant_id::text
    AND payload->>'workspaceId' = workspace_id::text
    AND payload->>'accountId' = account_id::text
    AND payload->>'stableKey' = stable_key
    AND payload->>'stateHash' = 'sha256:' || state_sha256
  )
);

/* ---------- copy/export handoff attempts (no send path) ---------- */

CREATE TABLE IF NOT EXISTS public.outreach_handoff_attempts (
  attempt_id text CONSTRAINT outreach_handoff_attempts_pkey PRIMARY KEY,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  account_id uuid NOT NULL CONSTRAINT outreach_handoff_attempts_account_fkey
    REFERENCES public.canonical_accounts (account_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  stable_key text NOT NULL,
  draft_version_id text NOT NULL CONSTRAINT outreach_handoff_attempts_draft_fkey
    REFERENCES public.outreach_draft_versions (version_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  action text NOT NULL,
  status text NOT NULL,
  block_code text,
  contact_version_id text CONSTRAINT outreach_handoff_attempts_contact_fkey
    REFERENCES public.contact_record_versions (version_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  contact_stable_key text,
  idempotency_key text NOT NULL,
  input_sha256 text NOT NULL,
  actor_id uuid NOT NULL,
  decided_at timestamptz NOT NULL,
  completed_at timestamptz,
  planned_at timestamptz NOT NULL,
  recipient_local_day text,
  payload jsonb NOT NULL,
  CONSTRAINT outreach_handoff_attempts_tenant_workspace_fkey
    FOREIGN KEY (tenant_id, workspace_id) REFERENCES public.workspaces (tenant_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT outreach_handoff_attempts_account_scope_fkey
    FOREIGN KEY (tenant_id, workspace_id, account_id)
    REFERENCES public.canonical_accounts (tenant_id, workspace_id, account_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT outreach_handoff_attempts_idempotency_unique
    UNIQUE (tenant_id, workspace_id, account_id, idempotency_key),
  CONSTRAINT outreach_handoff_attempts_id_format_chk
    CHECK (attempt_id ~ '^(attempt|outreach-export-receipt):[0-9a-f]{64}$'),
  CONSTRAINT outreach_handoff_attempts_action_chk
    CHECK (action IN ('copy', 'export')),
  CONSTRAINT outreach_handoff_attempts_status_chk
    CHECK (status IN ('blocked', 'released')),
  CONSTRAINT outreach_handoff_attempts_block_chk CHECK (
    (status = 'blocked' AND block_code IS NOT NULL AND completed_at IS NULL)
    OR (status = 'released' AND block_code IS NULL AND completed_at IS NOT NULL)
  ),
  CONSTRAINT outreach_handoff_attempts_hash_chk
    CHECK (input_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT outreach_handoff_attempts_day_chk CHECK (
    recipient_local_day IS NULL OR recipient_local_day ~ '^\d{4}-\d{2}-\d{2}$'
  ),
  CONSTRAINT outreach_handoff_attempts_payload_chk CHECK (
    pg_catalog.jsonb_typeof(payload) = 'object'
    AND payload->>'status' = status
    AND coalesce(payload->>'blockCode', '') = coalesce(block_code, '')
    AND (
      (status = 'released'
        AND pg_catalog.jsonb_typeof(payload->'receipt') = 'object'
        AND pg_catalog.jsonb_typeof(payload->'decision') = 'object'
        AND payload->'receipt'->>'receiptId' = attempt_id
        AND payload->'receipt'->>'action' = action
        AND payload->'receipt'->>'idempotencyKey' = idempotency_key
        AND payload->'decision'->>'result' = 'allow')
      OR (status = 'blocked'
        AND (payload->'receipt' IS NULL OR payload->'receipt' = 'null'::jsonb))
    )
  )
);
CREATE INDEX IF NOT EXISTS idx_outreach_handoff_scope
  ON public.outreach_handoff_attempts
  (tenant_id, workspace_id, account_id, stable_key, decided_at);
CREATE INDEX IF NOT EXISTS idx_outreach_handoff_contact_day
  ON public.outreach_handoff_attempts
  (tenant_id, workspace_id, account_id, contact_stable_key, recipient_local_day)
  WHERE status = 'released';

/* ---------- outcome records ---------- */

CREATE TABLE IF NOT EXISTS public.outcome_record_versions (
  version_id text CONSTRAINT outcome_record_versions_pkey PRIMARY KEY,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  account_id uuid NOT NULL CONSTRAINT outcome_record_versions_account_fkey
    REFERENCES public.canonical_accounts (account_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  play_version_id text NOT NULL CONSTRAINT outcome_record_versions_play_fkey
    REFERENCES public.lead_play_versions (version_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  stable_key text NOT NULL,
  revision integer NOT NULL,
  supersedes_version_id text CONSTRAINT outcome_record_versions_supersedes_fkey
    REFERENCES public.outcome_record_versions (version_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  outcome text NOT NULL,
  channel text NOT NULL,
  bounce_classification text,
  draft_version_id text CONSTRAINT outcome_record_versions_draft_fkey
    REFERENCES public.outreach_draft_versions (version_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  source_kind text NOT NULL,
  recorded_by uuid NOT NULL,
  occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL,
  content_sha256 text NOT NULL,
  version_sha256 text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  CONSTRAINT outcome_record_versions_tenant_workspace_fkey
    FOREIGN KEY (tenant_id, workspace_id) REFERENCES public.workspaces (tenant_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT outcome_record_versions_account_scope_fkey
    FOREIGN KEY (tenant_id, workspace_id, account_id)
    REFERENCES public.canonical_accounts (tenant_id, workspace_id, account_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT outcome_record_versions_revision_unique
    UNIQUE (tenant_id, workspace_id, account_id, play_version_id, stable_key, revision),
  CONSTRAINT outcome_record_versions_id_format_chk
    CHECK (version_id ~ '^outcome-version:[0-9a-f]{64}$'),
  CONSTRAINT outcome_record_versions_revision_chk CHECK (
    revision > 0
    AND ((revision = 1 AND supersedes_version_id IS NULL)
      OR (revision > 1 AND supersedes_version_id IS NOT NULL))
  ),
  CONSTRAINT outcome_record_versions_outcome_chk CHECK (outcome IN (
    'copied', 'exported', 'sent_manually', 'delivery_unknown', 'bounced',
    'unknown_bounce', 'opted_out', 'complaint', 'replied', 'meeting_set',
    'opportunity', 'won', 'lost', 'not_interested', 'disqualified', 'unknown'
  )),
  CONSTRAINT outcome_record_versions_channel_chk
    CHECK (channel IN ('email', 'phone', 'sms', 'social', 'in_person', 'other', 'none')),
  CONSTRAINT outcome_record_versions_bounce_chk CHECK (
    bounce_classification IS NULL
    OR bounce_classification IN ('hard_bounce', 'soft_bounce', 'unknown_bounce')
  ),
  CONSTRAINT outcome_record_versions_source_chk
    CHECK (source_kind IN ('member_observation', 'approved_import')),
  CONSTRAINT outcome_record_versions_hashes_chk CHECK (
    content_sha256 ~ '^[0-9a-f]{64}$' AND version_sha256 ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT outcome_record_versions_chronology_chk
    CHECK (occurred_at <= recorded_at AND recorded_at <= created_at),
  CONSTRAINT outcome_record_versions_payload_chk CHECK (
    pg_catalog.jsonb_typeof(payload) = 'object'
    AND payload->>'versionId' = version_id
    AND payload->>'tenantId' = tenant_id::text
    AND payload->>'workspaceId' = workspace_id::text
    AND payload->>'accountId' = account_id::text
    AND payload->>'playVersionId' = play_version_id
    AND payload->>'stableKey' = stable_key
    AND (payload->>'revision')::numeric = revision
    AND coalesce(payload->>'supersedesVersionId', '') = coalesce(supersedes_version_id, '')
    AND payload->>'outcome' = outcome
    AND payload->>'channel' = channel
    AND coalesce(payload->>'bounceClassification', '') = coalesce(bounce_classification, '')
    AND coalesce(payload->'outreachDraftVersionRef'->>'versionId', '')
      = coalesce(draft_version_id, '')
    AND payload->'source'->>'kind' = source_kind
    AND payload->'recordedBy'->>'actorId' = recorded_by::text
    AND payload->>'occurredAt'
      = pg_catalog.to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    AND payload->>'recordedAt'
      = pg_catalog.to_char(recorded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    AND payload->>'contentHash' = 'sha256:' || content_sha256
    AND payload->>'versionHash' = 'sha256:' || version_sha256
  )
);
CREATE INDEX IF NOT EXISTS idx_outcome_record_versions_scope
  ON public.outcome_record_versions
  (tenant_id, workspace_id, account_id, play_version_id, stable_key, revision DESC);
CREATE INDEX IF NOT EXISTS idx_outcome_record_versions_outcome
  ON public.outcome_record_versions (tenant_id, workspace_id, outcome, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_outcome_record_versions_draft
  ON public.outcome_record_versions (tenant_id, workspace_id, draft_version_id)
  WHERE draft_version_id IS NOT NULL;

/* ---------- suppression records (append-only, protective) ---------- */

CREATE TABLE IF NOT EXISTS public.suppression_records (
  record_id text CONSTRAINT suppression_records_pkey PRIMARY KEY,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  account_id uuid CONSTRAINT suppression_records_account_fkey
    REFERENCES public.canonical_accounts (account_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  contact_stable_key text,
  disposition text NOT NULL,
  reason text NOT NULL,
  source_kind text NOT NULL,
  outcome_version_id text CONSTRAINT suppression_records_outcome_fkey
    REFERENCES public.outcome_record_versions (version_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  actor_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL,
  payload jsonb NOT NULL,
  record_sha256 text NOT NULL,
  CONSTRAINT suppression_records_tenant_workspace_fkey
    FOREIGN KEY (tenant_id, workspace_id) REFERENCES public.workspaces (tenant_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT suppression_records_id_format_chk
    CHECK (record_id ~ '^suppression-record:[0-9a-f]{64}$'),
  CONSTRAINT suppression_records_disposition_chk CHECK (disposition IN (
    'opt_out', 'do_not_contact', 'complaint', 'hard_bounce', 'soft_bounce',
    'deletion_pending', 'deleted_tombstone', 'source_prohibited', 'conflicted', 'unknown'
  )),
  CONSTRAINT suppression_records_source_chk CHECK (
    source_kind IN ('member_recorded', 'outcome_derived')
    AND ((source_kind = 'outcome_derived' AND outcome_version_id IS NOT NULL)
      OR (source_kind = 'member_recorded' AND outcome_version_id IS NULL))
  ),
  CONSTRAINT suppression_records_scope_chk
    CHECK (account_id IS NOT NULL OR contact_stable_key IS NULL),
  CONSTRAINT suppression_records_hash_chk
    CHECK (record_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT suppression_records_chronology_chk
    CHECK (occurred_at <= recorded_at),
  CONSTRAINT suppression_records_payload_chk CHECK (
    pg_catalog.jsonb_typeof(payload) = 'object'
    AND payload->>'recordId' = record_id
    AND payload->>'tenantId' = tenant_id::text
    AND payload->>'workspaceId' = workspace_id::text
    AND coalesce(payload->>'accountId', '') = coalesce(account_id::text, '')
    AND coalesce(payload->>'contactStableKey', '') = coalesce(contact_stable_key, '')
    AND payload->>'disposition' = disposition
    AND payload->>'reason' = reason
    AND payload->'source'->>'kind' = source_kind
    AND coalesce(payload->'source'->>'outcomeVersionId', '')
      = coalesce(outcome_version_id, '')
    AND payload->'actor'->>'actorId' = actor_id::text
    AND payload->>'occurredAt'
      = pg_catalog.to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    AND payload->>'recordedAt'
      = pg_catalog.to_char(recorded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    AND payload->>'recordHash' = 'sha256:' || record_sha256
  )
);
CREATE INDEX IF NOT EXISTS idx_suppression_records_scope
  ON public.suppression_records
  (tenant_id, workspace_id, account_id, contact_stable_key, occurred_at);
CREATE INDEX IF NOT EXISTS idx_suppression_records_tenant
  ON public.suppression_records (tenant_id, workspace_id) WHERE account_id IS NULL;

/* ---------- learning proposals ---------- */

CREATE TABLE IF NOT EXISTS public.learning_proposal_versions (
  version_id text CONSTRAINT learning_proposal_versions_pkey PRIMARY KEY,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  account_id uuid NOT NULL CONSTRAINT learning_proposal_versions_account_fkey
    REFERENCES public.canonical_accounts (account_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  play_version_id text NOT NULL CONSTRAINT learning_proposal_versions_play_fkey
    REFERENCES public.lead_play_versions (version_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  stable_key text NOT NULL,
  revision integer NOT NULL,
  supersedes_version_id text CONSTRAINT learning_proposal_versions_supersedes_fkey
    REFERENCES public.learning_proposal_versions (version_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  review_status text NOT NULL,
  metric_key text NOT NULL,
  content_sha256 text NOT NULL,
  version_sha256 text NOT NULL,
  review_sha256 text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  CONSTRAINT learning_proposal_versions_tenant_workspace_fkey
    FOREIGN KEY (tenant_id, workspace_id) REFERENCES public.workspaces (tenant_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT learning_proposal_versions_account_scope_fkey
    FOREIGN KEY (tenant_id, workspace_id, account_id)
    REFERENCES public.canonical_accounts (tenant_id, workspace_id, account_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT learning_proposal_versions_revision_unique
    UNIQUE (tenant_id, workspace_id, account_id, play_version_id, stable_key, revision),
  CONSTRAINT learning_proposal_versions_id_format_chk
    CHECK (version_id ~ '^learning-proposal-version:[0-9a-f]{64}$'),
  CONSTRAINT learning_proposal_versions_revision_chk CHECK (
    revision > 0
    AND ((revision = 1 AND supersedes_version_id IS NULL)
      OR (revision > 1 AND supersedes_version_id IS NOT NULL))
  ),
  CONSTRAINT learning_proposal_versions_review_chk
    CHECK (review_status IN ('draft', 'in_review', 'approved', 'rejected')),
  CONSTRAINT learning_proposal_versions_metric_chk CHECK (metric_key IN (
    'reply_rate', 'meeting_rate', 'opportunity_rate', 'win_rate', 'opt_out_rate', 'bounce_rate'
  )),
  CONSTRAINT learning_proposal_versions_hashes_chk CHECK (
    content_sha256 ~ '^[0-9a-f]{64}$'
    AND version_sha256 ~ '^[0-9a-f]{64}$'
    AND review_sha256 ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT learning_proposal_versions_payload_chk CHECK (
    pg_catalog.jsonb_typeof(payload) = 'object'
    AND payload->>'versionId' = version_id
    AND payload->>'tenantId' = tenant_id::text
    AND payload->>'workspaceId' = workspace_id::text
    AND payload->>'accountId' = account_id::text
    AND payload->>'playVersionId' = play_version_id
    AND payload->>'stableKey' = stable_key
    AND (payload->>'revision')::numeric = revision
    AND coalesce(payload->>'supersedesVersionId', '') = coalesce(supersedes_version_id, '')
    AND payload->'review'->>'status' = review_status
    AND payload->'metric'->>'metricKey' = metric_key
    AND payload->>'contentHash' = 'sha256:' || content_sha256
    AND payload->>'versionHash' = 'sha256:' || version_sha256
    AND payload->'review'->>'reviewHash' = 'sha256:' || review_sha256
    AND payload->>'createdAt'
      = pg_catalog.to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  )
);
CREATE INDEX IF NOT EXISTS idx_learning_proposal_versions_scope
  ON public.learning_proposal_versions
  (tenant_id, workspace_id, account_id, play_version_id, stable_key, revision DESC);
CREATE INDEX IF NOT EXISTS idx_learning_proposal_versions_review
  ON public.learning_proposal_versions (tenant_id, workspace_id, review_status, created_at DESC);

/* ---------- guards ---------- */

CREATE OR REPLACE FUNCTION public.novatrade_l06_immutable()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $function$
BEGIN
  RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='L06_RECORD_IMMUTABLE';
END;
$function$;

CREATE OR REPLACE FUNCTION public.novatrade_l06_draft_chain_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $function$
DECLARE parent_row public.outreach_draft_versions%ROWTYPE;
BEGIN
  IF NEW.supersedes_version_id IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO parent_row FROM public.outreach_draft_versions v
  WHERE v.version_id = NEW.supersedes_version_id;
  IF NOT FOUND OR parent_row.tenant_id IS DISTINCT FROM NEW.tenant_id
    OR parent_row.workspace_id IS DISTINCT FROM NEW.workspace_id
    OR parent_row.account_id IS DISTINCT FROM NEW.account_id
    OR parent_row.stable_key IS DISTINCT FROM NEW.stable_key
    OR parent_row.revision <> NEW.revision - 1 THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='L06_DRAFT_CHAIN_MISMATCH';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.novatrade_l06_outcome_chain_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $function$
DECLARE parent_row public.outcome_record_versions%ROWTYPE;
BEGIN
  IF NEW.supersedes_version_id IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO parent_row FROM public.outcome_record_versions v
  WHERE v.version_id = NEW.supersedes_version_id;
  IF NOT FOUND OR parent_row.tenant_id IS DISTINCT FROM NEW.tenant_id
    OR parent_row.workspace_id IS DISTINCT FROM NEW.workspace_id
    OR parent_row.account_id IS DISTINCT FROM NEW.account_id
    OR parent_row.play_version_id IS DISTINCT FROM NEW.play_version_id
    OR parent_row.stable_key IS DISTINCT FROM NEW.stable_key
    OR parent_row.revision <> NEW.revision - 1 THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='L06_OUTCOME_CHAIN_MISMATCH';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.novatrade_l06_proposal_chain_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $function$
DECLARE parent_row public.learning_proposal_versions%ROWTYPE;
BEGIN
  IF NEW.supersedes_version_id IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO parent_row FROM public.learning_proposal_versions v
  WHERE v.version_id = NEW.supersedes_version_id;
  IF NOT FOUND OR parent_row.tenant_id IS DISTINCT FROM NEW.tenant_id
    OR parent_row.workspace_id IS DISTINCT FROM NEW.workspace_id
    OR parent_row.account_id IS DISTINCT FROM NEW.account_id
    OR parent_row.play_version_id IS DISTINCT FROM NEW.play_version_id
    OR parent_row.stable_key IS DISTINCT FROM NEW.stable_key
    OR parent_row.revision <> NEW.revision - 1 THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='L06_PROPOSAL_CHAIN_MISMATCH';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.novatrade_l06_versioned_review_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $function$
BEGIN
  IF NEW.version_id IS DISTINCT FROM OLD.version_id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id OR NEW.account_id IS DISTINCT FROM OLD.account_id
    OR NEW.stable_key IS DISTINCT FROM OLD.stable_key OR NEW.revision IS DISTINCT FROM OLD.revision
    OR NEW.supersedes_version_id IS DISTINCT FROM OLD.supersedes_version_id
    OR NEW.content_sha256 IS DISTINCT FROM OLD.content_sha256
    OR NEW.version_sha256 IS DISTINCT FROM OLD.version_sha256
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='L06_VERSION_IDENTITY_IMMUTABLE';
  END IF;
  IF NEW.review_sha256 = OLD.review_sha256 THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='L06_REVIEW_STALE_UPDATE';
  END IF;
  IF NOT ((OLD.review_status = 'draft' AND NEW.review_status = 'in_review')
    OR (OLD.review_status = 'in_review' AND NEW.review_status IN ('approved', 'rejected'))) THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='L06_REVIEW_INVALID_TRANSITION';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.novatrade_l06_current_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $function$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
    OR NEW.account_id IS DISTINCT FROM OLD.account_id
    OR NEW.stable_key IS DISTINCT FROM OLD.stable_key THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='L06_CURRENT_IDENTITY_IMMUTABLE';
  END IF;
  IF NEW.updated_at <= OLD.updated_at OR NEW.state_sha256 = OLD.state_sha256 THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='L06_CURRENT_STALE_UPDATE';
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_outreach_draft_versions_chain ON public.outreach_draft_versions;
CREATE TRIGGER trg_outreach_draft_versions_chain BEFORE INSERT ON public.outreach_draft_versions
FOR EACH ROW EXECUTE FUNCTION public.novatrade_l06_draft_chain_guard();
DROP TRIGGER IF EXISTS trg_outreach_draft_versions_review ON public.outreach_draft_versions;
CREATE TRIGGER trg_outreach_draft_versions_review BEFORE UPDATE ON public.outreach_draft_versions
FOR EACH ROW EXECUTE FUNCTION public.novatrade_l06_versioned_review_guard();
DROP TRIGGER IF EXISTS trg_outreach_draft_versions_immutable ON public.outreach_draft_versions;
CREATE TRIGGER trg_outreach_draft_versions_immutable BEFORE DELETE
ON public.outreach_draft_versions FOR EACH ROW EXECUTE FUNCTION public.novatrade_l06_immutable();

DROP TRIGGER IF EXISTS trg_outreach_draft_current_guard ON public.outreach_draft_current;
CREATE TRIGGER trg_outreach_draft_current_guard BEFORE UPDATE ON public.outreach_draft_current
FOR EACH ROW EXECUTE FUNCTION public.novatrade_l06_current_guard();
DROP TRIGGER IF EXISTS trg_outreach_draft_current_immutable ON public.outreach_draft_current;
CREATE TRIGGER trg_outreach_draft_current_immutable BEFORE DELETE
ON public.outreach_draft_current FOR EACH ROW EXECUTE FUNCTION public.novatrade_l06_immutable();

DROP TRIGGER IF EXISTS trg_outreach_handoff_attempts_immutable ON public.outreach_handoff_attempts;
CREATE TRIGGER trg_outreach_handoff_attempts_immutable
BEFORE UPDATE OR DELETE ON public.outreach_handoff_attempts
FOR EACH ROW EXECUTE FUNCTION public.novatrade_l06_immutable();

DROP TRIGGER IF EXISTS trg_outcome_record_versions_chain ON public.outcome_record_versions;
CREATE TRIGGER trg_outcome_record_versions_chain BEFORE INSERT ON public.outcome_record_versions
FOR EACH ROW EXECUTE FUNCTION public.novatrade_l06_outcome_chain_guard();
DROP TRIGGER IF EXISTS trg_outcome_record_versions_immutable ON public.outcome_record_versions;
CREATE TRIGGER trg_outcome_record_versions_immutable
BEFORE UPDATE OR DELETE ON public.outcome_record_versions
FOR EACH ROW EXECUTE FUNCTION public.novatrade_l06_immutable();

DROP TRIGGER IF EXISTS trg_suppression_records_immutable ON public.suppression_records;
CREATE TRIGGER trg_suppression_records_immutable
BEFORE UPDATE OR DELETE ON public.suppression_records
FOR EACH ROW EXECUTE FUNCTION public.novatrade_l06_immutable();

DROP TRIGGER IF EXISTS trg_learning_proposal_versions_chain ON public.learning_proposal_versions;
CREATE TRIGGER trg_learning_proposal_versions_chain BEFORE INSERT ON public.learning_proposal_versions
FOR EACH ROW EXECUTE FUNCTION public.novatrade_l06_proposal_chain_guard();
DROP TRIGGER IF EXISTS trg_learning_proposal_versions_review ON public.learning_proposal_versions;
CREATE TRIGGER trg_learning_proposal_versions_review BEFORE UPDATE ON public.learning_proposal_versions
FOR EACH ROW EXECUTE FUNCTION public.novatrade_l06_versioned_review_guard();
DROP TRIGGER IF EXISTS trg_learning_proposal_versions_immutable ON public.learning_proposal_versions;
CREATE TRIGGER trg_learning_proposal_versions_immutable BEFORE DELETE
ON public.learning_proposal_versions FOR EACH ROW EXECUTE FUNCTION public.novatrade_l06_immutable();

/* ---------- security ---------- */

DO $security$
DECLARE target_table text; target_role text; target_function text;
BEGIN
  FOREACH target_table IN ARRAY ARRAY[
    'outreach_draft_versions', 'outreach_draft_current', 'outreach_handoff_attempts',
    'outcome_record_versions', 'suppression_records', 'learning_proposal_versions'
  ] LOOP
    EXECUTE pg_catalog.format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', target_table);
    EXECUTE pg_catalog.format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', target_table);
    EXECUTE pg_catalog.format('REVOKE ALL ON TABLE public.%I FROM PUBLIC', target_table);
    FOREACH target_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = target_role) THEN
        EXECUTE pg_catalog.format('REVOKE ALL ON TABLE public.%I FROM %I', target_table, target_role);
      END IF;
    END LOOP;
  END LOOP;
  FOREACH target_function IN ARRAY ARRAY[
    'public.novatrade_l06_immutable()', 'public.novatrade_l06_draft_chain_guard()',
    'public.novatrade_l06_outcome_chain_guard()', 'public.novatrade_l06_proposal_chain_guard()',
    'public.novatrade_l06_versioned_review_guard()', 'public.novatrade_l06_current_guard()'
  ] LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', target_function);
    FOREACH target_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = target_role) THEN
        EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION %s FROM %I', target_function, target_role);
      END IF;
    END LOOP;
  END LOOP;
END;
$security$;

COMMENT ON TABLE public.outreach_draft_versions IS
  'Immutable outreach draft versions: deterministic composed subject/body with hash-verified citations, evidence digest, and review history.';
COMMENT ON TABLE public.outreach_draft_current IS
  'Mutable per-stable-key projection of the current approved outreach draft binding; guarded by expected-hash updates.';
COMMENT ON TABLE public.outreach_handoff_attempts IS
  'Append-only copy/export handoff attempts: blocked attempts carry a block code and optional policy decision; released attempts carry the caller-attested export receipt. No delivery, send, or provider state exists.';
COMMENT ON TABLE public.outcome_record_versions IS
  'Immutable manually-observed outcome versions per account and play; corrections append superseding revisions with audit history.';
COMMENT ON TABLE public.suppression_records IS
  'Append-only protective suppression records at tenant, account, or contact scope; records override any recorded clear disposition.';
COMMENT ON TABLE public.learning_proposal_versions IS
  'Immutable learning proposal versions: reversible, human-reviewed change proposals derived from outcome cohorts; never activates policy.';

DO $receipt$
DECLARE table_count integer; rls_count integer; policy_count integer; trigger_count integer;
BEGIN
  SELECT count(*) INTO table_count FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind = 'r'
    AND c.relname = ANY (ARRAY[
      'outreach_draft_versions', 'outreach_draft_current', 'outreach_handoff_attempts',
      'outcome_record_versions', 'suppression_records', 'learning_proposal_versions']);
  SELECT count(*) INTO rls_count FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relrowsecurity AND c.relforcerowsecurity
    AND c.relname = ANY (ARRAY[
      'outreach_draft_versions', 'outreach_draft_current', 'outreach_handoff_attempts',
      'outcome_record_versions', 'suppression_records', 'learning_proposal_versions']);
  SELECT count(*) INTO policy_count FROM pg_catalog.pg_policy p
  WHERE p.polrelid = ANY (ARRAY[
    'public.outreach_draft_versions'::regclass, 'public.outreach_draft_current'::regclass,
    'public.outreach_handoff_attempts'::regclass, 'public.outcome_record_versions'::regclass,
    'public.suppression_records'::regclass, 'public.learning_proposal_versions'::regclass]);
  SELECT count(*) INTO trigger_count FROM pg_catalog.pg_trigger t
  WHERE NOT t.tgisinternal AND t.tgrelid = ANY (ARRAY[
    'public.outreach_draft_versions'::regclass, 'public.outreach_draft_current'::regclass,
    'public.outreach_handoff_attempts'::regclass, 'public.outcome_record_versions'::regclass,
    'public.suppression_records'::regclass, 'public.learning_proposal_versions'::regclass]);
  IF table_count <> 6 OR rls_count <> 6 OR policy_count <> 0 OR trigger_count <> 12 THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='L06_CATALOG_INCOMPLETE';
  END IF;
END;
$receipt$;

COMMIT;
