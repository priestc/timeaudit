/*
 * assemble.js — shape the extracted + traced data into the SPEC.md JSON:
 * the per-page document and entries for the shared technical log.
 */
"use strict";

const fs = require("fs");

function claimIdPrefix(title) {
  const words = String(title).split(/\s+/).filter((w) => /^[A-Za-z]/.test(w));
  let p = words.map((w) => w[0].toUpperCase()).join("").replace(/[^A-Z]/g, "");
  if (p.length < 2) p = String(title).replace(/[^A-Za-z]/g, "").slice(0, 3).toUpperCase();
  return p.slice(0, 4) || "PG";
}

function cleanSource(s) {
  if (!s) return null;
  const out = {
    author: s.author ?? null,
    title: s.title ?? null,
    container_work: s.container_work ?? null,
    publisher_or_journal: s.publisher_or_journal ?? null,
    year: s.year ?? null,
    pages: s.pages ?? null,
    identifier: s.identifier ?? null,
    document_type: s.document_type || "other",
    retrieval_url: s.retrieval_url ?? null,
    retrieval_status: s.retrieval_status || "not_independently_verified",
    is_public_domain: s.is_public_domain ?? null,
    local_cache_path: s.local_cache_path ?? null,
  };
  if (typeof out.year === "string") {
    const y = out.year.match(/\d{4}/);
    out.year = y ? parseInt(y[0], 10) : null;
  }
  return out;
}

function buildHop(hop, i) {
  return {
    hop_index: hop.hop_index,
    cited_by: hop.cited_by,
    // for hop_index > 1: does the previous hop's document explicitly cite this
    // source, and if so what does its reference read verbatim?
    explicitly_cited_by_previous:
      i === 0 ? null : hop.explicitly_cited_by_previous == null ? null : !!hop.explicitly_cited_by_previous,
    citation_in_previous_verbatim: i === 0 ? null : hop.citation_in_previous_verbatim || null,
    source: cleanSource(hop.source),
    structured_facts: hop.structured_facts || {},
    verbatim_quotes: (hop.verbatim_quotes || []).slice(0, hop.source && hop.source.is_public_domain ? 8 : 3),
    is_terminal: !!hop.is_terminal,
    terminal_type: hop.terminal_type || null,
  };
}

function buildClaim(prefix, n, claim) {
  const id = prefix + "-" + String(n).padStart(3, "0");
  const footnotes = {};
  for (const mk of claim.markers || []) {
    if (!(mk.label in footnotes)) footnotes[mk.label] = mk.footnoteText || null;
  }
  const chain = (claim.hops || []).map(buildHop);
  const structured = {};
  if (claim.cutoff && claim.cutoff.note) structured.cutoff_note = claim.cutoff.note;
  if (claim.cutoff && claim.cutoff.ambiguous) structured.cutoff_basis = claim.cutoff.basis;
  if (claim.notes) Object.assign(structured, claim.notes);

  const out = {
    claim_id: id,
    wikipedia_text_verbatim: claim.sentence,
    location_on_page: claim.section,
    citation_markers: [...new Set((claim.markers || []).map((m) => m.label))],
    citation_footnotes_verbatim: footnotes,
    citation_chain: chain,
    status: claim.status || "pending",
    technical_log_refs: claim.technical_log_refs || [],
  };
  if (Object.keys(structured).length) out.structured_facts = structured;
  return out;
}

const SPEC_URL = "https://github.com/priestc/timeaudit/blob/main/SPEC.md";

// mode: "local" | "hybrid" | "ai-only"
function generatorBlock(mode, extra = {}) {
  return Object.assign(
    {
      tool: "timeaudit",
      mode,
      generated_at: new Date().toISOString(),
      spec_url: SPEC_URL,
      ai_model: null,
    },
    extra
  );
}

