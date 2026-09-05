#!/usr/bin/env node
/*
 * timeaudit — generate a Wikipedia chronology extraction report (see SPEC.md).
 *
 *   timeaudit https://en.wikipedia.org/wiki/Ancient_Egypt
 *
 * The analysis has three phases. The code currently implements phases 1 and 2:
 *
 *   PHASE 1 — parse the article for dated "claims" and classify them
 *     1. fetch the page via the MediaWiki API
 *     2. find sentences making a numerical age claim
 *     3. apply the 1450 CE cutoff
 *     4. parse each cited source from the embedded COinS metadata
 *   PHASE 2 — follow the Wikipedia citations and download the raw source text
 *     5. download + cache every reachable cited source under source-cache/
 *        (direct URL, Wikipedia archive-url, OA lookups, Wayback Machine)
 *     6. extract the plain text of each downloaded source (kept for phase 3)
 *   PHASE 3 — read through those sources and classify the dating evidence
 *     NOT YET IMPLEMENTED. Returns once phase-2 source retrieval is stronger.
 *     Until then: one hop per cited source, no multi-hop citation chasing, no
 *     terminal-method classification, no text-mined quotes; every traced claim
 *     is "retrieved" (at least one cited source downloaded), "dead_end" (every
 *     cited source unreachable), or "no_source" (nothing citable on the
 *     sentence). ("resolved" / "pending" are phase-3 outcomes and do not occur.)
 *   then: write <slug>.json and copy the report + cache to the tank2 folder
 *
 * Options:
 *   --out <dir>        where to write <slug>.json         (default: cwd)
 *   --cache <dir>      source-cache root       (default: <out>/source-cache)
 *   --max-claims <n>   cap claims processed                (default: 60)
 *   --downloads <n>    max source downloads this run       (default: 40)
 *   --email <addr>     contact email for Unpaywall OA lookup
 *                      (default: $TIMEAUDIT_CONTACT_EMAIL; omitted => no OA lookup)
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

  --mode local     the local software, phases 1-2 only: page fetch, claim
                   detection, 1450 CE cutoff, citation parsing, and downloading
                   the raw text of every cited source (with Wayback fallback).
                   No AI. This is the default.
  --mode ai-only   no local analysis — hand the model just the Wikipedia URL and
                   a link to SPEC.md and let it build the whole report itself
                   (using web search / fetch). Needs ANTHROPIC_API_KEY.

  alias: --no-ai / --local = --mode local,  --ai-only = --mode ai-only

Options:
  --out <dir>        where to write <slug>.json          (default: cwd)
  --cache <dir>      source-cache root      (default: <out>/source-cache)
  --max-claims <n>   cap claims processed                  (default: 60)
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
    downloads: 40,
    email: process.env.TIMEAUDIT_CONTACT_EMAIL || null,
    mode: null, // resolved after parsing
    sync: true,
    push: false,
    quiet: false,
  };
  const MODES = ["local", "ai-only"];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") o.out = path.resolve(argv[++i]);
    else if (a === "--cache") o.cache = path.resolve(argv[++i]);
    else if (a === "--max-claims") o.maxClaims = parseInt(argv[++i], 10);
    else if (a === "--downloads") o.downloads = parseInt(argv[++i], 10);
    else if (a === "--email") o.email = argv[++i];
    else if (a === "--mode") {
      o.mode = argv[++i];
      if (!MODES.includes(o.mode)) throw new Error("--mode must be one of: " + MODES.join(", "));
    } else if (a === "--no-ai" || a === "--local") o.mode = "local";
    else if (a === "--ai" || a === "--hybrid")
      throw new Error("hybrid mode is gone — it was phase-3 work (reading the downloaded sources), which is not implemented yet. Use --mode local or --mode ai-only.");
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

async function main() {
  const opt = parseArgs(process.argv.slice(2));
  if (opt.help || !opt.url) {
    process.stdout.write(HELP);
    process.exit(opt.help ? 0 : 1);
  }
  const mode = opt.mode || "local";
  if (mode === "ai-only" && !ai.available()) {
    throw new Error("--mode ai-only needs ANTHROPIC_API_KEY (set it in .env, or use --mode local)");
  }
  const log = (...a) => !opt.quiet && process.stderr.write(a.join(" ") + "\n");
  log("• mode: " + mode + (mode === "local" ? " (phases 1-2, no AI)" : " (" + ai.MODEL + ")"));

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
  log("  phases 1-2 only: each cited source is fetched once; no phase-3 analysis of the downloaded text yet");
  if (!scholar.havePdftotext()) log("  ! pdftotext not found — PDF source text will not be extracted");

  const budget = { left: opt.downloads };
  const claims = [];

  for (let ci = 0; ci < rawClaims.length; ci++) {
    const c = rawClaims[ci];
    log("\n[" + (ci + 1) + "/" + rawClaims.length + "] " + c.section + " :: " + c.sentence.slice(0, 90) + "…");

    // resolve markers -> footnote text + source; split hop-worthy vs note-only
    const hopSources = []; // { src, noteId, label } — one per distinct real source
    const letterNotes = []; // { label, refs: [noteId], snippets: [string] } — the [m]/[n] kind
    for (const mk of c.markers) {
      mk.footnoteText = refIdx.markerText(mk.noteId);
      if (refIdx.isNoteOnly(mk.noteId, mk.label)) {
        mk.isNote = true; // a lettered explanatory note, not a citation of its own
        const ann = refIdx.noteAnnotation(mk.noteId);
        if (ann.snippets.length) letterNotes.push({ label: mk.label, refs: ann.refs, snippets: ann.snippets });
        continue;
      }
      const src = refIdx.source(mk.noteId);
      if (!src) continue;
      // a citation Wikipedia lists is a real parallel source — show it even if
      // its metadata is thin (it'll just be "unreachable"). Only skip a parse
      // with nothing usable at all.
      const worthy =
        src.author || src._doi || src.year || src.retrieval_url || (src.title && src.title.trim().length >= 12);
      if (worthy && !hopSources.some((h) => sameSource(h.src, src))) {
        hopSources.push({ src, noteId: mk.noteId, label: mk.label });
      }
    }

    c.hops = [];

    if (!hopSources.length) {
      c.status = "no_source";
      c.notes = { extraction_note: "no citation with resolvable source metadata on this sentence" };
      claims.push(c);
      continue;
    }

    // A sentence that cites more than one source in parallel (e.g. "[98][99]"
    // on two separately-titled works) gets one independent hop per source —
    // each its own "Wikipedia citation". Phase 2 fetches every one of them; it
    // does not chase onward citations found inside a source (that reads the
    // downloaded text — phase 3).
    if (hopSources.length > 1) log("   " + hopSources.length + " parallel Wikipedia-cited sources on this sentence");
    let anyDownloaded = false;

    for (let si = 0; si < hopSources.length; si++) {
      const parallel = hopSources.length > 1 ? { index: si + 1, total: hopSources.length } : null;
      const src = hopSources[si].src;
      src._fromNote = hopSources[si].noteId; // link back to the [n] marker
      const globalHop = c.hops.length + 1;
      log("   source " + globalHop + (parallel ? " (parallel " + parallel.index + "/" + parallel.total + ")" : "") + ": " + shortCite(src));
      const dl = await scholar.fetchSource(src, { cacheDir: opt.cache, pageSlug: page.slug, email: opt.email, budget });
      if (dl.status === "downloaded" || dl.status === "cached") {
        src.local_cache_path = "/" + dl.rel.replace(/\\/g, "/");
        // phase 2 only downloads the file; "retrieved" = it's in the cache.
        // Checking its contents against the claim is phase 3 (would be
        // "verified_verbatim").
        src.retrieval_status = "retrieved";
        src.retrieval_note = null;
        src.retrieved_via_wayback = !!dl.viaWayback;
        anyDownloaded = true;
        log("      " + dl.status + (dl.via ? " via " + dl.via : "") + " -> " + dl.rel);
        // extract the plain text now so phase 3 has it ready — nothing reads it yet
        if (dl.file) scholar.extractText(dl.file, dl.contentType);
      } else {
        src.retrieval_status = dl.status === "unreachable" ? "unreachable" : src.retrieval_status;
        // record the most accurate reason available, whatever stage failed
        // (skipped-budget included — that's still "why", even if not yet unreachable)
        if (dl.reason) src.retrieval_note = dl.reason;
        log("      " + dl.status + (dl.reason ? " — " + dl.reason : ""));
      }
      c.hops.push({
        hop_index: globalHop,
        cited_by: "Wikipedia footnote [" + hopSources[si].label + "]",
        // set on a parallel source so the renderer can label it "N of M";
        // null when the sentence cites just one source
        parallel,
        source: src,
        // filled just below: passage(s) a Wikipedia [m]/[n] explanatory note
        // quotes from THIS source (editorially picked by Wikipedia, not text-mined)
        wikipedia_note_quotes: [],
      });
    }

    // "retrieved" = at least one cited source is in the cache; "dead_end" =
    // every cited source on this sentence was unreachable. (Whether a retrieved
    // source actually backs the claim is phase 3 — "resolved" / "pending".)
    c.status = anyDownloaded ? "retrieved" : "dead_end";

    // Hang each lettered explanatory note's quote on the hop for the source it
    // cites: an [m] that reads `Dyson: "…"[25]` is a snippet FROM [25], not a
    // citation of its own. Match by the ref it points at; fall back to the
    // sole hop / first hop if the sentence has just one source.
    for (const ln of letterNotes) {
      let hop =
        c.hops.find((hp) => hp.source && ln.refs.indexOf(hp.source._fromNote) !== -1) ||
        (c.hops.length === 1 ? c.hops[0] : c.hops.find((hp) => hp.parallel && hp.parallel.index === 1));
      if (hop) {
        for (const q of ln.snippets) {
          if (hop.wikipedia_note_quotes.length < 3 && !hop.wikipedia_note_quotes.includes(q)) {
            hop.wikipedia_note_quotes.push(q);
          }
        }
        log("   note [" + ln.label + "] -> quote attached to source " + hop.hop_index);
      }
    }

    // NOTE: the shared technical-log is disabled for now (it will return later —
    // assemble.mergeTechnicalLog is kept for when it does). claim.technical_log_refs
    // stays [] and no technical-log.json is written.

    claims.push(c);
  }

  // ---- assemble ----
  const gen = assemble.generatorBlock(mode);
  const doc = assemble.buildDocument(page, claims, gen);
  fs.mkdirSync(opt.out, { recursive: true });
  const jsonPath = path.join(opt.out, page.slug + ".json");
  fs.writeFileSync(jsonPath, JSON.stringify(doc, null, 2) + "\n");

  const byStatus = doc.claims.reduce((m, c) => ((m[c.status] = (m[c.status] || 0) + 1), m), {});
  log("\n• wrote " + path.relative(process.cwd(), jsonPath) + "  (" + doc.claims.length + " claims: " + JSON.stringify(byStatus) + ")");

  await finish(opt, jsonPath, log);
  log("\nDone [" + mode + "]. Review " + path.relative(process.cwd(), jsonPath) +
    (mode === "local" ? " — phases 1-2: claims found + sources fetched. Phase-3 evidence analysis is not implemented yet." : "."));
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
