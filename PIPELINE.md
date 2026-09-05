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

## Three phases — the code does phases 1 and 2

1. **Phase 1 — parse the article for dated "claims" and classify them.**
2. **Phase 2 — follow the Wikipedia citations and download the raw text of each
   cited source.**
3. **Phase 3 — read through those sources and classify the dating evidence.**
   *Not implemented yet* — it returns once phase-2 retrieval is good enough to
   build on. Everything that worked off the *content* of a downloaded source has
   been removed for now: no onward (multi-hop) citation chasing, no
   terminal-method classification, no text-mined quotes, and the `hybrid` AI
   mode is gone. A traced claim ends at `status:"pending"` (the cited source is
   in hand, waiting for phase 3) or `"dead_end"` (every cited source was
   unreachable).

## Two modes

The mode is written into the report as `generator.mode`, so a corpus of reports
can be compared over time to see which approach produces the best extractions.

| `--mode` | What it does | Needs a key |
| -------- | ------------ | ----------- |
| `local` | **Only the local software.** Phases 1-2 below run; no AI is contacted. The default. Aliases: `--no-ai`, `--local`. | no |
| `ai-only` | **No local analysis.** The model is handed just the Wikipedia URL and a link to `SPEC.md` and builds the entire report itself, using web search / web fetch to read the page and chase citations. The local `source-cache/` is not populated. Alias: `--ai-only`. | yes |

(`--ai` / `--hybrid` now exit with an error pointing at these two.)

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

(`ai-only` also records `ai_model`, `ai_usage`, `web_tool_calls`,
`stop_reason`.) `db.js list` shows the mode column, and the Firestore record
carries `generator_mode` / `generator_model` for querying.

## `local` pipeline (phases 1-2): all local, no AI

| Phase | Stage | How it's done locally |
| ----- | ----- | --------------------- |
| 1 | **Fetch** | MediaWiki `action=parse` API — HTML + wikitext + sections in one request. Raw response cached under `source-cache/_wikipedia/`. |
| 1 | **Find dated claims** | Sentence-split the article body; keep only sentences that **state an actual number** as a time target — `N BCE`, `N CE`, `Nth`/spelled-ordinal century or millennium, `N years ago`, `N BP`, ranges. A bare era word ("Neolithic", "medieval", "Bronze Age") or a bare "cal BP" with no figure is **not** a time target and never makes a sentence a claim. A bare number with no BC/AD/CE marker is only read as a calendar year when its surrounding words fit one ("in 1200 the site was rebuilt"); when they say a quantity ("between 400 and as many as 600 distinct Indus symbols", "up to 700 seals") it's a count, not a date. `wikipedia_text_verbatim` keeps the inline `[n]` citation markers exactly where Wikipedia shows them. |
| 1 | **1450 CE cutoff** | Parse every concrete date out of the sentence (BCE→negative; an unmarked *century*→CE, an unmarked *millennium*→BCE since its CE reading would be a future year; YBP→`1950−N`), apply SPEC rule 0 as a **hard** gate: if the earliest concrete date is ≥ 1450 CE the sentence is out of scope, no exceptions — a modern-event sentence ("excavation began in 1995", "discovered in 2017") that merely name-drops "Neolithic" is still dropped. Only a BCE or a genuine pre-1450 CE date *in the same sentence* keeps a modern year in scope. Sentences with date language but no parseable number at all are kept and flagged. |
| 1 | **Citation metadata** | Every Wikipedia citation embeds a COinS / OpenURL blob (`class="Z3988"`) — author, title, year, journal, DOI, ISBN, pages, all machine-readable. Shortened `{{sfn}}` footnotes are followed to their bibliography entry. Lettered `{{efn}}` explanatory notes (`[m]`/`[n]`) are not citations — their quoted snippet is attached to the numbered source they quote as `hop.wikipedia_note_quotes`. No scraping guesswork. |
| 2 | **Parallel citations** | A sentence citing more than one distinct source (`[98][99]` on two different works) gets one independent hop per source — every one is fetched, not just the first. Each parallel source's hop is marked `parallel_citation: {index, total}` (SPEC rule 6); the viewer labels these "Wikipedia parallel citation N of M". |
| 2 | **Download sources** | For each cited source, candidate URLs are tried in order: direct PDF → **Wikipedia `archive-url`** (the editor-recorded snapshot) → **OpenAlex** OA location (by DOI, no key) → **Europe PMC** full-text XML (by DOI/PMCID, no key) → **Unpaywall** (needs `--email`) → the cited URL → `doi.org`. Polite: 1 request/second/host, one User-Agent, 40 MB cap, already-cached files reused (SPEC rule 8). Bot-walls / paywalls / Cloudflare challenges / login redirects are detected and skipped. When every candidate fails, the *most specific* reason found across all of them is kept — a `books.google.*` link (never anything but a restricted preview for an in-copyright book) records `"unable to retrieve source because copyrighted"`; other paywalls, bot-challenges, HTTP errors, login walls, and print-only citations with no online copy at all each get their own accurate `source.retrieval_note`, not a blanket "unreachable". |
| 2 | **Wayback Machine fallback** | When a real page/file candidate (the direct link, the cited URL, or a DOI landing page — not an OA-aggregator API query) fails, the Internet Archive's free `wayback/available` lookup is checked for a saved snapshot (aimed at the citation's "Retrieved" date when there is one) before giving up on it; a hit is downloaded and validated exactly like a live source and `source.retrieved_via_wayback` is set. No snapshot found is not itself a failure reason — the original error is what gets recorded. |
| 2 | **Text extraction** | `pdftotext` (poppler) for PDFs, tag-strip for HTML/XML. Cached as a sibling `.txt` — this is the raw text phase 3 will read; nothing reads it yet. |
| — | **Assemble** | Build the SPEC JSON. (The `T<n>` shared technical log is disabled for now.) |
| — | **Sync** | `rsync` the report and the whole `source-cache/` tree to the tank2 folder. |

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

