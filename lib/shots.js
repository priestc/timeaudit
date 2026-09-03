/*
 * shots.js — derive screenshots for a report AFTER the analysis JSON exists.
 *
 * Screenshots are a presentation artefact, not part of SPEC.md: the extractor
 * never makes them. This module rebuilds them on demand from the two things the
 * extractor does produce — the report JSON and the cached source files — using
 * only local software (pdftoppm / pdftotext).
 *
 * File-name convention, under  <cacheRoot>/_shots/<slug>/ :
 *   <claim_id>.wp.png            sentence crop from the Wikipedia page render
 *   <claim_id>.wp.page.png       the whole Wikipedia page the sentence is on
 *   <claim_id>.h<hop>.q<n>.png   quote <n> (1-based) cropped from hop <hop>'s PDF
 *   <claim_id>.h<hop>.q<n>.page.png   the whole source page that quote is on
 * render.js builds the same paths so nothing needs storing in the JSON.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { snapshotQuote, snapshotPage } = require("./scholar");
const { slugify, parseWikiUrl, getBuffer } = require("./wiki");

function stripMarkers(s) {
  return String(s || "").replace(/\[(?:\d{1,3}|[a-z]{1,3})\]/g, "").replace(/\s+/g, " ").trim();
}

// resolve a source.local_cache_path ("/source-cache/<slug>/x.pdf") to a real file
function cachedFile(cacheRoot, localCachePath) {
  if (!localCachePath) return null;
  const rel = String(localCachePath).replace(/^\/?source-cache\//, "");
  return path.join(cacheRoot, rel);
}

async function ensureWikipediaPdf(report, cacheRoot) {
  const slug = slugify(report.page && report.page.title);
  const dir = path.join(cacheRoot, "_wikipedia");
  const pdf = path.join(dir, slug + ".pdf");
  if (fs.existsSync(pdf)) return pdf;
  if (!report.page || !report.page.url) return null;
  let lang, title;
  try {
    ({ lang, title } = parseWikiUrl(report.page.url));
  } catch {
    return null;
  }
  try {
    const buf = await getBuffer(
      "https://" + lang + ".wikipedia.org/api/rest_v1/page/pdf/" + encodeURIComponent(title.replace(/ /g, "_"))
    );
    if (buf && buf.slice(0, 5).toString("latin1") === "%PDF-") {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(pdf, buf);
      return pdf;
    }
  } catch {
    /* offline / endpoint down — Wikipedia shots just won't exist */
  }
  return null;
}

// crop a quote and (sharing renders per page) the full page it sits on
function makeCropAndPage(pdf, quote, cropPath, pagePath, pageCache) {
  if (!fs.existsSync(cropPath)) {
    const shot = snapshotQuote(pdf, quote, cropPath);
    if (!shot) return false;
    if (!fs.existsSync(pagePath)) {
      const key = pdf + "#" + shot.page;
      if (!pageCache[key]) {
        const tmp = pagePath.replace(/\.page\.png$/i, ".fullpage-p" + shot.page + ".png");
        pageCache[key] = snapshotPage(pdf, shot.page, tmp) ? tmp : null;
      }
      if (pageCache[key]) fs.copyFileSync(pageCache[key], pagePath);
    }
    return true;
  }
  return true;
}

/** Generate every missing screenshot for a report. Idempotent. */
async function ensureShots(report, cacheRoot) {
  const slug = slugify(report.page && report.page.title);
  const dir = path.join(cacheRoot, "_shots", slug);
  fs.mkdirSync(dir, { recursive: true });
  const pageCache = {};
  let made = 0;

  const wikiPdf = await ensureWikipediaPdf(report, cacheRoot);
  for (const c of report.claims || []) {
    const id = c.claim_id;
    if (wikiPdf && c.wikipedia_text_verbatim) {
      if (
        makeCropAndPage(
          wikiPdf,
          stripMarkers(c.wikipedia_text_verbatim),
          path.join(dir, id + ".wp.png"),
          path.join(dir, id + ".wp.page.png"),
          pageCache
        )
      ) {
        made++;
      }
    }
    for (const h of c.citation_chain || []) {
      const srcPdf = cachedFile(cacheRoot, h.source && h.source.local_cache_path);
      if (!srcPdf || !/\.pdf$/i.test(srcPdf) || !fs.existsSync(srcPdf)) continue;
      (h.verbatim_quotes || []).forEach((q, i) => {
        const n = i + 1;
        if (
          makeCropAndPage(
            srcPdf,
            q,
            path.join(dir, id + ".h" + h.hop_index + ".q" + n + ".png"),
            path.join(dir, id + ".h" + h.hop_index + ".q" + n + ".page.png"),
            pageCache
          )
        ) {
          made++;
        }
      });
    }
  }
  // tidy the shared per-page temporaries
  for (const f of Object.values(pageCache)) {
    if (f) try { fs.unlinkSync(f); } catch { /* ignore */ }
  }
  return { slug, dir, made };
}

/**
 * Generate ONE shot by its file name (no .png), for lazy serving.
 * @returns absolute path to the PNG, or null.
 */
async function generateShot(report, cacheRoot, name) {
  const slug = slugify(report.page && report.page.title);
  const dir = path.join(cacheRoot, "_shots", slug);
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, name + ".png");
  if (fs.existsSync(out)) return out;
  const pageCache = {};

  let m = name.match(/^(.+?)\.wp(\.page)?$/);
  if (m) {
    const claim = (report.claims || []).find((c) => c.claim_id === m[1]);
    if (!claim) return null;
    const pdf = await ensureWikipediaPdf(report, cacheRoot);
    if (!pdf) return null;
    makeCropAndPage(
      pdf,
      stripMarkers(claim.wikipedia_text_verbatim),
      path.join(dir, m[1] + ".wp.png"),
      path.join(dir, m[1] + ".wp.page.png"),
      pageCache
    );
  } else if ((m = name.match(/^(.+?)\.h(\d+)\.q(\d+)(\.page)?$/))) {
    const claim = (report.claims || []).find((c) => c.claim_id === m[1]);
    const hop = claim && (claim.citation_chain || []).find((h) => String(h.hop_index) === m[2]);
    const quote = hop && (hop.verbatim_quotes || [])[parseInt(m[3], 10) - 1];
    const srcPdf = cachedFile(cacheRoot, hop && hop.source && hop.source.local_cache_path);
    if (!quote || !srcPdf || !/\.pdf$/i.test(srcPdf) || !fs.existsSync(srcPdf)) return null;
    makeCropAndPage(
      srcPdf,
      quote,
      path.join(dir, m[1] + ".h" + m[2] + ".q" + m[3] + ".png"),
      path.join(dir, m[1] + ".h" + m[2] + ".q" + m[3] + ".page.png"),
      pageCache
    );
  } else {
    return null;
  }
  for (const f of Object.values(pageCache)) {
    if (f) try { fs.unlinkSync(f); } catch { /* ignore */ }
  }
  return fs.existsSync(out) ? out : null;
}

module.exports = { ensureShots, generateShot, stripMarkers };
