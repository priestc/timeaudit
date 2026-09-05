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

  // an archive snapshot Wikipedia already recorded for this citation — a
  // known-good copy of what the editor cited; ask for the raw saved bytes
  if (source._archiveUrl) {
    push(source._archiveUrl.replace(/^http:/, "https:").replace(/(\/web\/\d+)\//, "$1id_/"), "wikipedia archive-url");
  }

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
  // matches the live host and a books.google URL wrapped in a Wayback link
  if (!/(?:^|\/\/|\.)books\.google\.[a-z.]+\//i.test(String(url || ""))) return false;
  if (isDirectPdf(url) || /output=(?:pdf|epub)/i.test(url)) return false;
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
  if (/paywalled|subscription|login[- ]?wall|access[- ]restricted/i.test(reason)) return 4;
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

// The Internet Archive's free, keyless lookup for the saved snapshot of a URL
// closest to `nearDate` (an ISO date or "YYYY-MM-DD"; e.g. the citation's
// "Retrieved …" access-date — the snapshot from around then is likelier to
// show what the editor cited than "closest to now"). `id_` after the
// timestamp asks for the raw saved bytes, not the toolbar-wrapped replay page.
async function waybackSnapshot(url, nearDate) {
  let q = "https://archive.org/wayback/available?url=" + encodeURIComponent(url);
  const ts = String(nearDate || "").replace(/[^0-9]/g, "").slice(0, 8);
  if (ts.length >= 4) q += "&timestamp=" + ts;
  const j = await tryJSON(q);
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
  if (r.status !== 200) {
    // politeGet already follows Location headers up to its hop cap. A 3xx that
    // survives that means the redirect chain never landed on content — the
    // final URL is almost always a paywall / SSO login wall (it says so).
    if (r.status >= 300 && r.status < 400) {
      const dest = r.finalUrl || url;
      const loginWall =
        /login_required|[?&](?:error|denied)=|\/login\b|\/signin\b|\boidc\b|shibboleth|\/idp\/|\bauthn\b|ezproxy|athens|wayf|SSO/i.test(dest);
      return {
        ok: false,
        reason: loginWall
          ? "redirects to a login / subscription page — the source is access-restricted (" + dest.slice(0, 160) + ")"
          : "redirect chain from " + url + " never resolved to a document (last stop: " + dest.slice(0, 160) + ")",
      };
    }
    return { ok: false, reason: "HTTP " + r.status + " from " + url };
  }
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

// a cached file's own provenance (was it saved from a live fetch or a
// Wayback Machine snapshot?) doesn't survive being reused by a later run
// unless it's written down — this is that tiny sidecar.
function metaPathFor(file) {
  return file + ".meta.json";
}
function readMeta(file) {
  try {
    return JSON.parse(fs.readFileSync(metaPathFor(file), "utf8"));
  } catch {
    return {};
  }
}
function writeMeta(file, meta) {
  try {
    fs.writeFileSync(metaPathFor(file), JSON.stringify(meta));
  } catch {
    /* best-effort — losing provenance isn't worth failing the fetch over */
  }
}

async function fetchSource(source, { cacheDir, pageSlug, email, budget }) {
  const dir = path.join(cacheDir, pageSlug);
  fs.mkdirSync(dir, { recursive: true });
  const base = hopSlug(source);

  // reuse if already cached (any extension)
  for (const ext of ["pdf", "html", "xml", "txt"]) {
    const p = path.join(dir, base + "." + ext);
    if (fs.existsSync(p)) {
      const meta = readMeta(p);
      return {
        status: "cached",
        file: p,
        rel: path.join("source-cache", pageSlug, base + "." + ext),
        contentType: ext,
        via: meta.via || null,
        viaWayback: !!meta.viaWayback,
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
        // aim the lookup at the citation's "Retrieved" date when we have one
        snapUrl = await waybackSnapshot(c.url, source._accessDate);
      } catch {
        /* Wayback lookup itself failing is not worth reporting over the original reason */
      }
      if (snapUrl) {
        const snapResult = await attemptDownload(snapUrl, dir, base);
        budget.left--;
        if (snapResult.ok) {
          result = snapResult;
          result.why = c.why + " (Wayback Machine archive)";
          result.viaWayback = true;
        } else {
          result.reason += "; a Wayback Machine archive exists but also failed (" + snapResult.reason + ")";
        }
      }
    }

    if (result.ok) {
      const via = result.why || c.why;
      writeMeta(result.file, { via, viaWayback: !!result.viaWayback });
      return {
        status: "downloaded",
        file: result.file,
        rel: path.join("source-cache", pageSlug, base + "." + result.contentType),
        contentType: result.contentType,
        via,
        viaWayback: !!result.viaWayback,
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

/*
 * Phase 3 (reading the downloaded source text to classify the dating method,
 * pull lab codes / calibrated ranges, pick load-bearing quotes, and chase
 * onward citations for multi-hop chains) previously lived here as
 * `classifyText()` / `findOnwardLeads()`. It has been removed until phase-2
 * source retrieval is solid enough to build on. `extractText()` above still
 * runs — the plain text it writes next to each cached source is what phase 3
 * will consume when it returns.
 */

module.exports = {
  hopSlug,
  resolveCandidates,
  fetchSource,
  extractText,
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
