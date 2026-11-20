#!/usr/bin/env node
// Demo dataset seed for the local-demo tenant (interview / walkthrough data).
//
// Inserts a deterministic Colorado trades dataset (plumbing, electrical, HVAC,
// roofing) into the tenant created by scripts/seed-local-tenant.mjs so that
// Explorer, Workbench (/queue), Leads, Statistics, Dashboard and Scheduler
// render meaningful data. Idempotent: every row uses a fixed `demo-*` id and is
// upserted, so re-running converges instead of duplicating.
//
// Usage (after `node scripts/local-supabase.mjs all` has written .env.local):
//   node --env-file=.env.local scripts/seed-demo-leads.mjs
//   node --env-file=.env.local scripts/seed-demo-leads.mjs --reset   # delete demo rows first
// `node scripts/local-supabase.mjs all` (or `... seed`) also runs it automatically.
//
// Same guard rails as seed-local-tenant.mjs: refuses non-loopback DATABASE_URL
// unless LOCAL_SEED_ALLOW_REMOTE=1, and requires the tenant foundation to exist.

import { argv, env, exit } from "node:process";
import postgres from "postgres";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

// Must match scripts/seed-local-tenant.mjs IDS.
const TENANT_ID = "10000000-0000-4000-8000-000000000001";
const ADMIN_ID = "12000000-0000-4000-8000-000000000001";
const RESEARCHER_ID = "12000000-0000-4000-8000-000000000002";
const MARKET_ID = "market-colorado";
// Lead ids are deterministic UUIDs: lead actions validate ids with z.string().uuid().
const DEMO_LEAD_ID_PREFIX = "de000000-0000-4000-8000-";

const CITIES = [
  { locality: "Denver", postal: "80205", lat: 39.7392, lng: -104.9903, area: "303" },
  { locality: "Boulder", postal: "80302", lat: 40.015, lng: -105.2705, area: "303" },
  { locality: "Colorado Springs", postal: "80903", lat: 38.8339, lng: -104.8214, area: "719" },
  { locality: "Fort Collins", postal: "80521", lat: 40.5853, lng: -105.0844, area: "970" },
  { locality: "Aurora", postal: "80012", lat: 39.7294, lng: -104.8319, area: "720" },
];

const TRADES = {
  plumbing: { primaryType: "plumber", categories: ["plumber", "home_goods_store"], deal: 2400 },
  electrical: { primaryType: "electrician", categories: ["electrician", "general_contractor"], deal: 2800 },
  hvac: { primaryType: "hvac_contractor", categories: ["hvac_contractor", "air_conditioning_contractor"], deal: 3200 },
  roofing: { primaryType: "roofing_contractor", categories: ["roofing_contractor", "general_contractor"], deal: 3600 },
};

// name, trade, city index, website status, pipeline status, assigned researcher?
const LEADS = [
  ["Mile High Plumbing Co.", "plumbing", 0, "none", "new", false],
  ["Front Range Drain & Sewer", "plumbing", 0, "social", "verified", true],
  ["Cherry Creek Pipe Pros", "plumbing", 0, "basic", "contacted", true],
  ["Flatirons Plumbing & Heating", "plumbing", 1, "none", "new", false],
  ["Pearl Street Rooter", "plumbing", 1, "custom", "closed_lost", false],
  ["Pikes Peak Plumbing", "plumbing", 2, "none", "preview_sent", true],
  ["Old Town Water Heater Repair", "plumbing", 3, "social", "new", false],
  ["Aurora Leak Detection", "plumbing", 4, "basic", "meeting_set", true],
  ["Rocky Mountain Electric", "electrical", 0, "none", "new", false],
  ["Highlands Electrical Services", "electrical", 0, "basic", "verified", false],
  ["Boulder Bright Electric", "electrical", 1, "none", "contacted", true],
  ["Garden of the Gods Electric", "electrical", 2, "social", "new", false],
  ["Springs Panel Upgrades", "electrical", 2, "none", "closed_won", true],
  ["Poudre Valley Electricians", "electrical", 3, "custom", "new", false],
  ["CSU Area Wiring Co.", "electrical", 3, "none", "verified", false],
  ["Aurora Spark Electric", "electrical", 4, "basic", "preview_sent", true],
  ["Denver Comfort HVAC", "hvac", 0, "basic", "contacted", true],
  ["Five Points Heating & Air", "hvac", 0, "none", "new", false],
  ["Chautauqua Climate Control", "hvac", 1, "social", "verified", false],
  ["Cheyenne Mountain Heating", "hvac", 2, "none", "meeting_set", true],
  ["Foothills Furnace Repair", "hvac", 3, "basic", "new", false],
  ["Horsetooth Air Conditioning", "hvac", 3, "none", "closed_won", true],
  ["Aurora Air Solutions", "hvac", 4, "custom", "new", false],
  ["Stapleton Swamp Cooler Service", "hvac", 4, "none", "verified", false],
  ["Summit Roofing Denver", "roofing", 0, "basic", "new", false],
  ["Capitol Hill Roof Repair", "roofing", 0, "none", "contacted", true],
  ["Boulder Hail Damage Roofing", "roofing", 1, "social", "new", false],
  ["Springs Storm Roofing", "roofing", 2, "none", "verified", false],
  ["Manitou Slate & Tile", "roofing", 2, "custom", "closed_lost", false],
  ["NoCo Roofing Contractors", "roofing", 3, "basic", "preview_sent", true],
  ["Aurora Gutter & Roof", "roofing", 4, "none", "new", false],
  ["Southlands Roofing Co.", "roofing", 4, "social", "new", false],
];

