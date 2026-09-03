/*
 * inline-assets.js — turn <img src="/source-cache/...">  references in rendered
 * HTML into self-contained data: URIs, reading the files from disk.
 *
 * Used by the standalone-HTML tools (json-to-html.js, build.js). The web viewer
 * keeps the URLs and lets serve.js serve the files.
 */
"use strict";

const fs = require("fs");
const path = require("path");

const MIME = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif" };

function inlineAssets(html, baseDir) {
  return String(html).replace(
    /(<img\b[^>]*\bsrc=")(\/?source-cache\/[^"']+?\.(png|jpe?g|webp|gif))(")/gi,
    (m, pre, rel, ext, post) => {
      const file = path.resolve(baseDir, rel.replace(/^\//, ""));
      if (!file.startsWith(path.resolve(baseDir) + path.sep) || !fs.existsSync(file)) return m;
      try {
        const b64 = fs.readFileSync(file).toString("base64");
        return pre + "data:" + (MIME[ext.toLowerCase()] || "image/png") + ";base64," + b64 + post;
      } catch {
        return m;
      }
    }
  );
}

module.exports = { inlineAssets };
