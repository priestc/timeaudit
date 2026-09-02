/*
 * sync.js — copy the generated report and all cached academic material to the
 * tank2 folder (where the web service and `db.js push` pick them up).
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const HOST = process.env.TIMEAUDIT_TANK2_HOST || "tank2";
const REMOTE_DIR = process.env.TIMEAUDIT_TANK2_DIR || "/home/chris/timeaudit";

function rsync(args) {
  execFileSync("rsync", ["-az", ...args], { stdio: ["ignore", "pipe", "pipe"] });
}

function syncToTank2({ jsonPath, techLogPath, cacheDir }) {
  const done = [];
  // 1. the report JSON
  rsync([jsonPath, HOST + ":" + REMOTE_DIR + "/"]);
  done.push(path.basename(jsonPath) + " -> " + HOST + ":" + REMOTE_DIR + "/");

  // 2. the shared technical log, if we wrote one
  if (techLogPath && fs.existsSync(techLogPath)) {
    rsync([techLogPath, HOST + ":" + REMOTE_DIR + "/"]);
    done.push(path.basename(techLogPath) + " -> " + HOST + ":" + REMOTE_DIR + "/");
  }

  // 3. the source cache (academic material): mirror the whole tree
  if (cacheDir && fs.existsSync(cacheDir)) {
    rsync([cacheDir.replace(/\/?$/, "/"), HOST + ":" + REMOTE_DIR + "/source-cache/"]);
    const n = countFiles(cacheDir);
    done.push(n + " cached file(s) -> " + HOST + ":" + REMOTE_DIR + "/source-cache/");
  }
  return done;
}

function countFiles(dir) {
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) n += countFiles(path.join(dir, e.name));
    else n++;
  }
  return n;
}

module.exports = { syncToTank2, HOST, REMOTE_DIR };