const STATUS_RANK = { new: 0, verified: 1, contacted: 2, preview_sent: 3, meeting_set: 4, closed_won: 5, closed_lost: 5 };

function fail(message) {
  console.error(`[seed-demo-leads] ${message}`);
  exit(1);
}

function assertLoopback(databaseUrl) {
  if (env.LOCAL_SEED_ALLOW_REMOTE === "1") return;
  const { hostname } = new URL(databaseUrl);
  if (!LOOPBACK_HOSTS.has(hostname)) {
    fail(`refusing to seed non-loopback target ${hostname}; set LOCAL_SEED_ALLOW_REMOTE=1 only for an approved disposable target`);
  }
}

const pad = (n) => String(n).padStart(3, "0");
const daysAgo = (d, hours = 0) => new Date(Date.now() - d * 86_400_000 - hours * 3_600_000);
const isoDate = (date) => date.toISOString().slice(0, 10);
const round = (n, digits = 1) => Math.round(n * 10 ** digits) / 10 ** digits;

function buildLead([name, trade, cityIndex, websiteStatus, status, assigned], index) {
  const city = CITIES[cityIndex];
  const spec = TRADES[trade];
  const id = `${DEMO_LEAD_ID_PREFIX}${String(index + 1).padStart(12, "0")}`;
  const seed = (index * 37 + 11) % 100;
  const rank = STATUS_RANK[status];
  const noSite = websiteStatus === "none" || websiteStatus === "social";
  const weakSite = websiteStatus === "basic";
  const rating = round(3.6 + (seed % 14) / 10);
  const reviewCount = 8 + ((seed * 7) % 240);
  const score = round(Math.min(98, (noSite ? 62 : weakSite ? 48 : 22) + (seed % 30) + rank * 2));
  const qualityBucket = websiteStatus === "custom"
    ? "not_a_fit"
    : weakSite
      ? "broken_site_opportunity"
      : rank >= 1 || seed % 3 !== 0 ? "ready_to_call" : "needs_ai_verify";
  const recommendedOffer = websiteStatus === "custom"
    ? "not_recommended"
    : weakSite ? "broken_site_rescue" : trade === "hvac" ? "booking_ready_site" : "local_service_site";
  const aiChecked = qualityBucket !== "needs_ai_verify";
  const aiStatus = !aiChecked ? "not_checked" : noSite ? "no_site_found" : weakSite ? "weak_site_found" : "site_found";
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
  const discovered = daysAgo(2 + (index % 28), index % 9);
  const contacted = rank >= 2 ? daysAgo(Math.max(0, (index % 28) - 1) % 10, 3) : null;
  const closed = status === "closed_won" || status === "closed_lost";
  const dealValue = spec.deal + (seed % 5) * 200;
  return {
    id,
    place_id: `demo-place-${pad(index + 1)}`,
    tenant_id: TENANT_ID,
    name,
    address: `${100 + seed * 13} ${["Main St", "Colfax Ave", "Broadway", "Pearl St", "College Ave"][cityIndex]}, ${city.locality}, CO ${city.postal}, USA`,
    phone: `(${city.area}) 555-${String(1000 + seed * 89).slice(0, 4)}`,
    categories: spec.categories,
    rating,
    review_count: reviewCount,
    website_uri: noSite ? (websiteStatus === "social" ? `https://facebook.com/${slug}` : null) : `https://${slug}.example.com`,
    website_status: websiteStatus,
    maps_uri: `https://maps.google.com/?cid=demo${pad(index + 1)}`,
    business_status: "OPERATIONAL",
    photo_count: 3 + (seed % 20),
    has_opening_hours: seed % 4 === 0 ? 0 : 1,
    primary_type: spec.primaryType,
    lat: round(city.lat + ((seed % 20) - 10) / 400, 5),
    lng: round(city.lng + ((seed % 17) - 8) / 400, 5),
    score,
    status,
    qualification_status: websiteStatus === "custom" ? "unqualified" : aiChecked ? "qualified" : "needs_verification",
    contactability_score: round(55 + (seed % 40)),
    estimated_deal_value: dealValue,
    business_type: trade,
    win_probability_score: round(Math.min(95, 20 + rank * 12 + (seed % 15))),
    ai_verification_status: aiStatus,
    ai_confidence: aiChecked ? round(0.62 + (seed % 35) / 100, 2) : 0,
    ai_summary: aiChecked
      ? `${name} is an established ${trade} business in ${city.locality} with ${reviewCount} reviews (${rating}★). ${noSite ? "No standalone website was found." : weakSite ? "Its website is a thin template with no booking path." : "It already runs a modern website."}`
      : null,
    ai_recommendation: aiChecked ? (websiteStatus === "custom" ? "skip" : "pitch") : null,
    ai_checked_at: aiChecked ? daysAgo(1 + (index % 6)) : null,
    ai_queue_status: aiChecked ? "done" : "queued",
    enrichment_status: aiChecked ? "enriched" : "pending",
    enriched_at: aiChecked ? daysAgo(1 + (index % 6), 2) : null,
    editorial_summary: `Family-owned ${trade} contractor serving ${city.locality} and nearby suburbs.`,
    discovered_at: discovered,
    created_at: discovered,
    updated_at: contacted ?? discovered,
    first_contacted_at: contacted,
    last_contacted_at: contacted,
    meeting_booked_at: rank >= 4 && status !== "closed_lost" ? daysAgo(index % 5) : null,
    demo_sent_at: rank >= 3 && status !== "closed_lost" ? daysAgo((index % 5) + 1) : null,
    reminder_date: assigned && !closed ? isoDate(daysAgo((index % 3) - 1)) : null,
    assigned_to_user_id: assigned ? RESEARCHER_ID : null,
    lead_quality_score: round(Math.min(99, score + (seed % 7))),
    quality_bucket: qualityBucket,
    easy_build_score: round(50 + (seed % 45)),
    cash_speed_score: round(40 + ((seed * 3) % 55)),
    need_score: round(noSite ? 70 + (seed % 25) : weakSite ? 55 + (seed % 25) : 15 + (seed % 20)),
    quality_reason: noSite
      ? "Strong reviews, no owned website — high need for a starter site."
      : weakSite ? "Website exists but is broken or thin; rescue opportunity." : "Already has a professional site.",
    recommended_offer: recommendedOffer,
    next_best_action: closed ? null : rank === 0 ? "Call to confirm owner and pitch starter site" : "Follow up on preview",
    phone_verification_status: rank >= 2 ? "works" : "unknown",
    raw_opportunity_score: round(score * 0.9),
    verification_score: aiChecked ? round(60 + (seed % 35)) : 0,
    sales_priority_score: round(score * 0.6 + rank * 5),
    pitch_outcome: closed ? status : null,
    decision_maker_reached: rank >= 3 ? 1 : 0,
    quoted_amount: rank >= 4 ? dealValue : 0,
    close_value: status === "closed_won" ? dealValue : 0,
    market_id: MARKET_ID,
    country_code: "US",
    admin_area1: "CO",
    admin_area2: `${city.locality} County`,
    locality: city.locality,
    postal_code: city.postal,
  };
}

