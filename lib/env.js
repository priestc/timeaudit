/*
 * env.js — load KEY=VALUE lines from a .env file into process.env.
 *
 * Node 18 (what tank2 runs) has no --env-file flag, so this is a tiny stand-in.
 * Existing process.env values always win over the file.
 */
"use strict";

const fs = require("fs");
const path = require("path");

function loadEnv(file) {
  file = file || path.join(process.cwd(), ".env");
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return false; // no .env file — fine, values may come from the real environment
  }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
  return true;
}

module.exports = { loadEnv };
