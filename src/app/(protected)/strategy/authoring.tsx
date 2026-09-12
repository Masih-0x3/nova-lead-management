"use client";

import { useState, useTransition } from "react";

import type { UnderstandingClaimOption } from "./page";
import { createIcpAction, createPlayAction } from "./actions";

const ICP_DOMAINS = [
  "job", "pain", "positive_signal", "disqualifier", "size_capability", "geography",
  "channel", "buying_trigger", "economics", "evidence_threshold", "buying_center_role", "custom",
] as const;

const REF = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;

function Field(props: Readonly<{ label: string; children: React.ReactNode; hint?: string }>) {
  return (
    <label className="block min-w-0 text-sm">
      <span className="section-label">{props.label}</span>
      {props.children}
      {props.hint ? <span className="mt-1 block text-xs" style={{ color: "var(--text-tertiary)" }}>{props.hint}</span> : null}
    </label>
  );
}

function TextInput(props: Readonly<{ value: string; onChange: (value: string) => void; required?: boolean; placeholder?: string }>) {
  return (
    <input
      className="glass-input mt-1 w-full"
      value={props.value}
      required={props.required}
      placeholder={props.placeholder}
      onChange={(event) => props.onChange(event.target.value)}
    />
  );
}

function TextArea(props: Readonly<{ value: string; onChange: (value: string) => void; rows?: number; required?: boolean }>) {
  return (
    <textarea
      className="glass-input mt-1 w-full"
      rows={props.rows ?? 2}
      value={props.value}
      required={props.required}
      onChange={(event) => props.onChange(event.target.value)}
    />
  );
}

function Select(props: Readonly<{ value: string; onChange: (value: string) => void; options: readonly string[] }>) {
  return (
    <select className="glass-input mt-1 w-full" value={props.value} onChange={(event) => props.onChange(event.target.value)}>
      {props.options.map((option) => <option key={option} value={option}>{option.replaceAll("_", " ")}</option>)}
    </select>
  );
}

function refsForClaims(claims: readonly UnderstandingClaimOption[], claimIds: ReadonlySet<string>) {
  return claims
    .filter((claim) => claimIds.has(claim.claimId))
    .flatMap((claim) => claim.evidenceIds.map((evidenceId) => ({ claimId: claim.claimId, evidenceId })));
}

