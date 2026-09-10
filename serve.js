#!/usr/bin/env node
/*
 * serve.js — web service for the browse UI.
 *
 * Scans a source for chronology JSON documents (see SPEC.md) and serves a
 * set of server-rendered pages (one URL each, no SPA) that render any of them
 * same lib/render.js as the CLI converter.
 *
 * Two backends:
 *   --source filesystem   (default)  read *.json under --dir
 *   --source firestore               read the Firestore collection (SETUP.md)
 * The backend can also be set with TIMEAUDIT_SOURCE=firestore.
 *
 * Usage: node serve.js [--port 8080] [--dir .] [--source filesystem|firestore]
 */
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const { loadEnv } = require("./lib/env");
loadEnv();

const shots = require("./lib/shots");
const wiki = require("./lib/wiki");
const { slugify } = wiki;
const { buildContextMap } = require("./lib/context");

let PORT = 8080;
let DIR = process.cwd();
let SOURCE = process.env.TIMEAUDIT_SOURCE || "filesystem";
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--port") PORT = parseInt(argv[++i], 10);
  else if (argv[i] === "--dir") DIR = path.resolve(argv[++i]);
  else if (argv[i] === "--source") SOURCE = argv[++i];
}

const ROOT = __dirname;

function isDoc(obj) {
  return obj && (Array.isArray(obj.claims) || Array.isArray(obj.entries));
}

/* ---------- filesystem backend ---------- */

function fsList() {
  const found = [];
  const walk = (dir, depth) => {
    if (depth > 4) return;
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (name.startsWith(".") || name === "node_modules" || name === "dist") continue;
      const full = path.join(dir, name);
      let st;
      try {
        st = fs.statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(full, depth + 1);
      else if (name.toLowerCase().endsWith(".json")) {
        try {
          const data = JSON.parse(fs.readFileSync(full, "utf8"));
          if (!isDoc(data)) continue;
          found.push({
            id: path.relative(DIR, full),
            name: path.basename(full),
            title: Array.isArray(data.entries)
              ? "Shared Technical Log"
              : (data.page && data.page.title) || path.basename(full),
            kind: Array.isArray(data.entries) ? "technical log" : "page",
            count: Array.isArray(data.entries) ? data.entries.length : (data.claims || []).length,
          });
        } catch {
          /* skip */
        }
      }
    }
  };
  walk(DIR, 0);
  found.sort((a, b) => a.title.localeCompare(b.title));
  return found;
}

function fsRead(id) {
  const full = path.resolve(DIR, id);
  if (!full.startsWith(DIR + path.sep) && full !== DIR) return null;
  if (!full.toLowerCase().endsWith(".json") || !fs.existsSync(full)) return null;
  return fs.readFileSync(full, "utf8");
}

/* ---------- firestore backend ---------- */

let store; // lazy require so the filesystem backend needs no firebase install
function firestoreStore() {
  if (!store) store = require("./lib/store");
  return store;
}

async function dbList() {
  const docs = await firestoreStore().listDocuments();
  return docs.map((d) => ({
    id: d.id,
    name: d.source_file,
    title: d.title,
    kind: d.kind,
    count: d.kind === "page" ? d.claim_count : d.entry_count,
  }));
}

async function dbRead(id) {
  const rec = await firestoreStore().getDocument(id);
  if (!rec) return null;
  return rec.raw_json || JSON.stringify(rec);
}

/* ---------- dispatch ---------- */

const backend =
  SOURCE === "firestore"
    ? { name: "firestore", list: dbList, read: dbRead }
    : { name: "filesystem", list: async () => fsList(), read: async (id) => fsRead(id) };

function send(res, code, type, body) {
  res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(body);
}

// parsed report whose page title slugifies to `slug` (for on-demand shot gen)
async function reportForSlug(slug) {
  for (const f of await backend.list()) {
    const cand = String(f.id).replace(/\.json$/i, "");
    if (cand !== slug && slugify(f.title) !== slug) continue;
    try {
      const raw = await backend.read(f.id);
      const data = JSON.parse(raw);
      if (Array.isArray(data.claims)) return data;
    } catch {
      /* skip */
    }
  }
  return null;
}

// the directory a doc's report + source-cache live/should be written under
function outDirForId(id) {
  return backend.name === "filesystem" ? path.dirname(path.resolve(DIR, id)) : DIR;
}

/* ---------- run the extraction pipeline on demand (re-analyze / add new) ------ */

// modes timeaudit.js still accepts; an old report whose generator.mode is
// "hybrid" (removed) re-analyzes with the default instead of erroring
const MODES = ["local", "ai-only"];
// keyed by doc id for re-analyze, by "new:<slug>" for a brand-new article
const reanalyzeJobs = new Map(); // key -> { running, ok, log: [], startedAt, finishedAt }

function jobSnapshot(job) {
  return { running: job.running, ok: job.ok, log: job.log, startedAt: job.startedAt, finishedAt: job.finishedAt };
}

// Delete every on-disk artefact left over from the previous run of this page
// (the report JSON, its academic source-cache, its cached wiki snapshot, its
// screenshot cache) so a re-analysis starts completely from scratch instead
// of quietly reusing stale downloads or leaving a stray file behind if the
// article's title (and so its slug) changed since the last run.
function wipeForFreshRun(id, slug, outDir, job) {
  try {
    const jsonPath = backend.name === "filesystem" ? path.resolve(DIR, id) : path.join(outDir, slug + ".json");
    if (fs.existsSync(jsonPath)) {
      fs.unlinkSync(jsonPath);
      job.log.push("deleted previous report: " + path.relative(ROOT, jsonPath));
    }
  } catch (e) {
    job.log.push("could not delete previous report: " + e.message);
  }
  const cacheRoot = path.join(outDir, "source-cache");
  for (const p of [
    path.join(cacheRoot, slug),
    path.join(cacheRoot, "_wikipedia", slug + ".parse.json"),
    path.join(cacheRoot, "_wikipedia", slug + ".html"),
    path.join(cacheRoot, "_wikipedia", slug + ".wikitext"),
    path.join(cacheRoot, "_shots", slug),
  ]) {
    try {
      if (fs.existsSync(p)) {
        fs.rmSync(p, { recursive: true, force: true });
        job.log.push("cleared cache: " + path.relative(ROOT, p));
      }
    } catch (e) {
      job.log.push("could not clear " + p + ": " + e.message);
    }
  }
}

// Runs the same pipeline timeaudit.js does on the CLI, into `outDir` (then
// `db.js push` when the backend is Firestore). Not synced to tank2 from here
// — a run triggered from inside the web UI shouldn't shell out `ssh tank2`.
//   opts.wipeSlug  present -> delete that slug's previous report + caches first
//                             ("re-analyze from scratch")
//   opts.mode      forces --mode; omitted -> timeaudit.js picks its default
function startTimeauditJob(jobKey, url, opts) {
  opts = opts || {};
  const outDir = opts.outDir || DIR;
  const job = { running: true, ok: null, log: [], startedAt: Date.now(), finishedAt: null };
  reanalyzeJobs.set(jobKey, job);
  if (opts.wipeSlug) {
    job.log.push("• re-analyzing from scratch — deleting the previous report and cached sources");
    wipeForFreshRun(jobKey, opts.wipeSlug, outDir, job);
  } else {
    job.log.push("• analyzing " + url);
  }
  const args = [path.join(ROOT, "timeaudit.js"), url, "--out", outDir, "--no-sync"];
  if (opts.mode) args.push("--mode", opts.mode);
  if (backend.name === "firestore") args.push("--push");
  const feed = (buf) => {
    for (const line of buf.toString("utf8").split(/\r?\n/)) {
      if (!line) continue;
      job.log.push(line);
      if (job.log.length > 400) job.log.shift();
    }
  };
  let child;
  try {
    child = spawn(process.execPath, args, { cwd: ROOT });
  } catch (e) {
    job.running = false;
    job.ok = false;
    job.finishedAt = Date.now();
    job.log.push("failed to start: " + e.message);
    return job;
  }
  child.stdout.on("data", feed);
  child.stderr.on("data", feed);
  child.on("close", (code) => {
    job.running = false;
    job.ok = code === 0;
    job.finishedAt = Date.now();
  });
  child.on("error", (e) => {
    job.running = false;
    job.ok = false;
    job.finishedAt = Date.now();
    job.log.push("failed to start: " + e.message);
  });
  return job;
}

