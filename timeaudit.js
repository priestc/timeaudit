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
      c.status = "pending";
      c.notes = { extraction_note: "no citation with resolvable source metadata on this sentence" };
      claims.push(c);
      continue;
    }

    // A sentence that cites more than one source in parallel (e.g. "[98][99]"
    // on two separately-titled works) gets one independent chain per source —
    // each is its own "Wikipedia citation", not a continuation of the other.
    if (hopSources.length > 1) log("   " + hopSources.length + " parallel Wikipedia-cited sources on this sentence");
    const visited = new Set(); // shared across branches: don't re-fetch a lead both already reached
    let anyResolved = false;
    let allDeadEnd = true;

    for (let si = 0; si < hopSources.length; si++) {
      const parallel = hopSources.length > 1 ? { index: si + 1, total: hopSources.length } : null;
      const rootSrc = hopSources[si].src;
      rootSrc._fromNote = hopSources[si].noteId; // link back to the [n] marker
      let frontier = {
        source: rootSrc,
        cited_by: "Wikipedia footnote [" + hopSources[si].label + "]",
        parallel,
      };
      let branchDeadEnd = false;

      for (let hop = 1; hop <= opt.depth && frontier; hop++) {
        const src = frontier.source;
        [src._doi, src.retrieval_url].filter(Boolean).forEach((k) => visited.add(k));
        const globalHop = c.hops.length + 1;
        log("   hop " + globalHop + (frontier.parallel ? " (parallel " + frontier.parallel.index + "/" + frontier.parallel.total + ")" : "") + ": " + shortCite(src));
        const dl = await scholar.fetchSource(src, { cacheDir: opt.cache, pageSlug: page.slug, email: opt.email, budget });
        if (dl.status === "downloaded" || dl.status === "cached") {
          src.local_cache_path = "/" + dl.rel.replace(/\\/g, "/");
          src.retrieval_status = dl.status === "cached" ? src.retrieval_status : "not_independently_verified";
          src.retrieval_note = null;
          src.retrieved_via_wayback = !!dl.viaWayback;
          log("      " + dl.status + (dl.via ? " via " + dl.via : "") + " -> " + dl.rel);
        } else {
          src.retrieval_status = dl.status === "unreachable" ? "unreachable" : src.retrieval_status;
          // record the most accurate reason available, whatever stage failed
          // (skipped-budget included — that's still "why", even if not yet unreachable)
          if (dl.reason) src.retrieval_note = dl.reason;
          log("      " + dl.status + (dl.reason ? " — " + dl.reason : ""));
        }
        const text = dl.file ? scholar.extractText(dl.file, dl.contentType) : "";
        const cls = scholar.classifyText(text, c);
        const hopObj = {
          // hop_index stays a single sequence across every branch, so array
          // position === hop_index - 1 holds for downstream code (AI quote/
          // terminal-hop lookups); `parallel` (branch-root hops only) is what
          // tells the renderer where one branch ends and the next begins.
          hop_index: globalHop,
          cited_by: frontier.cited_by,
          // hop > 1 within a branch is only ever reached by finding a DOI
          // printed *in* the previous source's own text (SPEC rule 6 —
          // explicit citations only); this is the surrounding reference text.
          // A branch's own root hop cites nothing previous — it's a second,
          // independent citation straight from Wikipedia.
          citation_in_previous_verbatim: hop === 1 ? null : frontier.citationVerbatim || null,
          parallel: hop === 1 ? frontier.parallel : null,
          source: src,
          structured_facts: cls.structured_facts,
          verbatim_quotes: [],
          // filled after the loop: passage(s) a Wikipedia [m]/[n] explanatory
          // note quotes from THIS source (editorially picked, not text-mined)
          wikipedia_note_quotes: [],
          is_terminal: cls.is_terminal,
          terminal_type: cls.terminal_type,
          _classify: cls,
          _excerpt: focusExcerpt(text),
        };
        c.hops.push(hopObj);

        if (cls.is_terminal) {
          anyResolved = true;
          break;
        }
        if (dl.status === "unreachable" && hop === 1) branchDeadEnd = true;

        // onward lead for the next hop (skip anything already reached by any branch)
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

      if (!branchDeadEnd) allDeadEnd = false;
    }

    c.status = anyResolved ? "resolved" : allDeadEnd ? "dead_end" : "pending";

    // Hang each lettered explanatory note's quote on the hop for the source it
    // cites: an [m] that reads `Dyson: "…"[25]` is a snippet FROM [25], not a
    // citation of its own. Match by the ref it points at; fall back to the
    // sole hop / hop 1 if the sentence has just one source.
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
        log("   note [" + ln.label + "] -> quote attached to hop " + hop.hop_index);
      }
    }

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
