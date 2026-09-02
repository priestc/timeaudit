/*
 * ai.js — OPTIONAL, minimal AI gap-filler.
 *
 * The whole pipeline runs without this. When ANTHROPIC_API_KEY is set (and
 * --no-ai was not passed) it makes exactly ONE request per claim to resolve the
 * judgement calls local heuristics can't: is this genuinely an in-scope age
 * claim, which hop (if any) reaches a physical dating method, and which <=3
 * verbatim sentences from the cached sources are load-bearing.
 *
 * Raw HTTPS to /v1/messages — no SDK dependency, to keep the CLI lean. Every
 * quote the model returns is verified to be a substring of the text we sent it,
 * so it cannot fabricate a quote (SPEC.md rule 5).
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
        timeout: 120000,
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

function norm(s) {
  return String(s).replace(/\s+/g, " ").trim().toLowerCase();
}

function buildPrompt(claim) {
  const hops = claim.hops
    .map((h, i) => {
      const s = h.source || {};
      const facts = JSON.stringify(h._classify ? h._classify.structured_facts : {});
      const excerpt = (h._excerpt || "").slice(0, 3000);
      return (
        "HOP " +
        (i + 1) +
        "\n  source: " +
        JSON.stringify({
          author: s.author,
          title: s.title,
          year: s.year,
          type: s.document_type,
          doi: s._doi || null,
          retrieval_status: s.retrieval_status,
          cached: s.local_cache_path || null,
        }) +
        "\n  local method guess: " +
        (h._classify ? h._classify.terminal_type + " (hits: " + (h._classify.method_hits || []).join(",") + ")" : "none") +
        "\n  local structured facts: " +
        facts +
        "\n  extracted text excerpt:\n" +
        (excerpt || "(no text extracted)")
      );
    })
    .join("\n\n");

  return (
    "You are extracting the evidentiary basis for a dated claim on Wikipedia, per a fixed protocol. " +
    "Do NOT use outside knowledge. Work only from the material below.\n\n" +
    "WIKIPEDIA SENTENCE (section: " +
    claim.section +
    "):\n" +
    claim.sentence +
    "\n\nLocal 1450 CE cutoff assessment: " +
    claim.cutoff.basis +
    "\n\nCITATION CHAIN (each hop is a source that was downloaded and had text extracted):\n\n" +
    hops +
    "\n\nReturn ONLY a JSON object, no prose, with this shape:\n" +
    "{\n" +
    '  "in_scope": boolean,            // is this genuinely a numerical age claim about a date before 1450 CE?\n' +
    '  "terminal_hop": integer|null,   // 1-based hop whose text directly describes a physical/comparative dating method for THIS claim, else null\n' +
    '  "terminal_type": "radiocarbon"|"OSL"|"uranium_thorium"|"argon_argon"|"dendrochronology"|"thermoluminescence"|"comparative"|"genetic_context_dating"|"other_physical"|null,\n' +
    '  "quotes": { "<hop number>": ["verbatim sentence copied EXACTLY from that hop\'s excerpt", ...] },  // <=3 per hop, load-bearing wording only\n' +
    '  "needs_deeper_hop": boolean,    // true if the chain clearly depends on a source not yet fetched\n' +
    '  "status": "resolved"|"pending"|"dead_end",\n' +
    '  "notes": "one sentence, factual"\n' +
    "}\n"
  );
}

/**
 * @returns {Promise<null | {in_scope, terminal_hop, terminal_type, quotes, needs_deeper_hop, status, notes}>}
 * Quotes are filtered to those actually present in the excerpts we sent.
 */
async function refineClaim(claim) {
  if (!available()) return null;
  const res = await callMessages({
    model: MODEL,
    max_tokens: 4000,
    thinking: { type: "adaptive" },
    messages: [{ role: "user", content: buildPrompt(claim) }],
  });
  const textBlock = (res.content || []).find((b) => b.type === "text");
  if (!textBlock) return null;
  const parsed = firstJsonObject(textBlock.text);
  if (!parsed) return null;

  // verify quotes against the material we actually sent
  const excerptByHop = {};
  claim.hops.forEach((h, i) => (excerptByHop[i + 1] = norm(h._excerpt || "")));
  const cleanQuotes = {};
  for (const [k, arr] of Object.entries(parsed.quotes || {})) {
    const hay = excerptByHop[k] || "";
    const kept = (Array.isArray(arr) ? arr : []).filter((q) => q && hay.includes(norm(q))).slice(0, 3);
    if (kept.length) cleanQuotes[k] = kept;
  }
  parsed.quotes = cleanQuotes;
  parsed._model = res.model || MODEL;
  parsed._usage = res.usage || null;
  return parsed;
}

module.exports = { available, refineClaim, MODEL };
