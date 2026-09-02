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
 *   9. write <slug>.json, update technical-log.json                 [local]
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

Local-first: the page fetch, claim detection, 1450 CE cutoff, citation parsing,
source downloads, dating-method heuristics and multi-hop chasing all run with no
AI. If ANTHROPIC_API_KEY is set, one AI call per claim confirms scope and picks
load-bearing quotes; without it, chains needing judgement are left "pending".

Options:
  --out <dir>        where to write <slug>.json          (default: cwd)
  --cache <dir>      source-cache root      (default: <out>/source-cache)
  --max-claims <n>   cap claims processed                (default: 60)
  --depth <n>        max citation-chain hops             (default: 3)
  --downloads <n>    max source downloads this run       (default: 40)
  --email <addr>     contact email for Unpaywall OA lookup
                     (default: $TIMEAUDIT_CONTACT_EMAIL; omitted => skip Unpaywall)
  --ai / --no-ai     force the AI gap-filler on / off
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
    ai: null,
    sync: true,
    push: false,
    quiet: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") o.out = path.resolve(argv[++i]);
    else if (a === "--cache") o.cache = path.resolve(argv[++i]);
    else if (a === "--max-claims") o.maxClaims = parseInt(argv[++i], 10);
    else if (a === "--depth") o.depth = parseInt(argv[++i], 10);
    else if (a === "--downloads") o.downloads = parseInt(argv[++i], 10);
    else if (a === "--email") o.email = argv[++i];
    else if (a === "--ai") o.ai = true;
    else if (a === "--no-ai") o.ai = false;
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
  const useAI = opt.ai === true || (opt.ai === null && ai.available());
  if (opt.ai === true && !ai.available()) {
    throw new Error("--ai given but ANTHROPIC_API_KEY is not set");
  }
  const log = (...a) => !opt.quiet && process.stderr.write(a.join(" ") + "\n");

  log("• fetching", opt.url);
  const page = await wiki.fetchPage(opt.url, { cacheDir: opt.cache });
  log("  " + page.title + "  (rev " + page.revid + ")");

  const refIdx = wiki.buildReferenceIndex(page.html);
  const rawClaims = wiki.extractClaims(page, { maxClaims: opt.maxClaims });
  log("• " + rawClaims.length + " candidate dated claim(s) in scope" + (rawClaims.length >= opt.maxClaims ? " (capped)" : ""));
  log("• AI gap-filler: " + (useAI ? "on (" + ai.MODEL + ")" : "off — chains needing judgement stay 'pending'"));
  if (!scholar.havePdftotext()) log("  ! pdftotext not found — PDF sources will not be text-mined");

  const budget = { left: opt.downloads };
  const claims = [];
  const techDrafts = [];

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
        source: src,
        structured_facts: cls.structured_facts,
        verbatim_quotes: [],
        is_terminal: cls.is_terminal,
        terminal_type: cls.terminal_type,
        _classify: cls,
        _excerpt: focusExcerpt(text),
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

    // technical-log drafts for terminal physical-method hops
    c.hops.forEach((h) => {
      if (h.is_terminal && h.terminal_type && h.terminal_type !== "comparative") {
        techDrafts.push({ source_page: page.title, claim_ref: "PENDING:" + claims.length, hop: h });
      }
    });

    claims.push(c);
  }

  // ---- assemble ----
  const prefix = assemble.claimIdPrefix(page.title);
  claims.forEach((c, i) => (c._claimId = prefix + "-" + String(i + 1).padStart(3, "0")));
  techDrafts.forEach((d) => {
    const idx = parseInt(d.claim_ref.split(":")[1], 10);
    d.claim_ref = claims[idx] ? claims[idx]._claimId : d.claim_ref;
  });

  const techLogPath = path.join(opt.out, "technical-log.json");
  let techAdded = [];
  if (techDrafts.length) {
    const { log: tlog, added } = assemble.mergeTechnicalLog(techLogPath, techDrafts);
    techAdded = added;
    // map T-ids back onto claims (in order)
    let k = 0;
    for (const c of claims) {
      const n = c.hops.filter((h) => h.is_terminal && h.terminal_type && h.terminal_type !== "comparative").length;
      if (n) {
        c.technical_log_refs = added.slice(k, k + n);
        k += n;
      }
    }
    fs.mkdirSync(opt.out, { recursive: true });
    fs.writeFileSync(techLogPath, JSON.stringify(tlog, null, 2) + "\n");
  }

  const doc = assemble.buildDocument(page, claims);
  fs.mkdirSync(opt.out, { recursive: true });
  const jsonPath = path.join(opt.out, page.slug + ".json");
  fs.writeFileSync(jsonPath, JSON.stringify(doc, null, 2) + "\n");

  const byStatus = doc.claims.reduce((m, c) => ((m[c.status] = (m[c.status] || 0) + 1), m), {});
  log("\n• wrote " + path.relative(process.cwd(), jsonPath) + "  (" + doc.claims.length + " claims: " + JSON.stringify(byStatus) + ")");
  if (techAdded.length) log("• technical-log.json += " + techAdded.join(", "));

  // ---- sync to tank2 ----
  if (opt.sync) {
    try {
      const done = sync.syncToTank2({ jsonPath, techLogPath: techDrafts.length ? techLogPath : null, cacheDir: opt.cache });
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

  log("\nDone. Review " + path.relative(process.cwd(), jsonPath) + " — heuristic output; 'pending' chains need a human or an --ai run.");
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
  process.stderr.write("\ntimeaudit: " + (e && e.stack ? e.stack : e) + "\n");
  process.exit(1);
});
