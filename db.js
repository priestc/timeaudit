#!/usr/bin/env node
/*
 * db.js — sync chronology JSON files with the Firestore database.
 *
 *   node db.js push [dir]        upload every *.json under dir (default: .)
 *   node db.js list              list the documents currently in Firestore
 *   node db.js pull <id> [out]   write one document's raw JSON back to a file
 *   node db.js delete <id>       remove one document from Firestore
 *
 * Config is read from .env (see .env.example / SETUP.md).
 */
"use strict";

const fs = require("fs");
const path = require("path");

const { loadEnv } = require("./lib/env");
loadEnv();

const { isConfigured, collectionName } = require("./lib/firebase");
const store = require("./lib/store");

function die(msg) {
  process.stderr.write("error: " + msg + "\n");
  process.exit(1);
}

function isChronologyJson(text) {
  try {
    const d = JSON.parse(text);
    return d && (Array.isArray(d.claims) || Array.isArray(d.entries));
  } catch {
    return false;
  }
}

function findJsonFiles(dir, depth = 0, out = []) {
  if (depth > 4) return out;
  for (const name of fs.readdirSync(dir)) {
    if (name.startsWith(".") || name === "node_modules" || name === "dist") continue;
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) findJsonFiles(full, depth + 1, out);
    else if (name.toLowerCase().endsWith(".json")) out.push(full);
  }
  return out;
}

async function cmdPush(dir) {
  dir = path.resolve(dir || ".");
  const files = findJsonFiles(dir).filter((f) => isChronologyJson(fs.readFileSync(f, "utf8")));
  if (!files.length) die("no chronology JSON files found under " + dir);
  let ok = 0;
  for (const file of files) {
    const rawText = fs.readFileSync(file, "utf8");
    const record = store.toRecord(path.basename(file), rawText);
    await store.putDocument(record);
    process.stderr.write(
      "pushed  " + record.doc_id + "  <-  " + path.relative(dir, file) + "\n"
    );
    ok++;
  }
  process.stderr.write(
    "\n" + ok + " document(s) written to Firestore collection '" + collectionName() + "'.\n"
  );
}

async function cmdList() {
  const docs = await store.listDocuments();
  if (!docs.length) {
    process.stderr.write("(collection '" + collectionName() + "' is empty)\n");
    return;
  }
  for (const d of docs) {
    const count =
      d.kind === "page" ? d.claim_count + " claim(s)" : d.entry_count + " entr(y/ies)";
    process.stdout.write(
      d.id.padEnd(34) +
        "  " +
        (d.generator_mode || "-").padEnd(9) +
        "  " +
        d.kind.padEnd(13) +
        "  " +
        count.padEnd(16) +
        "  " +
        d.title +
        "\n"
    );
  }
}

async function cmdPull(id, outPath) {
  if (!id) die("usage: node db.js pull <id> [out.json]");
  const rec = await store.getDocument(id);
  if (!rec) die("no document with id '" + id + "' in Firestore");
  const raw = rec.raw_json || JSON.stringify(rec, null, 2);
  const out = outPath || rec.source_file || id + ".json";
  if (out === "-") {
    process.stdout.write(raw.endsWith("\n") ? raw : raw + "\n");
  } else {
    fs.writeFileSync(out, raw);
    process.stderr.write("wrote " + out + "\n");
  }
}

async function cmdDelete(id) {
  if (!id) die("usage: node db.js delete <id>");
  await store.deleteDocument(id);
  process.stderr.write("deleted '" + id + "' from Firestore\n");
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === "-h" || cmd === "--help") {
    process.stdout.write(
      "usage:\n" +
        "  node db.js push [dir]        upload every *.json under dir (default .)\n" +
        "  node db.js list              list documents in Firestore\n" +
        "  node db.js pull <id> [out]   download one document's raw JSON\n" +
        "  node db.js delete <id>       remove one document\n"
    );
    process.exit(cmd ? 0 : 1);
  }
  if (!isConfigured()) {
    die(
      "Firebase is not configured. Copy .env.example to .env and fill in the " +
        "FIREBASE_* values (SETUP.md has the console walkthrough)."
    );
  }
  try {
    if (cmd === "push") await cmdPush(rest[0]);
    else if (cmd === "list") await cmdList();
    else if (cmd === "pull") await cmdPull(rest[0], rest[1]);
    else if (cmd === "delete") await cmdDelete(rest[0]);
    else die("unknown command: " + cmd);
  } catch (e) {
    die(e && e.message ? e.message : String(e));
  }
  // the firebase client SDK keeps a connection open; nothing left to do.
  process.exit(0);
}

main();
