#!/usr/bin/env node
/*
 * json-to-html.js — convert a chronology-extraction JSON file (see SPEC.md)
 * into a standalone HTML file for viewing in a browser.
 *
 * Usage:
 *   node json-to-html.js <input.json> [output.html]
 *   node json-to-html.js <input.json> --stdout
 *   node json-to-html.js <dir-or-glob> --out <dir>      # batch: every *.json
 *
 * With no output path, writes <input>.html next to the input file.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { renderDocument, slug } = require("./lib/render");

function die(msg) {
  process.stderr.write("error: " + msg + "\n");
  process.exit(1);
}

function looksLikeChronologyDoc(obj) {
  return (
    obj &&
    typeof obj === "object" &&
    (Array.isArray(obj.claims) || Array.isArray(obj.entries))
  );
}

function convertFile(inPath, outPath) {
  let raw;
  try {
    raw = fs.readFileSync(inPath, "utf8");
  } catch (e) {
    die("cannot read " + inPath + ": " + e.message);
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    die(inPath + " is not valid JSON: " + e.message);
  }
  if (!looksLikeChronologyDoc(data)) {
    die(
      inPath +
        ' does not look like a chronology document (no "claims" or "entries" array).'
    );
  }
  const html = renderDocument(data);
  if (outPath === "-") {
    process.stdout.write(html);
    return;
  }
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, html);
  process.stderr.write(inPath + "  ->  " + outPath + "\n");
}

function main(argv) {
  const args = argv.slice(2);
  if (!args.length || args[0] === "-h" || args[0] === "--help") {
    process.stdout.write(
      "usage: node json-to-html.js <input.json> [output.html | --stdout]\n" +
        "       node json-to-html.js <dir> --out <dir>\n"
    );
    process.exit(args.length ? 0 : 1);
  }

  const input = args[0];
  let outArg = null;
  let stdout = false;
  let outDir = null;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--stdout") stdout = true;
    else if (args[i] === "--out") outDir = args[++i];
    else if (!outArg) outArg = args[i];
  }

  let stat;
  try {
    stat = fs.statSync(input);
  } catch (e) {
    die("no such file or directory: " + input);
  }

  if (stat.isDirectory()) {
    const dest = outDir || outArg || path.join(input, "html");
    const files = fs
      .readdirSync(input)
      .filter((f) => f.toLowerCase().endsWith(".json"))
      .map((f) => path.join(input, f));
    if (!files.length) die("no .json files found in " + input);
    let n = 0;
    for (const f of files) {
      try {
        JSON.parse(fs.readFileSync(f, "utf8"));
      } catch {
        continue;
      }
      convertFile(f, path.join(dest, slug(path.basename(f, ".json")) + ".html"));
      n++;
    }
    process.stderr.write("converted " + n + " file(s) into " + dest + "\n");
    return;
  }

  const out = stdout
    ? "-"
    : outArg || path.join(path.dirname(input), path.basename(input, path.extname(input)) + ".html");
  convertFile(input, out);
}

main(process.argv);
