#!/usr/bin/env node
/*
 * serve.js — web service for the browse UI.
 *
 * Scans a source for chronology JSON documents (see SPEC.md) and serves a
 * single-page browser that renders any of them to HTML on the fly, using the
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

const { loadEnv } = require("./lib/env");
loadEnv();

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

const STATUS_ORDER = ["resolved", "pending", "dead_end"];

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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const pathname = decodeURIComponent(url.pathname);

  try {
    if (pathname === "/" || pathname === "/index.html") {
      return send(res, 200, "text/html; charset=utf-8", fs.readFileSync(path.join(ROOT, "web", "index.html")));
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
    if (pathname === "/api/file") {
      const raw = await backend.read(url.searchParams.get("id") || "");
      if (raw == null) return send(res, 404, "text/plain", "not found");
      return send(res, 200, "application/json", raw);
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
