-- L-05 qualification snapshots and review queues.
--
-- Persists play-specific qualification documents (score vector, rationale,
-- citations, automated vs current decision) plus the reusable review queue
-- aggregate and its queryable item/event projections. Qualification snapshots
-- keep an immutable evaluation identity; human review appends events and
-- changes decision state under a guarded transition. Queue rows stay
-- hash-chained with optimistic-concurrency protection.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';
SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtext('novatrade:l05:qualification-review-foundation')
);

CREATE TABLE IF NOT EXISTS public.account_qualification_snapshots (
  version_id text CONSTRAINT account_qualification_snapshots_pkey PRIMARY KEY,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  account_id uuid NOT NULL CONSTRAINT account_qualification_snapshots_account_fkey
    REFERENCES public.canonical_accounts (account_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  play_version_id text NOT NULL,
  play_content_sha256 text NOT NULL,
  policy_sha256 text NOT NULL,
  qualification_sha256 text NOT NULL,
  weighted_score numeric NOT NULL,
  automated_decision text NOT NULL,
  decision text NOT NULL,
  review_status text NOT NULL,
  evaluated_at timestamptz NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.statement_timestamp(),
  CONSTRAINT account_qualification_snapshots_tenant_workspace_fkey
    FOREIGN KEY (tenant_id, workspace_id) REFERENCES public.workspaces (tenant_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT account_qualification_snapshots_account_scope_fkey
    FOREIGN KEY (tenant_id, workspace_id, account_id)
    REFERENCES public.canonical_accounts (tenant_id, workspace_id, account_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT account_qualification_snapshots_id_format_chk
    CHECK (version_id ~ '^account-qualification:[0-9a-f]{64}$'),
  CONSTRAINT account_qualification_snapshots_play_chk
    CHECK (play_version_id ~ '^lead-play-version:[0-9a-f]{64}$'),
  CONSTRAINT account_qualification_snapshots_hashes_chk CHECK (
    play_content_sha256 ~ '^[0-9a-f]{64}$'
    AND policy_sha256 ~ '^[0-9a-f]{64}$'
    AND qualification_sha256 ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT account_qualification_snapshots_score_chk CHECK (
    weighted_score >= 0 AND weighted_score <= 10000
  ),
  CONSTRAINT account_qualification_snapshots_decision_chk CHECK (
    automated_decision IN ('qualified', 'needs_review', 'unqualified')
    AND decision IN ('qualified', 'needs_review', 'unqualified')
  ),
  CONSTRAINT account_qualification_snapshots_review_chk
    CHECK (review_status IN ('unreviewed', 'confirmed', 'overridden')),
  CONSTRAINT account_qualification_snapshots_payload_chk CHECK (
    pg_catalog.jsonb_typeof(payload) = 'object'
    AND payload->>'versionId' = version_id
    AND payload->>'tenantId' = tenant_id::text
    AND payload->>'workspaceId' = workspace_id::text
    AND payload->>'accountId' = account_id::text
    AND payload->>'playVersionId' = play_version_id
    AND payload->>'playContentHash' = 'sha256:' || play_content_sha256
    AND payload->>'policyHash' = 'sha256:' || policy_sha256
    AND payload->>'qualificationHash' = 'sha256:' || qualification_sha256
    AND (payload->>'weightedScore')::numeric = weighted_score
    AND payload->>'automatedDecision' = automated_decision
    AND payload->>'decision' = decision
    AND payload->>'reviewStatus' = review_status
    AND payload->>'evaluatedAt'
      = pg_catalog.to_char(evaluated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  )
);
CREATE INDEX IF NOT EXISTS idx_account_qualification_snapshots_scope_account
  ON public.account_qualification_snapshots
  (tenant_id, workspace_id, account_id, play_version_id, evaluated_at DESC);
CREATE INDEX IF NOT EXISTS idx_account_qualification_snapshots_scope_review
  ON public.account_qualification_snapshots
  (tenant_id, workspace_id, review_status, decision, evaluated_at DESC);
-- One child snapshot per reviewed parent hash: prevents concurrent reviewers
-- forking the chain off the same version (optimistic-concurrency backstop).
CREATE UNIQUE INDEX IF NOT EXISTS idx_account_qualification_snapshots_parent
  ON public.account_qualification_snapshots
  (tenant_id, workspace_id, account_id,
    (payload->'reviewEvents'->-1->>'fromQualificationHash'))
  WHERE review_status <> 'unreviewed';

CREATE TABLE IF NOT EXISTS public.review_queue_documents (
  queue_id text CONSTRAINT review_queue_documents_pkey PRIMARY KEY,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  queue_sha256 text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT review_queue_documents_tenant_workspace_fkey
    FOREIGN KEY (tenant_id, workspace_id) REFERENCES public.workspaces (tenant_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT review_queue_documents_scope_unique UNIQUE (tenant_id, workspace_id),
  CONSTRAINT review_queue_documents_id_format_chk
    CHECK (queue_id ~ '^review-queue:[0-9a-f]{64}$'),
  CONSTRAINT review_queue_documents_hash_chk CHECK (queue_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT review_queue_documents_payload_chk CHECK (
    pg_catalog.jsonb_typeof(payload) = 'object'
    AND payload->>'queueId' = queue_id
    AND payload->>'tenantId' = tenant_id::text
    AND payload->>'workspaceId' = workspace_id::text
    AND payload->>'queueHash' = 'sha256:' || queue_sha256
  ),
  CONSTRAINT review_queue_documents_time_chk CHECK (updated_at >= created_at)
);

CREATE TABLE IF NOT EXISTS public.review_queue_items (
  item_id text NOT NULL,
  queue_id text NOT NULL CONSTRAINT review_queue_items_queue_fkey
    REFERENCES public.review_queue_documents (queue_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  kind text NOT NULL,
  subject jsonb NOT NULL,
  priority text NOT NULL,
  reason text NOT NULL,
  uncertainty_ids jsonb NOT NULL,
  status text NOT NULL,
  claimed_by uuid,
  lease_expires_at timestamptz,
  resolution jsonb,
  enqueued_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT review_queue_items_pkey PRIMARY KEY (queue_id, item_id),
  CONSTRAINT review_queue_items_tenant_workspace_fkey
    FOREIGN KEY (tenant_id, workspace_id) REFERENCES public.workspaces (tenant_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT review_queue_items_scope_item_unique UNIQUE (tenant_id, workspace_id, item_id),
  CONSTRAINT review_queue_items_id_format_chk
    CHECK (item_id ~ '^review-item:[0-9a-f]{64}$'),
  CONSTRAINT review_queue_items_kind_chk CHECK (kind IN (
    'ambiguous_account_resolution', 'qualification_review', 'buying_center_review'
  )),
  CONSTRAINT review_queue_items_subject_chk CHECK (
    pg_catalog.jsonb_typeof(subject) = 'object'
    AND pg_catalog.char_length(subject->>'subjectId') BETWEEN 1 AND 300
    AND pg_catalog.char_length(subject->>'versionId') BETWEEN 1 AND 300
    AND subject->>'contentHash' ~ '^sha256:[0-9a-f]{64}$'
  ),
  CONSTRAINT review_queue_items_priority_chk
    CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  CONSTRAINT review_queue_items_status_chk
    CHECK (status IN ('queued', 'claimed', 'resolved')),
  CONSTRAINT review_queue_items_claim_chk CHECK (
    (status = 'queued' AND claimed_by IS NULL AND lease_expires_at IS NULL AND resolution IS NULL)
    OR (status = 'claimed' AND claimed_by IS NOT NULL AND lease_expires_at IS NOT NULL
      AND resolution IS NULL)
    OR (status = 'resolved' AND claimed_by IS NOT NULL AND resolution IS NOT NULL)
  ),
  CONSTRAINT review_queue_items_reason_chk CHECK (
    pg_catalog.char_length(reason) BETWEEN 1 AND 2000
    AND reason = pg_catalog.btrim(reason)
    AND reason !~ '[[:cntrl:]]'
  ),
  CONSTRAINT review_queue_items_uncertainties_chk CHECK (
    pg_catalog.jsonb_typeof(uncertainty_ids) = 'array'
    AND pg_catalog.jsonb_array_length(uncertainty_ids) <= 16
  ),
  CONSTRAINT review_queue_items_time_chk CHECK (updated_at >= enqueued_at)
);
CREATE INDEX IF NOT EXISTS idx_review_queue_items_scope_status
  ON public.review_queue_items
  (tenant_id, workspace_id, status, priority, enqueued_at);
CREATE INDEX IF NOT EXISTS idx_review_queue_items_scope_kind
  ON public.review_queue_items (tenant_id, workspace_id, kind, status);
CREATE INDEX IF NOT EXISTS idx_review_queue_items_scope_lease
  ON public.review_queue_items (tenant_id, workspace_id, lease_expires_at)
  WHERE status = 'claimed';

CREATE TABLE IF NOT EXISTS public.review_queue_events (
  queue_id text NOT NULL CONSTRAINT review_queue_events_queue_fkey
    REFERENCES public.review_queue_documents (queue_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  sequence integer NOT NULL,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  item_id text NOT NULL,
  action text NOT NULL,
  actor_id uuid,
  at timestamptz NOT NULL,
  reason text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.statement_timestamp(),
  CONSTRAINT review_queue_events_pkey PRIMARY KEY (queue_id, sequence),
  CONSTRAINT review_queue_events_tenant_workspace_fkey
    FOREIGN KEY (tenant_id, workspace_id) REFERENCES public.workspaces (tenant_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT review_queue_events_item_fkey
    FOREIGN KEY (queue_id, item_id)
    REFERENCES public.review_queue_items (queue_id, item_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT review_queue_events_sequence_chk CHECK (sequence > 0),
  CONSTRAINT review_queue_events_action_chk
    CHECK (action IN ('enqueue', 'claim', 'release', 'resolve')),
  CONSTRAINT review_queue_events_item_chk
    CHECK (item_id ~ '^review-item:[0-9a-f]{64}$'),
  CONSTRAINT review_queue_events_actor_chk CHECK (
    (action = 'enqueue' AND actor_id IS NULL)
    OR (action <> 'enqueue' AND actor_id IS NOT NULL)
  ),
  CONSTRAINT review_queue_events_payload_chk
    CHECK (pg_catalog.jsonb_typeof(payload) = 'object')
);
CREATE INDEX IF NOT EXISTS idx_review_queue_events_scope_at
  ON public.review_queue_events (tenant_id, workspace_id, at, sequence);

-- Snapshot rows are an append-only, replay-verified chain: a review creates a
-- new version whose final review event links back to the parent snapshot hash.
-- The guard validates that link and the decision semantics on insert.
CREATE OR REPLACE FUNCTION public.novatrade_l05_qualification_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $function$
DECLARE
  event_count integer;
  from_hash text;
  parent_decision text;
BEGIN
  IF pg_catalog.jsonb_typeof(NEW.payload->'reviewEvents') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='L05_QUALIFICATION_EVENTS_MALFORMED';
  END IF;
  event_count := pg_catalog.jsonb_array_length(NEW.payload->'reviewEvents');
  IF NEW.review_status = 'unreviewed' THEN
    IF event_count <> 0 OR NEW.decision <> NEW.automated_decision THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='L05_QUALIFICATION_UNREVIEWED_MALFORMED';
    END IF;
    RETURN NEW;
  END IF;
  IF event_count < 1 THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='L05_QUALIFICATION_EVENTS_MALFORMED';
  END IF;
  from_hash := NEW.payload->'reviewEvents'->-1->>'fromQualificationHash';
  IF from_hash IS NULL OR from_hash !~ '^sha256:[0-9a-f]{64}$' THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='L05_QUALIFICATION_PARENT_MALFORMED';
  END IF;
  SELECT parent.decision INTO parent_decision
  FROM public.account_qualification_snapshots parent
  WHERE parent.tenant_id = NEW.tenant_id AND parent.workspace_id = NEW.workspace_id
    AND parent.account_id = NEW.account_id
    AND parent.qualification_sha256 = pg_catalog.substring(from_hash, 8);
  IF parent_decision IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='L05_QUALIFICATION_PARENT_MISSING';
  END IF;
  IF (NEW.review_status = 'confirmed' AND NEW.decision IS DISTINCT FROM parent_decision)
    OR (NEW.review_status = 'overridden' AND NEW.decision IS NOT DISTINCT FROM parent_decision) THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='L05_QUALIFICATION_INVALID_REVIEW';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.novatrade_l05_queue_document_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $function$
BEGIN
  IF NEW.queue_id IS DISTINCT FROM OLD.queue_id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='L05_QUEUE_IDENTITY_IMMUTABLE';
  END IF;
  IF NEW.updated_at <= OLD.updated_at OR NEW.queue_sha256 = OLD.queue_sha256 THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='L05_QUEUE_STALE_UPDATE';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.novatrade_l05_queue_item_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $function$
BEGIN
  IF NEW.item_id IS DISTINCT FROM OLD.item_id OR NEW.queue_id IS DISTINCT FROM OLD.queue_id
    OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
    OR NEW.kind IS DISTINCT FROM OLD.kind OR NEW.subject IS DISTINCT FROM OLD.subject
    OR NEW.enqueued_at IS DISTINCT FROM OLD.enqueued_at THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='L05_QUEUE_ITEM_IDENTITY_IMMUTABLE';
  END IF;
  IF NEW.updated_at <= OLD.updated_at THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='L05_QUEUE_ITEM_STALE_UPDATE';
  END IF;
  IF OLD.status = 'resolved' THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='L05_QUEUE_ITEM_TERMINAL';
  END IF;
  IF NOT ((OLD.status = 'queued' AND NEW.status = 'claimed')
    OR (OLD.status = 'claimed' AND NEW.status IN ('queued', 'resolved'))
    OR (OLD.status = 'claimed' AND NEW.status = 'claimed' AND NEW.claimed_by <> OLD.claimed_by)) THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='L05_QUEUE_ITEM_INVALID_TRANSITION';
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_account_qualification_snapshots_guard
  ON public.account_qualification_snapshots;
CREATE TRIGGER trg_account_qualification_snapshots_guard BEFORE INSERT
ON public.account_qualification_snapshots
FOR EACH ROW EXECUTE FUNCTION public.novatrade_l05_qualification_guard();
DROP TRIGGER IF EXISTS trg_account_qualification_snapshots_immutable
  ON public.account_qualification_snapshots;
CREATE TRIGGER trg_account_qualification_snapshots_immutable BEFORE UPDATE OR DELETE
ON public.account_qualification_snapshots FOR EACH ROW EXECUTE FUNCTION public.novatrade_l05_immutable();
DROP TRIGGER IF EXISTS trg_review_queue_documents_guard ON public.review_queue_documents;
CREATE TRIGGER trg_review_queue_documents_guard BEFORE UPDATE ON public.review_queue_documents
FOR EACH ROW EXECUTE FUNCTION public.novatrade_l05_queue_document_guard();
DROP TRIGGER IF EXISTS trg_review_queue_documents_immutable ON public.review_queue_documents;
CREATE TRIGGER trg_review_queue_documents_immutable BEFORE DELETE ON public.review_queue_documents
FOR EACH ROW EXECUTE FUNCTION public.novatrade_l05_immutable();
DROP TRIGGER IF EXISTS trg_review_queue_items_guard ON public.review_queue_items;
CREATE TRIGGER trg_review_queue_items_guard BEFORE UPDATE ON public.review_queue_items
FOR EACH ROW EXECUTE FUNCTION public.novatrade_l05_queue_item_guard();
DROP TRIGGER IF EXISTS trg_review_queue_items_immutable ON public.review_queue_items;
CREATE TRIGGER trg_review_queue_items_immutable BEFORE DELETE ON public.review_queue_items
FOR EACH ROW EXECUTE FUNCTION public.novatrade_l05_immutable();
DROP TRIGGER IF EXISTS trg_review_queue_events_immutable ON public.review_queue_events;
CREATE TRIGGER trg_review_queue_events_immutable BEFORE UPDATE OR DELETE ON public.review_queue_events
FOR EACH ROW EXECUTE FUNCTION public.novatrade_l05_immutable();

DO $security$
DECLARE target_table text; target_role text; target_function text;
BEGIN
  FOREACH target_table IN ARRAY ARRAY[
    'account_qualification_snapshots', 'review_queue_documents',
    'review_queue_items', 'review_queue_events'
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
    'public.novatrade_l05_qualification_guard()',
    'public.novatrade_l05_queue_document_guard()', 'public.novatrade_l05_queue_item_guard()'
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

COMMENT ON TABLE public.account_qualification_snapshots IS
  'Play-specific qualification snapshots. The evaluation identity is immutable; human review appends events and moves decision state under a guarded transition.';
COMMENT ON TABLE public.review_queue_documents IS
  'Hash-chained review queue aggregates, one per tenant/workspace scope, guarded by optimistic concurrency.';
COMMENT ON TABLE public.review_queue_items IS
  'Queryable projection of queue items with lease state; transitions follow the domain queue state machine.';
COMMENT ON TABLE public.review_queue_events IS
  'Append-only queue event projection preserving the full audit trail.';

DO $receipt$
DECLARE table_count integer; rls_count integer; policy_count integer; trigger_count integer;
BEGIN
  SELECT count(*) INTO table_count FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname = ANY (ARRAY[
    'account_qualification_snapshots', 'review_queue_documents',
    'review_queue_items', 'review_queue_events']);
  SELECT count(*) INTO rls_count FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relrowsecurity AND c.relforcerowsecurity
    AND c.relname = ANY (ARRAY[
      'account_qualification_snapshots', 'review_queue_documents',
      'review_queue_items', 'review_queue_events']);
  SELECT count(*) INTO policy_count FROM pg_catalog.pg_policy p
  WHERE p.polrelid = ANY (ARRAY[
    'public.account_qualification_snapshots'::regclass,
    'public.review_queue_documents'::regclass,
    'public.review_queue_items'::regclass, 'public.review_queue_events'::regclass]);
  SELECT count(*) INTO trigger_count FROM pg_catalog.pg_trigger t
  WHERE NOT t.tgisinternal AND t.tgrelid = ANY (ARRAY[
    'public.account_qualification_snapshots'::regclass,
    'public.review_queue_documents'::regclass,
    'public.review_queue_items'::regclass, 'public.review_queue_events'::regclass]);
  IF table_count <> 4 OR rls_count <> 4 OR policy_count <> 0 OR trigger_count <> 7 THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='L05_QUALIFICATION_REVIEW_CATALOG_INCOMPLETE';
  END IF;
END;
$receipt$;
COMMIT;
