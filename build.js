#!/usr/bin/env node
/*
 * build.js — render every chronology JSON in the project into a static site
 * under dist/: one HTML page per document plus an index.html gallery.
 *
 * Usage: node build.js [srcDir] [outDir]
 *   srcDir defaults to the project root, outDir defaults to ./dist
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { renderDocument, STYLES, esc, slug } = require("./lib/render");

const SRC = path.resolve(process.argv[2] || __dirname);
const OUT = path.resolve(process.argv[3] || path.join(__dirname, "dist"));

function readDoc(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    if (Array.isArray(data.claims) || Array.isArray(data.entries)) return data;
  } catch {
    /* not our JSON */
  }
  return null;
}

function collect(dir) {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    if (name.startsWith(".") || name === "node_modules" || name === "dist") continue;
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) out.push(...collect(full));
    else if (name.toLowerCase().endsWith(".json")) {
      const data = readDoc(full);
      if (data) out.push({ file: full, data });
    }
  }
  return out;
}

function summarize(data) {
  if (Array.isArray(data.entries)) {
    return { kind: "technical log", title: "Shared Technical Log", count: data.entries.length, statuses: {} };
  }
  const claims = data.claims || [];
  const statuses = {};
  claims.forEach((c) => {
    statuses[c.status] = (statuses[c.status] || 0) + 1;
  });
  return {
    kind: "page",
    title: (data.page && data.page.title) || "Untitled",
    url: data.page && data.page.url,
    count: claims.length,
    statuses,
  };
}

function galleryPage(cards) {
  const rows = cards
    .map((c) => {
      const s = c.summary;
      const chips = Object.keys(s.statuses)
        .map(
          (k) =>
            '<span class="badge badge-' +
            ({ resolved: "ok", dead_end: "bad", pending: "warn" }[k] || "neutral") +
            '">' +
            esc(k.replace(/_/g, " ")) +
            " " +
            s.statuses[k] +
            "</span>"
        )
        .join(" ");
      return (
        '<a class="card" href="./' +
        esc(c.htmlName) +
        '">' +
        "<h2>" +
        esc(s.title) +
        "</h2>" +
        '<div class="doc-meta">' +
        esc(s.kind) +
        " · " +
        s.count +
        (s.kind === "page" ? " claim(s)" : " entr(y/ies)") +
        "</div>" +
        (chips ? '<div class="chips">' + chips + "</div>" : "") +
        '<div class="doc-meta src">' +
        esc(path.relative(SRC, c.file)) +
        "</div>" +
        "</a>"
      );
    })
    .join("\n");

  return (
    "<!doctype html>\n<html lang=\"en\"><head><meta charset=\"utf-8\">\n" +
    '<meta name="viewport" content="width=device-width,initial-scale=1">\n' +
    "<title>Chronology Extractions</title>\n<style>\n" +
    STYLES +
    "\n.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:16px;margin-top:20px}" +
    "\n.card{display:block;background:var(--card);border:1px solid var(--border);border-radius:12px;padding:16px 18px;text-decoration:none;color:inherit;transition:border-color .15s}" +
    "\n.card:hover{border-color:var(--accent)}" +
    "\n.card h2{margin:0 0 4px;font-size:1.05rem}" +
    "\n.chips{margin-top:8px;display:flex;flex-wrap:wrap;gap:6px}" +
    "\n.src{margin-top:8px;font-size:.75rem;word-break:break-all}" +
    "\n</style></head><body><main class=\"wrap\">\n" +
    "<header class=\"doc-head\"><h1>Chronology Extractions</h1>" +
    '<div class="doc-meta">' +
    cards.length +
    " document(s) · generated " +
    new Date().toISOString().slice(0, 10) +
    "</div></header>\n" +
    '<div class="grid">\n' +
    rows +
    "\n</div>\n</main></body></html>\n"
  );
}

function main() {
  const docs = collect(SRC);
  if (!docs.length) {
    process.stderr.write("no chronology JSON documents found under " + SRC + "\n");
    process.exit(1);
  }
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });

  const used = new Set();
  const cards = docs.map(({ file, data }) => {
    let base = slug(path.basename(file, ".json"));
    let name = base + ".html";
    let i = 2;
    while (used.has(name)) name = base + "-" + i++ + ".html";
    used.add(name);
    fs.writeFileSync(path.join(OUT, name), renderDocument(data));
    return { file, data, htmlName: name, summary: summarize(data) };
  });

  fs.writeFileSync(path.join(OUT, "index.html"), galleryPage(cards));
  process.stderr.write(
    "built " + cards.length + " page(s) + index.html into " + OUT + "\n"
  );
}

main();
