/*
 * scholar.js — the "follow the citation" half of the pipeline, done locally:
 *
 *   - resolve candidate URLs for a source (direct link, OA copy, DOI landing)
 *   - download and cache the file under source-cache/<slug>/ (SPEC.md rule 8)
 *   - extract plain text (pdftotext for PDFs, tag-strip for HTML)
 *   - heuristically classify whether the source is a terminal dating method,
 *     and pull structured facts (lab codes, calibrated ranges, sample counts)
 *     and candidate load-bearing quotes
 *   - find onward citation leads (DOIs/URLs) inside a source for multi-hop
 *
 * No AI. No npm deps. `pdftotext` (poppler) is used when present.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");
const { execFileSync } = require("child_process");

const UA = "timeaudit/1.0 (chronology extraction; +https://github.com/priestc/timeaudit)";
const MAX_BYTES = 40 * 1024 * 1024;
const lastHit = new Map(); // host -> ts, for 1 req/s/host politeness

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function politeGet(url, { asBuffer = false, timeout = 25000, redirects = 6 } = {}) {
  const u = new URL(url);
  const wait = 1000 - (Date.now() - (lastHit.get(u.host) || 0));
  if (wait > 0) await sleep(wait);
  lastHit.set(u.host, Date.now());

  return new Promise((resolve, reject) => {
    const lib = u.protocol === "http:" ? http : https;
    const req = lib.get(
      url,
      { headers: { "User-Agent": UA, Accept: "*/*" }, timeout },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
          res.resume();
          return resolve(
            politeGet(new URL(res.headers.location, url).toString(), { asBuffer, timeout, redirects: redirects - 1 })
          );
        }
        const chunks = [];
        let n = 0;
        res.on("data", (c) => {
          n += c.length;
          if (n > MAX_BYTES) {
            req.destroy();
            return;
          }
          chunks.push(c);
        });
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            contentType: (res.headers["content-type"] || "").split(";")[0].trim(),
            finalUrl: url,
            body: asBuffer ? Buffer.concat(chunks) : Buffer.concat(chunks).toString("utf8"),
          })
        );
      }
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
  });
}

function hopSlug(source) {
  const last = Array.isArray(source.author)
    ? String(source.author[0] || "").split(/[\s,]+/).filter(Boolean).pop()
    : String(source.author || "").split(/[\s,]+/).filter(Boolean).pop();
  const title = (source.title || "").split(/\s+/).slice(0, 4).join(" ");
  let s = [last, source.year, title].filter(Boolean).join(" ");
  if (!s && source._doi) s = "doi-" + source._doi;
  if (!s && source.retrieval_url) {
    try {
      const u = new URL(source.retrieval_url);
      s = u.hostname.replace(/^www\./, "") + "-" + u.pathname.split("/").filter(Boolean).slice(-2).join("-");
    } catch {
      /* ignore */
    }
  }
  return (
    (s || "source")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "source"
  );
}

/* ------------------------------------------------------ URL resolution ------ */

