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

  function renderQuotes(quotes) {
    if (!quotes || !quotes.length) return "";
    return (
      '<div class="quotes"><div class="section-label">Verbatim quotes</div>' +
      quotes
        .map(function (q) {
          return "<blockquote class=\"quote\">" + esc(q) + "</blockquote>";
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

  function renderHop(hop) {
    var termBadge = hop.is_terminal
      ? badge("terminal" + (hop.terminal_type ? " · " + hop.terminal_type.replace(/_/g, " ") : ""), "term")
      : badge("intermediate hop", "neutral");
    return (
      '<li class="hop">' +
      '<div class="hop-head">' +
      '<span class="hop-index">Hop ' +
      esc(hop.hop_index) +
      "</span>" +
      termBadge +
      "</div>" +
      (hop.cited_by
        ? '<div class="cited-by"><span class="section-label">Cited by</span> ' + esc(hop.cited_by) + "</div>"
        : "") +
      renderSource(hop.source) +
      renderFacts(hop.structured_facts) +
      renderQuotes(hop.verbatim_quotes) +
      "</li>"
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

    var markers = (claim.citation_markers || [])
      .map(function (m) {
        return '<span class="marker">[' + esc(m) + "]</span>";
      })
      .join(" ");

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
      esc(claim.wikipedia_text_verbatim) +
      "</blockquote>" +
      (markers || fnHtml
        ? '<div class="citations"><div class="section-label">Citations on the sentence</div>' +
          (markers ? '<div class="markers">' + markers + "</div>" : "") +
          fnHtml +
          "</div>"
        : "") +
      (chain.length
        ? '<div class="chain"><div class="section-label">Citation chain (' +
          chain.length +
          " hop" +
          (chain.length === 1 ? "" : "s") +
          ')</div><ol class="hops">' +
          chain.map(renderHop).join("") +
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
  function renderBody(data) {
    if (!data || typeof data !== "object") {
      return '<p class="error">Not a valid JSON document.</p>';
    }

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
    ".wp-text{margin:0 0 14px;padding:10px 14px;border-left:3px solid var(--accent);background:rgba(37,99,235,.06);border-radius:0 6px 6px 0;font-size:.98rem}",
    ".section-label{font-size:.7rem;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);font-weight:700;margin-bottom:4px}",
    ".citations{margin:12px 0}",
    ".markers{margin-bottom:6px}",
    ".marker,.fn-marker{font-family:ui-monospace,Menlo,monospace;font-size:.8rem;color:var(--muted);margin-right:4px}",
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
    "blockquote.quote{margin:6px 0;padding:6px 12px;border-left:3px solid var(--quote-bar);color:var(--fg);font-size:.88rem;font-style:italic}",
    ".tech-refs{margin-top:12px;font-size:.85rem}",
    ".tech-ref,.tech-refs .section-label{display:inline;margin-right:6px}",
    ".tech-ref{font-family:ui-monospace,Menlo,monospace;background:#ede9fe;color:#5b21b6;padding:1px 7px;border-radius:6px}",
    "code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.82em;background:rgba(127,127,127,.14);padding:1px 4px;border-radius:4px}",
  ].join("\n");

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
      renderBody(data) +
      "\n</main>\n</body>\n</html>\n"
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
