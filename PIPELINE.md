# `timeaudit <url>` — the report generator

Turns a Wikipedia URL into a chronology-extraction JSON report that conforms to
[`SPEC.md`](./SPEC.md), plus a local cache of every academic source it could
download.

```bash
timeaudit https://en.wikipedia.org/wiki/Ancient_Egypt
# or, without installing:
node timeaudit.js https://en.wikipedia.org/wiki/Ancient_Egypt
```

Writes `./<slug>.json`, updates `./technical-log.json`, saves sources under
`./source-cache/<slug>/`, and (unless `--no-sync`) copies all of that to the
tank2 folder (`/home/chris/timeaudit/`), where the web service and `db.js push`
pick it up.

## Design goal: maximum local computation, minimum external AI

Everything except one optional step runs locally with no API calls to any AI:

| Stage | How it's done locally |
| ----- | --------------------- |
| **Fetch** | MediaWiki `action=parse` API — HTML + wikitext + sections in one request. Raw response cached under `source-cache/_wikipedia/`. |
| **Find dated claims** | Sentence-split the article body; keep sentences matching date patterns (`N BCE`, `N CE`, `Nth millennium`, `N years ago`, `cal BP`, ranges, …). |
| **1450 CE cutoff** | Parse the years out of each sentence (BCE→negative, centuries→midpoint, YBP→`1950−N`), apply SPEC rule 0. All-BCE always in; modern-only sentences dropped; genuinely ambiguous ones kept and flagged. |
| **Citation metadata** | Every Wikipedia citation embeds a COinS / OpenURL blob (`class="Z3988"`) — author, title, year, journal, DOI, ISBN, pages, all machine-readable. Shortened `{{sfn}}` footnotes are followed to their bibliography entry. No scraping guesswork. |
| **Download sources** | For each cited source, candidate URLs are tried in order: direct PDF → **OpenAlex** OA location (by DOI, no key) → **Europe PMC** full-text XML (by DOI/PMCID, no key) → **Unpaywall** (needs `--email`) → the cited URL → `doi.org`. Polite: 1 request/second/host, one User-Agent, 40 MB cap, already-cached files reused (SPEC rule 8). Bot-walls / paywalls / Cloudflare challenges are detected and skipped. |
| **Text extraction** | `pdftotext` (poppler) for PDFs, tag-strip for HTML/XML. Cached as a sibling `.txt`. |
| **Terminal classification** | Regex signatures for radiocarbon / OSL / U-Th / Ar-Ar / dendro / TL / comparative, plus lab-code (`OxA-1234`, `KIA-…`), calibrated-range (`8617–8315 calBC`) and sample-count extraction. A hop is only called *terminal* on strong evidence (lab codes, ≥2 calibrated ranges, or explicit "N samples were dated" wording) — otherwise the method is recorded as a guess and the chain stays `pending`. |
| **Multi-hop** | If a hop isn't terminal, DOIs inside its extracted text (preferring ones near dating-method language) become the next hop, up to `--depth` (default 3). Already-visited DOIs/URLs are skipped. |
| **Assemble** | Build the SPEC JSON; append `T<n>` entries to `technical-log.json` for terminal physical-method hops (deduped). |
| **Sync** | `rsync` the report, technical log and whole `source-cache/` tree to the tank2 folder. |

### The one optional AI step

If `ANTHROPIC_API_KEY` is set (and `--no-ai` wasn't passed), **one** request per
claim — no agent loop — is made to `claude-opus-5` (override with
`TIMEAUDIT_AI_MODEL`). It only does what local heuristics can't:

- confirm the sentence is genuinely a pre-1450 numerical age claim (drops it if not)
- say which hop, if any, actually reaches a dating method, and its type
- pick ≤3 load-bearing verbatim quotes per hop

Every quote it returns is verified to be a substring of the text we sent it, so
it cannot fabricate one (SPEC rule 5). Without a key the tool still produces a
complete report — the judgement-dependent chains are just marked `pending` with
all the local evidence attached for a later `--ai` run or a human.

## Options

```
--out <dir>        where to write <slug>.json          (default: cwd)
--cache <dir>      source-cache root      (default: <out>/source-cache)
--max-claims <n>   cap claims processed                (default: 60)
--depth <n>        max citation-chain hops             (default: 3)
--downloads <n>    max source downloads this run       (default: 40)
--email <addr>     contact email for the Unpaywall OA lookup
                   (default: $TIMEAUDIT_CONTACT_EMAIL; omitted => Unpaywall skipped)
--ai / --no-ai     force the AI gap-filler on / off
--no-sync          do not copy anything to the tank2 folder
--push             also run `node db.js push` afterwards (into Firestore)
--quiet
```

`TIMEAUDIT_CONTACT_EMAIL` in `.env` is worth setting — Unpaywall roughly doubles
the download hit rate. OpenAlex and Europe PMC need no key.

## What the output looks like

`status` per claim is `resolved` (a hop reached a dating method), `dead_end`
(hop 1 unreachable, no leads) or `pending` (chain followed but no confident
terminus — the common case without `--ai`). Heuristic runs are a strong
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
