/*
 * render.js — turns a "Wikipedia Chronology Extraction Protocol" JSON document
 * (see SPEC.md) into HTML. Works in Node (require) and in the browser (window.ChronoRender).
 *
 * Two document shapes are supported:
 *   - a per-page file:      { schema_version, page, claims: [...] }
 *   - the shared tech log:  { schema_version, entries: [...] }
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.ChronoRender = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  function esc(s) {
    if (s === null || s === undefined) return "";
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function isBlank(v) {
    return (
      v === null ||
      v === undefined ||
      v === "" ||
      (Array.isArray(v) && v.length === 0) ||
      (typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0)
    );
  }

  function fmtValue(v) {
    if (isBlank(v)) return '<span class="muted">—</span>';
    if (Array.isArray(v)) return v.map(fmtValue).join('<span class="sep">, </span>');
    if (typeof v === "boolean") return v ? "Yes" : "No";
    if (typeof v === "object") return "<code>" + esc(JSON.stringify(v)) + "</code>";
    var s = String(v);
    // linkify bare URLs
    if (/^https?:\/\/\S+$/.test(s)) {
      return '<a href="' + esc(s) + '" target="_blank" rel="noopener noreferrer">' + esc(s) + "</a>";
    }
    return esc(s);
  }

  function slug(s) {
    return String(s || "document")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "document";
  }

  function badge(text, kind) {
    return '<span class="badge badge-' + esc(kind || "neutral") + '">' + esc(text) + "</span>";
  }

  var STATUS_KIND = { resolved: "ok", dead_end: "bad", pending: "warn" };
  var RETRIEVAL_KIND = {
    verified_verbatim: "ok",
    not_independently_verified: "warn",
    unreachable: "bad",
  };

  function kvRows(obj, order) {
    if (!obj || typeof obj !== "object") return "";
    var keys = order
      ? order.filter(function (k) {
          return k in obj;
        })
      : Object.keys(obj);
    // append any keys not covered by `order`
    if (order) {
      Object.keys(obj).forEach(function (k) {
        if (keys.indexOf(k) === -1) keys.push(k);
      });
    }
    return keys
      .map(function (k) {
        return (
          "<tr><th>" +
          esc(k.replace(/_/g, " ")) +
          "</th><td>" +
          fmtValue(obj[k]) +
          "</td></tr>"
        );
      })
      .join("");
  }

  function renderSource(src) {
    if (!src) return "";
    var order = [
      "author",
      "title",
      "container_work",
      "publisher_or_journal",
      "year",
      "pages",
      "identifier",
      "document_type",
      "retrieval_url",
      "retrieval_status",
      "is_public_domain",
      "local_cache_path",
    ];
    var status = src.retrieval_status
      ? '<div class="source-status">' +
        badge(src.retrieval_status.replace(/_/g, " "), RETRIEVAL_KIND[src.retrieval_status]) +
        (src.is_public_domain === true ? " " + badge("public domain", "ok") : "") +
        "</div>"
      : "";
    return (
      '<div class="source">' +
      status +
      '<table class="kv">' +
      kvRows(src, order) +
      "</table>" +
      "</div>"
    );
  }

  // screenshots are a presentation artefact (see SPEC.md) — not in the JSON.
  // Their paths are derived here from a fixed name scheme; a `hasShot` gate (set
  // by the caller for standalone builds) decides whether the file exists yet.
  var CTX = { slug: "page", base: "/source-cache/_shots", hasShot: function () { return true; } };

  function shotFigure(cropName, pageName, caption, openLabel, extraClass) {
    if (!CTX.hasShot(CTX.slug + "/" + cropName + ".png")) return "";
    var cropUrl = CTX.base + "/" + CTX.slug + "/" + cropName + ".png";
    var pageUrl = CTX.base + "/" + CTX.slug + "/" + pageName + ".png";
    var img =
      '<img loading="lazy" alt="' + esc(caption) + '" src="' + esc(cropUrl) +
      '" onerror="var f=this.closest(\'figure\');if(f)f.remove()">';
    var cap = esc(caption);
    if (CTX.hasShot(CTX.slug + "/" + pageName + ".png")) {
      img =
        '<a class="quote-shot-link" href="' + esc(pageUrl) +
        '" target="_blank" rel="noopener noreferrer">' + img + "</a>";
      cap += ' — <span class="shot-open">' + esc(openLabel) + "</span>";
    }
    return (
      '<figure class="quote-shot' + (extraClass ? " " + extraClass : "") + '">' +
      img + "<figcaption>" + cap + "</figcaption></figure>"
    );
  }

  function renderQuotes(quotes, claimId, hopIndex) {
    if (!quotes || !quotes.length) return "";
    return (
      '<div class="quotes"><div class="section-label">Verbatim quotes</div>' +
      quotes
        .map(function (q, i) {
          var stem = claimId + ".h" + hopIndex + ".q" + (i + 1);
          var shot = shotFigure(
            stem,
            stem + ".page",
            "as printed in the source",
            "click to open the full page it was taken from"
          );
          return '<blockquote class="quote">' + esc(q) + "</blockquote>" + shot;
        })
        .join("") +
      "</div>"
    );
  }

  function renderFacts(facts) {
    if (isBlank(facts)) return "";
    return (
      '<div class="facts"><div class="section-label">Structured facts</div>' +
      '<table class="kv">' +
      kvRows(facts) +
      "</table></div>"
    );
  }

  /*
   * Role label for one hop in a chain (see SPEC.md "Hop role labels"):
   *   - the Wikipedia-cited source (index 0)       -> "Wikipedia citation"
   *   - the hop reaching the primary technical     -> "Final technical source"
   *     result (is_terminal)
   *   - if that is the same hop as the WP citation -> "Wikipedia citation / Final technical source"
   *   - a source between those two                 -> "Intermediate hop N"
   *   - the last source of a chain that never      -> "Furthest source reached"
   *     reached a technical result
   * So the word "hop" only appears in chains of three or more links.
   */
  function hopRoleLabel(chain, i) {
    var n = chain.length;
    var t = -1;
    for (var k = 0; k < n; k++) {
      if (chain[k].is_terminal) {
        t = k;
        break;
      }
    }
    if (i === 0 && t === 0) return "Wikipedia citation / Final technical source";
    if (i === 0) return "Wikipedia citation";
    if (i === t) return "Final technical source";
    if (t === -1 && i === n - 1) return "Furthest source reached";
    var num = 0;
    for (var j = 1; j < n; j++) {
      if (j === t || (t === -1 && j === n - 1)) continue;
      num++;
      if (j === i) break;
    }
    return "Intermediate hop " + num;
  }

  // Shown at the bottom of hop i: the citation, in hop i's document, that leads
  // to hop i+1. Every chain link is an explicit citation (SPEC.md rule 6), so if
  // there is a next hop there is a citation behind it.
  function renderCitesNext(chain, i) {
    var next = chain[i + 1];
    if (!next) return "";
    var verbatim = next.citation_in_previous_verbatim;
    if (verbatim) {
      return (
        '<div class="cites-next"><div class="section-label">Cites the next source, verbatim</div>' +
        '<blockquote class="quote">' +
        esc(verbatim) +
        "</blockquote></div>"
      );
    }
    return '<div class="cites-next muted">Cites the next source (exact reference text not captured).</div>';
  }

  function renderHop(hop, i, chain, claimId) {
    var methodBadge =
      hop.is_terminal && hop.terminal_type
        ? " " + badge(hop.terminal_type.replace(/_/g, " "), "term")
        : "";
    return (
      '<li class="hop">' +
      '<div class="hop-head">' +
      '<span class="hop-index">' +
      esc(hopRoleLabel(chain, i)) +
      "</span>" +
      methodBadge +
      "</div>" +
      (hop.cited_by
        ? '<div class="cited-by"><span class="section-label">Cited by</span> ' + esc(hop.cited_by) + "</div>"
        : "") +
      renderSource(hop.source) +
      renderFacts(hop.structured_facts) +
      renderQuotes(hop.verbatim_quotes, claimId, hop.hop_index) +
      renderCitesNext(chain, i) +
      "</li>"
    );
  }

  // screenshot of the claim sentence on the rendered Wikipedia page
  function renderWikiShot(claim) {
    return shotFigure(
      claim.claim_id + ".wp",
      claim.claim_id + ".wp.page",
      "as it appears on the Wikipedia page",
      "click to open the full Wikipedia page",
      "wiki-shot"
    );
  }

  function renderClaim(claim) {
    var footnotes = claim.citation_footnotes_verbatim || {};
    var fnHtml = Object.keys(footnotes)
      .map(function (m) {
        var t = footnotes[m];
        return (
          '<div class="footnote"><span class="fn-marker">[' +
          esc(m) +
          "]</span> " +
          (isBlank(t) ? '<span class="muted">no footnote text shown</span>' : esc(t)) +
          "</div>"
        );
      })
      .join("");

    var chain = claim.citation_chain || [];
    var techRefs = (claim.technical_log_refs || [])
      .map(function (r) {
        return '<span class="tech-ref">' + esc(r) + "</span>";
      })
      .join(" ");

    return (
      '<article class="claim" id="' +
      esc(claim.claim_id) +
      '">' +
      '<header class="claim-head">' +
      '<span class="claim-id">' +
      esc(claim.claim_id) +
      "</span>" +
      badge(String(claim.status || "unknown").replace(/_/g, " "), STATUS_KIND[claim.status]) +
      (claim.location_on_page
        ? '<span class="loc">' + esc(claim.location_on_page) + "</span>"
        : "") +
      "</header>" +
      '<blockquote class="wp-text">' +
      esc(claim.wikipedia_text_verbatim).replace(/\[([0-9]{1,3}|[a-z]{1,3})\]/g, '<sup class="cm">[$1]</sup>') +
      "</blockquote>" +
      renderWikiShot(claim) +
      (fnHtml
        ? '<div class="citations"><div class="section-label">Citations on the sentence</div>' +
          fnHtml +
          "</div>"
        : "") +
      (chain.length
        ? '<div class="chain"><div class="section-label">Citation chain (' +
          chain.length +
          " source" +
          (chain.length === 1 ? "" : "s") +
          ')</div><ol class="hops">' +
          chain
            .map(function (h, i) {
              return renderHop(h, i, chain, claim.claim_id);
            })
            .join("") +
          "</ol></div>"
        : '<div class="chain muted">No citation chain recorded.</div>') +
      (techRefs
        ? '<div class="tech-refs"><span class="section-label">Technical log</span> ' + techRefs + "</div>"
        : "") +
      "</article>"
    );
  }

  function renderTechEntry(e) {
    var order = [
      "id",
      "source_page",
      "claim_ref",
      "site",
      "project_or_excavation",
      "years_active",
      "director_or_lead",
      "publishing_source",
      "sample_count",
      "sample_material",
      "method",
      "calibration_method",
      "laboratory",
      "lab_code_prefixes",
      "funding",
      "earliest_date_reported",
      "latest_date_reported",
      "notes",
    ];
    return (
      '<article class="claim" id="' +
      esc(e.id) +
      '">' +
      '<header class="claim-head"><span class="claim-id">' +
      esc(e.id) +
      "</span>" +
      (e.method ? badge(e.method, "term") : "") +
      (e.site ? '<span class="loc">' + esc(e.site) + "</span>" : "") +
      "</header>" +
      '<table class="kv">' +
      kvRows(e, order) +
      "</table>" +
      "</article>"
    );
  }

  function summaryBar(claims) {
    var counts = { resolved: 0, dead_end: 0, pending: 0 };
    var terminalPhysical = 0;
    claims.forEach(function (c) {
      if (c.status in counts) counts[c.status]++;
      (c.citation_chain || []).forEach(function (h) {
        if (h.is_terminal && h.terminal_type && h.terminal_type !== "comparative") terminalPhysical++;
      });
    });
    var items = [
      ["claims", claims.length, "neutral"],
      ["resolved", counts.resolved, "ok"],
      ["pending", counts.pending, "warn"],
      ["dead ends", counts.dead_end, "bad"],
      ["physical-method terminals", terminalPhysical, "term"],
    ];
    return (
      '<div class="summary">' +
      items
        .map(function (it) {
          return (
            '<div class="stat stat-' +
            it[2] +
            '"><span class="stat-num">' +
            esc(it[1]) +
            '</span><span class="stat-label">' +
            esc(it[0]) +
            "</span></div>"
          );
        })
        .join("") +
      "</div>"
    );
  }

  /** Inner HTML for a document (no <html>/<head>). */
  function renderBody(data, opts) {
    if (!data || typeof data !== "object") {
      return '<p class="error">Not a valid JSON document.</p>';
    }
    opts = opts || {};
    CTX = {
      slug: slug((data.page && data.page.title) || "page"),
      base: opts.shotBase || "/source-cache/_shots",
      hasShot: typeof opts.hasShot === "function" ? opts.hasShot : function () { return true; },
    };

    if (Array.isArray(data.entries)) {
      // shared technical log
      return (
        '<header class="doc-head">' +
        "<h1>Shared Technical Log</h1>" +
        '<div class="doc-meta">schema ' +
        esc(data.schema_version || "?") +
        " · " +
        data.entries.length +
        " entr" +
        (data.entries.length === 1 ? "y" : "ies") +
        "</div></header>" +
        '<div class="claims">' +
        data.entries.map(renderTechEntry).join("") +
        "</div>"
      );
    }

    var page = data.page || {};
    var claims = data.claims || [];
    var titleLink = page.url
      ? '<a href="' + esc(page.url) + '" target="_blank" rel="noopener noreferrer">' + esc(page.title || page.url) + "</a>"
      : esc(page.title || "Untitled page");

    var meta = [];
    if (page.retrieved_at) meta.push("retrieved " + esc(page.retrieved_at));
    if (data.schema_version) meta.push("schema " + esc(data.schema_version));
    if (page.wikipedia_revision_id) meta.push("rev " + esc(page.wikipedia_revision_id));
    if (data.generator && data.generator.mode) {
      meta.push(
        'mode <span class="gen-mode gen-' +
          esc(data.generator.mode) +
          '">' +
          esc(data.generator.mode) +
          "</span>" +
          (data.generator.ai_model ? " (" + esc(data.generator.ai_model) + ")" : "")
      );
    }

    return (
      '<header class="doc-head">' +
      "<h1>" +
      titleLink +
      "</h1>" +
      (meta.length ? '<div class="doc-meta">' + meta.join(" · ") + "</div>" : "") +
      "</header>" +
      summaryBar(claims) +
      '<div class="claims">' +
      (claims.length
        ? claims.map(renderClaim).join("")
        : '<p class="muted">No claims recorded in this document.</p>') +
      "</div>"
    );
  }

  var STYLES = [
    ":root{--bg:#fbfbfa;--fg:#1a1a1a;--muted:#6b7280;--card:#ffffff;--border:#e4e4e7;--accent:#2563eb;--quote-bar:#cbd5e1;}",
    "@media (prefers-color-scheme:dark){:root{--bg:#16171a;--fg:#e6e6e6;--muted:#9aa0a6;--card:#1f2023;--border:#33353a;--accent:#6ea8fe;--quote-bar:#44474d;}}",
    "*{box-sizing:border-box}",
    "body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;}",
    ".wrap{max-width:920px;margin:0 auto;padding:32px 20px 80px;}",
    "a{color:var(--accent)}",
    "h1{font-size:1.7rem;margin:0 0 6px;line-height:1.25}",
    ".doc-head{margin-bottom:20px;border-bottom:1px solid var(--border);padding-bottom:16px}",
    ".doc-meta{color:var(--muted);font-size:.85rem}",
    ".gen-mode{display:inline-block;padding:0 6px;border-radius:4px;font-weight:700;font-size:.78em;text-transform:uppercase;letter-spacing:.03em}",
    ".gen-local{background:#e0e7ff;color:#3730a3}.gen-hybrid{background:#dcfce7;color:#166534}.gen-ai-only{background:#fef3c7;color:#92400e}",
    "@media (prefers-color-scheme:dark){.gen-local{background:#312e81;color:#c7d2fe}.gen-hybrid{background:#14532d;color:#bbf7d0}.gen-ai-only{background:#78350f;color:#fde68a}}",
    ".muted,.sep{color:var(--muted)}",
    ".error{color:#b91c1c;font-weight:600}",
    ".summary{display:flex;flex-wrap:wrap;gap:10px;margin:18px 0 28px}",
    ".stat{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:10px 14px;min-width:96px;display:flex;flex-direction:column;gap:2px}",
    ".stat-num{font-size:1.35rem;font-weight:700}",
    ".stat-label{font-size:.72rem;text-transform:uppercase;letter-spacing:.04em;color:var(--muted)}",
    ".stat-ok .stat-num{color:#15803d}.stat-warn .stat-num{color:#b45309}.stat-bad .stat-num{color:#b91c1c}.stat-term .stat-num{color:#7c3aed}",
    ".claim{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:18px 20px;margin-bottom:20px}",
    ".claim-head{display:flex;align-items:center;flex-wrap:wrap;gap:10px;margin-bottom:10px}",
    ".claim-id{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-weight:700;font-size:.9rem}",
    ".loc{color:var(--muted);font-size:.82rem}",
    ".badge{display:inline-block;font-size:.72rem;font-weight:600;padding:2px 8px;border-radius:999px;text-transform:lowercase;letter-spacing:.02em;border:1px solid transparent;white-space:nowrap}",
    ".badge-ok{background:#dcfce7;color:#166534}.badge-warn{background:#fef3c7;color:#92400e}.badge-bad{background:#fee2e2;color:#991b1b}.badge-term{background:#ede9fe;color:#5b21b6}.badge-neutral{background:#e5e7eb;color:#374151}",
    "@media (prefers-color-scheme:dark){.badge-ok{background:#14532d;color:#bbf7d0}.badge-warn{background:#78350f;color:#fde68a}.badge-bad{background:#7f1d1d;color:#fecaca}.badge-term{background:#4c1d95;color:#ddd6fe}.badge-neutral{background:#374151;color:#e5e7eb}}",
    ".wp-text{margin:0 0 10px;padding:10px 14px;border-left:3px solid var(--accent);background:rgba(37,99,235,.06);border-radius:0 6px 6px 0;font-size:.98rem}",
    ".wp-text .cm{color:var(--accent);font-size:.7em;font-weight:600}",
    "figure.wiki-shot{margin:0 0 14px;padding:0}",
    "figure.wiki-shot img{max-width:640px}",
    ".section-label{font-size:.7rem;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);font-weight:700;margin-bottom:4px}",
    ".citations{margin:12px 0}",
    ".fn-marker{font-family:ui-monospace,Menlo,monospace;font-size:.8rem;color:var(--muted);margin-right:4px}",
    ".footnote{font-size:.86rem;margin:3px 0;padding-left:2px}",
    ".chain{margin-top:14px}",
    "ol.hops{list-style:none;margin:0;padding:0;counter-reset:hop}",
    ".hop{border:1px solid var(--border);border-radius:10px;padding:12px 14px;margin-top:10px;background:var(--bg)}",
    ".hop-head{display:flex;align-items:center;gap:10px;margin-bottom:8px}",
    ".hop-index{font-weight:700;font-size:.85rem}",
    ".cited-by{font-size:.85rem;margin-bottom:8px}",
    ".cited-by .section-label{display:inline;margin-right:6px}",
    "table.kv{border-collapse:collapse;width:100%;font-size:.86rem;margin:6px 0}",
    "table.kv th{text-align:left;vertical-align:top;padding:3px 12px 3px 0;color:var(--muted);font-weight:600;white-space:nowrap;width:1%}",
    "table.kv td{vertical-align:top;padding:3px 0;word-break:break-word}",
    ".source{margin:8px 0}",
    ".source-status{margin-bottom:4px;display:flex;gap:6px;flex-wrap:wrap}",
    ".facts,.quotes{margin-top:10px}",
    ".cites-next{margin-top:12px;padding-top:8px;border-top:1px dashed var(--border);font-size:.85rem}",
    ".cites-next.muted{font-style:italic}",
    "blockquote.quote{margin:6px 0;padding:6px 12px;border-left:3px solid var(--quote-bar);color:var(--fg);font-size:.88rem;font-style:italic}",
    "figure.quote-shot{margin:2px 0 14px;padding:0 0 0 15px}",
    "figure.quote-shot img{display:block;max-width:100%;border:1px solid var(--border);border-radius:4px;background:#fff}",
    "figure.quote-shot a.quote-shot-link{display:block;cursor:zoom-in}",
    "figure.quote-shot a.quote-shot-link:hover img{border-color:var(--accent)}",
    "figure.quote-shot figcaption{font-size:.72rem;color:var(--muted);margin-top:3px}",
    "figure.quote-shot .shot-open{color:var(--accent)}",
    ".tech-refs{margin-top:12px;font-size:.85rem}",
    ".tech-ref,.tech-refs .section-label{display:inline;margin-right:6px}",
    ".tech-ref{font-family:ui-monospace,Menlo,monospace;background:#ede9fe;color:#5b21b6;padding:1px 7px;border-radius:6px}",
    "code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.82em;background:rgba(127,127,127,.14);padding:1px 4px;border-radius:4px}",
  ].join("\n");

  // A real URL (served viewer) opens natively via target="_blank". A data: URI
  // (standalone file) can't be a top-level navigation, so write it into a blank
  // tab as an <img> instead.
  var QUOTE_SHOT_SCRIPT =
    "<script>\n" +
    "document.addEventListener('click',function(e){\n" +
    "  var a=e.target.closest&&e.target.closest('a.quote-shot-link');\n" +
    "  if(!a)return;\n" +
    "  var href=a.getAttribute('href')||'';\n" +
    "  if(href.slice(0,5)!=='data:')return;\n" +
    "  e.preventDefault();\n" +
    "  var w=window.open('','_blank');\n" +
    "  if(!w){window.location.href=href;return;}\n" +
    "  w.document.write('<!doctype html><meta charset=\"utf-8\"><title>source page</title>'+\n" +
    "    '<body style=\"margin:0;background:#333;text-align:center\">'+\n" +
    "    '<img style=\"max-width:100%;height:auto\" src=\"'+href.replace(/\"/g,'&quot;')+'\">');\n" +
    "  w.document.close();\n" +
    "});\n" +
    "</script>";

  /** A complete standalone HTML document string. */
  function renderDocument(data, opts) {
    opts = opts || {};
    var title =
      opts.title ||
      (data && data.page && data.page.title) ||
      (data && Array.isArray(data.entries) ? "Technical Log" : "Chronology Extraction");
    return (
      "<!doctype html>\n" +
      '<html lang="en">\n<head>\n<meta charset="utf-8">\n' +
      '<meta name="viewport" content="width=device-width,initial-scale=1">\n' +
      "<title>" +
      esc(title) +
      "</title>\n<style>\n" +
      STYLES +
      "\n</style>\n</head>\n<body>\n<main class=\"wrap\">\n" +
      renderBody(data, opts) +
      "\n</main>\n" +
      QUOTE_SHOT_SCRIPT +
      "\n</body>\n</html>\n"
    );
  }

  return {
    renderBody: renderBody,
    renderDocument: renderDocument,
    STYLES: STYLES,
    esc: esc,
    slug: slug,
  };
});