function isDirectPdf(url) {
  return /\.pdf($|[?#])/i.test(url || "") || /\/pdf(\/|$|\?)/i.test(url || "");
}
function pmcIdOf(url) {
  const m = String(url || "").match(/PMC(\d{4,9})/i);
  return m ? "PMC" + m[1] : null;
}

async function tryJSON(url) {
  try {
    const r = await politeGet(url);
    if (r.status === 200) return JSON.parse(r.body);
  } catch {
    /* optional source */
  }
  return null;
}

// Ordered list of URLs to try. The OA aggregators (OpenAlex, Europe PMC) need no
// key and don't block scripted access, so they come before publisher landing pages.
async function resolveCandidates(source, { email } = {}) {
  const out = [];
  const push = (u, why) => u && /^https?:/.test(u) && !out.some((o) => o.url === u) && out.push({ url: u, why });

  if (isDirectPdf(source.retrieval_url)) push(source.retrieval_url, "direct pdf");

  // OpenAlex — OA location by DOI
  if (source._doi) {
    const j = await tryJSON("https://api.openalex.org/works/doi:" + encodeURIComponent(source._doi));
    if (j) {
      push(j.best_oa_location && j.best_oa_location.pdf_url, "openalex OA pdf");
      push(j.open_access && j.open_access.oa_url, "openalex OA url");
      const pmcid = pmcIdOf(JSON.stringify(j.locations || []));
      if (pmcid) push("https://www.ebi.ac.uk/europepmc/webservices/rest/" + pmcid + "/fullTextXML", "europepmc fulltext");
    }
  }

  // Europe PMC — by PMC id in the cited URL, or by DOI
  const pmcid = pmcIdOf(source.retrieval_url);
  if (pmcid) push("https://www.ebi.ac.uk/europepmc/webservices/rest/" + pmcid + "/fullTextXML", "europepmc fulltext");
  if (source._doi && !pmcid) {
    const s = await tryJSON(
      "https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=DOI:" +
        encodeURIComponent(source._doi) +
        "&resultType=core&format=json"
    );
    const hit = s && s.resultList && s.resultList.result && s.resultList.result[0];
    if (hit && hit.pmcid) {
      push("https://www.ebi.ac.uk/europepmc/webservices/rest/" + hit.pmcid + "/fullTextXML", "europepmc fulltext");
    }
    (hit && hit.fullTextUrlList && hit.fullTextUrlList.fullTextUrl ? hit.fullTextUrlList.fullTextUrl : [])
      .filter((f) => f.availability === "Open access" || f.documentStyle === "pdf")
      .forEach((f) => push(f.url, "europepmc " + (f.documentStyle || "link")));
  }

  // Unpaywall — needs a contact email
  if (source._doi && email) {
    const j = await tryJSON(
      "https://api.unpaywall.org/v2/" + encodeURIComponent(source._doi) + "?email=" + encodeURIComponent(email)
    );
    const loc = j && (j.best_oa_location || (j.oa_locations || [])[0]);
    if (loc) {
      push(loc.url_for_pdf, "unpaywall OA pdf");
      push(loc.url, "unpaywall OA landing");
    }
  }

  push(source.retrieval_url, "cited url");
  if (source._doi) push("https://doi.org/" + source._doi, "doi landing");
  return out;
}

/* ------------------------------------------------------ download + cache ---- */

function extRfrom(contentType, url) {
  if (/pdf/i.test(contentType) || isDirectPdf(url)) return "pdf";
  if (/html/i.test(contentType) || !contentType) return "html";
  if (/xml/i.test(contentType)) return "xml";
  if (/plain/i.test(contentType)) return "txt";
  return "bin";
}

// A books.google.* URL that isn't a direct file download is always just the
// restricted-preview shell — Google never serves an in-copyright book's full
// text over a plain HTTP GET, so there's no point even trying it, and a "200
// OK, some HTML came back" would otherwise be mistaken for a real download.
function isGoogleBooksPreview(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (!/(^|\.)books\.google\.[a-z.]+$/i.test(u.hostname)) return false;
  if (isDirectPdf(url) || /output=(?:pdf|epub)/i.test(u.search)) return false;
  return true;
}
const COPYRIGHT_REASON = "unable to retrieve source because copyrighted (Google Books preview only, not the full text)";

// A response body that is a bot-wall / challenge / paywall rather than the
// source, with a specific reason for why (SPEC.md non-goal: never guess past
// this, just record accurately what stopped retrieval).
function blockedReason(text) {
  const head = text.slice(0, 6000);
  if (/recaptcha\/challengepage|Just a moment\.\.\.|cf-browser-verification|Checking if the site connection is secure|Enable JavaScript and cookies to continue|Access to this page has been denied/i.test(head)) {
    return "blocked by an anti-bot / browser-verification challenge";
  }
  if (/\b403 Forbidden\b/i.test(head) && text.length < 3000) return "server refused access (HTTP 403 Forbidden)";
  if (/\b429 Too Many Requests\b/i.test(head) && text.length < 3000) return "server refused access (HTTP 429 Too Many Requests)";
  if (
    /\b(purchase access|get access|institutional login|subscribe to (?:read|view)|buy this article|pay-per-view)\b/i.test(head) &&
    text.length < 9000
  ) {
    return "paywalled — publisher requires purchase or institutional access";
  }
  if (/\baccess denied\b/i.test(head) && text.length < 9000) return "access denied by the host";
  return null;
}

// Rank candidate failure reasons so the *most informative* one is what a
// claim ends up recording, not just whichever candidate happened to be tried
// last (SPEC.md: always record the most accurate reason a source failed).
function reasonRank(reason) {
  if (/copyrighted/i.test(reason)) return 5;
  if (/paywalled/i.test(reason)) return 4;
  if (/anti-bot|access denied/i.test(reason)) return 3;
  if (/^server refused access/i.test(reason)) return 2;
  if (/^network error/i.test(reason)) return 1;
  return 0; // stub/empty page, not-really-a-pdf, etc. — least specific
}

// candidates worth re-checking in the Wayback Machine when they fail — real
// pages/files that could have existed and simply moved or come down, as
// opposed to a live API query (OpenAlex/Europe PMC/Unpaywall) whose 404 means
// "not indexed there", which an archived snapshot of that same query
// wouldn't change.
const ARCHIVABLE_WHY = new Set(["direct pdf", "cited url", "doi landing"]);

// The Internet Archive's free, keyless lookup for the closest saved snapshot
// of a URL. `id_` after the timestamp asks for the raw saved bytes, not the
// Wayback Machine's toolbar-wrapped replay page.
async function waybackSnapshot(url) {
  const j = await tryJSON("https://archive.org/wayback/available?url=" + encodeURIComponent(url));
  const snap = j && j.archived_snapshots && j.archived_snapshots.closest;
  if (!snap || !snap.available || !snap.url) return null;
  return snap.url.replace(/^http:/, "https:").replace(/(\/web\/\d+)\//, "$1id_/");
}

// One attempt at downloading+validating a single URL. Never touches the
// budget counter itself — the caller does, since a Wayback retry is a
// second request against the same budget.
async function attemptDownload(url, dir, base) {
  let r;
  try {
    r = await politeGet(url, { asBuffer: true });
  } catch (e) {
    return { ok: false, reason: "network error contacting " + url + " (" + (e && e.message ? e.message : e) + ")" };
  }
  if (r.status !== 200) return { ok: false, reason: "HTTP " + r.status + " from " + url };
  if (!r.body.length) return { ok: false, reason: "empty response from " + url };
  const ext = extRfrom(r.contentType, r.finalUrl);
  if (ext === "pdf" && r.body.slice(0, 5).toString("latin1") !== "%PDF-") {
    return { ok: false, reason: "response from " + url + " was not actually a PDF" };
  }
  if (ext !== "pdf") {
    const asText = r.body.toString("utf8");
    const blocked = blockedReason(asText);
    if (blocked) return { ok: false, reason: blocked }; // bot-wall / paywall
    if (asText.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim().length < 400) {
      return { ok: false, reason: "page returned almost no text (likely a stub or preview page)" };
    }
  }
  const file = path.join(dir, base + "." + ext);
  fs.writeFileSync(file, r.body);
  // caller builds `rel` itself (it knows pageSlug); just hand back what was saved
  return { ok: true, file, contentType: ext, url };
}

async function fetchSource(source, { cacheDir, pageSlug, email, budget }) {
  const dir = path.join(cacheDir, pageSlug);
  fs.mkdirSync(dir, { recursive: true });
  const base = hopSlug(source);

  // reuse if already cached (any extension)
  for (const ext of ["pdf", "html", "xml", "txt"]) {
    const p = path.join(dir, base + "." + ext);
    if (fs.existsSync(p)) {
      return {
        status: "cached",
        file: p,
        rel: path.join("source-cache", pageSlug, base + "." + ext),
        contentType: ext,
      };
    }
  }
  if (budget && budget.left <= 0) {
    return { status: "skipped-budget", reason: "download budget for this run was exhausted before this source could be attempted" };
  }

  const cands = await resolveCandidates(source, { email });
  if (!cands.length) {
    return {
      status: "unreachable",
      reason: "no retrievable URL could be resolved from this citation's metadata (e.g. a print-only reference with no DOI or online copy)",
    };
  }

  const failures = []; // { reason } for every candidate that didn't work
  for (const c of cands) {
    if (budget && budget.left <= 0) {
      failures.push({ reason: "download budget for this run was exhausted" });
      break;
    }
    if (isGoogleBooksPreview(c.url)) {
      failures.push({ reason: COPYRIGHT_REASON });
      continue;
    }

    let result = await attemptDownload(c.url, dir, base);
    if (budget) budget.left--;

    if (!result.ok && ARCHIVABLE_WHY.has(c.why) && budget && budget.left > 0) {
      let snapUrl = null;
      try {
        snapUrl = await waybackSnapshot(c.url);
      } catch {
        /* Wayback lookup itself failing is not worth reporting over the original reason */
      }
      if (snapUrl) {
        const viaWayback = await attemptDownload(snapUrl, dir, base);
        budget.left--;
        if (viaWayback.ok) {
          result = viaWayback;
          result.why = c.why + " (Wayback Machine archive)";
        } else {
          result.reason += "; a Wayback Machine archive exists but also failed (" + viaWayback.reason + ")";
        }
      }
    }

    if (result.ok) {
      return {
        status: "downloaded",
        file: result.file,
        rel: path.join("source-cache", pageSlug, base + "." + result.contentType),
        contentType: result.contentType,
        via: result.why || c.why,
        url: result.url,
      };
    }
    failures.push({ reason: result.reason });
  }
  // every candidate failed — surface the single most informative reason
  const best = failures.reduce((a, b) => (reasonRank(b.reason) > reasonRank(a.reason) ? b : a), failures[0]);
  return { status: "unreachable", reason: (best && best.reason) || "every candidate URL failed" };
}

/* ------------------------------------------------------ text extraction ---- */

let HAVE_PDFTOTEXT = null;
function havePdftotext() {
  if (HAVE_PDFTOTEXT === null) {
    try {
      execFileSync("pdftotext", ["-v"], { stdio: "ignore" });
      HAVE_PDFTOTEXT = true;
    } catch {
      HAVE_PDFTOTEXT = false;
    }
  }
  return HAVE_PDFTOTEXT;
}

function extractText(file, contentType) {
  const txtPath = file.replace(/\.[a-z0-9]+$/i, "") + ".txt";
  if (fs.existsSync(txtPath)) return fs.readFileSync(txtPath, "utf8");
  let text = "";
  if (contentType === "pdf" || /\.pdf$/i.test(file)) {
    if (!havePdftotext()) return "";
    try {
      text = execFileSync("pdftotext", ["-q", "-enc", "UTF-8", "-nopgbrk", file, "-"], {
        maxBuffer: 64 * 1024 * 1024,
      }).toString("utf8");
    } catch {
      text = "";
    }
  } else {
    const raw = fs.readFileSync(file, "utf8");
    text = raw
      .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&#(\d+);/g, (_, d) => {
        try {
          return String.fromCodePoint(+d);
        } catch {
          return "";
        }
      });
  }
  text = text.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  if (text) {
    try {
      fs.writeFileSync(txtPath, text);
    } catch {
      /* ignore */
    }
  }
  return text;
}

/* ------------------------------------------------------ terminal classify -- */

const SIGNATURES = [
  ["radiocarbon", /\b(radiocarbon|\bAMS\b|14C|C-14|\bcal(?:ibrated)?\.?\s?(?:BP|BC|yr)\b|OxCal|IntCal\d*|CALIB|Bayesian (?:age|chronological) model|conventional radiocarbon age)\b/i],
  ["OSL", /\b(optically stimulated luminescence|\bOSL\b|\bpIRIR\b|luminescence (?:dating|ages?)|single[- ]grain (?:OSL|luminescence)|equivalent dose|De \(Gy\))\b/i],
  ["uranium_thorium", /\b(uranium[-\s]?thorium|U[-\s]?Th\b|²³⁰Th\/²³⁴U|230Th\/234U|uranium[-\s]series|U-series dating)\b/i],
  ["argon_argon", /\b(⁴⁰Ar\/³⁹Ar|40Ar\/39Ar|argon[-\s]argon|\bK[-\s]Ar\b|potassium[-\s]argon)\b/i],
  ["dendrochronology", /\b(dendrochronolog\w*|tree[-\s]ring (?:date|dating|chronolog)|wiggle[-\s]match)\b/i],
  ["thermoluminescence", /\b(thermoluminescence|\bTL dating\b|\bTL ages?\b)\b/i],
  ["genetic_context_dating", /\b(molecular clock|ancient DNA|aDNA|radiocarbon-dated (?:skeleton|individual)|genome[- ]wide .* dated to)\b/i],
  ["comparative", /\b(typolog\w+|seriation|stylistic (?:comparison|grounds|dating)|cross[-\s]dating|relative chronolog\w*|king[- ]list|synchronism|ceramic (?:phase|assemblage) comparison|art[- ]historical dating)\b/i],
];

const LAB_CODE = /\b(?:Beta|OxA|GrN|GrA|Poz|Wk|AA|Ua|KIA|Hela|RICH|DEM|LTL|GifA|Ly(?:on)?|SUERC|UBA|D-AMS|ETH|CAMS|PSU|ISGS|BM|GX|Tx|Hd|Bln|GdA|MAMS|AAR|VERA|CNA)[-\s]?\d{3,6}\b/g;
// calibrated ranges like "8617-8315 calBC", "9500 ± 60 BP", "7000-6500 cal BC"
const CAL_RANGE = /(?<![\d.,])\d{3,5}\s?[–-]\s?\d{3,5}\s?(?:cal\.?\s?)?(?:BC|BCE|BP|CE|AD)\b|(?<![\d.,])\d{3,5}\s?±\s?\d{1,4}\s?(?:cal\.?\s?)?BP\b/gi;
const SAMPLE_N = /\b(\d{1,3})\s+(?:radiocarbon\s+|AMS\s+|OSL\s+|calibrated\s+)?(?:dates|determinations|samples|measurements|assays)\b/i;

function classifyText(text, claim) {
  if (!text || text.length < 200) {
    return { terminal_type: null, is_terminal: false, confidence: 0, structured_facts: {}, candidate_quotes: [], reason: "no extractable text" };
  }
  const hits = SIGNATURES.filter(([, re]) => re.test(text)).map(([k]) => k);
  const physical = hits.filter((h) => h !== "comparative");

  const facts = {};
  const labs = [...new Set((text.match(LAB_CODE) || []).map((s) => s.replace(/\s+/g, " ").trim()))].slice(0, 25);
  if (labs.length) facts.lab_codes = labs;
  const nm = text.match(SAMPLE_N);
  if (nm) facts.sample_count_mentioned = parseInt(nm[1], 10);
  const ranges = [];
  let rm;
  const RR = new RegExp(CAL_RANGE.source, "gi");
  while ((rm = RR.exec(text)) && ranges.length < 12) ranges.push(rm[0].replace(/\s+/g, " ").trim());
  if (ranges.length) facts.date_expressions_found = [...new Set(ranges)];

  // Being *about* a dating method (a mention) is not the same as *being* the
  // terminal source. Without AI we only call a hop terminal on strong evidence:
  // lab codes, calibrated ranges, or explicit "N samples were dated" wording.
  const didDating =
    /\b(?:samples?|charcoal|bone|seeds?|material)\s+(?:were|was)\s+(?:radiocarbon[- ]?)?dated\b/i.test(text) ||
    /\b(?:radiocarbon|AMS|OSL|luminescence)\s+dating\s+(?:was|were)\s+(?:carried out|performed|undertaken|conducted)\b/i.test(text) ||
    /\b\d{1,3}\s+(?:new\s+)?(?:radiocarbon|AMS|OSL)?\s*(?:dates|determinations|measurements|assays)\b/i.test(text);
  const strongPhysical = labs.length >= 1 || ranges.length >= 2 || (physical.length && didDating);

  let terminal_type = null;
  let is_terminal = false;
  let confidence = 0;
  if (physical.length && strongPhysical) {
    terminal_type = physical[0];
    is_terminal = true;
    confidence = Math.min(1, 0.4 + 0.15 * physical.length + (labs.length ? 0.3 : 0) + (ranges.length ? 0.15 : 0));
  } else if (physical.length) {
    terminal_type = physical[0]; // a guess only
    confidence = 0.25;
  } else if (hits.includes("comparative") && /\b(dated|dating|chronolog|phase|period)\b/i.test(text)) {
    terminal_type = "comparative";
    is_terminal = true;
    confidence = 0.35;
  }
  if (/\blaborator/i.test(text)) {
    const l = text.match(/\b([A-Z][A-Za-z.\- ]{3,40}?(?:Radiocarbon|AMS|Luminescence|Dating)\s+Laborator(?:y|ies))\b/);
    if (l) facts.laboratory_named = l[1].trim();
  }

  // candidate load-bearing quotes: sentences with a method term AND a number/era
  const quotes = [];
  const sents = text.replace(/\n+/g, " ").split(/(?<=[.!?])\s+(?=[A-Z0-9"'(])/);
  const methodRe = /radiocarbon|luminescence|\bOSL\b|\bAMS\b|dendro|thermolumin|uranium|argon|calibrat|\bcal BP\b|\bBP\b|seriation|typolog|stylistic/i;
  for (const s0 of sents) {
    const s = s0.replace(/\s+/g, " ").trim();
    if (s.length < 40 || s.length > 320) continue;
    if (methodRe.test(s) && /\d/.test(s)) {
      quotes.push(s);
      if (quotes.length >= 5) break;
    }
  }

  return { terminal_type, is_terminal, confidence: +confidence.toFixed(2), structured_facts: facts, candidate_quotes: quotes, method_hits: hits };
}

/* ------------------------------------------------------ onward leads ------- */

function findOnwardLeads(text, { max = 4 } = {}) {
  if (!text) return [];
  const leads = [];
  const seen = new Set();
  const methodIdx = [];
  const mr = /radiocarbon|luminescence|\bOSL\b|dendro|uranium[-\s]?series|\bAMS\b|calibrat/gi;
  let m;
  while ((m = mr.exec(text))) methodIdx.push(m.index);

  const doiRe = /\b10\.\d{4,9}\/[^\s"'<>)\]]+/g;
  while ((m = doiRe.exec(text))) {
    const doi = m[0].replace(/[.,;]+$/, "");
    if (seen.has(doi)) continue;
    seen.add(doi);
    const near = methodIdx.some((i) => Math.abs(i - m.index) < 1200);
    // the reference/citation text as it sits in this document, around the DOI
    const ctx = text
      .slice(Math.max(0, m.index - 260), m.index + m[0].length + 40)
      .replace(/\s+/g, " ")
      .trim();
    leads.push({ kind: "doi", value: doi, url: "https://doi.org/" + doi, near_method: near, context: ctx });
  }
  leads.sort((a, b) => Number(b.near_method) - Number(a.near_method));
  return leads.slice(0, max);
}

module.exports = {
  hopSlug,
  resolveCandidates,
  fetchSource,
  extractText,
  classifyText,
  findOnwardLeads,
  havePdftotext,
  havePdftoppm,
  snapshotQuote,
  snapshotPage,
  politeGet,
};

/* ---------------------------------------------- quote screenshots (PDF) ---- */

let HAVE_PDFTOPPM = null;
function havePdftoppm() {
  if (HAVE_PDFTOPPM === null) {
    try {
      execFileSync("pdftoppm", ["-h"], { stdio: "ignore" });
      HAVE_PDFTOPPM = true;
    } catch {
      HAVE_PDFTOPPM = false;
    }
  }
  return HAVE_PDFTOPPM;
}

function normTok(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "");
}

// [{ width, height, words: [{x0,y0,x1,y1,t}] }] in PDF points (origin top-left)
function pdfWordBoxes(pdfPath) {
  let xml;
  try {
    xml = execFileSync("pdftotext", ["-bbox-layout", pdfPath, "-"], {
      maxBuffer: 128 * 1024 * 1024,
    }).toString("utf8");
  } catch {
    return [];
  }
  const pages = [];
  const pageRe = /<page width="([\d.]+)" height="([\d.]+)">([\s\S]*?)<\/page>/g;
  const wordRe = /<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([\s\S]*?)<\/word>/g;
  let pm;
  while ((pm = pageRe.exec(xml))) {
    const words = [];
    let wm;
    wordRe.lastIndex = 0;
    while ((wm = wordRe.exec(pm[3]))) {
      const t = normTok(
        wm[5].replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      );
      if (t) words.push({ x0: +wm[1], y0: +wm[2], x1: +wm[3], y1: +wm[4], t });
    }
    pages.push({ width: +pm[1], height: +pm[2], words });
  }
  return pages;
}

// find where `quote` sits in the page word-stream; tolerant of hyphenation /
// extra tokens (up to 2 skipped stream words per quote token)
function locateQuote(pages, quote) {
  const qt = quote.split(/\s+/).map(normTok).filter((t) => t.length > 1);
  if (qt.length < 4) return null;
  const probe = qt.slice(0, Math.min(40, qt.length));
  const need = Math.max(4, Math.ceil(probe.length * 0.6));
  let best = null;
  for (let p = 0; p < pages.length; p++) {
    const W = pages[p].words;
    for (let i = 0; i < W.length; i++) {
      if (W[i].t !== probe[0] && !W[i].t.startsWith(probe[0])) continue;
      let si = i;
      let matched = 0;
      const hit = [];
      for (let qi = 0; qi < probe.length && si < W.length; qi++) {
        let adv = 0;
        while (si < W.length && adv <= 2) {
          const w = W[si].t;
          if (w === probe[qi] || w.startsWith(probe[qi]) || probe[qi].startsWith(w)) {
            hit.push(W[si]);
            si++;
            matched++;
            break;
          }
          si++;
          adv++;
        }
      }
      if (matched >= need && (!best || matched > best.matched)) {
        best = { page: p, matched, probeLen: probe.length, words: hit.slice() };
      }
      if (best && best.matched === probe.length) break;
    }
    if (best && best.matched === probe.length) break;
  }
  return best;
}

/**
 * Render the region of `pdfPath` where `quote` appears to a tight PNG at outPng.
 * @returns {{page:number,file:string} | null}
 */
function snapshotQuote(pdfPath, quote, outPng, opts = {}) {
  const dpi = opts.dpi || 150;
  const padPt = opts.padPt == null ? 10 : opts.padPt;
  if (!havePdftoppm() || !fs.existsSync(pdfPath)) return null;
  const pages = pdfWordBoxes(pdfPath);
  const loc = pages.length ? locateQuote(pages, quote) : null;
  if (!loc || !loc.words.length) return null;
  const pg = pages[loc.page];

  // group matched words into lines by vertical overlap, so a quote whose match
  // brushes an adjacent column doesn't blow the crop out to the page width
  const rows = [];
  loc.words
    .slice()
    .sort((a, b) => a.y0 - b.y0)
    .forEach((w) => {
      const r = rows.find((r) => Math.abs((r.y0 + r.y1) / 2 - (w.y0 + w.y1) / 2) < (w.y1 - w.y0) * 0.7);
      if (r) {
        r.x0 = Math.min(r.x0, w.x0);
        r.x1 = Math.max(r.x1, w.x1);
        r.y0 = Math.min(r.y0, w.y0);
        r.y1 = Math.max(r.y1, w.y1);
      } else {
        rows.push({ x0: w.x0, x1: w.x1, y0: w.y0, y1: w.y1 });
      }
    });
  const lineW = Math.max(...rows.map((r) => r.x1 - r.x0));
  let x0 = Math.min(...rows.map((r) => r.x0)) - padPt;
  let x1 = x0 + lineW + 2 * padPt;
  let y0 = Math.min(...rows.map((r) => r.y0)) - padPt;
  let y1 = Math.max(...rows.map((r) => r.y1)) + padPt;
  x0 = Math.max(0, x0);
  y0 = Math.max(0, y0);
  x1 = Math.min(pg.width, x1);
  y1 = Math.min(pg.height, y1);
  const w = x1 - x0;
  const h = y1 - y0;
  if (w < 20 || h < 6 || h > pg.height * 0.6) return null; // implausible match

  const s = dpi / 72;
  const prefix = outPng.replace(/\.png$/i, "");
  try {
    execFileSync(
      "pdftoppm",
      [
        "-png", "-singlefile", "-r", String(dpi),
        "-f", String(loc.page + 1), "-l", String(loc.page + 1),
        "-x", String(Math.floor(x0 * s)), "-y", String(Math.floor(y0 * s)),
        "-W", String(Math.ceil(w * s)), "-H", String(Math.ceil(h * s)),
        pdfPath, prefix,
      ],
      { stdio: "ignore" }
    );
  } catch {
    return null;
  }
  return fs.existsSync(outPng) ? { page: loc.page + 1, file: outPng } : null;
}

/**
 * Render a whole PDF page (no crop) to a PNG — the full page a quote was taken
 * from, running heads / page numbers / figures / other columns and all.
 * @returns {{file:string} | null}
 */
function snapshotPage(pdfPath, page, outPng, opts = {}) {
  const dpi = opts.dpi || 150;
  if (!havePdftoppm() || !fs.existsSync(pdfPath)) return null;
  if (fs.existsSync(outPng)) return { file: outPng }; // shared across quotes on the same page
  try {
    execFileSync(
      "pdftoppm",
      ["-png", "-singlefile", "-r", String(dpi), "-f", String(page), "-l", String(page), pdfPath, outPng.replace(/\.png$/i, "")],
      { stdio: "ignore" }
    );
  } catch {
    return null;
  }
  return fs.existsSync(outPng) ? { file: outPng } : null;
}
