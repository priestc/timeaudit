/*
 * ai.js — OPTIONAL. Used only by `--mode ai-only`, where the model is handed
 * the Wikipedia URL + a link to SPEC.md and builds the whole report itself
 * (web search / fetch). The default `local` mode does not touch this file.
 *
 * (The old `hybrid` mode — one AI call per claim to pick a terminal hop and
 * load-bearing quotes from the downloaded sources — was phase-3 work and has
 * been removed until phase 3 is built.)
 *
 * Raw HTTPS to /v1/messages — no SDK dependency, to keep the CLI lean.
 */
"use strict";

const https = require("https");

const MODEL = process.env.TIMEAUDIT_AI_MODEL || "claude-opus-5";

function available() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

function callMessages(body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = https.request(
      "https://api.anthropic.com/v1/messages",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": process.env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "content-length": Buffer.byteLength(payload),
        },
        timeout: 600000,
      },
      (res) => {
        let s = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (s += c));
        res.on("end", () => {
          if (res.statusCode !== 200) return reject(new Error("Anthropic API HTTP " + res.statusCode + ": " + s.slice(0, 300)));
          try {
            resolve(JSON.parse(s));
          } catch (e) {
            reject(new Error("bad JSON from Anthropic API: " + e.message));
          }
        });
      }
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end(payload);
  });
}

function firstJsonObject(text) {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) {
      try {
        return JSON.parse(text.slice(start, i + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

/* ----------------------------------------------------- ai-only whole report --- */

function collectText(content) {
  return (content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

/**
 * ai-only mode: hand the model just the two URLs and let it do everything
 * (fetch the page, read the spec, chase citations via web tools) and return the
 * whole report JSON. No local pipeline is involved.
 *
 * @returns {Promise<{ json: object|null, model: string, usage: object, raw: string, searches: number }>}
 */
async function generateReport({ wikiUrl, specUrl }) {
  if (!available()) throw new Error("ai-only mode needs ANTHROPIC_API_KEY");

  const prompt =
    "You are producing a chronology-extraction report by following a fixed protocol.\n\n" +
    "1. Fetch and read the protocol specification: " +
    specUrl +
    "\n2. Fetch the Wikipedia article: " +
    wikiUrl +
    "\n3. Follow the protocol exactly: identify every sentence making a numerical age claim, " +
    "apply the 1450 CE cutoff, record verbatim sentences and citation footnotes, and trace each " +
    "citation chain (use web search / web fetch to open the cited sources) until it reaches a " +
    "terminal dating method or a dead end.\n" +
    "4. Obey the protocol's copyright and no-fabrication rules: never invent a quote, citation, " +
    "lab code, or date; mark unreachable sources accordingly.\n\n" +
    "Output ONLY the final JSON object conforming to the spec's top-level page-file schema " +
    "(schema_version, page, claims[]). No markdown, no prose, no code fence — just the JSON.";

  const tools = [
    { type: "web_search_20260209", name: "web_search", max_uses: 40 },
    { type: "web_fetch_20260209", name: "web_fetch", max_uses: 40 },
  ];

  let messages = [{ role: "user", content: prompt }];
  let last = null;
  let searches = 0;
  for (let i = 0; i < 16; i++) {
    last = await callMessages({
      model: MODEL,
      max_tokens: 32000,
      thinking: { type: "adaptive" },
      tools,
      messages,
    });
    searches += (last.content || []).filter((b) => b.type === "server_tool_use").length;
    if (last.stop_reason === "pause_turn") {
      messages = messages.concat([{ role: "assistant", content: last.content }]);
      continue;
    }
    break;
  }
  const raw = collectText(last && last.content);
  return {
    json: firstJsonObject(raw),
    model: (last && last.model) || MODEL,
    usage: (last && last.usage) || null,
    stop_reason: last && last.stop_reason,
    raw,
    searches,
  };
}

module.exports = { available, generateReport, MODEL };
