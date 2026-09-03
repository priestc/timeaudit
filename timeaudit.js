#!/usr/bin/env node
/*
 * timeaudit — generate a Wikipedia chronology extraction report (see SPEC.md).
 *
 *   timeaudit https://en.wikipedia.org/wiki/Ancient_Egypt
 *
 * Pipeline (local-first; external AI only fills the gaps, and only if a key is set):
 *   1. fetch the page via the MediaWiki API                         [local]
 *   2. find sentences making a numerical age claim                  [local]
 *   3. apply the 1450 CE cutoff                                     [local]
 *   4. parse each cited source from the embedded COinS metadata     [local]
 *   5. download + cache every reachable source under source-cache/  [local]
 *   6. heuristically classify dating method, lab codes, ranges      [local]
 *   7. follow onward citations found inside sources (multi-hop)     [local]
 *   8. one AI call per claim to confirm scope + pick quotes         [AI, optional]
 *   9. write <slug>.json                                          [local]
 *  10. copy the report + all cached material to the tank2 folder    [local]
 *
 * Options:
 *   --out <dir>        where to write <slug>.json         (default: cwd)
 *   --cache <dir>      source-cache root       (default: <out>/source-cache)
 *   --max-claims <n>   cap claims processed                (default: 60)
 *   --depth <n>        max citation-chain hops             (default: 3)
 *   --downloads <n>    max source downloads this run       (default: 40)
 *   --email <addr>     contact email for Unpaywall OA lookup
 *                      (default: $TIMEAUDIT_CONTACT_EMAIL; omitted => no OA lookup)
 *   --ai / --no-ai     force the AI gap-filler on / off   (default: on iff ANTHROPIC_API_KEY)
 *   --no-sync          do not copy anything to tank2
 *   --push             also run `node db.js push` afterwards
 *   --quiet
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const { loadEnv } = require("./lib/env");
loadEnv();

const wiki = require("./lib/wiki");
const scholar = require("./lib/scholar");
const assemble = require("./lib/assemble");
const ai = require("./lib/ai");
const sync = require("./lib/sync");

const HELP = `timeaudit — generate a Wikipedia chronology extraction report (see SPEC.md)

  timeaudit <wikipedia-url> [options]
  timeaudit https://en.wikipedia.org/wiki/Ancient_Egypt

Modes (recorded in the report's "generator.mode" field, for tracking which
approach works best over time):

  --mode local     only the local software: page fetch, claim detection, 1450 CE
                   cutoff, citation parsing, source download + caching,
                   dating-method heuristics, multi-hop DOI chasing. No AI.
  --mode hybrid    local pipeline + one AI call per claim to confirm scope and
                   pick load-bearing quotes (default when ANTHROPIC_API_KEY set)
  --mode ai-only   no local analysis — hand the model just the Wikipedia URL and
                   a link to SPEC.md and let it build the whole report itself
                   (using web search / fetch). Needs ANTHROPIC_API_KEY.

  aliases: --no-ai = --mode local,  --ai = --mode hybrid,  --ai-only = --mode ai-only

Options:
  --out <dir>        where to write <slug>.json          (default: cwd)
  --cache <dir>      source-cache root      (default: <out>/source-cache)
  --max-claims <n>   cap claims processed  (local/hybrid)  (default: 60)
  --depth <n>        max citation-chain hops (local/hybrid) (default: 3)
  --downloads <n>    max source downloads this run          (default: 40)
  --email <addr>     contact email for Unpaywall OA lookup
                     (default: $TIMEAUDIT_CONTACT_EMAIL; omitted => skip Unpaywall)
  --no-sync          do not copy anything to the tank2 folder
  --push             also run \`node db.js push\` afterwards
  --quiet
`;

function parseArgs(argv) {
  const o = {
    url: null,
    out: process.cwd(),
    cache: null,
    maxClaims: 60,
    depth: 3,
    downloads: 40,
    email: process.env.TIMEAUDIT_CONTACT_EMAIL || null,
    mode: null, // resolved after parsing
    sync: true,
    push: false,
    quiet: false,
  };
  const MODES = ["local", "hybrid", "ai-only"];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") o.out = path.resolve(argv[++i]);
    else if (a === "--cache") o.cache = path.resolve(argv[++i]);
    else if (a === "--max-claims") o.maxClaims = parseInt(argv[++i], 10);
    else if (a === "--depth") o.depth = parseInt(argv[++i], 10);
    else if (a === "--downloads") o.downloads = parseInt(argv[++i], 10);
    else if (a === "--email") o.email = argv[++i];
    else if (a === "--mode") {
      o.mode = argv[++i];
      if (!MODES.includes(o.mode)) throw new Error("--mode must be one of: " + MODES.join(", "));
    } else if (a === "--no-ai" || a === "--local") o.mode = "local";
    else if (a === "--ai" || a === "--hybrid") o.mode = "hybrid";
    else if (a === "--ai-only") o.mode = "ai-only";
    else if (a === "--no-sync") o.sync = false;
    else if (a === "--push") o.push = true;
    else if (a === "--quiet") o.quiet = true;
    else if (a === "-h" || a === "--help") o.help = true;
    else if (!a.startsWith("-") && !o.url) o.url = a;
    else throw new Error("unknown argument: " + a);
  }
  if (!o.cache) o.cache = path.join(o.out, "source-cache");
  return o;
}

function focusExcerpt(text, size = 3500) {
  if (!text) return "";
  const re = /radiocarbon|luminescence|\bOSL\b|dendro|uranium[-\s]?(?:series|thorium)|argon|thermolumin|calibrat|\bcal\.?\s?BP\b|seriation|typolog/i;
  const m = text.match(re);
  const at = m ? Math.max(0, m.index - Math.floor(size / 3)) : 0;
  return text.slice(at, at + size).trim();
}

async function main() {
  const opt = parseArgs(process.argv.slice(2));
  if (opt.help || !opt.url) {
    process.stdout.write(HELP);
    process.exit(opt.help ? 0 : 1);
  }
  const mode = opt.mode || (ai.available() ? "hybrid" : "local");
  if ((mode === "hybrid" || mode === "ai-only") && !ai.available()) {
    throw new Error("--mode " + mode + " needs ANTHROPIC_API_KEY (set it in .env, or use --mode local)");
  }
  const useAI = mode === "hybrid";
  const log = (...a) => !opt.quiet && process.stderr.write(a.join(" ") + "\n");
  log("• mode: " + mode + (mode === "local" ? " (no AI)" : " (" + ai.MODEL + ")"));

  log("• fetching", opt.url);
  const page = await wiki.fetchPage(opt.url, { cacheDir: opt.cache });
  log("  " + page.title + "  (rev " + page.revid + ")");

  /* ---------------- ai-only: model builds the whole report ---------------- */
  if (mode === "ai-only") {
    log("• handing the URL + SPEC.md to " + ai.MODEL + " (web search/fetch enabled) — this can take several minutes");
    const r = await ai.generateReport({ wikiUrl: page.url, specUrl: assemble.SPEC_URL });
    log("  model made " + r.searches + " web tool call(s); stop_reason=" + r.stop_reason);
    if (!r.json) {
      const rawPath = path.join(opt.out, page.slug + ".ai-only.raw.txt");
      fs.mkdirSync(opt.out, { recursive: true });
      fs.writeFileSync(rawPath, r.raw || "(empty response)");
      throw new Error("model did not return parseable JSON — raw response saved to " + rawPath);
    }
    const gen = assemble.generatorBlock("ai-only", {
      ai_model: r.model,
      ai_usage: r.usage,
      web_tool_calls: r.searches,
      stop_reason: r.stop_reason,
    });
    const doc = assemble.wrapAiOnly(page, r.json, gen);
    fs.mkdirSync(opt.out, { recursive: true });
    const jsonPath = path.join(opt.out, page.slug + ".json");
    fs.writeFileSync(jsonPath, JSON.stringify(doc, null, 2) + "\n");
    const byStatus = (doc.claims || []).reduce((m, c) => ((m[c.status] = (m[c.status] || 0) + 1), m), {});
    log("• wrote " + path.relative(process.cwd(), jsonPath) + "  (" + (doc.claims || []).length + " claims: " + JSON.stringify(byStatus) + ")");
    log("  note: ai-only mode does not populate the local source-cache");
    await finish(opt, jsonPath, log);
    return;
  }

  const refIdx = wiki.buildReferenceIndex(page.html);
  const rawClaims = wiki.extractClaims(page, { maxClaims: opt.maxClaims });
  log("• " + rawClaims.length + " candidate dated claim(s) in scope" + (rawClaims.length >= opt.maxClaims ? " (capped)" : ""));
  if (mode === "local") log("  chains needing judgement will stay 'pending' (no AI in this mode)");
  if (!scholar.havePdftotext()) log("  ! pdftotext not found — PDF sources will not be text-mined");

  // screenshot each claim's sentence on the rendered Wikipedia page (its own
  // citation markers, infobox, layout — where the quote is actually taken from)
  if (page.pdfPath) {
    const wdir = path.join(opt.cache, "_wikipedia");
    const wbase = path.join("source-cache", "_wikipedia", page.slug);
    const fullByPage = {};
    for (let ci = 0; ci < rawClaims.length; ci++) {
      const c = rawClaims[ci];
      const relCrop = wbase + ".claim" + (ci + 1) + ".png";
      const shot = scholar.snapshotQuote(page.pdfPath, c.sentence, path.join(wdir, path.basename(relCrop)));
      if (!shot) continue;
      c.wikipedia_quote_image = "/" + relCrop.replace(/\\/g, "/");
      if (!(shot.page in fullByPage)) {
        const relFull = wbase + ".p" + shot.page + ".png";
        const ok = scholar.snapshotPage(page.pdfPath, shot.page, path.join(wdir, path.basename(relFull)));
        fullByPage[shot.page] = ok ? "/" + relFull.replace(/\\/g, "/") : null;
      }
      c.wikipedia_quote_page_image = fullByPage[shot.page];
    }
    log("• wikipedia page screenshots: " + rawClaims.filter((c) => c.wikipedia_quote_image).length + "/" + rawClaims.length);
  }

  const budget = { left: opt.downloads };
  const claims = [];

  for (let ci = 0; ci < rawClaims.length; ci++) {
    const c = rawClaims[ci];
    log("\n[" + (ci + 1) + "/" + rawClaims.length + "] " + c.section + " :: " + c.sentence.slice(0, 90) + "…");

    // resolve markers -> footnote text + source; split hop-worthy vs note-only
    const hopSources = [];
    for (const mk of c.markers) {
      mk.footnoteText = refIdx.markerText(mk.noteId);
      if (refIdx.isNoteOnly(mk.noteId, mk.label)) continue;
      const src = refIdx.source(mk.noteId);
      if (!src) continue;
      const worthy = src.author || src._doi || src.year || (src.title && !src._sparse) || src.retrieval_url;
      if (worthy && !hopSources.some((h) => sameSource(h, src))) hopSources.push(src);
    }

    c.hops = [];
    let status = "pending";

    if (!hopSources.length) {
      c.status = "pending";
      c.notes = { extraction_note: "no citation with resolvable source metadata on this sentence" };
      claims.push(c);
      continue;
    }

    // hop 1: the Wikipedia-cited source
    const visited = new Set();
    let frontier = { source: hopSources[0], cited_by: "Wikipedia footnote " + c.markers.map((m) => "[" + m.label + "]").filter((v, i, a) => a.indexOf(v) === i).join("") };
    for (let hop = 1; hop <= opt.depth && frontier; hop++) {
      const src = frontier.source;
      [src._doi, src.retrieval_url].filter(Boolean).forEach((k) => visited.add(k));
      log("   hop " + hop + ": " + shortCite(src));
      const dl = await scholar.fetchSource(src, { cacheDir: opt.cache, pageSlug: page.slug, email: opt.email, budget });
      if (dl.status === "downloaded" || dl.status === "cached") {
        src.local_cache_path = "/" + dl.rel.replace(/\\/g, "/");
        src.retrieval_status = dl.status === "cached" ? src.retrieval_status : "not_independently_verified";
        log("      " + dl.status + (dl.via ? " via " + dl.via : "") + " -> " + dl.rel);
      } else {
        src.retrieval_status = dl.status === "unreachable" ? "unreachable" : src.retrieval_status;
        log("      " + dl.status);
      }
      const text = dl.file ? scholar.extractText(dl.file, dl.contentType) : "";
      const cls = scholar.classifyText(text, c);
      const hopObj = {
        hop_index: hop,
        cited_by: frontier.cited_by,
        // hop > 1 is only ever reached by finding a DOI printed *in* the previous
        // source's own text (SPEC rule 6 — explicit citations only); this is the
        // surrounding reference text.
        citation_in_previous_verbatim: hop === 1 ? null : frontier.citationVerbatim || null,
        source: src,
        structured_facts: cls.structured_facts,
        verbatim_quotes: [],
        is_terminal: cls.is_terminal,
        terminal_type: cls.terminal_type,
        _classify: cls,
        _excerpt: focusExcerpt(text),
        _pdfPath: dl.file && (dl.contentType === "pdf" || /\.pdf$/i.test(dl.file)) ? dl.file : null,
      };
      c.hops.push(hopObj);

      if (cls.is_terminal) {
        status = "resolved";
        break;
      }
      if (dl.status === "unreachable" && hop === 1) status = "dead_end";

      // onward lead for the next hop (skip anything already in this chain)
      const leads = scholar.findOnwardLeads(text).filter((l) => !visited.has(l.value) && !visited.has(l.url));
      const lead = leads.find((l) => l.near_method) || leads[0];
      if (!lead || budget.left <= 0) {
        frontier = null;
      } else {
        frontier = {
          cited_by: "onward citation found in " + (src.local_cache_path || shortCite(src)) + (lead.near_method ? " (near dating-method text)" : ""),
          citationVerbatim: lead.context || null,
          source: {
            author: null, title: null, container_work: null, publisher_or_journal: null,
            year: null, pages: null, identifier: "doi:" + lead.value, document_type: "journal_article",
            retrieval_url: lead.url, retrieval_status: "not_independently_verified",
            is_public_domain: null, local_cache_path: null, _doi: lead.value,
          },
        };
      }
    }

    c.status = status;

    // optional AI pass
    if (useAI) {
      try {
        const r = await ai.refineClaim(c);
        if (r) {
          if (r.in_scope === false) {
            log("   ✗ AI: not an in-scope pre-1450 age claim — dropped");
            continue;
          }
          if (r.status) c.status = r.status;
          for (const [k, arr] of Object.entries(r.quotes || {})) {
            const h = c.hops[parseInt(k, 10) - 1];
            if (h) h.verbatim_quotes = arr;
          }
          if (r.terminal_hop && c.hops[r.terminal_hop - 1]) {
            const h = c.hops[r.terminal_hop - 1];
            h.is_terminal = true;
            h.terminal_type = r.terminal_type || h.terminal_type;
          }
          c.notes = Object.assign(c.notes || {}, { ai_note: r.notes || null, ai_model: r._model });
          log("   ✓ AI: status=" + c.status + (r.terminal_hop ? " terminal@hop" + r.terminal_hop + " (" + r.terminal_type + ")" : ""));
        }
      } catch (e) {
        log("   ! AI call failed (" + e.message + ") — keeping local result");
      }
    } else {
      // promote heuristic quotes when running without AI, capped per SPEC
      for (const h of c.hops) {
        if (!h.verbatim_quotes.length && h._classify.candidate_quotes.length) {
          h.verbatim_quotes = h._classify.candidate_quotes.slice(0, h.source.is_public_domain ? 8 : 3);
        }
      }
    }

    // screenshot each final quote as it appears in the source PDF (original
    // font), plus the whole page it sits on (running heads, page numbers, other
    // columns and all — authenticity), shared across quotes on the same page
    for (const h of c.hops) {
      h.quote_images = [];
      h.quote_page_images = [];
      if (!h._pdfPath || !h.verbatim_quotes.length) continue;
      const base = path.basename(h._pdfPath, ".pdf");
      const dir = path.join(opt.cache, page.slug);
      const fullByPage = {};
      h.verbatim_quotes.forEach((q, qi) => {
        const relCrop = path.join("source-cache", page.slug, base + ".h" + h.hop_index + "q" + (qi + 1) + ".png");
        const shot = scholar.snapshotQuote(h._pdfPath, q, path.join(dir, path.basename(relCrop)));
        h.quote_images[qi] = shot ? "/" + relCrop.replace(/\\/g, "/") : null;
        if (!shot) {
          h.quote_page_images[qi] = null;
          return;
        }
        log("      quote shot: " + relCrop + " (p." + shot.page + ")");
        if (!(shot.page in fullByPage)) {
          const relFull = path.join("source-cache", page.slug, base + ".p" + shot.page + ".png");
          const ok = scholar.snapshotPage(h._pdfPath, shot.page, path.join(dir, path.basename(relFull)));
          fullByPage[shot.page] = ok ? "/" + relFull.replace(/\\/g, "/") : null;
          if (ok) log("      full page:  " + relFull);
        }
        h.quote_page_images[qi] = fullByPage[shot.page];
      });
    }

    // NOTE: the shared technical-log is disabled for now (it will return later —
    // assemble.mergeTechnicalLog is kept for when it does). claim.technical_log_refs
    // stays [] and no technical-log.json is written.

    claims.push(c);
  }

  // ---- assemble ----
  const gen = assemble.generatorBlock(mode, { ai_model: useAI ? ai.MODEL : null });
  const doc = assemble.buildDocument(page, claims, gen);
  fs.mkdirSync(opt.out, { recursive: true });
  const jsonPath = path.join(opt.out, page.slug + ".json");
  fs.writeFileSync(jsonPath, JSON.stringify(doc, null, 2) + "\n");

  const byStatus = doc.claims.reduce((m, c) => ((m[c.status] = (m[c.status] || 0) + 1), m), {});
  log("\n• wrote " + path.relative(process.cwd(), jsonPath) + "  (" + doc.claims.length + " claims: " + JSON.stringify(byStatus) + ")");

  await finish(opt, jsonPath, log);
  log("\nDone [" + mode + "]. Review " + path.relative(process.cwd(), jsonPath) +
    (mode === "local" ? " — heuristic output; 'pending' chains need --mode hybrid or a human." : "."));
}