function buildOutreach(leads) {
  const events = [];
  const outcomeFor = { contacted: "contacted", preview_sent: "demo_sent", meeting_set: "meeting_set", closed_won: "closed_won", closed_lost: "closed_lost" };
  for (const lead of leads) {
    if (!lead.first_contacted_at) continue;
    const actor = lead.assigned_to_user_id ?? ADMIN_ID;
    const actorEmail = actor === RESEARCHER_ID ? "researcher" : "admin";
    events.push({
      id: `demo-outreach-${lead.id.slice(-3)}-1`,
      lead_id: lead.id,
      channel: "call",
      outcome: "left_voicemail",
      note: "Left voicemail with office manager.",
      actor_user_id: actor,
      actor_email: actorEmail,
      created_at: new Date(lead.first_contacted_at.getTime() - 2 * 86_400_000),
    });
    events.push({
      id: `demo-outreach-${lead.id.slice(-3)}-2`,
      lead_id: lead.id,
      channel: lead.status === "preview_sent" ? "email" : "call",
      outcome: outcomeFor[lead.status] ?? "contacted",
      note: lead.status === "closed_won" ? "Signed starter-site package." : "Spoke with owner; interested in a mobile-friendly site.",
      actor_user_id: actor,
      actor_email: actorEmail,
      decision_maker_reached: lead.decision_maker_reached,
      quoted_amount: lead.quoted_amount,
      close_value: lead.close_value,
      created_at: lead.first_contacted_at,
    });
  }
  return events;
}

