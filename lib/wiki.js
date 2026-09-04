/*
 * wiki.js — everything that can be done locally from a Wikipedia page, with no
 * external AI and no dependencies:
 *
 *   - fetch the page via the MediaWiki parse API (HTML + wikitext + sections)
 *   - split it into sentences and find the ones making a numerical age claim
 *   - apply the 1450 CE cutoff (SPEC.md rule 0)
 *   - build a reference index: for every inline [n] marker, the verbatim
 *     footnote text and a structured `source` object parsed from the COinS
 *     (OpenURL) metadata Wikipedia embeds next to every citation
 */
"use strict";

const fs = require("fs");
const path = require("path");
const https = require("https");

/* ------------------------------------------------------------------ fetch --- */

function parseWikiUrl(input) {
  let u;
  try {
    u = new URL(input);
  } catch {
    throw new Error("not a URL: " + input);
  }
  if (!/\bwikipedia\.org$/.test(u.hostname) && !/\bwikipedia\.org$/.test(u.hostname.replace(/^[^.]+\./, ""))) {
    throw new Error("not a wikipedia.org URL: " + input);
  }
  const lang = u.hostname.split(".")[0];
  let title = decodeURIComponent(u.pathname.replace(/^\/wiki\//, "").replace(/^\/+/, ""));
  if (!title && u.searchParams.get("title")) title = u.searchParams.get("title");
  if (!title) throw new Error("could not find an article title in: " + input);
  return { lang, host: u.hostname, title: title.replace(/_/g, " ") };
}

function getJSON(url) {
  return new Promise((resolve, reject) => {
    https
      .get(
        url,
        { headers: { "User-Agent": "timeaudit/1.0 (chronology extraction; +https://github.com/priestc/timeaudit)" } },
        (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            return resolve(getJSON(new URL(res.headers.location, url).toString()));
          }
          if (res.statusCode !== 200) {
            res.resume();
            return reject(new Error("HTTP " + res.statusCode + " for " + url));
          }
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (c) => (body += c));
          res.on("end", () => {
            try {
              resolve(JSON.parse(body));
            } catch (e) {
              reject(new Error("bad JSON from " + url + ": " + e.message));
            }
          });
        }
      )
      .on("error", reject);
  });
}

function slugify(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "page";
}

function getBuffer(url, redirects = 5) {
  return new Promise((resolve, reject) => {
    https
      .get(
        url,
        { headers: { "User-Agent": "timeaudit/1.0 (chronology extraction; +https://github.com/priestc/timeaudit)" }, timeout: 90000 },
        (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
            res.resume();
            return resolve(getBuffer(new URL(res.headers.location, url).toString(), redirects - 1));
          }
          if (res.statusCode !== 200) {
            res.resume();
            return reject(new Error("HTTP " + res.statusCode + " for " + url));
          }
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => resolve(Buffer.concat(chunks)));
        }
      )
      .on("error", reject)
      .on("timeout", function () {
        this.destroy(new Error("timeout"));
      });
  });
}

async function fetchPage(input, opts = {}) {
  const { lang, title } = parseWikiUrl(input);
  const api =
    "https://" +
    lang +
    ".wikipedia.org/w/api.php?action=parse&format=json&formatversion=2&redirects=1&prop=text%7Cwikitext%7Csections%7Cexternallinks%7Crevid%7Cdisplaytitle&page=" +
    encodeURIComponent(title);
  const res = await getJSON(api);
  if (res.error) throw new Error("MediaWiki API: " + res.error.info);
  const p = res.parse;
  const slug = slugify(p.title);
  const out = {
    title: p.title,
    slug,
    lang,
    url: "https://" + lang + ".wikipedia.org/wiki/" + encodeURIComponent(p.title.replace(/ /g, "_")),
    revid: p.revid || null,
    retrievedAt: new Date().toISOString().slice(0, 10),
    html: p.text,
    wikitext: p.wikitext,
    sections: p.sections || [],
    externallinks: p.externallinks || [],
  };
  if (opts.cacheDir) {
    const dir = path.join(opts.cacheDir, "_wikipedia");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, slug + ".parse.json"), JSON.stringify(res, null, 2));
    fs.writeFileSync(path.join(dir, slug + ".html"), p.text);
    fs.writeFileSync(path.join(dir, slug + ".wikitext"), p.wikitext);
    out.cachePaths = {
      api: path.join("source-cache", "_wikipedia", slug + ".parse.json"),
      html: path.join("source-cache", "_wikipedia", slug + ".html"),
    };
    // NB: the article's PDF render (for sentence screenshots) is fetched later,
    // by lib/shots.js — screenshots are a presentation step, not extraction.
  }
  return out;
}

/* --------------------------------------------------------------- html util --- */

const ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–",
  mdash: "—", hellip: "…", times: "×", deg: "°", prime: "′",
  Prime: "″", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”",
};
function decodeEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => cp(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => cp(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, n) => (n in ENTITIES ? ENTITIES[n] : m));
}
function cp(n) {
  try {
    return String.fromCodePoint(n);
  } catch {
    return "";
  }
}
function stripTags(s) {
  return decodeEntities(String(s).replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
}

/* -------------------------------------------------------- reference index --- */

// Parse a COinS / OpenURL context object string into a source-ish object.
function parseCoins(ctx) {
  const q = {};
  decodeEntities(ctx)
    .split("&")
    .forEach((pair) => {
      const i = pair.indexOf("=");
      if (i === -1) return;
      const k = pair.slice(0, i);
      const v = decodeURIComponent(pair.slice(i + 1).replace(/\+/g, " "));
      if (k === "rft.au") (q._au = q._au || []).push(v);
      else q[k] = v;
    });

  const genre = q["rft.genre"] || "";
  let docType = "web_page";
  if (genre === "article") docType = "journal_article";
  else if (genre === "book") docType = "book";
  else if (genre === "bookitem" || genre === "chapter") docType = "excavation_report_chapter";
  else if (genre === "proceeding" || genre === "conference") docType = "other";
  else if (q["rft.btitle"]) docType = "book";
  else if (q["rft.atitle"] && q["rft.jtitle"]) docType = "journal_article";

  const authors = [];
  if (q["rft.aulast"]) authors.push([q["rft.aufirst"], q["rft.aulast"]].filter(Boolean).join(" "));
  (q._au || []).forEach((a) => authors.push(a));

  const doi = q["rft_id"] && /^info:doi\//.test(q["rft_id"]) ? q["rft_id"].replace("info:doi/", "") : q["rft.doi"] || null;
  let url = null;
  if (q["rft_id"] && /^https?:/.test(q["rft_id"])) url = q["rft_id"];
  const year = (q["rft.date"] || "").match(/\d{4}/);

  return {
    author: authors.length === 0 ? null : authors.length === 1 ? authors[0] : authors,
    title: q["rft.atitle"] || q["rft.btitle"] || q["rft.title"] || null,
    container_work: q["rft.btitle"] && q["rft.atitle"] ? q["rft.btitle"] : null,
    publisher_or_journal: q["rft.jtitle"] || q["rft.pub"] || null,
    year: year ? parseInt(year[0], 10) : null,
    pages: q["rft.pages"] || (q["rft.spage"] ? q["rft.spage"] + (q["rft.epage"] ? "-" + q["rft.epage"] : "") : null),
    identifier: doi ? "doi:" + doi : q["rft.isbn"] ? "ISBN " + q["rft.isbn"] : null,
    document_type: docType,
    retrieval_url: url || (doi ? "https://doi.org/" + doi : null),
    retrieval_status: "not_independently_verified",
    is_public_domain: year && year[0] && parseInt(year[0], 10) < 1930 ? true : false,
    local_cache_path: null,
    _doi: doi,
    _isbn: q["rft.isbn"] || null,
  };
}

/*
 * Returns { markerText(noteId), source(noteId) }.
 * Handles both full <li id="cite_note-X"> citations and shortened footnotes
 * that point to a #CITEREF... full citation elsewhere on the page.
 */
function buildReferenceIndex(html) {
  const h = html.replace(/&#95;/g, "_").replace(/<style\b[\s\S]*?<\/style>/gi, "");

  // 1a. every <cite id="CITEREF..."> -> the COinS span that follows it
  const citerefCoins = {}; // CITEREFxxx -> parsed source
  let m;
  const citeIdRe = /<cite[^>]*\bid="(CITEREF[^"]+)"[^>]*>/g;
  while ((m = citeIdRe.exec(h))) {
    const after = h.slice(m.index, m.index + 4000);
    const cm = after.match(/\btitle="(ctx_ver=Z39\.88[^"]*)"/);
    if (cm) citerefCoins[m[1]] = parseCoins(cm[1]);
  }
  // 1b. COinS spans that sit directly inside a <li id="cite_note-X"> (full refs)
  const coinsRe = /<span[^>]*\btitle="(ctx_ver=Z39\.88[^"]*)"[^>]*><\/span>/g;
  while ((m = coinsRe.exec(h))) {
    const before = h.slice(Math.max(0, m.index - 4000), m.index);
    const noteM = before.match(/<li[^>]*\bid="cite_note-([^"]+)"[^>]*>(?:(?!<\/li>)[\s\S])*$/);
    if (noteM && !/id="CITEREF/.test(before.slice(-300))) {
      citerefCoins["NOTE:" + noteM[1]] = parseCoins(m[1]);
    }
  }

  // 2. each <li id="cite_note-X"> -> its reference-text (verbatim) and any CITEREF target
  const notes = {};
  const liRe = /<li[^>]*\bid="cite_note-([^"]+)"[^>]*>([\s\S]*?)<\/li>/g;
  while ((m = liRe.exec(h))) {
    const id = m[1];
    const inner = m[2].replace(/<style\b[\s\S]*?<\/style>/gi, "");
    const textM = inner.match(/<span[^>]*class="reference-text"[^>]*>([\s\S]*?)<\/span>\s*$/) ||
      inner.match(/<span[^>]*class="reference-text"[^>]*>([\s\S]*)/);
    const bodyHtml = textM ? textM[1] : inner;
    const citerefM = bodyHtml.match(/href="#(CITEREF[^"]+)"/);
    notes[id] = {
      text: stripTags(bodyHtml),
      citeref: citerefM ? citerefM[1] : null,
    };
  }

  function markerText(noteId) {
    const n = notes[noteId];
    return n ? n.text : null;
  }
  // An explanatory ("lettered") note carries prose, not a citation to chase.
  function isNoteOnly(noteId, label) {
    if (/lower-alpha|lower-roman|upper-alpha|note-/.test(noteId) && /^[a-z]{1,3}$/i.test(label || "")) {
      return !citerefCoins["NOTE:" + noteId];
    }
    return false;
  }
  function source(noteId) {
    const n = notes[noteId];
    if (!n) return null;
    if (n.citeref && citerefCoins[n.citeref]) return clone(citerefCoins[n.citeref]);
    if (citerefCoins["NOTE:" + noteId]) return clone(citerefCoins["NOTE:" + noteId]);
    // fall back to a bare source from the footnote string (short-footnote with no
    // matched bibliography entry, or a plain inline citation)
    if (n.text && n.text.length > 3) {
      const doiM = n.text.match(/\b10\.\d{4,9}\/[^\s"']+/);
      const urlM = n.text.match(/https?:\/\/[^\s"'\])]+/);
      return {
        author: null,
        title: n.text.replace(/\s+/g, " ").slice(0, 240),
        container_work: null,
        publisher_or_journal: null,
        year: (n.text.match(/\b(1[5-9]\d\d|20\d\d)\b/) || [null])[0],
        pages: null,
        identifier: doiM ? "doi:" + doiM[0] : null,
        document_type: "other",
        retrieval_url: urlM ? urlM[0] : doiM ? "https://doi.org/" + doiM[0] : null,
        retrieval_status: "not_independently_verified",
        is_public_domain: null,
        local_cache_path: null,
        _doi: doiM ? doiM[0] : null,
        _isbn: null,
        _sparse: true,
      };
    }
    return null;
  }
  return { markerText, source, isNoteOnly, _notes: notes, _citerefCoins: citerefCoins };
}
function clone(o) {
  return JSON.parse(JSON.stringify(o));
}

/* --------------------------------------------------------------- claims ----- */

const MONTHS = "January|February|March|April|May|June|July|August|September|October|November|December";
// a word that can precede a year and still reads as part of the same date
// phrase — "before 305 AD", "around 45 BC", "roughly 1000 AD", "in 1200" —
// shared by the bare-year and the BC/AD/century patterns below so the match
// (and what the finder highlights) includes the qualifier, not just the digits
const DATE_QUALIFIER_SRC =
  "(?:in|by|around|about|before|after|since|until|during|from|between|and|to|c\\.|circa|dated|dating|roughly|approx\\.?)";
// qualifiers can stack ("in about 703") — allow up to two before the year
const DATE_QUALIFIER_OPT = "(?:" + DATE_QUALIFIER_SRC + "\\s+){0,2}";
const DATE_QUALIFIER_REQ = "(?:" + DATE_QUALIFIER_SRC + "\\s+){1,2}";
// centuries/millennia are usually "the Nth century" — let the qualifier
// group be followed by an optional "the" ("in the 8th century")
const DATE_QUALIFIER_CENTURY = DATE_QUALIFIER_OPT + "(?:the\\s+)?";
// Step 1: patterns that count as "a mention of a year or point in time".
// numeric / calendar forms:
const DATE_PATTERNS = [
  new RegExp("\\b" + DATE_QUALIFIER_OPT + "\\d{1,4}(?:,\\d{3})?\\s?(?:BC|BCE|B\\.C\\.(?:E\\.)?)\\b", "i"),
  new RegExp("\\b" + DATE_QUALIFIER_OPT + "\\d{3,4}\\s?(?:AD|CE|A\\.D\\.|C\\.E\\.)\\b", "i"),
  /\b\d{1,4}(?:,\d{3})?\s?[–-]\s?\d{1,4}(?:,\d{3})?\s?(?:BC|BCE|AD|CE)\b/i,
  new RegExp(
    "\\b" + DATE_QUALIFIER_CENTURY + "\\d{1,2}(?:st|nd|rd|th)\\s+(?:century|millennium)(?:\\s+(?:BC|BCE|AD|CE))?\\b",
    "i"
  ),
  new RegExp(
    "\\b" +
      DATE_QUALIFIER_CENTURY +
      "(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|thirteenth|fourteenth)\\s+(?:century|millennium)(?:\\s+(?:BC|BCE|AD|CE))?\\b",
    "i"
  ),
  /\b\d{1,3}(?:,\d{3})?\s+years?\s+(?:ago|before\s+present|BP|B\.P\.)\b/i,
  /\b(?:BP|cal\.?\s?BP|YBP)\b/,
  /\b\d{4,6}\s?(?:BP|years?\s+ago)\b/i,
];
// a bare number used as a calendar year — "in 1020", "by 1600", "the 1370s" —
// after a date word, and not immediately a unit/count
const BARE_YEAR_RE = new RegExp(
  "\\b" +
    DATE_QUALIFIER_REQ +
    "(?:the\\s+)?(?:early\\s+|mid-?\\s*|late\\s+)?(\\d{3,4})s?\\b(?!\\s*(?:BC|BCE|AD|CE|ft|feet|foot|cm|mm|km|kg|ha|acres?|metres?|meters?|m\\b|miles?|yards?|pounds?|manuscripts?|copies|copy|examples?|people|persons?|individuals?|graves?|burials?|artefacts?|artifacts?|items?|specimens?|samples?|sherds?|beads?|coins?|pieces?|fragments?|pillars?|stones?|structures?|sites?|houses?|km2|m2))",
  "i"
);
// named archaeological / historical periods (bare "Neolithic" counts):
const PERIOD_RE_I =
  /\b(?:epi[- ]?)?(?:pal(?:a)?eolithic|mesolithic|neolithic|chalcolithic|eneolithic|bronze[- ]age|iron[- ]age|copper[- ]age|stone[- ]age|pleistocene|holocene|pliocene|(?:pre|proto)[- ]?histor(?:y|ic|ical)|antiquity|middle ages|medi(?:a)?eval|dark ages|ppna|ppnb|ppn|hallstatt|la\s+t[eè]ne)\b/i;
// "Ravi Phase", "Uruk period", "Early Dynastic period", … (proper-name + period noun)
const PERIOD_RE_NAMED =
  /\b[A-Z][a-z]{2,}(?:[- ][A-Z][a-z]{2,})?\s+(?:[Pp]eriod|[Pp]hase|[Ee]ra|[Dd]ynasty|[Cc]ulture|[Hh]orizon|[Kk]ingdom)\b/;

// Presentation: the exact substrings in a sentence that made it a date
// candidate in step 1 — so the finder can highlight what it matched on.
function dateTriggers(text) {
  const hits = [];
  const seen = new Set();
  const add = (s) => {
    s = (s || "").replace(/^[\s,;:]+|[\s,;:]+$/g, "");
    const k = s.toLowerCase();
    if (s && !seen.has(k)) {
      seen.add(k);
      hits.push(s);
    }
  };
  const scan = (re, group) => {
    const g = new RegExp(re.source, /g/.test(re.flags) ? re.flags : re.flags + "g");
    let m;
    while ((m = g.exec(text))) {
      add(group != null && m[group] != null ? m[group] : m[0]);
      if (m.index === g.lastIndex) g.lastIndex++;
    }
  };
  // a pair of years joined by or/and/to/– is one time target ("672 or 673",
  // "2600 and 2400 BC") — scanned first so it wins the highlight span
  scan(/\b\d{3,4}\s*(?:or|and|to|through|[–—-])\s*\d{3,4}(?:\s*(?:BC|BCE|AD|CE))?\b/i);
  for (const re of DATE_PATTERNS) scan(re);
  scan(BARE_YEAR_RE); // whole match — keeps the qualifier ("in 1200", "before 731")
  // (bare era words like "medieval"/"antiquity" are not highlighted — they
  // are no longer a candidacy trigger on their own; see Step 1 below)
  return hits;
}

// Step 3: is the date/period being used to assign an age to something?
const DATING_CUE =
  /\b(?:dat(?:e|es|ed|ing)\s+(?:to|from|back|between)|dates?\s+(?:to|from|as far back)|(?:was|were|is|are|been|being)\s+(?:built|constructed|erected|founded|established|occupied|inhabited|settled|created|carved|made|dug|laid|deposited|buried|raised|abandoned|reoccupied|reused|first\s+\w+)|(?:built|constructed|erected|occupied|inhabited|founded|established|abandoned|created|carved|deposited|settled)\s+(?:in|during|around|between|by|c\.|circa|about|over|from)|construction\s+(?:began|started|occurred|dates|phase)|(?:begins?|began|started|commenced|originated|arose|emerged|appeared|flourished)\s+(?:in|around|about|c\.|circa|during|by)|(?:lasted|spanned|ran|extended|continued|dating)\s+(?:from|until|between|for|to|through|back)|in\s+use\s+(?:until|from|between|during|by)|(?:radiocarbon|carbon|luminescence|uranium)[\s-]*dat|(?:goes|going|dates?)\s+back\s+(?:to|as far)|as\s+(?:old|early|late)\s+as|belongs?\s+to\s+the|attributed\s+to\s+the|assigned\s+to|(?:from|of|in|during)\s+the\s+(?:early\s+|middle\s+|late\s+|mature\s+)?[\w-]+(?:\s+[\w-]+)?\s+(?:period|era|age|phase))\b/i;
// the date word is placing a person or an event, not dating the subject.
// The born/died/wrote/... + bare year form is excluded only when the year
// has no era marker — a modern reference ("the antiquarian died in 1990").
// With an explicit BC/AD/BCE/CE marker ("died c. 509 BC") it almost always
// *is* the claim (an ancient figure's birth/death date), so it's let through.
const NON_DATING_CUE =
  /\b\d{1,2}(?:st|nd|rd|th)[- ]century\s+(?:[a-z]+\s+){0,2}(?:antiquar(?:y|ian)|writer|author|poet|scholar|monk|bishop|priest|king|queen|historian|scientist|geologist|philosopher|architect|artist|traveller|traveler|chronicler|figure|nobleman|surveyor|clergyman)\b|(?:the\s+)?(?:neolithic|agricultural|industrial|scientific|urban)\s+revolution\b|(?:invented|discovered|published|devised|coined|introduced|described|proposed|born|died|wrote|excavated|surveyed|visited|founded|reported)\s+(?:in|c\.|circa|around|by)\s+\d{3,4}\b(?!\s*(?:BC|BCE|B\.C\.(?:E\.)?|AD|CE|A\.D\.|C\.E\.))/i;
const ABBREV = /\b(?:c|ca|approx|no|vol|pp|ed|eds|al|Dr|Mr|Mrs|St|Fig|e\.g|i\.e|cf|r|fl|b|d)\.$/i;
const MARKER_STRIP = /\x01[^\x03]*\x03/g; // drop marker sentinels

// Split into one sentence per element. Marker sentinels (\x01..\x03) attach to
// the token before them (e.g. "period.[48]") and must be transparent to the
// sentence boundary, or several sentences get glued into one claim.
function splitSentences(text) {
  const parts = [];
  let buf = "";
  const toks = text.split(/(\s+)/);
  for (let i = 0; i < toks.length; i++) {
    buf += toks[i];
    const bare = toks[i].replace(MARKER_STRIP, "");
    if (
      bare &&
      /[.!?]["')\]]?$/.test(bare) &&
      !ABBREV.test(buf.replace(MARKER_STRIP, "")) &&
      !/\b[A-Z]\.$/.test(buf.replace(MARKER_STRIP, "").trim())
    ) {
      parts.push(buf.trim());
      buf = "";
    }
  }
  if (buf.trim()) parts.push(buf.trim());
  return parts.filter((s) => s.replace(MARKER_STRIP, "").length > 20);
}

// Replace each inline citation <sup> with a sentinel  \x01 label \x02 noteId \x03
// so a clean sentence and a "with [n] markers" sentence can both be rebuilt.
const MARKER_RE = /\x01([^\x02]*)\x02([^\x03]*)\x03/g;
function tokenizeMarkers(blockHtml) {
  return blockHtml.replace(
    /<sup[^>]*class="[^"]*\breference\b[^"]*"[^>]*>([\s\S]*?)<\/sup>/gi,
    (full, inner) => {
      const idm = inner.match(/href="#cite_note-([^"]+)"/);
      if (!idm) return "";
      const labM = stripTags(inner).match(/\[?([\w]+)\]?/);
      return "\x01" + (labM ? labM[1] : "?") + "\x02" + idm[1] + "\x03";
    }
  );
}

// One or more inline citation sentinels in a row (a "citation group").
const MARKER_GROUP_RE = /(?:\x01[^\x03]*\x03[\s,;]*)+/g;
// Split a sentence at *mid-sentence* citation groups, so a sentence that stacks
// two separately-cited assertions becomes two claims:
//   "It was completed in about 731,[5] and Bede implies … a birth date in 672 or 673.[1][6]"
//   -> ["It was completed in about 731,[5]",
//       "Bede implies … a birth date in 672 or 673.[1][6]"]
// A citation group that ends the sentence is not a split point.
function splitAtInlineCites(rawSentence) {
  const cuts = [];
  let m;
  MARKER_GROUP_RE.lastIndex = 0;
  while ((m = MARKER_GROUP_RE.exec(rawSentence))) {
    const end = m.index + m[0].length;
    if (/\S/.test(rawSentence.slice(end).replace(MARKER_STRIP, ""))) cuts.push(end);
  }
  if (!cuts.length) return [rawSentence];
  const segs = [];
  let last = 0;
  for (const end of cuts) {
    segs.push(rawSentence.slice(last, end));
    last = end;
  }
  segs.push(rawSentence.slice(last));
  return segs
    .map((s, i) => {
      s = s.replace(/^[\s,;:]+/, "");
      if (i > 0) s = s.replace(/^(?:and|but|which|while|although|though)\s+/i, "");
      return s.trim();
    })
    .filter((s) => s.replace(MARKER_STRIP, "").trim().length > 0);
}

// section headings with their character offset in the html
function headingOffsets(html) {
  const out = [];
  const re = /<h([2-4])[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/h\1>/g;
  let m;
  while ((m = re.exec(html))) out.push({ offset: m.index, level: +m[1], line: stripTags(m[3]) });
  return out;
}
function sectionAt(headings, offset) {
  let cur = "Lead section";
  for (const h of headings) {
    if (h.offset < offset) cur = h.line;
    else break;
  }
  return cur;
}
// apparatus sections — bibliography / citation lists, not article prose.
// A dated-sounding sentence here ("Twelfth Century", "400 to 1070") is a
// book title or publication year, never a claim about the article subject.
const NON_CONTENT_SECTION =
  /^((?:primary|secondary|general|further)?\s*(?:references?|notes?|citations?|bibliography|sources?|reading)|notes\s+and\s+references|external\s+links|see\s+also|footnotes|works\s+cited|cited\s+works)$/i;

/* -------- "is this claim about the article's subject?" ------------------- */

const TITLE_STOP = new Set([
  "the", "of", "and", "a", "an", "in", "on", "at", "to",
  "valley", "civilisation", "civilization", "site", "culture", "people",
  "ancient", "history", "list", "old", "great", "new",
]);
// noun phrases that, near the start of a sentence, plausibly refer to the
// subject (a part of the monument, a construction phase, …) in an article that
// is itself about that subject
const SITE_NOUN =
  /\b(sites?|monuments?|settlements?|complex(?:es)?|compounds?|structures?|buildings?|tells?|mounds?|enclosures?|circles?|henges?|sanctuar(?:y|ies)|temples?|pillars?|stones?|sarsens?|bluestones?|megaliths?|trilithons?|ruins?|remains?|relics?|bod?(?:y|ies)|corpse|coffins?|tombs?|graves?|burials?|shrines?|cults?|postholes?|ditch(?:es)?|banks?|avenues?|cursus|barrows?|cairns?|platforms?|phases?|stages?|layers?|strata|occupations?|constructions?|excavations?|deposits?|cities|city|towns?|cultures?)\b/i;
// openers that report a date obtained by a dating method — in the article body
// these are almost always dating the subject
const METHOD_OPENER =
  /^(?:radiocarbon|carbon(?:[- ]?14)?|luminescence|osl|thermoluminescence|uranium[- ]series|argon|potassium[- ]argon|soil|sediment|stratigraph\w*|dendrochronolog\w*|analysis|analyses|excavations?|\w+\s+dating)\b/i;
const ANAPHOR = /\b(it|its|they|their|these|this|he|she|his|her|him)\b/i;
// sentence openers whose grammatical subject is clearly some OTHER entity —
// a person, a role, a demographic group — not the article's subject
const OFF_TOPIC_OPENER = new RegExp(
  "^(?:" +
    "(?:a|an|the)\\s+(?:\\w+\\s+){0,2}(?:boy|girl|man|woman|child|infant|individual|person|adult|male|female|worker|archer|skeleton|body|farmer|hunter|settler|king|queen|prince|priest|bishop|monk|saint|scholar|author|writer|researcher|archaeologist|historian|figure)s?\\b" +
    "|(?:the\\s+)?(?:first|early|late|neolithic|mesolithic|bronze[- ]age|iron[- ]age)\\s+(?:farmers|settlers|inhabitants|people|population|humans|migrants|hunters|communities|tribes)\\b" +
    "|[A-Z][a-z]{2,}\\s+(?:[A-Z]\\.?\\s+)?(?:of\\s+)?[A-Z][a-z]{2,}\\b" + // Firstname Lastname / Name of Place
  ")",
  ""
);

// terms that identify the article's subject: the title, bolded lead aliases,
// and the significant single words of the title
function subjectTerms(page) {
  const title = String(page.title || "");
  const terms = new Set();
  if (title) terms.add(title.toLowerCase());
  const lead = (page.html || "").split(/<h[23]\b/i)[0];
  for (const m of lead.matchAll(/<b>([\s\S]*?)<\/b>/g)) {
    const t = stripTags(m[1]).toLowerCase().trim();
    if (t.length >= 2 && t.length <= 60) terms.add(t);
  }
  for (const w of title.toLowerCase().split(/\s+/)) {
    const t = w.replace(/[^\p{L}\p{N}]/gu, "");
    if (t.length >= 4 && !TITLE_STOP.has(t)) terms.add(t);
  }
  return [...terms];
}

function mentionsSubject(text, terms) {
  const low = text.toLowerCase();
  return terms.some((t) => {
    if (t.indexOf(" ") !== -1 || /[^\x00-\x7f]/.test(t)) return low.indexOf(t) !== -1;
    return new RegExp("\\b" + t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b").test(low);
  });
}

/* -------- 1450 CE cutoff -------------------------------------------------- */

const ORDINALS = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7,
  eighth: 8, ninth: 9, tenth: 10, eleventh: 11, twelfth: 12, thirteenth: 13, fourteenth: 14,
};

function assessCutoff(sentence) {
  const s = sentence;
  const years = []; // approx calendar years, negative = BCE
  let sawBCE = false;
  let ambiguous = false;

  // N BC / BCE
  for (const m of s.matchAll(/\b(\d{1,4}(?:,\d{3})?)\s?(BC|BCE|B\.C\.(?:E\.)?)\b/gi)) {
    years.push(-parseInt(m[1].replace(/,/g, ""), 10));
    sawBCE = true;
  }
  // N AD / CE
  for (const m of s.matchAll(/\b(\d{3,4})\s?(AD|CE|A\.D\.|C\.E\.)\b/gi)) {
    years.push(parseInt(m[1], 10));
  }
  // Nth century / millennium (+ era). An unmarked century ("in the 20th
  // century") is treated as CE, same as a bare year — English prose marks
  // BC/BCE explicitly essentially every time it's meant; leaving it
  // unparsed let modern-only sentences slip through as "no parseable year,
  // kept per rule 0" (e.g. an excavation "early in the 20th century").
  for (const m of s.matchAll(/\b(\d{1,2})(?:st|nd|rd|th)\s+(century|millennium)(?:\s+(BC|BCE|AD|CE))?\b/gi)) {
    const n = parseInt(m[1], 10);
    const span = m[2].toLowerCase() === "millennium" ? 1000 : 100;
    const mid = n * span - span / 2;
    if (/^bc/i.test(m[3] || "")) {
      years.push(-mid);
      sawBCE = true;
    } else {
      years.push(mid);
    }
  }
  for (const m of s.matchAll(/\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|thirteenth|fourteenth)\s+(century|millennium)(?:\s+(BC|BCE|AD|CE))?\b/gi)) {
    const n = ORDINALS[m[1].toLowerCase()];
    const span = m[2].toLowerCase() === "millennium" ? 1000 : 100;
    const mid = n * span - span / 2;
    if (/^bc/i.test(m[3] || "")) {
      years.push(-mid);
      sawBCE = true;
    } else {
      years.push(mid);
    }
  }
  // N years ago / BP
  for (const m of s.matchAll(/\b(\d{1,3}(?:,\d{3})?|\d{4,6})\s+years?\s+(?:ago|before\s+present|BP|B\.P\.)\b/gi)) {
    years.push(1950 - parseInt(m[1].replace(/,/g, ""), 10));
  }
  for (const m of s.matchAll(/\b(\d{3,6})\s?(?:cal\.?\s?)?(?:BP|YBP)\b/gi)) {
    years.push(1950 - parseInt(m[1], 10));
  }
  // bare calendar years ("in 1020", "the 1370s") — treated as CE
  for (const m of s.matchAll(new RegExp(BARE_YEAR_RE.source, "gi"))) {
    const y = parseInt(m[1], 10);
    if (y >= 100 && y <= 2100) years.push(y);
  }

  if (sawBCE) return { inScope: true, basis: "BCE date present", years, ambiguous };

  if (!years.length) {
    return { inScope: true, basis: "date language but no parseable year (kept per rule 0)", years, ambiguous: true };
  }
  const minY = Math.min(...years);
  const maxY = Math.max(...years);
  if (minY < 1450) {
    const note =
      maxY >= 1450
        ? "range straddles the 1450 CE cutoff; included for the pre-1450 portion (" + minY + "–1449 CE)"
        : null;
    return { inScope: true, basis: "earliest point " + minY + " CE < 1450", years, note, ambiguous };
  }
  // every parsed year is >= 1450, but a named period still points at an
  // ancient time — unless the period word only appears inside a quoted
  // phrase ("postulating an origin in 'remote antiquity'"), which is someone's
  // characterization, not a dating claim, and shouldn't rescue a modern
  // sentence. (A bare century is no longer a separate rescue condition here:
  // it's already folded into `years` above — BC-marked as negative, unmarked
  // defaulted to CE — so it's already reflected in minY/maxY.)
  const sUnquoted = s.replace(/"[^"]*"|“[^”]*”/g, " ");
  if (PERIOD_RE_I.test(sUnquoted) || PERIOD_RE_NAMED.test(sUnquoted)) {
    return { inScope: true, basis: "modern year present but an ancient period is referenced", years, ambiguous: true };
  }
  return { inScope: false, basis: "all dates >= 1450 CE (min " + minY + ")", years, ambiguous };
}

/* -------- claim extraction --------------------------------------------------- */

function extractClaims(page, opts = {}) {
  const html = page.html
    .replace(/&#95;/g, "_")
    .replace(/<style\b[\s\S]*?<\/style>/gi, "")
    .replace(/<table\b[\s\S]*?<\/table>/gi, " ");
  const headings = headingOffsets(html);
  const seen = new Set();
  const claims = [];
  const rejected = []; // date-language sentences dropped (opts.includeRejected)
  let seq = 0; // document order across kept + rejected candidates
  const done = () => (opts.includeRejected ? { claims, rejected } : claims);

  const terms = subjectTerms(page); // the article's subject + aliases
  const MAX_CLAIM_CHARS = 340; // a claim is one simple assertion, not a paragraph

  const ctxClean = (s) =>
    s.replace(MARKER_STRIP, "").replace(/\s+([.,;:])/g, "$1").replace(/\s+/g, " ").trim();

  // content blocks: <p> and list items inside the parser output
  const blockRe = /<(p|li|dd)\b[^>]*>([\s\S]*?)<\/\1>/g;
  let m;
  while ((m = blockRe.exec(html))) {
    const blockOffset = m.index;
    const section = sectionAt(headings, blockOffset);
    if (NON_CONTENT_SECTION.test(section)) continue;
    const tokenized = tokenizeMarkers(m[2]);
    const plain = decodeEntities(tokenized.replace(/<[^>]+>/g, "")).replace(/[ \t]+/g, " ").trim();
    if (!plain || plain.length < 25) continue;
    const blockAboutSubject = mentionsSubject(plain.replace(MARKER_STRIP, ""), terms);
    const sents = splitSentences(plain);
    // a sentence that stacks two separately-cited assertions ("… 731,[5] and …
    // 673.[1][6]") is expanded into one unit per assertion
    const units = [];
    for (let si = 0; si < sents.length; si++) {
      for (const seg of splitAtInlineCites(sents[si])) units.push({ raw: seg, si });
    }

    for (let ui = 0; ui < units.length; ui++) {
      const rawSentence = units[ui].raw;
      const si = units[ui].si;
      const markers = [];
      // clean: markers removed (for date detection, cutoff, dedup, AI prompt)
      const clean = rawSentence
        .replace(MARKER_RE, (_, label, noteId) => {
          markers.push({ label, noteId });
          return "";
        })
        .replace(/\s+([.,;:])/g, "$1")
        .replace(/\s+/g, " ")
        .trim();
      if (clean.length < 25) continue;
      // Step 1: does the sentence contain an actual number that reads as a
      // year or point in time? A bare era word on its own ("medieval",
      // "antiquity", "Bronze Age") is not enough — it names no specific age.
      const hasNumericDate = DATE_PATTERNS.some((re) => re.test(clean)) || BARE_YEAR_RE.test(clean);
      if (!hasNumericDate) continue; // not a candidate — not shown

      // cited: [n] markers kept inline, exactly where Wikipedia shows them
      const sentenceCited = rawSentence
        .replace(MARKER_RE, (_, label) => "[" + label + "]")
        .replace(/ +(\[[\w]+\])/g, "$1")
        .replace(/\s+([.,;:])/g, "$1")
        .replace(/\s+/g, " ")
        .trim();

      const cut = assessCutoff(clean);
      const record = { seq: seq++, sentence: clean, sentence_cited: sentenceCited, section, markers, cutoff: cut };
      if (opts.includeRejected) {
        record.context_before = sents.slice(Math.max(0, si - 2), si).map(ctxClean);
        record.context_after = sents.slice(si + 1, si + 3).map(ctxClean);
        record.triggers = dateTriggers(clean); // words that made it a candidate
      }
      const reject = (reason) => {
        if (opts.includeRejected && rejected.length < 500) rejected.push(Object.assign({ reason }, record));
      };

      if (!cut.inScope) {
        reject(cut.basis);
        continue;
      }
      // a claim must be a single simple assertion, not a run of sentences
      if (clean.length > MAX_CLAIM_CHARS) {
        reject("sentence too long — not a single simple claim");
        continue;
      }

      // Step 3: is the number used to *assign an age* to something? A real
      // BC/AD date almost always dates something; reject only when it's
      // clearly placing a person or a modern event instead.
      const ageUse = !(NON_DATING_CUE.test(clean) && !DATING_CUE.test(clean));
      if (!ageUse) {
        reject("mentions a date but is not claiming something is that age");
        continue;
      }

      // a claim must be *about the article's subject*. The article body is
      // presumed to be about it; keep unless the sentence's own subject is
      // clearly a different, separately-named entity (a person, a group, …).
      const core = clean.replace(
        /^(?:in|around|by|during|about|approximately|roughly|from|between|at|c\.|circa)\b[^,]{0,45},?\s*/i,
        ""
      );
      const opener = core.split(/\s+/).slice(0, 14).join(" ");
      const aboutSubject =
        mentionsSubject(clean, terms) ||
        SITE_NOUN.test(opener) ||
        ANAPHOR.test(opener) ||
        METHOD_OPENER.test(opener) ||
        (blockAboutSubject && !OFF_TOPIC_OPENER.test(core));
      if (!aboutSubject) {
        reject("not about the article subject");
        continue;
      }

      const key = clean.toLowerCase().replace(/[^a-z0-9]+/g, "");
      if (seen.has(key)) {
        reject("duplicate of an earlier in-scope sentence");
        continue;
      }
      seen.add(key);

      claims.push(record);
      if (opts.maxClaims && claims.length >= opts.maxClaims) return done();
    }
  }
  return done();
}

module.exports = {
  parseWikiUrl,
  fetchPage,
  slugify,
  getBuffer,
  buildReferenceIndex,
  extractClaims,
  assessCutoff,
  subjectTerms,
  mentionsSubject,
  stripTags,
  decodeEntities,
  parseCoins,
};
