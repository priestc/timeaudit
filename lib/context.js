/*
 * lib/context.js — presentation-only "sentence before/after" context for the
 * viewer, in the same spirit as lib/shots.js: this is derived *after* the
 * analysis JSON exists, from the report + the cached wiki page, using local
 * software (the same sentence scan the extractor and the claim finder use).
 * It is never part of the SPEC JSON.
 *
 * How it works: re-run wiki.extractClaims() (with includeRejected, so every
 * date-mentioning sentence is covered, not just the ones that became claims)
 * against the cached wiki HTML for the report's page, then match each
 * claim's own wikipedia_text_verbatim against the resulting sentences'
 * sentence_cited text. A match carries the same context_before/after the
 * claim finder shows.
 *
 * Best-effort: returns {} (no context shown) if the wiki page was never
 * cached (ai-only mode doesn't populate source-cache) or can't be read.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const wiki = require("./wiki");

// report + cacheRoot -> { claim_id: { before: [...], after: [...] } }
function buildContextMap(report, cacheRoot) {
  const out = {};
  const claims = (report && report.claims) || [];
  if (!claims.length) return out;

  const slug = wiki.slugify((report.page && report.page.title) || "page");
  const htmlPath = path.join(cacheRoot, "_wikipedia", slug + ".html");
  let html;
  try {
    html = fs.readFileSync(htmlPath, "utf8");
  } catch {
    return out;
  }

  let scanned;
  try {
    const page = {
      title: (report.page && report.page.title) || "",
      url: (report.page && report.page.url) || "",
      html,
    };
    scanned = wiki.extractClaims(page, { includeRejected: true, maxClaims: 100000 });
  } catch {
    return out;
  }

  const bySentence = new Map();
  scanned.claims.concat(scanned.rejected).forEach((c) => {
    if (!bySentence.has(c.sentence_cited)) bySentence.set(c.sentence_cited, c);
  });

  claims.forEach((claim) => {
    const hit = bySentence.get(claim.wikipedia_text_verbatim);
    if (hit && ((hit.context_before && hit.context_before.length) || (hit.context_after && hit.context_after.length))) {
      out[claim.claim_id] = { before: hit.context_before || [], after: hit.context_after || [] };
    }
  });
  return out;
}

module.exports = { buildContextMap };