function buildDocument(page, claims, generator) {
  const prefix = claimIdPrefix(page.title);
  return {
    schema_version: "1.0",
    generator: generator || generatorBlock("local"),
    page: {
      title: page.title,
      url: page.url,
      retrieved_at: page.retrievedAt || new Date().toISOString().slice(0, 10),
      wikipedia_revision_id: page.revid ? String(page.revid) : null,
    },
    claims: claims.map((c, i) => buildClaim(prefix, i + 1, c)),
  };
}

// Take whatever JSON the model returned in ai-only mode and force it into the
// SPEC shape: our page metadata, our generator block, its claims.
function wrapAiOnly(page, modelJson, generator) {
  const claims = Array.isArray(modelJson && modelJson.claims) ? modelJson.claims : [];
  return {
    schema_version: "1.0",
    generator,
    page: {
      title: page.title,
      url: page.url,
      retrieved_at: page.retrievedAt || new Date().toISOString().slice(0, 10),
      wikipedia_revision_id: page.revid ? String(page.revid) : null,
    },
    claims,
  };
}

/* --------------------------------------------------- shared technical log --- */

function loadTechnicalLog(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, "utf8"));
    if (Array.isArray(j.entries)) return j;
  } catch {
    /* new */
  }
  return { schema_version: "1.0", entries: [] };
}

function nextTechId(log) {
  let max = 0;
  for (const e of log.entries) {
    const m = String(e.id || "").match(/^T(\d+)$/);
    if (m) max = Math.max(max, +m[1]);
  }
  return max + 1;
}

// entryDrafts: [{ source_page, claim_ref, hop, terminal }]
function mergeTechnicalLog(file, drafts) {
  const log = loadTechnicalLog(file);
  let id = nextTechId(log);
  const added = [];
  for (const d of drafts) {
    const src = d.hop.source || {};
    const f = d.hop.structured_facts || {};
    // de-dup: same publishing source + claim_ref already present?
    const pubShort =
      (Array.isArray(src.author) ? src.author[0] : src.author || "") +
      (src.year ? " " + src.year : "") +
      (src.title ? ": " + String(src.title).slice(0, 40) : "");
    if (log.entries.some((e) => e.claim_ref === d.claim_ref && e.publishing_source === pubShort)) continue;
    const entry = {
      id: "T" + id++,
      source_page: d.source_page,
      claim_ref: d.claim_ref,
      site: d.site || null,
      project_or_excavation: null,
      years_active: null,
      director_or_lead: Array.isArray(src.author) ? src.author : src.author ? [src.author] : null,
      publishing_source: pubShort || (src.title || "unknown"),
      sample_count: f.sample_count_mentioned ?? null,
      sample_material: f.sample_material ?? null,
      method:
        d.hop.terminal_type === "radiocarbon"
          ? "radiocarbon"
          : d.hop.terminal_type || "unspecified physical method",
      calibration_method: (f.date_expressions_found || []).some((x) => /cal|OxCal|IntCal/i.test(x))
        ? "calibrated (see quotes)"
        : null,
      laboratory: f.laboratory_named ?? null,
      lab_code_prefixes: f.lab_codes
        ? [...new Set(f.lab_codes.map((c) => c.replace(/[-\s]?\d.*$/, "")))]
        : null,
      funding: null,
      earliest_date_reported: (f.date_expressions_found || [])[0] || null,
      latest_date_reported: (f.date_expressions_found || []).slice(-1)[0] || null,
      notes:
        "Auto-extracted by timeaudit from " +
        (d.hop.source && d.hop.source.local_cache_path ? d.hop.source.local_cache_path : "cited source") +
        "; heuristic classification, not human-verified.",
    };
    log.entries.push(entry);
    added.push(entry.id);
  }
  return { log, added };
}

module.exports = {
  buildDocument,
  buildClaim,
  claimIdPrefix,
  mergeTechnicalLog,
  loadTechnicalLog,
  generatorBlock,
  wrapAiOnly,
  SPEC_URL,
};