const STATUS_ORDER = ["retrieved", "dead_end", "no_source", "resolved", "pending"];

// Aggregate every page document into corpus-wide statistics.
async function computeStats() {
  const list = await backend.list();
  const byStatus = {};
  const byMode = {};
  const perDoc = [];
  let totalClaims = 0;

  for (const f of list) {
    let raw;
    try {
      raw = await backend.read(f.id);
    } catch {
      continue;
    }
    if (raw == null) continue;
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!Array.isArray(data.claims)) continue;
    const claims = data.claims;
    const mode = (data.generator && data.generator.mode) || "unspecified";
    const docStatus = {};
    for (const c of claims) {
      const s = c.status || "unknown";
      byStatus[s] = (byStatus[s] || 0) + 1;
      docStatus[s] = (docStatus[s] || 0) + 1;
    }
    totalClaims += claims.length;
    byMode[mode] = byMode[mode] || { documents: 0, claims: 0 };
    byMode[mode].documents += 1;
    byMode[mode].claims += claims.length;
    perDoc.push({ id: f.id, title: f.title, mode, claims: claims.length, by_status: docStatus });
  }

  const by_status = {};
  const keys = Object.keys(byStatus).sort((a, b) => {
    const ia = STATUS_ORDER.indexOf(a);
    const ib = STATUS_ORDER.indexOf(b);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib) || a.localeCompare(b);
  });
  for (const k of keys) {
    by_status[k] = {
      count: byStatus[k],
      pct: totalClaims ? Math.round((1000 * byStatus[k]) / totalClaims) / 10 : 0,
    };
  }
  perDoc.sort((a, b) => b.claims - a.claims);

  return {
    documents: perDoc.length,
    claims: totalClaims,
    by_status,
    by_mode: byMode,
    per_document: perDoc,
  };
}

// a stable identity for a source, so the same book/paper cited from several
// claims (even across documents) is one row with every claim that cites it
function sourceKey(s) {
  return (
    (s.identifier && String(s.identifier).trim()) ||
    [s.author, s.title, s.year].map((v) => (v == null ? "" : String(v))).join("|")
  );
}

// Corpus-wide: every source that could never be retrieved (grouped, SPEC's
// retrieval_note carries the specific reason), and every source that a claim
// actually validated against (hop.is_terminal — a phase-3 output, so this list
// stays empty until phase 3 is implemented), each with backlinks to the
// claim(s)/document(s) that cite it.
async function computeSourceReport() {
  const list = await backend.list();
  const unreachable = new Map();
  const validated = new Map();

  for (const f of list) {
    let raw, data;
    try {
      raw = await backend.read(f.id);
      data = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!Array.isArray(data.claims)) continue;
    const docTitle = (data.page && data.page.title) || f.title;

    for (const c of data.claims) {
      for (const h of c.citation_chain || []) {
        const s = h.source || {};
        const ref = { doc_id: f.id, doc_title: docTitle, claim_id: c.claim_id };
        const key = sourceKey(s);
        if (s.retrieval_status === "unreachable") {
          if (!unreachable.has(key)) unreachable.set(key, { source: s, refs: [] });
          unreachable.get(key).refs.push(ref);
        }
        if (h.is_terminal) {
          if (!validated.has(key)) validated.set(key, { source: s, terminal_type: h.terminal_type, refs: [] });
          validated.get(key).refs.push(ref);
        }
      }
    }
  }

  const byTitle = (a, b) => (a.source.title || "").localeCompare(b.source.title || "");
  return {
    unreachable: [...unreachable.values()].sort(byTitle),
    validated: [...validated.values()].sort(byTitle),
  };
}

