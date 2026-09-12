-- L-05 contact records and buying-center maps.
--
-- Persists the immutable version documents produced by src/lib/contacts.
-- Contact records carry provenance receipts, permitted-use state, freshness,
-- and suppression disposition; buying-center versions carry role hypotheses
-- that remain structurally distinct from verified contact references.
-- Indexed columns are projections of the payload and must match it exactly so
-- a forged projection cannot disagree with the hash-verified document.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';
SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtext('novatrade:l05:contacts-buying-centers')
);

CREATE TABLE IF NOT EXISTS public.contact_record_versions (
  version_id text CONSTRAINT contact_record_versions_pkey PRIMARY KEY,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  account_id uuid NOT NULL CONSTRAINT contact_record_versions_account_fkey
    REFERENCES public.canonical_accounts (account_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  stable_key text NOT NULL,
  revision integer NOT NULL,
  supersedes_version_id text CONSTRAINT contact_record_versions_supersedes_fkey
    REFERENCES public.contact_record_versions (version_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  review_status text NOT NULL,
  suppression_disposition text NOT NULL,
  freshness_state text NOT NULL,
  contact_point_class text NOT NULL,
  connector_key text NOT NULL,
  content_sha256 text NOT NULL,
  version_sha256 text NOT NULL,
  review_sha256 text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  CONSTRAINT contact_record_versions_tenant_workspace_fkey
    FOREIGN KEY (tenant_id, workspace_id) REFERENCES public.workspaces (tenant_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT contact_record_versions_account_scope_fkey
    FOREIGN KEY (tenant_id, workspace_id, account_id)
    REFERENCES public.canonical_accounts (tenant_id, workspace_id, account_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT contact_record_versions_revision_unique
    UNIQUE (tenant_id, workspace_id, account_id, stable_key, revision),
  CONSTRAINT contact_record_versions_id_format_chk
    CHECK (version_id ~ '^contact-version:[0-9a-f]{64}$'),
  CONSTRAINT contact_record_versions_revision_chk CHECK (
    revision > 0
    AND ((revision = 1 AND supersedes_version_id IS NULL)
      OR (revision > 1 AND supersedes_version_id IS NOT NULL))
  ),
  CONSTRAINT contact_record_versions_review_chk
    CHECK (review_status IN ('draft', 'in_review', 'approved', 'rejected')),
  CONSTRAINT contact_record_versions_suppression_chk CHECK (suppression_disposition IN (
    'clear', 'opt_out', 'do_not_contact', 'complaint', 'hard_bounce', 'soft_bounce',
    'deletion_pending', 'deleted_tombstone', 'source_prohibited', 'conflicted', 'unknown'
  )),
  CONSTRAINT contact_record_versions_freshness_chk
    CHECK (freshness_state IN ('KNOWN', 'UNKNOWN', 'CONFLICTED', 'STALE', 'NA')),
  CONSTRAINT contact_record_versions_class_chk CHECK (
    pg_catalog.char_length(contact_point_class) BETWEEN 1 AND 120
  ),
  CONSTRAINT contact_record_versions_connector_chk CHECK (
    pg_catalog.char_length(connector_key) BETWEEN 1 AND 300
  ),
  CONSTRAINT contact_record_versions_hashes_chk CHECK (
    content_sha256 ~ '^[0-9a-f]{64}$'
    AND version_sha256 ~ '^[0-9a-f]{64}$'
    AND review_sha256 ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT contact_record_versions_payload_chk CHECK (
    pg_catalog.jsonb_typeof(payload) = 'object'
    AND payload->>'versionId' = version_id
    AND payload->>'tenantId' = tenant_id::text
    AND payload->>'workspaceId' = workspace_id::text
    AND payload->>'accountId' = account_id::text
    AND payload->>'stableKey' = stable_key
    AND (payload->>'revision')::numeric = revision
    AND pg_catalog.coalesce(payload->>'supersedesVersionId', '') = pg_catalog.coalesce(supersedes_version_id, '')
    AND payload->'review'->>'status' = review_status
    AND payload->>'suppressionDisposition' = suppression_disposition
    AND payload->'freshness'->>'state' = freshness_state
    AND payload->'identity'->>'contactPointClass' = contact_point_class
    AND payload->'sourceReceipt'->>'connectorKey' = connector_key
    AND payload->>'contentHash' = 'sha256:' || content_sha256
    AND payload->>'versionHash' = 'sha256:' || version_sha256
    AND payload->'review'->>'reviewHash' = 'sha256:' || review_sha256
    AND payload->>'createdAt' = pg_catalog.to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  )
);
CREATE INDEX IF NOT EXISTS idx_contact_record_versions_scope_account
  ON public.contact_record_versions (tenant_id, workspace_id, account_id, stable_key, revision DESC);
CREATE INDEX IF NOT EXISTS idx_contact_record_versions_scope_review
  ON public.contact_record_versions (tenant_id, workspace_id, review_status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_contact_record_versions_scope_suppression
  ON public.contact_record_versions (tenant_id, workspace_id, suppression_disposition);

CREATE TABLE IF NOT EXISTS public.buying_center_versions (
  version_id text CONSTRAINT buying_center_versions_pkey PRIMARY KEY,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  account_id uuid NOT NULL CONSTRAINT buying_center_versions_account_fkey
    REFERENCES public.canonical_accounts (account_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  play_version_id text NOT NULL,
  stable_key text NOT NULL,
  revision integer NOT NULL,
  supersedes_version_id text CONSTRAINT buying_center_versions_supersedes_fkey
    REFERENCES public.buying_center_versions (version_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  review_status text NOT NULL,
  hypothesis_count integer NOT NULL,
  verified_contact_count integer NOT NULL,
  content_sha256 text NOT NULL,
  version_sha256 text NOT NULL,
  review_sha256 text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  CONSTRAINT buying_center_versions_tenant_workspace_fkey
    FOREIGN KEY (tenant_id, workspace_id) REFERENCES public.workspaces (tenant_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT buying_center_versions_account_scope_fkey
    FOREIGN KEY (tenant_id, workspace_id, account_id)
    REFERENCES public.canonical_accounts (tenant_id, workspace_id, account_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT buying_center_versions_revision_unique
    UNIQUE (tenant_id, workspace_id, account_id, play_version_id, stable_key, revision),
  CONSTRAINT buying_center_versions_id_format_chk
    CHECK (version_id ~ '^buying-center-version:[0-9a-f]{64}$'),
  CONSTRAINT buying_center_versions_play_chk
    CHECK (play_version_id ~ '^lead-play-version:[0-9a-f]{64}$'),
  CONSTRAINT buying_center_versions_revision_chk CHECK (
    revision > 0
    AND ((revision = 1 AND supersedes_version_id IS NULL)
      OR (revision > 1 AND supersedes_version_id IS NOT NULL))
  ),
  CONSTRAINT buying_center_versions_review_chk
    CHECK (review_status IN ('draft', 'in_review', 'approved', 'rejected')),
  CONSTRAINT buying_center_versions_counts_chk
    CHECK (hypothesis_count >= 0 AND verified_contact_count >= 0),
  CONSTRAINT buying_center_versions_hashes_chk CHECK (
    content_sha256 ~ '^[0-9a-f]{64}$'
    AND version_sha256 ~ '^[0-9a-f]{64}$'
    AND review_sha256 ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT buying_center_versions_payload_chk CHECK (
    pg_catalog.jsonb_typeof(payload) = 'object'
    AND payload->>'versionId' = version_id
    AND payload->>'tenantId' = tenant_id::text
    AND payload->>'workspaceId' = workspace_id::text
    AND payload->>'accountId' = account_id::text
    AND payload->>'playVersionId' = play_version_id
    AND payload->>'stableKey' = stable_key
    AND (payload->>'revision')::numeric = revision
    AND pg_catalog.coalesce(payload->>'supersedesVersionId', '') = pg_catalog.coalesce(supersedes_version_id, '')
    AND payload->'review'->>'status' = review_status
    AND pg_catalog.jsonb_array_length(payload->'hypotheses') = hypothesis_count
    AND payload->>'contentHash' = 'sha256:' || content_sha256
    AND payload->>'versionHash' = 'sha256:' || version_sha256
    AND payload->'review'->>'reviewHash' = 'sha256:' || review_sha256
    AND payload->>'createdAt' = pg_catalog.to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  )
);
CREATE INDEX IF NOT EXISTS idx_buying_center_versions_scope_account
  ON public.buying_center_versions
  (tenant_id, workspace_id, account_id, play_version_id, revision DESC);
CREATE INDEX IF NOT EXISTS idx_buying_center_versions_scope_review
  ON public.buying_center_versions (tenant_id, workspace_id, review_status, created_at DESC);

CREATE OR REPLACE FUNCTION public.novatrade_l05_contact_chain_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $function$
DECLARE parent_row public.contact_record_versions%ROWTYPE;
BEGIN
  IF NEW.supersedes_version_id IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO parent_row FROM public.contact_record_versions v
  WHERE v.version_id = NEW.supersedes_version_id;
  IF NOT FOUND OR parent_row.tenant_id IS DISTINCT FROM NEW.tenant_id
    OR parent_row.workspace_id IS DISTINCT FROM NEW.workspace_id
    OR parent_row.account_id IS DISTINCT FROM NEW.account_id
    OR parent_row.stable_key IS DISTINCT FROM NEW.stable_key
    OR parent_row.revision <> NEW.revision - 1 THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='L05_CONTACT_CHAIN_MISMATCH';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.novatrade_l05_center_chain_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $function$
DECLARE parent_row public.buying_center_versions%ROWTYPE;
BEGIN
  IF NEW.supersedes_version_id IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO parent_row FROM public.buying_center_versions v
  WHERE v.version_id = NEW.supersedes_version_id;
  IF NOT FOUND OR parent_row.tenant_id IS DISTINCT FROM NEW.tenant_id
    OR parent_row.workspace_id IS DISTINCT FROM NEW.workspace_id
    OR parent_row.account_id IS DISTINCT FROM NEW.account_id
    OR parent_row.play_version_id IS DISTINCT FROM NEW.play_version_id
    OR parent_row.stable_key IS DISTINCT FROM NEW.stable_key
    OR parent_row.revision <> NEW.revision - 1 THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='L05_CENTER_CHAIN_MISMATCH';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.novatrade_l05_versioned_review_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $function$
BEGIN
  IF NEW.version_id IS DISTINCT FROM OLD.version_id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id OR NEW.account_id IS DISTINCT FROM OLD.account_id
    OR NEW.stable_key IS DISTINCT FROM OLD.stable_key OR NEW.revision IS DISTINCT FROM OLD.revision
    OR NEW.supersedes_version_id IS DISTINCT FROM OLD.supersedes_version_id
    OR NEW.content_sha256 IS DISTINCT FROM OLD.content_sha256
    OR NEW.version_sha256 IS DISTINCT FROM OLD.version_sha256
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='L05_VERSION_IDENTITY_IMMUTABLE';
  END IF;
  IF NEW.review_sha256 = OLD.review_sha256 THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='L05_REVIEW_STALE_UPDATE';
  END IF;
  IF NOT ((OLD.review_status = 'draft' AND NEW.review_status = 'in_review')
    OR (OLD.review_status = 'in_review' AND NEW.review_status IN ('approved', 'rejected'))) THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='L05_REVIEW_INVALID_TRANSITION';
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_contact_record_versions_chain ON public.contact_record_versions;
CREATE TRIGGER trg_contact_record_versions_chain BEFORE INSERT ON public.contact_record_versions
FOR EACH ROW EXECUTE FUNCTION public.novatrade_l05_contact_chain_guard();
DROP TRIGGER IF EXISTS trg_contact_record_versions_review ON public.contact_record_versions;
CREATE TRIGGER trg_contact_record_versions_review BEFORE UPDATE ON public.contact_record_versions
FOR EACH ROW EXECUTE FUNCTION public.novatrade_l05_versioned_review_guard();
DROP TRIGGER IF EXISTS trg_contact_record_versions_immutable ON public.contact_record_versions;
CREATE TRIGGER trg_contact_record_versions_immutable BEFORE DELETE
ON public.contact_record_versions FOR EACH ROW EXECUTE FUNCTION public.novatrade_l05_immutable();
DROP TRIGGER IF EXISTS trg_buying_center_versions_chain ON public.buying_center_versions;
CREATE TRIGGER trg_buying_center_versions_chain BEFORE INSERT ON public.buying_center_versions
FOR EACH ROW EXECUTE FUNCTION public.novatrade_l05_center_chain_guard();
DROP TRIGGER IF EXISTS trg_buying_center_versions_review ON public.buying_center_versions;
CREATE TRIGGER trg_buying_center_versions_review BEFORE UPDATE ON public.buying_center_versions
FOR EACH ROW EXECUTE FUNCTION public.novatrade_l05_versioned_review_guard();
DROP TRIGGER IF EXISTS trg_buying_center_versions_immutable ON public.buying_center_versions;
CREATE TRIGGER trg_buying_center_versions_immutable BEFORE DELETE
ON public.buying_center_versions FOR EACH ROW EXECUTE FUNCTION public.novatrade_l05_immutable();

DO $security$
DECLARE target_table text; target_role text; target_function text;
BEGIN
  FOREACH target_table IN ARRAY ARRAY['contact_record_versions', 'buying_center_versions'] LOOP
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
    'public.novatrade_l05_contact_chain_guard()', 'public.novatrade_l05_center_chain_guard()'
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

COMMENT ON TABLE public.contact_record_versions IS
  'Immutable contact-record versions: identity plus role hypothesis, provenance receipt, permitted-use state, freshness, suppression, and review history in one hash-verified document.';
COMMENT ON TABLE public.buying_center_versions IS
  'Immutable buying-center versions per account and play: confidence-scored role hypotheses that stay distinct from verified contact references.';

DO $receipt$
DECLARE table_count integer; rls_count integer; policy_count integer; trigger_count integer;
BEGIN
  SELECT count(*) INTO table_count FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind = 'r'
    AND c.relname = ANY (ARRAY['contact_record_versions', 'buying_center_versions']);
  SELECT count(*) INTO rls_count FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relrowsecurity AND c.relforcerowsecurity
    AND c.relname = ANY (ARRAY['contact_record_versions', 'buying_center_versions']);
  SELECT count(*) INTO policy_count FROM pg_catalog.pg_policy p
  WHERE p.polrelid = ANY (ARRAY[
    'public.contact_record_versions'::regclass, 'public.buying_center_versions'::regclass]);
  SELECT count(*) INTO trigger_count FROM pg_catalog.pg_trigger t
  WHERE NOT t.tgisinternal AND t.tgrelid = ANY (ARRAY[
    'public.contact_record_versions'::regclass, 'public.buying_center_versions'::regclass]);
  IF table_count <> 2 OR rls_count <> 2 OR policy_count <> 0 OR trigger_count <> 4 THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='L05_CONTACTS_CENTERS_CATALOG_INCOMPLETE';
  END IF;
END;
$receipt$;
COMMIT;