function ClaimPicker(props: Readonly<{
  claims: readonly UnderstandingClaimOption[];
  selected: ReadonlySet<string>;
  onToggle: (claimId: string) => void;
  label: string;
}>) {
  return (
    <fieldset className="min-w-0 rounded-xl border p-3" style={{ borderColor: "var(--surface-card-border)" }}>
      <legend className="section-label px-1">{props.label}</legend>
      {props.claims.length === 0 ? (
        <p className="text-xs" style={{ color: "var(--text-tertiary)" }}>
          No claims are available — the approved understanding carries no evidenced facts.
        </p>
      ) : (
        <ul className="mt-1 max-h-48 space-y-2 overflow-y-auto" aria-label={props.label}>
          {props.claims.map((claim) => (
            <li key={claim.claimId}>
              <label className="flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border p-2"
                style={{ borderColor: "var(--table-row-border)", background: "var(--surface-muted)" }}>
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={props.selected.has(claim.claimId)}
                  onChange={() => props.onToggle(claim.claimId)}
                />
                <span className="min-w-0">
                  <span className="block break-words text-xs font-medium" style={{ color: "var(--text-primary)" }}>{claim.statement}</span>
                  <span className="mt-0.5 block break-all font-mono text-[0.65rem]" style={{ color: "var(--text-tertiary)" }}>
                    {claim.domain} · {claim.claimId} · {claim.evidenceIds.length} evidence
                  </span>
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}
    </fieldset>
  );
}

type CriterionRow = Readonly<{
  id: string;
  domain: string;
  rule: string;
  rationale: string;
  confidencePct: number;
  claimIds: ReadonlySet<string>;
}>;

type UncertaintyRow = Readonly<{
  id: string;
  domain: string;
  statement: string;
  impact: string;
  claimIds: ReadonlySet<string>;
}>;

type HypothesisRow = Readonly<{
  id: string;
  queryFamily: string;
  statement: string;
  rationale: string;
  claimIds: ReadonlySet<string>;
}>;

let rowCounter = 0;
function nextRowId(prefix: string): string {
  rowCounter += 1;
  return `${prefix}:${rowCounter}:${Math.random().toString(36).slice(2, 8)}`;
}

function toggleClaim(set: ReadonlySet<string>, claimId: string): ReadonlySet<string> {
  const next = new Set(set);
  if (next.has(claimId)) next.delete(claimId); else next.add(claimId);
  return next;
}

function updateRow<T extends { id: string }>(rows: readonly T[], id: string, patch: Partial<T>): T[] {
  return rows.map((row) => row.id === id ? { ...row, ...patch } : row);
}

export function IcpAuthoringForm(props: Readonly<{
  understandingVersionId: string;
  claims: readonly UnderstandingClaimOption[];
  busy: boolean;
  onDone: (message: string) => void;
}>) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [stableKey, setStableKey] = useState("icp:main");
  const [title, setTitle] = useState("");
  const [segment, setSegment] = useState("");
  const [useCase, setUseCase] = useState("");
  const [criteria, setCriteria] = useState<readonly CriterionRow[]>([]);
  const [exclusions, setExclusions] = useState<readonly CriterionRow[]>([]);
  const [uncertainties, setUncertainties] = useState<readonly UncertaintyRow[]>([]);

  const addCriterion = (kind: "include" | "exclude") => {
    const row: CriterionRow = {
      id: nextRowId(kind === "include" ? "icp-criterion" : "icp-exclusion"),
      domain: kind === "include" ? "positive_signal" : "disqualifier",
      rule: "", rationale: "", confidencePct: 50, claimIds: new Set(),
    };
    if (kind === "include") setCriteria([...criteria, row]); else setExclusions([...exclusions, row]);
  };

  const toCriterionPayload = (row: CriterionRow, index: number, prefix: string) => ({
    criterionId: `${prefix}:${index + 1}`,
    ruleKey: `${row.domain}:${index + 1}`,
    domain: row.domain,
    rule: row.rule.trim(),
    rationale: row.rationale.trim(),
    confidenceBasisPoints: Math.round(row.confidencePct * 100),
    rationaleRefs: refsForClaims(props.claims, row.claimIds),
  });

  const submit = () => {
    if (!REF.test(stableKey)) { setError("Stable key must match [A-Za-z0-9._:@/-] and start alphanumeric."); return; }
    if (title.trim().length === 0 || segment.trim().length === 0 || useCase.trim().length === 0) {
      setError("Title, segment, and use case are required."); return;
    }
    if (criteria.length === 0) { setError("At least one inclusion criterion is required."); return; }
    const invalid = [...criteria, ...exclusions].find((row) =>
      row.rule.trim().length === 0 || row.rationale.trim().length === 0 || row.claimIds.size === 0);
    if (invalid) { setError("Every criterion needs a rule, a rationale, and at least one evidence claim."); return; }
    const badUncertainty = uncertainties.find((row) =>
      row.statement.trim().length === 0 || row.impact.trim().length === 0 || row.claimIds.size === 0);
    if (badUncertainty) { setError("Every uncertainty needs a statement, an impact, and related claims."); return; }
    setError(null);
    startTransition(async () => {
      const result = await createIcpAction({
        stableKey: stableKey.trim(),
        understandingVersionId: props.understandingVersionId,
        title: title.trim(),
        segment: segment.trim(),
        useCase: useCase.trim(),
        positiveCriteria: criteria.map((row, index) => toCriterionPayload(row, index, "criterion")),
        exclusions: exclusions.map((row, index) => toCriterionPayload(row, index, "exclusion")),
        uncertainties: uncertainties.map((row, index) => ({
          uncertaintyId: `uncertainty:${index + 1}`,
          domain: row.domain,
          statement: row.statement.trim(),
          impact: row.impact.trim(),
          relatedClaimIds: [...row.claimIds].sort(),
        })),
      });
      if (result.ok) props.onDone(result.message); else setError(result.message);
    });
  };

  const busy = pending || props.busy;
  return (
    <div className="mt-4 space-y-4 rounded-xl border p-4" style={{ borderColor: "var(--surface-card-border)" }}
      role="group" aria-label="New ICP draft">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Stable key" hint="Stable identity across revisions, e.g. icp:main.">
          <TextInput value={stableKey} onChange={setStableKey} required />
        </Field>
        <Field label="Title"><TextInput value={title} onChange={setTitle} required /></Field>
      </div>
      <Field label="Segment"><TextInput value={segment} onChange={setSegment} required /></Field>
      <Field label="Use case"><TextArea value={useCase} onChange={setUseCase} required /></Field>

      <CriterionList
        title="Inclusion criteria"
        rows={criteria}
        claims={props.claims}
        onAdd={() => addCriterion("include")}
        onChange={(rows) => setCriteria(rows)}
      />
      <CriterionList
        title="Exclusion criteria"
        rows={exclusions}
        claims={props.claims}
        onAdd={() => addCriterion("exclude")}
        onChange={(rows) => setExclusions(rows)}
      />
      <UncertaintyList
        rows={uncertainties}
        claims={props.claims}
        withDomain
        onAdd={() => setUncertainties([...uncertainties, {
          id: nextRowId("icp-uncertainty"), domain: "custom", statement: "", impact: "", claimIds: new Set(),
        }])}
        onChange={setUncertainties}
      />

      {error && <p role="alert" className="text-sm" style={{ color: "var(--danger-text)" }}>{error}</p>}
      <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
        <button type="button" className="btn-primary min-h-11" disabled={busy} onClick={submit}>
          {busy ? "Working…" : "Create ICP draft"}
        </button>
      </div>
    </div>
  );
}

function CriterionList(props: Readonly<{
  title: string;
  rows: readonly CriterionRow[];
  claims: readonly UnderstandingClaimOption[];
  onAdd: () => void;
  onChange: (rows: readonly CriterionRow[]) => void;
}>) {
  return (
    <section className="space-y-3" aria-label={props.title}>
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>{props.title}</h3>
        <button type="button" className="btn-glass min-h-11 text-sm" onClick={props.onAdd}>Add</button>
      </div>
      {props.rows.length === 0 && (
        <p className="text-xs" style={{ color: "var(--text-tertiary)" }}>None added yet.</p>
      )}
      <ul className="space-y-3">
        {props.rows.map((row, index) => (
          <li key={row.id} className="space-y-3 rounded-xl border p-3" style={{ borderColor: "var(--table-row-border)", background: "var(--surface-muted)" }}>
            <div className="flex items-center justify-between gap-3">
              <p className="section-label">Rule {index + 1}</p>
              <button type="button" className="btn-glass min-h-11 text-sm"
                onClick={() => props.onChange(props.rows.filter((item) => item.id !== row.id))}>
                Remove
              </button>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Domain">
                <Select value={row.domain} options={ICP_DOMAINS}
                  onChange={(domain) => props.onChange(updateRow(props.rows, row.id, { domain }))} />
              </Field>
              <Field label="Confidence" hint={`${row.confidencePct}%`}>
                <input type="range" min={0} max={100} value={row.confidencePct} aria-label="Confidence percent"
                  className="mt-3 w-full"
                  onChange={(event) => props.onChange(updateRow(props.rows, row.id, { confidencePct: Number(event.target.value) }))} />
              </Field>
            </div>
            <Field label="Rule">
              <TextArea value={row.rule} rows={2}
                onChange={(rule) => props.onChange(updateRow(props.rows, row.id, { rule }))} />
            </Field>
            <Field label="Rationale">
              <TextArea value={row.rationale} rows={2}
                onChange={(rationale) => props.onChange(updateRow(props.rows, row.id, { rationale }))} />
            </Field>
            <ClaimPicker claims={props.claims} selected={row.claimIds} label={`Evidence claims for rule ${index + 1}`}
              onToggle={(claimId) => props.onChange(updateRow(props.rows, row.id, { claimIds: toggleClaim(row.claimIds, claimId) }))} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function UncertaintyList(props: Readonly<{
  rows: readonly UncertaintyRow[];
  claims: readonly UnderstandingClaimOption[];
  withDomain?: boolean;
  onAdd: () => void;
  onChange: (rows: readonly UncertaintyRow[]) => void;
}>) {
  return (
    <section className="space-y-3" aria-label="Uncertainties">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>Uncertainties</h3>
        <button type="button" className="btn-glass min-h-11 text-sm" onClick={props.onAdd}>Add</button>
      </div>
      {props.rows.length === 0 && (
        <p className="text-xs" style={{ color: "var(--text-tertiary)" }}>None recorded.</p>
      )}
      <ul className="space-y-3">
        {props.rows.map((row, index) => (
          <li key={row.id} className="space-y-3 rounded-xl border p-3" style={{ borderColor: "var(--table-row-border)", background: "var(--surface-muted)" }}>
            <div className="flex items-center justify-between gap-3">
              <p className="section-label">Uncertainty {index + 1}</p>
              <button type="button" className="btn-glass min-h-11 text-sm"
                onClick={() => props.onChange(props.rows.filter((item) => item.id !== row.id))}>
                Remove
              </button>
            </div>
            {props.withDomain && (
              <Field label="Domain">
                <Select value={row.domain} options={ICP_DOMAINS}
                  onChange={(domain) => props.onChange(updateRow(props.rows, row.id, { domain }))} />
              </Field>
            )}
            <Field label="Statement">
              <TextArea value={row.statement} rows={2}
                onChange={(statement) => props.onChange(updateRow(props.rows, row.id, { statement }))} />
            </Field>
            <Field label="Impact">
              <TextArea value={row.impact} rows={2}
                onChange={(impact) => props.onChange(updateRow(props.rows, row.id, { impact }))} />
            </Field>
            <ClaimPicker claims={props.claims} selected={row.claimIds} label={`Related claims for uncertainty ${index + 1}`}
              onToggle={(claimId) => props.onChange(updateRow(props.rows, row.id, { claimIds: toggleClaim(row.claimIds, claimId) }))} />
          </li>
        ))}
      </ul>
    </section>
  );
}

export function LeadPlayAuthoringForm(props: Readonly<{
  icpVersionId: string;
  icpTitle: string;
  claims: readonly UnderstandingClaimOption[];
  busy: boolean;
  onDone: (message: string) => void;
}>) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [stableKey, setStableKey] = useState("play:main");
  const [title, setTitle] = useState("");
  const [objective, setObjective] = useState("");
  const [motion, setMotion] = useState("");
  const [sources, setSources] = useState("");
  const [maxAccounts, setMaxAccounts] = useState("50");
  const [maxRequests, setMaxRequests] = useState("500");
  const [maxSpend, setMaxSpend] = useState("0");
  const [hypotheses, setHypotheses] = useState<readonly HypothesisRow[]>([]);
  const [rationaleClaimIds, setRationaleClaimIds] = useState<ReadonlySet<string>>(new Set());
  const [uncertainties, setUncertainties] = useState<readonly UncertaintyRow[]>([]);

  const submit = () => {
    if (!REF.test(stableKey)) { setError("Stable key must match [A-Za-z0-9._:@/-] and start alphanumeric."); return; }
    if (title.trim().length === 0 || objective.trim().length === 0 || motion.trim().length === 0) {
      setError("Title, objective, and motion are required."); return;
    }
    if (hypotheses.length === 0) { setError("At least one search hypothesis is required."); return; }
    const badHypothesis = hypotheses.find((row) =>
      row.statement.trim().length === 0 || row.queryFamily.trim().length === 0
      || row.rationale.trim().length === 0 || row.claimIds.size === 0);
    if (badHypothesis) { setError("Every hypothesis needs a query family, statement, rationale, and evidence claims."); return; }
    const sourceList = sources.split(",").map((item) => item.trim()).filter((item) => item.length > 0);
    if (sourceList.length === 0) { setError("At least one allowed source is required."); return; }
    if (sourceList.some((item) => !REF.test(item))) { setError("Every source key must match the reference format."); return; }
    if (rationaleClaimIds.size === 0) { setError("Select at least one evidence claim for the play rationale."); return; }
    const accounts = Number(maxAccounts);
    const requests = Number(maxRequests);
    const spendCents = Math.round(Number(maxSpend) * 100);
    if (!Number.isSafeInteger(accounts) || accounts < 1 || accounts > 10_000
      || !Number.isSafeInteger(requests) || requests < 1 || requests > 10_000
      || !Number.isSafeInteger(spendCents) || spendCents < 0 || spendCents > 100_000_000) {
      setError("Bounds must be integers: accounts 1–10000, requests 1–10000, spend ≥ $0."); return;
    }
    const badUncertainty = uncertainties.find((row) =>
      row.statement.trim().length === 0 || row.impact.trim().length === 0 || row.claimIds.size === 0);
    if (badUncertainty) { setError("Every uncertainty needs a statement, an impact, and related claims."); return; }
    setError(null);
    startTransition(async () => {
      const result = await createPlayAction({
        stableKey: stableKey.trim(),
        icpVersionId: props.icpVersionId,
        title: title.trim(),
        objective: objective.trim(),
        motion: motion.trim(),
        searchHypotheses: hypotheses.map((row, index) => ({
          hypothesisId: `hypothesis:${index + 1}`,
          queryFamily: row.queryFamily.trim(),
          statement: row.statement.trim(),
          rationale: row.rationale.trim(),
          rationaleRefs: refsForClaims(props.claims, row.claimIds),
        })),
        sourceAllowlist: sourceList,
        bounds: { maxAccounts: accounts, maxProviderRequests: requests, maxSpendCents: spendCents },
        rationaleRefs: refsForClaims(props.claims, rationaleClaimIds),
        uncertainties: uncertainties.map((row, index) => ({
          uncertaintyId: `uncertainty:${index + 1}`,
          statement: row.statement.trim(),
          impact: row.impact.trim(),
          relatedClaimIds: [...row.claimIds].sort(),
        })),
      });
      if (result.ok) props.onDone(result.message); else setError(result.message);
    });
  };

  const busy = pending || props.busy;
  return (
    <div className="mt-4 space-y-4 rounded-xl border p-4" style={{ borderColor: "var(--surface-card-border)" }}
      role="group" aria-label="New lead-play draft">
      <p className="text-xs" style={{ color: "var(--text-tertiary)" }}>
        Bound to approved ICP “{props.icpTitle}”. Outreach mode is fixed to draft-only.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Stable key" hint="Stable identity across revisions, e.g. play:main.">
          <TextInput value={stableKey} onChange={setStableKey} required />
        </Field>
        <Field label="Title"><TextInput value={title} onChange={setTitle} required /></Field>
      </div>
      <Field label="Objective"><TextInput value={objective} onChange={setObjective} required /></Field>
      <Field label="Motion"><TextArea value={motion} onChange={setMotion} required /></Field>
      <Field label="Allowed sources" hint="Comma-separated source keys, e.g. connector:linkedin, connector:news.">
        <TextInput value={sources} onChange={setSources} required placeholder="connector:a, connector:b" />
      </Field>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Max accounts">
          <TextInput value={maxAccounts} onChange={setMaxAccounts} required />
        </Field>
        <Field label="Max provider requests">
          <TextInput value={maxRequests} onChange={setMaxRequests} required />
        </Field>
        <Field label="Max spend (USD)">
          <TextInput value={maxSpend} onChange={setMaxSpend} required />
        </Field>
      </div>

      <section className="space-y-3" aria-label="Search hypotheses">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>Search hypotheses</h3>
          <button type="button" className="btn-glass min-h-11 text-sm"
            onClick={() => setHypotheses([...hypotheses, {
              id: nextRowId("play-hypothesis"), queryFamily: "", statement: "", rationale: "", claimIds: new Set(),
            }])}>
            Add
          </button>
        </div>
        {hypotheses.length === 0 && <p className="text-xs" style={{ color: "var(--text-tertiary)" }}>None added yet.</p>}
        <ul className="space-y-3">
          {hypotheses.map((row, index) => (
            <li key={row.id} className="space-y-3 rounded-xl border p-3" style={{ borderColor: "var(--table-row-border)", background: "var(--surface-muted)" }}>
              <div className="flex items-center justify-between gap-3">
                <p className="section-label">Hypothesis {index + 1}</p>
                <button type="button" className="btn-glass min-h-11 text-sm"
                  onClick={() => setHypotheses(hypotheses.filter((item) => item.id !== row.id))}>
                  Remove
                </button>
              </div>
              <Field label="Query family">
                <TextInput value={row.queryFamily} placeholder="e.g. hiring-signals"
                  onChange={(queryFamily) => setHypotheses(updateRow(hypotheses, row.id, { queryFamily }))} />
              </Field>
              <Field label="Statement">
                <TextArea value={row.statement} rows={2}
                  onChange={(statement) => setHypotheses(updateRow(hypotheses, row.id, { statement }))} />
              </Field>
              <Field label="Rationale">
                <TextArea value={row.rationale} rows={2}
                  onChange={(rationale) => setHypotheses(updateRow(hypotheses, row.id, { rationale }))} />
              </Field>
              <ClaimPicker claims={props.claims} selected={row.claimIds} label={`Evidence claims for hypothesis ${index + 1}`}
                onToggle={(claimId) => setHypotheses(updateRow(hypotheses, row.id, { claimIds: toggleClaim(row.claimIds, claimId) }))} />
            </li>
          ))}
        </ul>
      </section>

      <ClaimPicker claims={props.claims} selected={rationaleClaimIds} label="Play-level rationale claims"
        onToggle={(claimId) => setRationaleClaimIds(toggleClaim(rationaleClaimIds, claimId))} />

      <UncertaintyList
        rows={uncertainties}
        claims={props.claims}
        onAdd={() => setUncertainties([...uncertainties, {
          id: nextRowId("play-uncertainty"), domain: "custom", statement: "", impact: "", claimIds: new Set(),
        }])}
        onChange={setUncertainties}
      />

      {error && <p role="alert" className="text-sm" style={{ color: "var(--danger-text)" }}>{error}</p>}
      <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
        <button type="button" className="btn-primary min-h-11" disabled={busy} onClick={submit}>
          {busy ? "Working…" : "Create lead-play draft"}
        </button>
      </div>
    </div>
  );
}
