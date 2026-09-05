# `timeaudit <url>` — the report generator

Turns a Wikipedia URL into a chronology-extraction JSON report that conforms to
[`SPEC.md`](./SPEC.md), plus a local cache of every academic source it could
download.

```bash
timeaudit https://en.wikipedia.org/wiki/Ancient_Egypt
# or, without installing:
node timeaudit.js https://en.wikipedia.org/wiki/Ancient_Egypt
```

Writes `./<slug>.json`, saves sources under `./source-cache/<slug>/`, and
(unless `--no-sync`) copies both to the tank2 folder (`/home/chris/timeaudit/`),
where the web service and `db.js push` pick them up.

> **The shared technical log is disabled for now** and will return in a later
> version. `claim.technical_log_refs` stays `[]`, no `technical-log.json` is
> written, and `assemble.mergeTechnicalLog()` is dormant but kept for when it
> comes back.

## Three modes

The mode is written into the report as `generator.mode`, so a corpus of reports
can be compared over time to see which approach produces the best extractions.

| `--mode` | What it does | Needs a key |
| -------- | ------------ | ----------- |
| `local` | **Only the local software.** The whole pipeline below runs; no AI is contacted. Chains that need a judgement call are left `status: "pending"` with all the evidence attached. Alias: `--no-ai`. | no |
| `hybrid` | The local pipeline **plus** one AI call per claim to confirm scope, pick the terminal hop, and choose ≤3 load-bearing quotes (each verified as a substring of the text sent, so it can't fabricate). The default when `ANTHROPIC_API_KEY` is set. Alias: `--ai`. | yes |
| `ai-only` | **No local analysis.** The model is handed just the Wikipedia URL and a link to `SPEC.md` and builds the entire report itself, using web search / web fetch to read the page and chase citations. The local `source-cache/` is not populated. Alias: `--ai-only`. | yes |

`generator` block in every report:

```json
"generator": {
  "tool": "timeaudit",
  "mode": "local",
  "generated_at": "2026-09-02T18:42:21.693Z",
  "spec_url": "https://github.com/priestc/timeaudit/blob/main/SPEC.md",
  "ai_model": null
}
```

(`ai-only` and `hybrid` also record `ai_model`; `ai-only` adds `ai_usage`,
`web_tool_calls`, `stop_reason`.) `db.js list` shows the mode column, and the
Firestore record carries `generator_mode` / `generator_model` for querying.

## `local` / `hybrid` pipeline: maximum local computation, minimum external AI

Everything except one optional step runs locally with no API calls to any AI:

| Stage | How it's done locally |
| ----- | --------------------- |
| **Fetch** | MediaWiki `action=parse` API — HTML + wikitext + sections in one request. Raw response cached under `source-cache/_wikipedia/`. |
| **Find dated claims** | Sentence-split the article body; keep only sentences that **state an actual number** as a time target — `N BCE`, `N CE`, `Nth`/spelled-ordinal century or millennium, `N years ago`, `N BP`, ranges. A bare era word ("Neolithic", "medieval", "Bronze Age") or a bare "cal BP" with no figure is **not** a time target and never makes a sentence a claim. `wikipedia_text_verbatim` keeps the inline `[n]` citation markers exactly where Wikipedia shows them. |
| **1450 CE cutoff** | Parse every concrete date out of the sentence (BCE→negative; an unmarked *century*→CE, an unmarked *millennium*→BCE since its CE reading would be a future year; YBP→`1950−N`), apply SPEC rule 0 as a **hard** gate: if the earliest concrete date is ≥ 1450 CE the sentence is out of scope, no exceptions — a modern-event sentence ("excavation began in 1995", "discovered in 2017") that merely name-drops "Neolithic" is still dropped. Only a BCE or a genuine pre-1450 CE date *in the same sentence* keeps a modern year in scope. Sentences with date language but no parseable number at all are kept and flagged. |
| **Citation metadata** | Every Wikipedia citation embeds a COinS / OpenURL blob (`class="Z3988"`) — author, title, year, journal, DOI, ISBN, pages, all machine-readable. Shortened `{{sfn}}` footnotes are followed to their bibliography entry. No scraping guesswork. |
| **Download sources** | For each cited source, candidate URLs are tried in order: direct PDF → **OpenAlex** OA location (by DOI, no key) → **Europe PMC** full-text XML (by DOI/PMCID, no key) → **Unpaywall** (needs `--email`) → the cited URL → `doi.org`. Polite: 1 request/second/host, one User-Agent, 40 MB cap, already-cached files reused (SPEC rule 8). Bot-walls / paywalls / Cloudflare challenges are detected and skipped. When every candidate fails, the *most specific* reason found across all of them is kept — a `books.google.*` link (never anything but a restricted preview for an in-copyright book) records `"unable to retrieve source because copyrighted"`; other paywalls, bot-challenges, HTTP errors, and print-only citations with no online copy at all each get their own accurate `source.retrieval_note`, not a blanket "unreachable". |
| **Wayback Machine fallback** | When a real page/file candidate (the direct link, the cited URL, or a DOI landing page — not an OA-aggregator API query) fails, the Internet Archive's free `wayback/available` lookup is checked for a saved snapshot before giving up on it; a hit is downloaded and validated exactly like a live source (`source.local_cache_path` and `retrieval_url`/`via` note it came from Wayback). No snapshot found is not itself a failure reason — the original error is what gets recorded. |
| **Text extraction** | `pdftotext` (poppler) for PDFs, tag-strip for HTML/XML. Cached as a sibling `.txt`. |
| **Terminal classification** | Regex signatures for radiocarbon / OSL / U-Th / Ar-Ar / dendro / TL / comparative, plus lab-code (`OxA-1234`, `KIA-…`), calibrated-range (`8617–8315 calBC`) and sample-count extraction. A hop is only called *terminal* on strong evidence (lab codes, ≥2 calibrated ranges, or explicit "N samples were dated" wording) — otherwise the method is recorded as a guess and the chain stays `pending`. |
| **Multi-hop** | If a hop isn't terminal, DOIs inside its extracted text (preferring ones near dating-method language) become the next hop, up to `--depth` (default 3). Already-visited DOIs/URLs are skipped. |
| **Parallel citations** | A sentence citing more than one distinct source (`[98][99]` on two different works) gets one independent chain per source — every one is fetched and traced, not just the first. Each branch's own hop 1 is marked `parallel_citation: {index, total}` (SPEC rule 6); the viewer labels these "Wikipedia parallel citation N of M". A claim resolves if *any* branch does. |
| **Assemble** | Build the SPEC JSON. (The `T<n>` shared technical log is disabled for now.) |
| **Sync** | `rsync` the report and the whole `source-cache/` tree to the tank2 folder. |

### Screenshots are a separate, later step (`lib/shots.js`)

Per SPEC.md, the extractor produces only the JSON and the cached source files —
never screenshots. Everything derivable afterwards with local software is done
after the analysis file exists:

- **`lib/shots.js`** rebuilds screenshots from the report + `source-cache/` on
  demand: `pdftotext -bbox-layout` locates each quoted passage (in a hop's
  cached source PDF, or in the article's Wikimedia PDF render which it fetches
  if missing), `pdftoppm` crops it and the whole page it sits on.
- The **viewer** (`serve.js`) generates each shot lazily the first time its URL
  is requested (`/source-cache/_shots/<slug>/<name>.png`), then caches it.
- **`json-to-html.js` / `build.js`** call `shots.ensureShots()` up front, then
  inline the PNGs as `data:` URIs.
- File names are fixed (`<claim_id>.wp.png`, `<claim_id>.h<hop>.q<n>.png`, …) so
  `lib/render.js` builds the `<img>` paths without anything being stored in the
  JSON.

### The one optional AI step (`hybrid` mode)

**One** request per claim — no agent loop — is made to `claude-opus-5` (override
with `TIMEAUDIT_AI_MODEL`). It only does what local heuristics can't:

- confirm the sentence is genuinely a pre-1450 numerical age claim (drops it if not)
- say which hop, if any, actually reaches a dating method, and its type
- pick ≤3 load-bearing verbatim quotes per hop

Every quote it returns is verified to be a substring of the text we sent it, so
it cannot fabricate one (SPEC rule 5).

## `ai-only` mode

The local pipeline is skipped entirely. `lib/ai.js` sends the model one prompt
containing the Wikipedia URL and `https://github.com/priestc/timeaudit/blob/main/SPEC.md`,
with the `web_search` / `web_fetch` server tools enabled, and asks it to return
the whole report JSON. `pause_turn` responses are resumed until the model
finishes (cap 16 round-trips). The returned JSON is re-wrapped so `page` and
`generator` come from us, not the model. Nothing is written to `source-cache/`.

## Options

```
--mode <local|hybrid|ai-only>   default: hybrid if ANTHROPIC_API_KEY set, else local
                                aliases: --no-ai, --ai, --ai-only
--out <dir>        where to write <slug>.json          (default: cwd)
--cache <dir>      source-cache root      (default: <out>/source-cache)
--max-claims <n>   cap claims processed  (local/hybrid)  (default: 60)
--depth <n>        max citation-chain hops (local/hybrid) (default: 3)
--downloads <n>    max source downloads this run          (default: 40)
--email <addr>     contact email for the Unpaywall OA lookup
                   (default: $TIMEAUDIT_CONTACT_EMAIL; omitted => Unpaywall skipped)
--no-sync          do not copy anything to the tank2 folder
--push             also run `node db.js push` afterwards (into Firestore)
--quiet
```

`TIMEAUDIT_CONTACT_EMAIL` in `.env` is worth setting — Unpaywall roughly doubles
the download hit rate. OpenAlex and Europe PMC need no key.

## What the output looks like

`status` per claim is `resolved` (any branch reached a dating method), `dead_end`
(every branch's own hop 1 was unreachable, no leads) or `pending` (chain(s)
followed but no confident terminus — the common case in `local` mode). A `local` run is a strong
scaffold, not a finished extraction: expect to finish `pending` chains and
sanity-check `resolved` ones. Re-running is cheap — cached sources are reused.

## Limitations

- Many publishers (AAAS, Elsevier, JSTOR, NCBI's own HTML) block scripted
  access; those sources come back `unreachable` unless an OA copy exists.
- Book sources (Google Books, ISBNs) usually can't be fetched — recorded with
  metadata only.
- Heuristic terminal classification over-trusts secondary sources that merely
  cite radiocarbon dates; `--ai` corrects this.
- Sentence splitting and date parsing are regex-based and will occasionally
  over- or under-include a claim.