// A source document's "document source" is the host its bytes actually came
// from — cam.ac.uk, penelope.uchicago.edu, … — NOT how we reached it. Wayback
// and Wikipedia-archive wrappers are unwrapped so the underlying publisher
// shows through (the archive route stays visible in retrieval_history); a few
// well-known aggregators / databases keep a friendly name. Null unless the
// document was actually retrieved.
const DOC_SOURCE_ALIASES = [
  [/web\.archive\.org\//i, "Wayback Machine"],
  [/\/europepmc\/|europepmc\.org/i, "Europe PMC"],
  [/ncbi\.nlm\.nih\.gov/i, "NCBI"],
  [/books\.google\.[a-z.]+|google\.[a-z.]+\/books/i, "Google Books"],
  [/archive\.org\//i, "Internet Archive"],
  [/openalex\.org/i, "OpenAlex"],
  [/unpaywall\.org/i, "Unpaywall"],
  [/doi\.org\//i, "DOI resolver"],
];
const MULTI_LABEL_TLD = new Set(["ac", "co", "com", "org", "net", "edu", "gov", "or", "ne", "gob"]);

function unwrapArchiveUrl(u) {
  const m = String(u || "").match(/web\.archive\.org\/web\/[^\s]*?\/(https?:\/\/.+)$/i);
  return m ? m[1] : String(u || "");
}
function hostOf(u) {
  try {
    return new URL(u).hostname.replace(/^www\d*\./i, "").toLowerCase();
  } catch {
    return "";
  }
}
function registrableDomain(host) {
  const p = host.split(".").filter(Boolean);
  if (p.length <= 2) return host;
  if (p[p.length - 1].length === 2 && MULTI_LABEL_TLD.has(p[p.length - 2])) return p.slice(-3).join(".");
  return p.slice(-2).join(".");
}
function documentSourceOf(s) {
  if (!s || s.retrieval_status !== "retrieved") return null;
  const hit = (s.retrieval_history || []).find((e) => e && e.result === "retrieved");
  const u = unwrapArchiveUrl((hit && hit.url) || s.retrieval_url || "");
  for (const [re, name] of DOC_SOURCE_ALIASES) if (re.test(u)) return name;
  const host = hostOf(u);
  if (host) return registrableDomain(host);
  return s.retrieved_via_wayback ? "Wayback Machine" : "cache";
}

// Corpus-wide: every distinct source document (a work cited by a Wikipedia
// article), keyed by identity, with its metadata, its "document source"
// (origin), retrieval status, and every article + claim that cites it. Powers
// both the "browse by document source" page and each source document's own
// detail page.
async function computeSourceDocuments() {
  const list = await backend.list();
  const byKey = new Map();

  for (const f of list) {
    let data;
    try {
      data = JSON.parse(await backend.read(f.id));
    } catch {
      continue;
    }
    if (!Array.isArray(data.claims)) continue;
    const docTitle = (data.page && data.page.title) || f.title;

    for (const c of data.claims) {
      for (const h of c.citation_chain || []) {
        const s = h.source || {};
        const key = sourceKey(s);
        if (!key) continue;
        if (!byKey.has(key)) {
          byKey.set(key, {
            key,
            source: s,
            origin: documentSourceOf(s),
            status: s.retrieval_status || "not_verified",
            refs: [],
          });
        }
        const rec = byKey.get(key);
        // keep the richest metadata seen for this key
        if ((s.title || "").length > (rec.source.title || "").length) rec.source = s;
        if (!rec.origin) rec.origin = documentSourceOf(s);
        rec.refs.push({
          doc_id: f.id,
          doc_title: docTitle,
          claim_id: c.claim_id,
          cited_by: h.cited_by || null,
        });
      }
    }
  }
  return [...byKey.values()].sort(
    (a, b) =>
      String(a.origin || "~").localeCompare(String(b.origin || "~")) ||
      (a.source.title || "").localeCompare(b.source.title || "")
  );
}

// Corpus-wide: every claim, grouped by status, so the stats page's "claims by
// status" rows can each open a list that renders each claim with the same
// template as the document page. Each entry carries the whole claim object.
async function computeClaimsByStatus() {
  const list = await backend.list();
  const groups = {}; // status -> [ {doc_id, doc_title, claim} ]
  for (const f of list) {
    let data;
    try {
      data = JSON.parse(await backend.read(f.id));
    } catch {
      continue;
    }
    if (!Array.isArray(data.claims)) continue;
    const docTitle = (data.page && data.page.title) || f.title;
    for (const c of data.claims) {
      const st = c.status || "unknown";
      (groups[st] = groups[st] || []).push({ doc_id: f.id, doc_title: docTitle, claim: c });
    }
  }
  return groups;
}

/* ===================== server-rendered pages (no SPA) ===================== */

const ChronoRender = require("./lib/render");
const E = ChronoRender.esc;

function badge(text, kind) {
  return '<span class="badge badge-' + E(kind || "neutral") + '">' + E(text) + "</span>";
}
const STATUS_KIND = { retrieved: "ok", dead_end: "bad", no_source: "neutral", resolved: "ok", pending: "warn" };
function statusDot(k) {
  return "s-" + (["retrieved", "dead_end", "no_source", "resolved", "pending"].indexOf(k) !== -1 ? k : "other");
}
async function readDoc(id) {
  // firestore ids are slugs; filesystem ids carry ".json" — accept either
  for (const cand of id.endsWith(".json") ? [id] : [id, id + ".json"]) {
    try {
      const raw = await backend.read(cand);
      if (raw == null) continue;
      const d = JSON.parse(raw);
      if (isDoc(d)) return d;
    } catch {
      /* try next */
    }
  }
  return null;
}
async function contextFor(id, data) {
  try {
    return buildContextMap(data, path.join(outDirForId(id), "source-cache"));
  } catch {
    return {};
  }
}
const NAV = [
  ["/", "\uD83C\uDFE0 Home", "home"],
  ["/statistics", "\uD83D\uDCCA Statistics", "stats"],
  ["/claim-finder", "\uD83D\uDD0E Claim finder", "finder"],
  ["/document-sources", "\uD83D\uDCDA Document sources", "sources"],
  ["/unreachable", "\uD83D\uDEAB Unreachable sources", "unreachable"],
  ["/radiocarbon", "\u2622\uFE0F Radiocarbon sources", "radiocarbon"],
];

const LAYOUT_CSS = [
  ":root{--sidebar:#f4f4f3}",
  "@media (prefers-color-scheme:dark){:root{--sidebar:#1b1c1f}}",
  "body{display:grid;grid-template-columns:290px 1fr;grid-template-rows:100vh;overflow:hidden}",
  "@media (max-width:820px){body{grid-template-columns:1fr;grid-template-rows:auto 1fr}}",
  ".ta-side{background:var(--sidebar);border-right:1px solid var(--border);display:flex;flex-direction:column;overflow:hidden}",
  ".ta-side .head{padding:16px 16px 12px;border-bottom:1px solid var(--border)}",
  ".ta-side .head b{font-size:1rem}",
  ".ta-nav{padding:8px 8px 0;display:flex;flex-direction:column;gap:5px}",
  ".ta-nav a{padding:9px 11px;border-radius:8px;font-size:.88rem;font-weight:600;border:1px solid var(--border);background:var(--card);color:var(--fg);text-decoration:none}",
  ".ta-nav a.active{background:var(--accent);color:#fff;border-color:var(--accent)}",
  ".ta-list{list-style:none;margin:0;padding:8px;overflow-y:auto;flex:1}",
  ".ta-list a{display:block;padding:9px 11px;border-radius:8px;margin-bottom:3px;text-decoration:none;color:var(--fg)}",
  ".ta-list a:hover{background:var(--card)}",
  ".ta-list a.active{background:var(--accent);color:#fff}",
  ".ta-list a.active .m{color:rgba(255,255,255,.85)}",
  ".ta-list .t{font-size:.88rem;font-weight:600;display:block;line-height:1.3}",
  ".ta-list .m{font-size:.74rem;color:var(--muted);margin-top:2px}",
  ".ta-main{overflow:auto;position:relative}",
  ".ta-bar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:9px 16px;border-bottom:1px solid var(--border);background:var(--sidebar);font-size:.85rem}",
  ".ta-bar .sub{color:var(--muted)}",
  ".ta-bar a{color:var(--accent);text-decoration:none}.ta-bar a:hover{text-decoration:underline}",
  ".ta-toolbar{display:flex;gap:8px;align-items:center;padding:10px 16px;border-bottom:1px solid var(--border)}",
  ".ta-toolbar a,.ta-toolbar button{font:inherit;font-size:.82rem;padding:6px 12px;border:1px solid var(--border);background:var(--card);color:var(--fg);border-radius:8px;cursor:pointer;text-decoration:none}",
  ".ta-toolbar a.on{background:var(--accent);color:#fff;border-color:var(--accent)}",
  ".pg{max-width:920px;margin:0 auto;padding:26px 22px 90px}",
  ".pg h1{font-size:1.5rem;margin:0 0 4px}.pg h2{font-size:1rem;margin:26px 0 10px}",
  ".pg .sub{color:var(--muted);font-size:.85rem;margin-bottom:16px}",
  ".empty{color:var(--muted);padding:56px 24px;text-align:center}",
  ".cards{display:flex;flex-wrap:wrap;gap:12px;margin:10px 0}",
  ".card{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:14px 18px;min-width:130px;display:flex;flex-direction:column;gap:2px}",
  ".card .big{font-size:1.9rem;font-weight:700;line-height:1}",
  ".card .lbl{font-size:.72rem;text-transform:uppercase;letter-spacing:.04em;color:var(--muted)}",
  ".sbar{display:flex;height:22px;border-radius:6px;overflow:hidden;border:1px solid var(--border);margin:6px 0 12px}",
  ".sbar span{display:block}",
  "table.brk{border-collapse:collapse;width:100%;font-size:.9rem}",
  "table.brk td,table.brk th{padding:6px 10px;border-bottom:1px solid var(--border);text-align:left}",
  "table.brk th{color:var(--muted);font-weight:600;font-size:.78rem;text-transform:uppercase;letter-spacing:.03em}",
  "table.brk td.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}",
  ".dot{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:7px;vertical-align:middle}",
  ".s-retrieved,.s-resolved{background:#16a34a}.s-pending{background:#d97706}.s-dead_end{background:#dc2626}",
  ".s-no_source,.s-unknown,.s-unspecified{background:#9ca3af}.s-other{background:#7c3aed}",
  ".minibar{display:inline-flex;width:120px;height:10px;border-radius:3px;overflow:hidden;border:1px solid var(--border);vertical-align:middle}",
  ".minibar span{display:block;height:100%}",
  ".src-list{list-style:none;margin:0;padding:0}",
  ".src-card{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:12px 14px;margin-bottom:10px}",
  ".src-card .st{font-weight:600;font-size:.95rem}",
  ".src-card a.st{color:var(--accent);text-decoration:none}.src-card a.st:hover{text-decoration:underline}",
  ".src-bits{color:var(--muted);font-size:.82rem;margin-top:2px}",
  ".src-status-row{margin-top:8px;display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
  ".src-note{font-style:italic;color:var(--muted);font-size:.82rem}",
  ".src-refs{margin-top:6px;display:flex;flex-wrap:wrap;gap:6px}",
  ".src-ref{font-size:.8rem;padding:2px 8px;border:1px solid var(--border);border-radius:6px;text-decoration:none;color:var(--accent);background:var(--bg)}",
  "table.kv2{border-collapse:collapse;width:100%;font-size:.86rem;margin:10px 0}",
  "table.kv2 th{text-align:left;vertical-align:top;padding:4px 14px 4px 0;color:var(--muted);font-weight:600;white-space:nowrap;width:1%}",
  "table.kv2 td{vertical-align:top;padding:4px 0;word-break:break-word}table.kv2 a{color:var(--accent);word-break:break-all}",
  ".rh-list{list-style:none;margin:6px 0 0;padding:0;font-size:.82rem}.rh-list>li{margin:0 0 8px}",
  ".rh-n{color:var(--muted);margin-right:4px}.rh-via{font-weight:600;margin-right:6px}",
  ".rh-url{margin:2px 0 0 18px;word-break:break-all;font-family:ui-monospace,Menlo,monospace;font-size:.78rem}",
  ".rh-url a{color:var(--muted)}.rh-detail{margin:2px 0 0 18px;color:var(--muted);font-style:italic}",
  "form.inl{display:flex;gap:8px;margin:14px 0}",
  "form.inl input{flex:1;padding:10px 13px;border:1px solid var(--border);border-radius:8px;background:var(--card);color:var(--fg);font:inherit}",
  "form.inl button{padding:10px 18px;font:inherit;font-weight:600;border:1px solid var(--accent);background:var(--accent);color:#fff;border-radius:8px;cursor:pointer}",
  "pre.raw{white-space:pre-wrap;word-break:break-word;font:12.5px/1.5 ui-monospace,Menlo,monospace}",
  ".fr-claims{list-style:none;margin:0;padding:0}",
  ".fr-claims li{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:12px 14px;margin-bottom:10px}",
  ".fr-claims li.rej{background:rgba(220,38,38,.09);border-color:rgba(220,38,38,.42)}",
  ".fr-sec{font-size:.72rem;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);margin-bottom:4px}",
  ".fr-drop{color:#b91c1c;font-weight:700;text-transform:none;margin-left:6px}",
  ".hstat{margin-top:14px;font:12.5px/1.5 ui-monospace,Menlo,monospace;color:var(--muted);white-space:pre-wrap}",
  ".dsrow{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:0 0 18px;padding:10px 14px;border:1px solid var(--border);border-radius:10px;background:var(--card)}",
  ".dsrow .lbl{font-size:.72rem;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);font-weight:700}",
  ".dsrow a.ds{font-weight:600;text-decoration:none;color:var(--accent);border:1px solid var(--accent);border-radius:999px;padding:3px 12px;font-size:.85rem}",
  ".dsrow a.ds:hover{background:var(--accent);color:#fff}",
  ".dsrow .none{color:var(--muted);font-style:italic;font-size:.85rem}",
].join("\n");

async function shell({ title, active, activeId, main, script }) {
  let list = [];
  try {
    list = await backend.list();
  } catch {
    /* empty */
  }
  const nav = NAV.map(
    ([href, label, key]) => '<a href="' + href + '"' + (active === key ? ' class="active"' : "") + ">" + E(label) + "</a>"
  ).join("");
  const items = list
    .map((f) => {
      const meta =
        f.kind === "page" ? "article \u00b7 " + f.count + " claim" + (f.count === 1 ? "" : "s") : f.kind + " \u00b7 " + f.count;
      return (
        '<a href="/article/' + encodeURIComponent(f.id) + '"' + (f.id === activeId ? ' class="active"' : "") + ">" +
        '<span class="t">' + E(f.title) + '</span><span class="m">' + E(meta) + "</span></a>"
      );
    })
    .join("");
  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    "<title>" + E(title) + " \u2014 Chronology Browser</title>" +
    "<style>" + ChronoRender.STYLES + "\n" + LAYOUT_CSS + "</style></head><body>" +
    '<aside class="ta-side"><div class="head"><b>Chronology Browser</b></div>' +
    '<nav class="ta-nav">' + nav + "</nav><div class=\"ta-list\">" + items + "</div></aside>" +
    '<main class="ta-main">' + main + "</main>" +
    (script ? "<script>" + script + "<\/script>" : "") +
    "</body></html>"
  );
}
const htmlPage = (o) => shell(o).then((h) => ["text/html; charset=utf-8", h]);

/* -------------------------------- pages --------------------------------- */

function pageHome() {
  const main =
    '<div class="pg"><h1>Add a Wikipedia article</h1>' +
    '<div class="sub">Paste a Wikipedia URL. It is run through the full extraction pipeline and added to the database.</div>' +
    '<form class="inl" id="af"><input id="au" type="url" placeholder="https://en.wikipedia.org/wiki/Stonehenge" required>' +
    "<button>Analyze &amp; add</button></form><div class=\"hstat\" id=\"hs\"></div>" +
    '<p class="sub" style="margin-top:26px">Pick a Wikipedia article from the list on the left to see its report, or use the pages in the nav.</p></div>';
  const script =
    "var f=document.getElementById('af'),u=document.getElementById('au'),s=document.getElementById('hs');" +
    "f.onsubmit=function(e){e.preventDefault();var url=u.value.trim();if(!url)return;" +
    "s.textContent='starting analysis of '+url+' \\u2026';f.querySelector('button').disabled=true;" +
    "fetch('/api/analyze?url='+encodeURIComponent(url),{method:'POST'}).then(function(r){return r.json();}).then(function(d){" +
    "if(d.error){s.textContent='error: '+d.error;f.querySelector('button').disabled=false;return;}" +
    "var job=d.job,slug=job.replace(/^new:/,'');" +
    "var t=setInterval(function(){fetch('/api/analyze/status?job='+encodeURIComponent(job)).then(function(r){return r.json();}).then(function(j){" +
    "s.textContent=(j.log||[]).slice(-6).join('\\n');" +
    "if(j.running===false){clearInterval(t);" +
    "if(j.ok){s.textContent+='\\n\\ndone \\u2014 opening \\u2026';location.href='/article/'+encodeURIComponent(slug);}" +
    "else{s.textContent+='\\n\\nfailed';f.querySelector('button').disabled=false;}}});},1500);" +
    "}).catch(function(err){s.textContent='error: '+err.message;f.querySelector('button').disabled=false;});};";
  return htmlPage({ title: "Home", active: "home", main, script });
}

async function pageArticle(id, raw) {
  const data = await readDoc(id);
  if (!data) return htmlPage({ title: "Not found", active: null, main: '<div class="empty">No such article.</div>' });
  const title = (data.page && data.page.title) || id;
  const toolbar =
    '<div class="ta-toolbar">' +
    (raw
      ? '<a href="/article/' + encodeURIComponent(id) + '">Rendered</a><a class="on">Raw JSON</a>'
      : '<a class="on">Rendered</a><a href="/article/' + encodeURIComponent(id) + '/raw">Raw JSON</a>') +
    '<a href="/article/' + encodeURIComponent(id) + '/download" download>Download HTML</a>' +
    '<button id="reana">\uD83D\uDD04 Re-analyze</button>' +
    '<span class="hstat" id="hs" style="margin:0 0 0 auto;font-size:.78rem"></span></div>';
  let body;
  if (raw) {
    body = '<div class="wrap"><pre class="raw">' + E(JSON.stringify(data, null, 2)) + "</pre></div>";
  } else {
    const ctx = await contextFor(id, data);
    body = '<div class="wrap">' + ChronoRender.renderBody(data, { context: ctx, claimBase: "/article/" + encodeURIComponent(id) + "/" }) + "</div>";
  }
  const script =
    "var b=document.getElementById('reana'),s=document.getElementById('hs');" +
    "b.onclick=function(){b.disabled=true;s.textContent='re-analyzing \\u2026';" +
    "fetch('/api/reanalyze?id=" + encodeURIComponent(id).replace(/'/g, "%27") + "',{method:'POST'}).then(function(r){return r.json();}).then(function(){" +
    "var t=setInterval(function(){fetch('/api/reanalyze/status?id=" + encodeURIComponent(id).replace(/'/g, "%27") + "').then(function(r){return r.json();}).then(function(j){" +
    "s.textContent=(j.log||[]).slice(-1)[0]||'re-analyzing \\u2026';" +
    "if(j&&!j.running){clearInterval(t);location.reload();}});},2000);" +
    "}).catch(function(e){s.textContent='error: '+e.message;b.disabled=false;});};";
  return htmlPage({ title: title + (raw ? " (raw)" : ""), active: null, activeId: id, main: toolbar + body, script });
}

async function pageClaim(id, claimId) {
  const data = await readDoc(id);
  const claim = data && (data.claims || []).find((c) => c.claim_id === claimId);
  const title = (data && data.page && data.page.title) || id;
  if (!claim) {
    return htmlPage({
      title: claimId,
      active: null,
      activeId: id,
      main: '<div class="pg"><div class="empty">No claim ' + E(claimId) + " in " + E(title) + ".</div></div>",
    });
  }
  const origins = [];
  (claim.citation_chain || []).forEach((h) => {
    const o = documentSourceOf(h.source || {});
    if (o && origins.indexOf(o) === -1) origins.push(o);
  });
  const dsRow =
    '<div class="dsrow"><span class="lbl">Document source</span>' +
    (origins.length
      ? origins
          .map((o) => '<a class="ds" href="/document-sources/' + encodeURIComponent(o) + '">' + E(o) + " \u2192</a>")
          .join("")
      : '<span class="none">no source document was retrieved for this claim</span>') +
    "</div>";
  const ctx = await contextFor(id, data);
  const sctx = {};
  if (ctx[claimId]) sctx[claimId] = ctx[claimId];
  const synth = {
    schema_version: data.schema_version,
    generator: data.generator,
    page: { title: title + " \u00b7 " + claimId, url: data.page && data.page.url },
    claims: [claim],
  };
  const bar =
    '<div class="ta-bar"><a href="/article/' + encodeURIComponent(id) + '">\u2190 ' + E(title) + "</a><b>" + E(claimId) +
    '</b><span class="sub">this page\u2019s URL links straight to this claim</span></div>';
  const body = '<div class="wrap">' + dsRow + ChronoRender.renderBody(synth, { context: sctx, hideSummary: true }) + "</div>";
  return htmlPage({ title: claimId + " \u00b7 " + title, active: null, activeId: id, main: bar + body });
}

async function pageClaimsByStatus(status) {
  const groups = await computeClaimsByStatus();
  const entries = (groups[status] || []).slice();
  const label = (status || "").replace(/_/g, " ");
  const byDoc = new Map();
  entries.forEach((e) => {
    if (!byDoc.has(e.doc_id)) byDoc.set(e.doc_id, { title: e.doc_title, claims: [] });
    byDoc.get(e.doc_id).claims.push(e.claim);
  });
  const bar = '<div class="ta-bar"><a href="/statistics">\u2190 statistics</a><b>' + E(label) + " claims (" + entries.length + ")</b></div>";
  let body = '<div class="wrap">';
  if (!entries.length) body += '<div class="empty">No claims with this status.</div>';
  for (const [docId, g] of [...byDoc.entries()].sort((a, b) => a[1].title.localeCompare(b[1].title))) {
    const synth = { page: { title: g.title }, claims: g.claims };
    body +=
      '<h2 style="margin-top:34px"><a href="/article/' + encodeURIComponent(docId) + '" style="color:var(--accent);text-decoration:none">' +
      E(g.title) + "</a></h2>" +
      ChronoRender.renderBody(synth, { claimBase: "/article/" + encodeURIComponent(docId) + "/", hideSummary: true }).replace(
        /^<header class="doc-head">[\s\S]*?<\/header>/,
        ""
      );
  }
  body += "</div>";
  return htmlPage({ title: label + " claims", active: null, main: bar + body });
}

async function pageStatistics() {
  const s = await computeStats();
  const order = Object.keys(s.by_status);
  const bar = order
    .map((k) => '<span class="' + statusDot(k) + '" style="width:' + s.by_status[k].pct + '%"></span>')
    .join("");
  const rows = order
    .map(
      (k) =>
        '<tr><td><span class="dot ' + statusDot(k) + '"></span><a href="/claims/' + encodeURIComponent(k) + '" style="color:var(--accent);text-decoration:none">' +
        E(k.replace(/_/g, " ")) + "</a></td><td class=\"num\">" + s.by_status[k].count + '</td><td class="num">' + s.by_status[k].pct.toFixed(1) + "%</td></tr>"
    )
    .join("");
  const modeRows =
    Object.keys(s.by_mode)
      .map((m) => "<tr><td>" + E(m) + '</td><td class="num">' + s.by_mode[m].documents + '</td><td class="num">' + s.by_mode[m].claims + "</td></tr>")
      .join("") || '<tr><td colspan="3" style="color:var(--muted)">no Wikipedia articles</td></tr>';
  const docRows = s.per_document
    .map((d) => {
      const mini = Object.keys(d.by_status)
        .map((k) => '<span class="' + statusDot(k) + '" style="width:' + (d.claims ? (100 * d.by_status[k]) / d.claims : 0) + '%"></span>')
        .join("");
      return (
        '<tr><td><a href="/article/' + encodeURIComponent(d.id) + '" style="color:var(--accent);text-decoration:none">' + E(d.title) + "</a></td><td>" +
        E(d.mode) + '</td><td class="num">' + d.claims + '</td><td><span class="minibar">' + mini + "</span></td></tr>"
      );
    })
    .join("");
  const main =
    '<div class="pg"><h1>Statistics</h1><div class="sub">across all Wikipedia articles in this source</div>' +
    '<div class="cards"><div class="card"><span class="big">' + s.claims + '</span><span class="lbl">claims found</span></div>' +
    '<div class="card"><span class="big">' + s.documents + '</span><span class="lbl">Wikipedia articles</span></div></div>' +
    "<h2>Claims by status</h2>" +
    (s.claims ? '<div class="sbar">' + bar + "</div>" : "") +
    '<table class="brk"><tr><th>status</th><th class="num">count</th><th class="num">share</th></tr>' +
    (rows || '<tr><td colspan="3" style="color:var(--muted)">no claims</td></tr>') + "</table>" +
    '<h2>By generation mode</h2><table class="brk"><tr><th>mode</th><th class="num">articles</th><th class="num">claims</th></tr>' + modeRows + "</table>" +
    '<h2>Per article</h2><table class="brk"><tr><th>article</th><th>mode</th><th class="num">claims</th><th>status mix</th></tr>' + docRows + "</table></div>";
  return htmlPage({ title: "Statistics", active: "stats", main });
}

function srcDocCardHtml(rec) {
  const s = rec.source || {};
  const author = Array.isArray(s.author) ? s.author.join(", ") : s.author;
  const bits = [author, s.year, s.document_type, s.identifier].filter(Boolean).join(" \u00b7 ");
  const kind = rec.status === "retrieved" ? "ok" : rec.status === "unreachable" ? "bad" : "neutral";
  return (
    '<li class="src-card"><a class="st" href="/source-document/' + encodeURIComponent(rec.key) + '">' +
    E(s.title || "(untitled source document)") + "</a>" +
    (bits ? '<div class="src-bits">' + E(bits) + "</div>" : "") +
    '<div class="src-status-row">' + badge(String(rec.status).replace(/_/g, " "), kind) +
    (rec.origin ? " " + badge(rec.origin, "neutral") : "") +
    '<span class="src-note">cited by ' + rec.refs.length + " claim" + (rec.refs.length === 1 ? "" : "s") + "</span></div></li>"
  );
}

async function pageDocumentSources(only) {
  const recs = await computeSourceDocuments();
  const groups = {};
  recs.forEach((r) => {
    (groups[r.origin || "not retrieved"] = groups[r.origin || "not retrieved"] || []).push(r);
  });
  let names = Object.keys(groups).sort((a, b) => (a === "not retrieved" ? 1 : b === "not retrieved" ? -1 : a.localeCompare(b)));
  if (only) names = names.filter((g) => g === only);
  const inner = names.length
    ? names
        .map((g) => {
          const rows = groups[g].slice().sort((a, b) => (a.source.title || "").localeCompare(b.source.title || ""));
          return (
            (only ? "" : "<h2>" + E(g) + ' <span class="sub" style="font-weight:400">(' + rows.length + ")</span></h2>") +
            '<ul class="src-list">' + rows.map(srcDocCardHtml).join("") + "</ul>"
          );
        })
        .join("")
    : '<div class="empty">No source documents from ' + E(only || "") + ".</div>";
  const head = only
    ? '<div class="sub"><a href="/document-sources" style="color:var(--accent);text-decoration:none">\u2190 all document sources</a></div><h1>' +
      E(only) + '</h1><div class="sub">every source document obtained from ' + E(only) + "</div>"
    : "<h1>Document sources</h1><div class=\"sub\">every source document a Wikipedia article cites, grouped by where it was obtained</div>";
  return htmlPage({ title: only ? only + " — Document sources" : "Document sources", active: "sources", main: '<div class="pg">' + head + inner + "</div>" });
}

function histBlockHtml(title, hist, isMeta) {
  if (!Array.isArray(hist) || !hist.length) return "";
  const rows = hist
    .map((h, i) => {
      const kind = /^retrieved$|^enriched$/.test(h.result) ? "ok" : /^skipped$|budget/.test(h.result || "") ? "neutral" : "bad";
      let extra = "";
      if (isMeta && h.found) {
        const f = h.found, p = [];
        if (f.title) p.push("title: " + f.title);
        if (f.author && f.author.length) p.push("author: " + (Array.isArray(f.author) ? f.author.join(", ") : f.author));
        if (f.year) p.push("year: " + f.year);
        if (f.container) p.push("in: " + f.container);
        if (f.doi) p.push("DOI: " + f.doi);
        if (f.isbn) p.push("ISBN: " + f.isbn);
        if (p.length) extra += '<div class="rh-detail">' + E(p.join(" \u00b7 ")) + "</div>";
      }
      if (h.query) extra += '<div class="rh-url">query: ' + E(h.query) + "</div>";
      if (h.url) extra += '<div class="rh-url"><a href="' + E(h.url) + '" target="_blank" rel="noopener">' + E(h.url) + "</a></div>";
      if (h.detail && h.result !== "retrieved") extra += '<div class="rh-detail">' + E(h.detail) + "</div>";
      return (
        '<li><span class="rh-n">' + (i + 1) + '.</span> <span class="rh-via">' + E(h.via || "\u2014") + "</span> " +
        badge(String(h.result || "").replace(/_/g, " "), kind) + extra + "</li>"
      );
    })
    .join("");
  return "<h2>" + E(title) + '</h2><ol class="rh-list">' + rows + "</ol>";
}

async function pageSourceDocument(key) {
  const rec = (await computeSourceDocuments()).find((r) => r.key === key);
  if (!rec) {
    return htmlPage({
      title: "Source document",
      active: "sources",
      main: '<div class="pg"><div class="sub"><a href="/document-sources" style="color:var(--accent);text-decoration:none">\u2190 document sources</a></div><div class="empty">No source document with that identity.</div></div>',
    });
  }
  const s = rec.source || {};
  const order = ["author", "title", "container_work", "publisher_or_journal", "year", "pages", "identifier", "document_type",
    "retrieval_url", "wikipedia_access_date", "retrieval_status", "retrieval_note", "retrieved_via_wayback", "is_public_domain", "local_cache_path"];
  const kv = order
    .filter((k) => k in s)
    .map((k) => {
      const v = s[k];
      let cell;
      if (k === "local_cache_path" && v) cell = '<a href="' + E(String(v).replace(/^\/+/, "")) + '" target="_blank" rel="noopener">' + E(v) + "</a>";
      else if (k === "retrieval_url" && v) cell = '<a href="' + E(v) + '" target="_blank" rel="noopener">' + E(v) + "</a>";
      else if (Array.isArray(v)) cell = E(v.join(", "));
      else if (v === null || v === "" || v === undefined) cell = '<span style="color:var(--muted)">\u2014</span>';
      else cell = E(String(v));
      return "<tr><th>" + E(k.replace(/_/g, " ")) + "</th><td>" + cell + "</td></tr>";
    })
    .join("");
  const citedBy = rec.refs
    .map(
      (r) =>
        '<a class="src-ref" href="/article/' + encodeURIComponent(r.doc_id) + "/" + encodeURIComponent(r.claim_id) + '">' +
        E(r.doc_title) + " \u00b7 " + E(r.claim_id) + "</a>"
    )
    .join("");
  const main =
    '<div class="pg"><div class="sub"><a href="/document-sources" style="color:var(--accent);text-decoration:none">\u2190 document sources</a></div>' +
    "<h1>" + E(s.title || "(untitled source document)") + "</h1>" +
    '<div class="src-status-row">' +
    badge(String(rec.status).replace(/_/g, " "), rec.status === "retrieved" ? "ok" : rec.status === "unreachable" ? "bad" : "neutral") +
    (rec.origin ? ' <a href="/document-sources/' + encodeURIComponent(rec.origin) + '">' + badge("document source: " + rec.origin, "neutral") + "</a>" : " " + badge("not retrieved", "neutral")) +
    "</div><table class=\"kv2\">" + kv + "</table>" +
    histBlockHtml("Metadata lookups", s.metadata_history, true) +
    histBlockHtml("Retrieval history", s.retrieval_history, false) +
    '<h2>Cited by</h2><div class="sub">the citation(s) in Wikipedia articles that point to this source document</div>' +
    '<div class="src-refs">' + citedBy + "</div>" +
    '<h2>Cites</h2><div class="sub">source documents this one cites, via its own citations \u2014 populated by phase 3 (following citations inside a source document), which is not implemented yet</div></div>';
  return htmlPage({ title: "Source document", active: "sources", main });
}

function sourceListCardHtml(entry, kind) {
  const s = entry.source || {};
  const author = Array.isArray(s.author) ? s.author.join(", ") : s.author;
  const bits = [author, s.year, s.document_type, s.identifier].filter(Boolean).join(" \u00b7 ");
  return (
    '<li class="src-card"><div class="st">' + E(s.title || "(untitled)") + "</div>" +
    (bits ? '<div class="src-bits">' + E(bits) + "</div>" : "") +
    '<div class="src-status-row">' +
    (kind === "validated" ? badge((entry.terminal_type || "terminal").replace(/_/g, " "), "term") : badge("unreachable", "bad")) +
    (s.retrieved_via_wayback === true ? " " + badge("via Wayback Machine", "neutral") : "") +
    (kind === "unreachable" && s.retrieval_note ? ' <span class="src-note">' + E(s.retrieval_note) + "</span>" : "") +
    "</div><div class=\"src-refs\">" +
    entry.refs
      .map(
        (r) =>
          '<a class="src-ref" href="/article/' + encodeURIComponent(r.doc_id) + "/" + encodeURIComponent(r.claim_id) + '">' +
          E(r.doc_title) + " \u00b7 " + E(r.claim_id) + "</a>"
      )
      .join("") +
    "</div></li>"
  );
}

async function pageUnreachable() {
  const d = await computeSourceReport();
  const list = d.unreachable || [];
  const main =
    '<div class="pg"><h1>Unreachable source documents (' + list.length + ")</h1>" +
    '<div class="sub">source documents a Wikipedia article cites whose full text could not be retrieved online \u2014 each with the specific reason</div>' +
    (list.length ? '<ul class="src-list">' + list.map((e) => sourceListCardHtml(e, "unreachable")).join("") + "</ul>" : '<div class="empty">None.</div>') +
    "</div>";
  return htmlPage({ title: "Unreachable sources", active: "unreachable", main });
}

async function pageRadiocarbon() {
  const d = await computeSourceReport();
  const list = (d.validated || []).filter((e) => e.terminal_type === "radiocarbon");
  const main =
    '<div class="pg"><h1>Radiocarbon source documents (' + list.length + ")</h1>" +
    '<div class="sub">source documents whose text carries the radiocarbon date behind a claim \u2014 populated by phase 3 (reading the downloaded source documents), which is not implemented yet</div>' +
    (list.length ? '<ul class="src-list">' + list.map((e) => sourceListCardHtml(e, "validated")).join("") + "</ul>" : '<div class="empty">None.</div>') +
    "</div>";
  return htmlPage({ title: "Radiocarbon sources", active: "radiocarbon", main });
}

async function pageClaimFinder(targetUrl) {
  const form =
    '<form class="inl" method="get" action="/claim-finder"><input name="url" type="url" value="' + E(targetUrl || "") +
    '" placeholder="https://en.wikipedia.org/wiki/Ancient_Egypt" required><button>Find claims</button></form>';
  let out = "";
  if (targetUrl) {
    try {
      wiki.parseWikiUrl(targetUrl);
      const page = await wiki.fetchPage(targetUrl);
      const { claims, rejected } = wiki.extractClaims(page, { maxClaims: 600, includeRejected: true });
      const all = claims
        .map((c) => ({ c, rej: false }))
        .concat(rejected.map((c) => ({ c, rej: true })))
        .sort((a, b) => (a.c.seq || 0) - (b.c.seq || 0));
      out =
        '<div class="sub">' + E(page.title) + " \u2014 " + claims.length + " kept \u00b7 " + rejected.length + " dropped</div>" +
        '<ul class="fr-claims">' +
        all
          .map((x) => {
            const c = x.c;
            const markers = (c.markers || []).map((m) => "[" + E(m.label) + "]").join("");
            return (
              '<li' + (x.rej ? ' class="rej"' : "") + '><div class="fr-sec">' + E(c.section || "") +
              (x.rej ? '<span class="fr-drop">dropped: ' + E(c.reason || "") + "</span>" : "") + "</div>" +
              "<div>" + E(c.sentence_cited || "") + " " + markers + "</div>" +
              (c.cutoff && c.cutoff.basis ? '<div class="sub" style="margin:4px 0 0">1450 CE check: ' + E(c.cutoff.basis) + "</div>" : "") +
              "</li>"
            );
          })
          .join("") +
        "</ul>";
    } catch (e) {
      out = '<div class="empty">' + E(e.message) + "</div>";
    }
  }
  const main =
    '<div class="pg"><h1>Claim finder</h1>' +
    '<div class="sub">Runs the analysis extractor (lib/wiki.js) on any Wikipedia URL \u2014 no source downloads, no AI. For tuning how claims are detected.</div>' +
    form + out + "</div>";
  return htmlPage({ title: "Claim finder", active: "finder", main });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const pathname = decodeURIComponent(url.pathname);

  try {
    // ---- server-rendered pages (GET) : each has its own URL, no SPA ----
    if (req.method === "GET" || req.method === "HEAD") {
      let pg = null;
      let m;
      if (pathname === "/" || pathname === "/index.html") pg = pageHome();
      else if (pathname === "/statistics") pg = pageStatistics();
      else if (pathname === "/document-sources") pg = pageDocumentSources(null);
      else if ((m = pathname.match(/^\/document-sources\/(.+)$/))) pg = pageDocumentSources(m[1]);
      else if ((m = pathname.match(/^\/source-document\/(.+)$/))) pg = pageSourceDocument(m[1]);
      else if ((m = pathname.match(/^\/claims\/([^/]+)$/))) pg = pageClaimsByStatus(m[1]);
      else if (pathname === "/unreachable") pg = pageUnreachable();
      else if (pathname === "/radiocarbon") pg = pageRadiocarbon();
      else if (pathname === "/claim-finder") pg = pageClaimFinder(url.searchParams.get("url") || "");
      else if ((m = pathname.match(/^\/article\/([^/]+)\/raw$/))) pg = pageArticle(m[1], true);
      else if ((m = pathname.match(/^\/article\/([^/]+)\/download$/))) {
        const data = await readDoc(m[1]);
        if (!data) return send(res, 404, "text/plain", "not found");
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "Content-Disposition": 'attachment; filename="' + String(m[1]).replace(/[^\w.-]/g, "_").replace(/\.json$/, "") + '.html"',
        });
        return res.end(ChronoRender.renderDocument(data, {}));
      } else if ((m = pathname.match(/^\/article\/([^/]+)\/(.+)$/))) pg = pageClaim(m[1], m[2]);
      else if ((m = pathname.match(/^\/article\/([^/]+)$/))) pg = pageArticle(m[1], false);
      if (pg) {
        const [type, body] = await pg;
        return send(res, 200, type, req.method === "HEAD" ? "" : body);
      }
    }
    if (pathname === "/render.js") {
      return send(res, 200, "text/javascript; charset=utf-8", fs.readFileSync(path.join(ROOT, "lib", "render.js")));
    }
    if (pathname === "/api/files") {
      return send(res, 200, "application/json", JSON.stringify(await backend.list()));
    }
    if (pathname === "/api/stats") {
      return send(res, 200, "application/json", JSON.stringify(await computeStats()));
    }
    if (pathname === "/api/sources") {
      return send(res, 200, "application/json", JSON.stringify(await computeSourceReport()));
    }
    if (pathname === "/api/claims") {
      return send(res, 200, "application/json", JSON.stringify(await computeClaimsByStatus()));
    }
    if (pathname === "/api/source-documents") {
      return send(res, 200, "application/json", JSON.stringify(await computeSourceDocuments()));
    }
    // "claim finder" — run the real extractor (lib/wiki.js) on an arbitrary URL
    if (pathname === "/api/find-claims") {
      const target = url.searchParams.get("url") || "";
      try {
        wiki.parseWikiUrl(target);
      } catch (e) {
        return send(res, 400, "application/json", JSON.stringify({ error: e.message }));
      }
      let page;
      try {
        page = await wiki.fetchPage(target);
      } catch (e) {
        return send(res, 502, "application/json", JSON.stringify({ error: e.message }));
      }
      const refIdx = wiki.buildReferenceIndex(page.html);
      const { claims, rejected } = wiki.extractClaims(page, { maxClaims: 600, includeRejected: true });
      const shapeMarker = (mk) => {
        const noteOnly = refIdx.isNoteOnly(mk.noteId, mk.label);
        const s = noteOnly ? null : refIdx.source(mk.noteId);
        return {
          label: mk.label,
          note_only: noteOnly,
          footnote: refIdx.markerText(mk.noteId),
          source: s
            ? {
                author: Array.isArray(s.author) ? s.author.join(", ") : s.author,
                title: s.title,
                year: s.year,
                type: s.document_type,
                url: s.retrieval_url,
                doi: s._doi || null,
                sparse: !!s._sparse,
              }
            : null,
        };
      };
      const shapeClaim = (c, isRejected) => ({
        rejected: isRejected,
        seq: c.seq,
        sentence_cited: c.sentence_cited,
        section: c.section,
        cutoff: c.cutoff,
        triggers: c.triggers || [],
        markers: (c.markers || []).map(shapeMarker),
        context_before: c.context_before || [],
        context_after: c.context_after || [],
        reason: c.reason || null, // set on dropped ones
      });
      // kept + rejected, interleaved in the order they appear in the article
      const candidates = claims
        .map((c) => shapeClaim(c, false))
        .concat(rejected.map((c) => shapeClaim(c, true)))
        .sort((a, b) => a.seq - b.seq);
      return send(
        res,
        200,
        "application/json",
        JSON.stringify({
          page: {
            title: page.title,
            url: page.url,
            revid: page.revid,
            sections: page.sections.length,
          },
          candidates: candidates,
          counts: { kept: claims.length, rejected: rejected.length },
        })
      );
    }
    if (pathname === "/api/file") {
      const raw = await backend.read(url.searchParams.get("id") || "");
      if (raw == null) return send(res, 404, "text/plain", "not found");
      return send(res, 200, "application/json", raw);
    }
    // grey "sentence before/after" context for the doc viewer (see lib/context.js)
    // — derived from the cached wiki page, {} if there isn't one (ai-only mode).
    if (pathname === "/api/context") {
      const id = url.searchParams.get("id") || "";
      const raw = await backend.read(id);
      if (raw == null) return send(res, 404, "application/json", JSON.stringify({ error: "document not found" }));
      let data;
      try {
        data = JSON.parse(raw);
      } catch (e) {
        return send(res, 500, "application/json", JSON.stringify({ error: "could not parse document: " + e.message }));
      }
      let context = {};
      try {
        context = buildContextMap(data, path.join(outDirForId(id), "source-cache"));
      } catch {
        /* best-effort */
      }
      return send(res, 200, "application/json", JSON.stringify(context));
    }
    // "Re-analyze" — rerun the full timeaudit.js pipeline for a document's
    // Wikipedia URL, overwriting it in place once the run finishes.
    if (pathname === "/api/reanalyze" && req.method === "POST") {
      const id = url.searchParams.get("id") || "";
      const raw = await backend.read(id);
      if (raw == null) return send(res, 404, "application/json", JSON.stringify({ error: "document not found" }));
      let data;
      try {
        data = JSON.parse(raw);
      } catch (e) {
        return send(res, 500, "application/json", JSON.stringify({ error: "could not parse document: " + e.message }));
      }
      const docUrl = data.page && data.page.url;
      if (!docUrl) return send(res, 400, "application/json", JSON.stringify({ error: "document has no page.url to re-fetch" }));
      const existing = reanalyzeJobs.get(id);
      if (existing && existing.running) {
        return send(res, 200, "application/json", JSON.stringify({ started: false, running: true }));
      }
      const mode = MODES.includes(data.generator && data.generator.mode) ? data.generator.mode : null;
      startTimeauditJob(id, docUrl, { mode, outDir: outDirForId(id), wipeSlug: String(id).replace(/\.json$/i, "") });
      return send(res, 200, "application/json", JSON.stringify({ started: true, url: docUrl, mode: mode || "(default)" }));
    }
    if (pathname === "/api/reanalyze/status") {
      const id = url.searchParams.get("id") || "";
      const job = reanalyzeJobs.get(id);
      if (!job) return send(res, 404, "application/json", JSON.stringify({ error: "no re-analyze job for this document yet" }));
      return send(res, 200, "application/json", JSON.stringify(jobSnapshot(job)));
    }
    // "Add article" — analyze a brand-new Wikipedia URL and add it to the DB.
    // Job is keyed "new:<slug>"; the client polls /api/analyze/status?job=<key>.
    if (pathname === "/api/analyze" && req.method === "POST") {
      const target = url.searchParams.get("url") || "";
      let parsed;
      try {
        parsed = wiki.parseWikiUrl(target);
      } catch (e) {
        return send(res, 400, "application/json", JSON.stringify({ error: e.message }));
      }
      // parseWikiUrl already decodes + de-underscores the title
      const jobKey = "new:" + slugify(parsed.title || target);
      const existing = reanalyzeJobs.get(jobKey);
      if (existing && existing.running) {
        return send(res, 200, "application/json", JSON.stringify({ started: false, running: true, job: jobKey }));
      }
      startTimeauditJob(jobKey, target, { outDir: DIR });
      return send(res, 200, "application/json", JSON.stringify({ started: true, job: jobKey, url: target }));
    }
    if (pathname === "/api/analyze/status") {
      const jobKey = url.searchParams.get("job") || "";
      const job = reanalyzeJobs.get(jobKey);
      if (!job) return send(res, 404, "application/json", JSON.stringify({ error: "no analyze job with that key" }));
      return send(res, 200, "application/json", JSON.stringify(jobSnapshot(job)));
    }
    // cached assets (images only). Screenshots under _shots/ are a presentation
    // artefact — generated here, on demand, from the report + cached sources.
    if (/^\/source-cache\/.+\.(png|jpe?g|webp|gif)$/i.test(pathname)) {
      const root = path.resolve(DIR, "source-cache");
      let full = path.resolve(DIR, "." + pathname);
      if (!full.startsWith(root + path.sep)) return send(res, 404, "text/plain", "not found");

      const shotM = pathname.match(/^\/source-cache\/_shots\/([^/]+)\/(.+)\.png$/i);
      if (!fs.existsSync(full) && shotM) {
        try {
          const report = await reportForSlug(shotM[1]);
          if (report) {
            const made = await shots.generateShot(report, root, shotM[2]);
            if (made) full = made;
          }
        } catch (e) {
          process.stderr.write("shot gen failed: " + e.message + "\n");
        }
      }
      if (!fs.existsSync(full)) return send(res, 404, "text/plain", "not found");
      const ext = pathname.split(".").pop().toLowerCase();
      return send(res, 200, "image/" + (ext === "jpg" ? "jpeg" : ext), fs.readFileSync(full));
    }
    // the raw cached document a source was resolved from ("local cache path"
    // links in the viewer) — served as-is, whatever format it was saved in.
    if (/^\/source-cache\/.+\.(pdf|xml|html?|txt)$/i.test(pathname)) {
      const root = path.resolve(DIR, "source-cache");
      const full = path.resolve(DIR, "." + pathname);
      if (!full.startsWith(root + path.sep) || !fs.existsSync(full)) return send(res, 404, "text/plain", "not found");
      const ext = pathname.split(".").pop().toLowerCase();
      const mime =
        { pdf: "application/pdf", xml: "application/xml", html: "text/html; charset=utf-8", htm: "text/html; charset=utf-8", txt: "text/plain; charset=utf-8" }[
          ext
        ] || "application/octet-stream";
      return send(res, 200, mime, fs.readFileSync(full));
    }
    send(res, 404, "text/plain", "not found");
  } catch (e) {
    process.stderr.write("request error: " + (e && e.message ? e.message : e) + "\n");
    send(res, 500, "text/plain", "server error");
  }
});

server.listen(PORT, async () => {
  let n = "?";
  try {
    n = (await backend.list()).length;
  } catch (e) {
    process.stderr.write("warning: could not read " + backend.name + " source: " + e.message + "\n");
  }
  process.stdout.write(
    "Source: " + backend.name + (backend.name === "filesystem" ? " (" + DIR + ")" : "") + "\n" +
      "Found " + n + " document(s).\n" +
      "Open  http://localhost:" + PORT + "/\n"
  );
});