## `ai-only` mode

The local pipeline is skipped entirely. `lib/ai.js` sends the model one prompt
containing the Wikipedia URL and `https://github.com/priestc/timeaudit/blob/main/SPEC.md`,
with the `web_search` / `web_fetch` server tools enabled, and asks it to return
the whole report JSON. `pause_turn` responses are resumed until the model
finishes (cap 16 round-trips). The returned JSON is re-wrapped so `page` and
`generator` come from us, not the model. Nothing is written to `source-cache/`.

## Options

```
--mode <local|ai-only>   default: local   aliases: --no-ai / --local, --ai-only
--out <dir>        where to write <slug>.json          (default: cwd)
--cache <dir>      source-cache root      (default: <out>/source-cache)
--max-claims <n>   cap claims processed                  (default: 60)
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

`status` per claim is `retrieved` (at least one cited source was downloaded to
the cache — the common case), `dead_end` (every cited source was unreachable),
or `no_source` (the sentence cites nothing with resolvable metadata). `resolved`
and `pending` are phase-3 trace outcomes and do not occur yet. Each hop's
`source` block carries `retrieval_status` (`retrieved` | `unreachable`),
`retrieval_note`, `retrieved_via_wayback`, and `local_cache_path`, plus
`wikipedia_note_quotes` where a Wikipedia explanatory note quotes the source.
Re-running is cheap — cached sources are reused.

## Limitations

- Many publishers (AAAS, Elsevier, JSTOR, NCBI's own HTML) block scripted
  access; those sources come back `unreachable` unless an OA copy or a Wayback
  snapshot exists.
- Book sources (Google Books, ISBNs) usually can't be fetched — recorded with
  metadata only, `retrieval_note` says why.
- Sentence splitting and date parsing are regex-based and will occasionally
  over- or under-include a claim.
- Phase 3 (reading the downloaded sources to identify the actual dating method,
  chase multi-hop citation chains, and pull load-bearing quotes) is not built
  yet — the report is a claim inventory plus a source cache, not a finished
  evidentiary trace.