async function main() {
  const databaseUrl = env.DATABASE_URL?.trim();
  if (!databaseUrl) fail("DATABASE_URL is required (run with --env-file=.env.local)");
  assertLoopback(databaseUrl);
  const reset = argv.includes("--reset");

  const sql = postgres(databaseUrl, { max: 1, prepare: false, onnotice: () => undefined, connect_timeout: 10 });
  try {
    const [tenant] = await sql`SELECT id FROM public.tenants WHERE id = ${TENANT_ID} AND status = 'active'`;
    if (!tenant) fail(`tenant ${TENANT_ID} not found; run scripts/seed-local-tenant.mjs (node scripts/local-supabase.mjs seed) first`);
    const [market] = await sql`SELECT id FROM public.location_markets WHERE id = ${MARKET_ID} AND status = 'active'`;
    if (!market) fail(`location market ${MARKET_ID} missing; apply migrations first`);

    const leads = LEADS.map(buildLead);
    const outreach = buildOutreach(leads);

    await sql.begin(async (tx) => {
      if (reset) {
        await tx`DELETE FROM public.crawl_runs WHERE tenant_id = ${TENANT_ID} AND id LIKE 'demo-%'`;
        await tx`DELETE FROM public.leads WHERE tenant_id = ${TENANT_ID} AND id LIKE ${`${DEMO_LEAD_ID_PREFIX}%`}`;
      }
      // Earlier revisions of this seed used non-UUID `demo-lead-NNN` ids.
      await tx`DELETE FROM public.leads WHERE tenant_id = ${TENANT_ID} AND id LIKE 'demo-lead-%'`;

      for (const lead of leads) {
        const columns = Object.keys(lead);
        const updatable = columns.filter((c) => !["id", "tenant_id", "place_id"].includes(c));
        await tx`
          INSERT INTO public.leads ${tx(lead, columns)}
          ON CONFLICT (id) DO UPDATE SET ${tx.unsafe(updatable.map((c) => `${c} = EXCLUDED.${c}`).join(", "))}`;
      }

      for (const event of outreach) {
        const row = { tenant_id: TENANT_ID, decision_maker_reached: 0, quoted_amount: 0, close_value: 0, ...event };
        await tx`
          INSERT INTO public.outreach_events ${tx(row)}
          ON CONFLICT (id) DO UPDATE SET outcome = EXCLUDED.outcome, note = EXCLUDED.note, created_at = EXCLUDED.created_at,
            decision_maker_reached = EXCLUDED.decision_maker_reached, quoted_amount = EXCLUDED.quoted_amount, close_value = EXCLUDED.close_value`;
      }

      const notes = leads.filter((lead) => lead.assigned_to_user_id).map((lead) => ({
        id: `demo-note-${lead.id.slice(-3)}`,
        lead_id: lead.id,
        tenant_id: TENANT_ID,
        author_user_id: RESEARCHER_ID,
        body: `Owner prefers calls before 9am. ${lead.quality_reason}`,
        created_at: lead.updated_at,
        updated_at: lead.updated_at,
      }));
      for (const note of notes) {
        await tx`INSERT INTO public.lead_notes ${tx(note)} ON CONFLICT (id) DO UPDATE SET body = EXCLUDED.body`;
      }

      // Researchers only see leads in markets they are granted.
      await tx`
        INSERT INTO public.user_market_access (user_id, market_id, tenant_id, workspace_id, created_by_user_id)
        VALUES (${RESEARCHER_ID}, ${MARKET_ID}, ${TENANT_ID}, NULL, ${ADMIN_ID})
        ON CONFLICT (tenant_id, workspace_id, user_id, market_id) DO NOTHING`;

      // Scheduler history: one finished run and one in progress, generalized
      // (city-level) units so no zip/cell catalog rows are required.
      const runs = [
        { id: "demo-run-001", status: "done", name: "Colorado trades sweep", started: daysAgo(6), ended: daysAgo(6, -3), discovered: 24, api: 40 },
        { id: "demo-run-002", status: "running", name: "Colorado HVAC + roofing refresh", started: daysAgo(0, 1), ended: null, discovered: 8, api: 14 },
      ];
      for (const run of runs) {
        await tx`
          INSERT INTO public.crawl_runs (id, tenant_id, mode, status, categories, started_at, ended_at, discovered_count,
            enriched_count, api_calls_used, market_id, name, scope_label, created_by_user_id, created_at, updated_at)
          VALUES (${run.id}, ${TENANT_ID}, 'coverage', ${run.status}, ${tx.json(Object.keys(TRADES))}, ${run.started}, ${run.ended},
            ${run.discovered}, ${Math.floor(run.discovered * 0.75)}, ${run.api}, ${MARKET_ID}, ${run.name}, 'Colorado, US', ${ADMIN_ID},
            ${run.started}, ${run.ended ?? run.started})
          ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, started_at = EXCLUDED.started_at, ended_at = EXCLUDED.ended_at,
            discovered_count = EXCLUDED.discovered_count, enriched_count = EXCLUDED.enriched_count,
            api_calls_used = EXCLUDED.api_calls_used, updated_at = EXCLUDED.updated_at`;
        let unitIndex = 0;
        for (const city of CITIES) {
          for (const trade of Object.keys(TRADES)) {
            unitIndex += 1;
            const unitStatus = run.status === "done" ? "done" : unitIndex <= 6 ? "done" : unitIndex === 7 ? "running" : "pending";
            const found = unitStatus === "done" ? 1 + (unitIndex % 3) : 0;
            await tx`
              INSERT INTO public.crawl_units (id, crawl_run_id, zip, category, keyword, status, attempt_count, discovered_count,
                started_at, finished_at, market_id, country_code, query_location_label, location_mode, pages_fetched,
                raw_places_seen, new_places_seen, duplicate_places_seen)
              VALUES (${`${run.id}-u${pad(unitIndex)}`}, ${run.id}, ${city.postal}, ${TRADES[trade].primaryType}, ${trade},
                ${unitStatus}, ${unitStatus === "pending" ? 0 : 1}, ${found},
                ${unitStatus === "pending" ? null : run.started}, ${unitStatus === "done" ? (run.ended ?? new Date()) : null},
                ${MARKET_ID}, 'US', ${`${city.locality}, CO`}, 'generalized', ${unitStatus === "done" ? 1 : 0},
                ${found * 3}, ${found}, ${found * 2})
              ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, discovered_count = EXCLUDED.discovered_count,
                started_at = EXCLUDED.started_at, finished_at = EXCLUDED.finished_at`;
          }
        }
      }
    });

    const [counts] = await sql`
      SELECT
        (SELECT count(*) FROM public.leads WHERE tenant_id = ${TENANT_ID} AND id LIKE ${`${DEMO_LEAD_ID_PREFIX}%`})::int AS leads,
        (SELECT count(*) FROM public.leads WHERE tenant_id = ${TENANT_ID} AND assigned_to_user_id = ${RESEARCHER_ID})::int AS assigned,
        (SELECT count(*) FROM public.outreach_events WHERE tenant_id = ${TENANT_ID} AND id LIKE 'demo-%')::int AS outreach,
        (SELECT count(*) FROM public.lead_notes WHERE tenant_id = ${TENANT_ID} AND id LIKE 'demo-%')::int AS notes,
        (SELECT count(*) FROM public.crawl_runs WHERE tenant_id = ${TENANT_ID} AND id LIKE 'demo-%')::int AS runs,
        (SELECT count(*) FROM public.crawl_units WHERE tenant_id = ${TENANT_ID} AND id LIKE 'demo-%')::int AS units`;
    console.log(`[seed-demo-leads] seeded demo dataset for tenant ${TENANT_ID}: ${counts.leads} leads (${counts.assigned} assigned to researcher), ${counts.outreach} outreach events, ${counts.notes} notes, ${counts.runs} crawl runs / ${counts.units} units`);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  } finally {
    await sql.end({ timeout: 1 });
  }
}

void main();