// sync the report + source cache to tank2, then optional db push
async function finish(opt, jsonPath, log) {
  if (opt.sync) {
    try {
      const done = sync.syncToTank2({ jsonPath, cacheDir: opt.cache });
      log("• synced to " + sync.HOST + ":");
      done.forEach((d) => log("    " + d));
    } catch (e) {
      log("! sync to tank2 failed: " + (e.stderr ? e.stderr.toString() : e.message));
    }
  }
  if (opt.push) {
    try {
      execFileSync("node", [path.join(__dirname, "db.js"), "push", opt.out], { stdio: "inherit" });
    } catch (e) {
      log("! db.js push failed: " + e.message);
    }
  }
}

function sameSource(a, b) {
  if (a._doi && b._doi) return a._doi === b._doi;
  return (a.title || "") === (b.title || "") && (a.year || "") === (b.year || "");
}
function shortCite(s) {
  const au = Array.isArray(s.author) ? s.author[0] : s.author;
  return [au, s.year, (s.title || s.retrieval_url || "?").slice(0, 50)].filter(Boolean).join(" ");
}

main().catch((e) => {
  const msg = process.env.TIMEAUDIT_DEBUG && e && e.stack ? e.stack : e && e.message ? e.message : String(e);
  process.stderr.write("\ntimeaudit: " + msg + "\n");
  process.exit(1);
});
