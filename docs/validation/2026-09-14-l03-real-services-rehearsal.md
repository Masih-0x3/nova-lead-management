# L-03 real-service rehearsal (Supabase Storage + clamd)

Date: 2026-09-14
Branch: `Masih-0x3/nova-release-services`
Status: implemented and locally validated; pending independent parent review

## What this proves

The L-03 document intake runtime wired to real services, not mocks:

- signed-upload reservation, direct-to-provider upload, bounded read, and
  quarantine-object write against a real `supabase/storage-api` private
  bucket over TLS;
- clean verdict and standard EICAR detection against a real `clamd` daemon
  over the `IDSESSION`/`INSTREAM` protocol with strict framed-reply parsing;
- signed-capability path rebinding rejected by the provider;
- quarantine objects unreachable without the service role (no anonymous,
  no unauthenticated, no public-path reads);
- refused clamd connections mapped to retryable `scanner_error`;
- unapproved live engine version refused (non-retryable policy error);
- checksum drift between leased and stored bytes failed closed;
- tenant binding enforced on delete and read;
- delete returns `removed: true`, repeat delete reports `removed: false`;
- reservation requests outside the capability contract rejected;
- extraction and citations only after a real clean scan — a benign CSV is
  re-read over private HTTPS by the production executor and yields evidence
  citations with source locators; an infected or scanner-error outcome never
  reaches extraction, and a forged lease with drifted checksum is refused by
  the executor's re-verification (`content_checksum_mismatch`, no output).

The extraction denial is a faithful composition: the in-memory request
fixture stands in for `novatrade_request_document_extraction` /
`novatrade_claim_document_extraction_job`. Those RPC predicates —
version must be `clean`/`extraction_failed` with a bound
`status='clean' AND verdict='clean'` scan job, plus lease-generation and
tenant fencing — are exercised on disposable Postgres by
`src/lib/__tests__/document-pipeline-l03-postgres.test.ts`.

## How to run

```bash
node scripts/l03-real-services.mjs --receipt /path/to/receipt.json
node scripts/l03-real-services.mjs --help
```

Requirements: Node 24 and a container CLI (`CONTAINER_CLI`, else `docker`,
else `podman`). The harness pulls `postgres:16-alpine`,
`supabase/storage-api`, `clamav/clamav`, and `node:24` images.

The run is fully disposable: unique run id, owned labels, a private network
with no published host ports, mkdtemp state (`0700`) holding the rehearsal
CA, JWTs, and cert material, and verified teardown of every owned resource
before the receipt is written. The receipt is the only surviving artifact —
no raw logs, env values, JWTs, or keys.

Security note: clamd's wire protocol is unauthenticated, unencrypted TCP.
In production it must live on a private network reachable only by the app
runtime — the same private-network posture this rehearsal provisions.
TLS is verified against a dedicated rehearsal CA; nothing disables
certificate validation globally.

The suite itself is `src/lib/__tests__/document-l03-real-services.test.ts`,
env-gated behind `NOVA_L03_REAL_SERVICES=1` and exercised from inside the
container network by the harness.

## Runtime configuration

Production wiring is selected by env (see `.env.example`):

- `NOVA_DOCUMENT_STORAGE_BACKEND=supabase` + `NOVA_DOCUMENT_SCANNER_BACKEND=clamd`
  select the real providers; any incomplete or contradictory combination
  fails closed at startup.
- `NOVA_DOCUMENT_STORAGE_BACKEND=local` / `NOVA_DOCUMENT_SCANNER_BACKEND=local`
  are honored only with `NOVA_DOCUMENT_LOCAL_ACCEPTANCE=1` — an explicit
  local-acceptance opt-in, never a silent fallback.
