# Wikipedia Chronology Extraction Protocol (v1.0)

## Purpose

This document specifies a process and JSON output format for extracting and cataloguing the evidentiary basis behind numerical age claims (dates, date ranges, "X years ago" statements) made on Wikipedia pages, particularly pages relating to pre-modern history and archaeology.

For each dated claim, the process traces the citation chain from the Wikipedia sentence, through each successive source it cites, until it reaches either (a) an actual physical dating technique (radiocarbon, dendrochronology, optically stimulated luminescence, uranium-thorium, argon-argon, etc.) or a comparative/relative method (artifact-style seriation, textual cross-reference, etc.), or (b) a dead end (source inaccessible, chain unresolved).

**The chain follows explicit citations only.** Every link in the chain is a citation that physically appears in the preceding document — the Wikipedia footnote for the first source, and a locatable reference inside each source for every source after it. The process never adds a source because it is *known* or *believed* to be the underlying basis for a date; if the citation cannot be found, the chain simply stops (see Core rule 6).

**Scope cutoff: only claims dating to before 1450 CE are processed.** Claims about events, dates, or date ranges at or after 1450 CE are out of scope and must be skipped without extraction. This keeps the process focused on periods where dating evidence is genuinely non-trivial to trace (radiocarbon, stratigraphy, artifact seriation, etc., rather than dated documents, mints, or inscriptions naming a specific regnal year) and caps processing cost across a page and across a full Wikipedia crawl.

This process does **not** evaluate whether any date is correct. It records what evidence and methodology stand behind a claim, as stated in the sources themselves.

## Intended use

This spec is designed to be followed by an AI system processing many Wikipedia pages at scale, producing one JSON file per page plus entries in a shared cross-page technical log. The output is intended for later pattern analysis across large numbers of pages (which methods recur, which labs, which calibration approaches, how often chains terminate vs. dead-end, etc.).

---

## Core rules

0. **Apply the 1450 CE cutoff before doing any other work on a claim.** All dates BCE are always in scope. For dates CE, only process claims dated before 1450 CE. For "X years ago" / "X YBP" (years before present) phrasing, convert to an approximate calendar year before checking the cutoff (YBP is generally measured from 1950 CE, so "600 YBP" ≈ 1350 CE and is in scope; "400 YBP" ≈ 1550 CE and is out of scope). For a claim spanning a range that straddles the cutoff (e.g., "1200–1600 CE"), process the claim but note in `structured_facts` that only the portion before 1450 CE was the reason for inclusion. For eras or date ranges too vague to place relative to the cutoff, use the midpoint or best-available estimate and err on the side of processing if genuinely ambiguous.
1. **Structured facts go in structured fields, not prose.** Lab codes, sample counts, site names, institutions, years, calibrated date ranges, and similar facts must be extracted into the typed JSON fields provided. Facts are not copyrightable and do not need to be quoted — restate them as data.
2. **Verbatim quotation is reserved for load-bearing wording**, not full reproduction of sources. Use exact quotation only for the specific sentence(s) that state the claim, the method, or a meaningful qualifier/hedge (e.g., "currently thought to," "if not later," "no longer valid") where paraphrase would risk distorting the meaning.
3. **Never paraphrase a technical or hedged claim into false precision.** If a source says a date is "currently thought to begin between 2700 and 2500 BC," do not restate this in a structured field as a single hard number. Preserve the hedge, either as an exact quote or as an explicitly-flagged approximate/range field.
4. **Copyright discipline is mandatory, not optional:**
   - For sources still under copyright, limit verbatim quotation to a **maximum of 3 short quoted sentences per source**, each under ~40 words. Do not reproduce full paragraphs, full data tables, or multiple quotes stitched together to reconstruct a source's structure.
   - For sources confirmed to be in the public domain (commonly: published before 1930, or otherwise verified as PD in the relevant jurisdiction), longer excerpts are permitted, but reproducing an entire chapter or document is still out of scope — extract the relevant passage, not the whole work.
   - Never quote song lyrics, poetry, or similarly protected creative material (not expected to arise in this dataset, but the rule stands if encountered).
   - If in doubt about a source's copyright status, treat it as copyrighted and apply the stricter limit.
5. **Never fabricate a quote, a citation, a lab code, or a date.** If a source cannot be accessed, mark it as `"retrieval_status": "unreachable"` and stop that branch of the chain. Do not reconstruct plausible-sounding content to fill a gap.
6. **Only explicitly-cited sources may appear in a chain — no inference, ever.** A source belongs in `citation_chain` **if and only if** it is explicitly cited by the document immediately before it in the chain (and the first hop is the source the Wikipedia footnote itself points to). A link established by background knowledge, domain expertise, editorial judgement, "this is well known to be the underlying source", content or date similarity, or any means other than a citation you can physically locate in the preceding document is **not a hop** and must not be recorded. If you cannot find the citation in the preceding document, the chain stops there — `"status": "pending"` (citation not yet located) or `"dead_end"` (that document was unreachable). You do not get to fill the gap with an asserted source. Each hop after the first records `citation_in_previous_verbatim`: the bibliography entry or footnote **exactly as printed in the preceding document** (a factual reference string, not copyrightable prose, so it may be reproduced in full); leave it null only when the citation demonstrably exists but its exact text could not be extracted (e.g. a bare identifier in a data table).

   **A sentence with more than one Wikipedia footnote is not automatically one chain.** If the footnotes resolve to genuinely different sources (`[98][99]` citing two different works, as opposed to `[98][98]`/`{{rp}}`-style repeats of the same one), each is its own independent starting point — a **parallel citation** — and gets its own chain, traced and fetched exactly as hop 1 would be on its own. Do not pick "the first one" and drop the rest: attempt every parallel source. Mark the first hop of every branch after the first with `parallel_citation: {"index": n, "total": N}` (1-based, `N` = how many parallel sources this sentence has); leave it `null` on every other hop, including the sole hop of a sentence with only one cited source. A claim's overall `status` is `"resolved"` if *any* branch reaches a terminal node, `"dead_end"` only if *every* branch's own hop 1 was unreachable, and `"pending"` otherwise.
7. **Only record a hop if the source is used as evidence for the claim.** A hop represents a source the previous document actually relies on to support the dated claim — not every source that document happens to mention. If a source discusses, cites, or quotes another work for background, historical context, contrast, or incidental scholarly conversation, and the claim's evidentiary basis does not depend on that other work, it is **not** a hop and must not be added to `citation_chain`. This applies even after a terminal node is reached: once a hop is marked `is_terminal: true`, the chain for that claim stops there — do not continue extracting further sources that terminal document happens to reference, unless the terminal document's own dating conclusion is itself shown to depend on that further source. When uncertain whether a mentioned source counts as evidentiary or contextual, ask: "if this citation were deleted from the document, would the document's stated date or method still stand on its own?" If yes, it's context, not a hop.
8. **Every downloaded source file must be saved to a local cache folder, not fetched and discarded.** Any PDF, HTML page, or other document retrieved while tracing a chain must be written to `/source-cache/<page-slug>/` (see Local Source Cache section below), and its local path recorded in `source.local_cache_path`. This allows a future rescan of the same claim to re-read the cached file instead of re-downloading it, saving bandwidth and avoiding redundant requests to the same external hosts across a large-scale crawl.
9. **Stop conditions for a chain:** a chain is considered resolved (`"status": "resolved"`) once it reaches a node classified as `"is_terminal": true`. A chain may also be marked `"status": "dead_end"` (source unreachable) or `"status": "pending"` (not yet fully traced, e.g., time/resource constraints on this pass).

---

## Process, step by step

1. Fetch the Wikipedia page. Identify every sentence making a numerical age claim (a specific year, era, "X years ago," a date range, etc.).
2. **Apply the 1450 CE cutoff (Rule 0) immediately.** Discard any claim dated at or after 1450 CE before doing any further work on it — do not record it, do not create a claim object for it, and do not spend any citation-tracing effort on it. This filtering step should happen before step 3, not after.
3. For each remaining claim, record the exact Wikipedia sentence verbatim, its location on the page (section heading), and every citation marker attached to it.
4. Record the exact text Wikipedia itself displays for each citation marker (footnote text, including any lettered explanatory notes, exactly as shown) before following the citation further.
5. Follow the citation to its source. Record full source metadata (author, title, container work, publisher/journal, year, pages, identifier such as ISBN/DOI, document type, and the URL or method used to retrieve it).
6. Within that source, locate the passage that supports the Wikipedia claim. Extract:
   - Structured facts (see field list below) into structured fields.
   - Up to 3 short verbatim quotes (per Rule 4) capturing load-bearing wording.
7. Determine whether this source is terminal:
   - **Terminal — physical method:** the source directly describes a physical dating technique applied to a sample (radiocarbon, OSL, U-Th, dendrochronology, argon-argon, thermoluminescence, etc.). Classify by `terminal_type`. **Stop here per Rule 7** — do not add further hops for sources this document merely mentions in passing, contrasts with, or cites as background, even if those sources are themselves about dating methods.
   - **Terminal — comparative method:** the source's dating rests on non-physical comparison (artifact style, textual cross-reference, king-list correlation, etc.) with no further physical technique behind it. Classify as `terminal_type: "comparative"` and briefly describe the comparison in a structured field, not a fabricated technical entry.
   - **Not terminal:** the source's own stated date or method genuinely depends on a further source for its evidentiary basis (not merely mentions one). Continue to the next hop only when that further source is **explicitly cited in this document** and you can locate the citation (per Rules 6 and 7). Copy that citation into `citation_in_previous_verbatim` on the new hop. If the document clearly rests on outside evidence but names no citation you can find, stop the chain at `"status": "pending"` — do not guess what the source was.
8. If a physical method is found, create (or append to) an entry in the shared `technical_log` using the schema below, and reference its ID from the claim's chain.
9. Repeat until every remaining claim on the page is resolved, dead-ended, or explicitly marked pending.
10. Output one JSON file per Wikipedia page, named `<page-slug>.json`, conforming to the schema below.

---

## JSON Schema

A formal JSON Schema (draft 2020-12) is provided alongside this document as `schema.json` for automated validation. The structure is summarized here.

### Top-level page file

```
{
  "schema_version": "1.0",
  "page": {
    "title": string,
    "url": string,
    "retrieved_at": string (ISO 8601 date),
    "wikipedia_revision_id": string | null
  },
  "claims": [ <Claim>, ... ]
}
```

### Claim object

```
{
  "claim_id": string,                     // unique within the page, e.g. "IVC-001"
  "wikipedia_text_verbatim": string,       // exact sentence, no paraphrase, WITH the inline citation markers ("...8000 BCE,[4] during...") exactly where Wikipedia shows them
  "location_on_page": string,              // section heading
  "citation_markers": [string, ...],       // e.g. ["2", "a"]
  "citation_footnotes_verbatim": {         // exact text Wikipedia shows per marker, if any
    "<marker>": string | null
  },
  "citation_chain": [ <Hop>, ... ],
  "status": "resolved" | "dead_end" | "pending",
  "technical_log_refs": [string, ...]      // IDs into technical_log, if any hop was terminal-physical
}
```

### Hop object

```
{
  "hop_index": integer,                    // 1-based position in citation_chain overall — sequential across the whole array, not reset per branch (see parallel_citation)
  "cited_by": string,                      // which prior document/footnote pointed here (free-form)
  "citation_in_previous_verbatim": string | null,  // hop_index > 1 *within its branch*: the reference/citation text exactly as printed in the PREVIOUS hop's document (bibliography entry or footnote). Every hop after the first in a branch is, by Rule 6, explicitly cited; this is null only when that citation could not be extracted verbatim. Always null on a branch's own hop 1 (the Wikipedia footnote text lives in the Claim's citation_footnotes_verbatim) — this is not necessarily array index 0; see parallel_citation.
  "parallel_citation": { "index": integer, "total": integer } | null,  // set only on the first hop of a branch when the sentence has more than one separately-cited source (Rule 6); null on every other hop, including the sole hop of a single-source sentence
  "source": {
    "author": string | [string, ...] | null,
    "title": string,
    "container_work": string | null,       // e.g. edited volume, journal
    "publisher_or_journal": string | null,
    "year": integer | null,
    "pages": string | null,
    "identifier": string | null,           // ISBN, DOI, etc.
    "document_type": string,               // "book" | "journal_article" | "excavation_report_chapter" | "web_page" | "thesis" | "other"
    "retrieval_url": string | null,
    "retrieval_status": "verified_verbatim" | "not_independently_verified" | "unreachable",
    "retrieval_note": string | null,       // the *specific* reason retrieval didn't reach verified_verbatim, whenever one is known — e.g. "unable to retrieve source because copyrighted (Google Books preview only, not the full text)", "paywalled — publisher requires purchase or institutional access", "blocked by an anti-bot / browser-verification challenge", "no retrievable URL could be resolved from this citation's metadata". null only when nothing more specific than the bare status is known. Never guess a reason that wasn't actually observed (Rule 5) — record what's true, or leave it null.
    "retrieved_via_wayback": boolean,      // true when local_cache_path was saved from a Wayback Machine archived snapshot because the live URL failed, rather than from the live URL itself — a real difference in provenance worth surfacing, not just an implementation detail
    "is_public_domain": boolean | null,
    "local_cache_path": string | null      // path under /source-cache/ where the downloaded file was saved; see Local Source Cache section
  },
  "structured_facts": { ... },             // free-form key/value for any extractable facts specific to this hop
  "verbatim_quotes": [string, ...],        // max 3 for copyrighted sources; see Rule 4
  "wikipedia_note_quotes": [string, ...],  // passage(s) a Wikipedia explanatory ("[m]"/"[n]") footnote on the citing sentence quotes from THIS source — an editorial selection made by Wikipedia, not text-mined by the extractor. A lettered note like `Dyson: "…"[25]` is a snippet *from* source [25], not a citation of its own: its quote is attached to that source's hop here, and the note is not added to citation_chain. Same Rule 4 quote cap.
  "is_terminal": boolean,
  "terminal_type": "radiocarbon" | "OSL" | "uranium_thorium" | "argon_argon" | "dendrochronology" | "thermoluminescence" | "comparative" | "genetic_context_dating" | "other_physical" | null
}
```

### Hop role labels (presentation)

`hop_index` is a raw position. When a chain is **displayed** (report viewer,
generated HTML), each hop is shown with a role label derived from its position
*within its own branch* and `is_terminal`, not the bare number. A branch is the
run of hops starting at a `parallel_citation`-marked hop (or array index 0) up
to, but not including, the next `parallel_citation`-marked hop:

| Condition (evaluated within the hop's own branch) | Label |
| --------- | ----- |
| first hop of a branch, `parallel_citation` is `null` (only one source on this sentence), not terminal | `Wikipedia citation` |
| first hop of a branch, `parallel_citation` is `null`, **is** terminal | `Wikipedia citation / Final technical source` |
| first hop of a branch, `parallel_citation` is `{index, total}`, not terminal | `Wikipedia parallel citation {index} of {total}` |
| first hop of a branch, `parallel_citation` is `{index, total}`, **is** terminal | `Wikipedia parallel citation {index} of {total} / Final technical source` |
| the hop with `is_terminal: true` within its branch, when it is not that branch's first hop | `Final technical source` |
| a hop between a branch's first hop and its final technical source | `Intermediate hop N` (N counts only the intermediate hops of that branch, from 1) |
| the last hop of a branch that never reached a terminal (`status` `pending`/`dead_end`) | `Furthest source reached` |

Consequence: the word "hop" only ever appears when a branch has **three or
more** links. One- and two-link branches read as `Wikipedia citation` (or
`Wikipedia parallel citation N of M`) → `Final technical source` (or the
combined label for a one-link branch). "Cites the next source" is only shown
between two hops of the *same* branch — a branch's last hop does not "cite"
the next branch's first hop; they're independent, both cited directly by
Wikipedia.

### Local Source Cache

Every file actually downloaded while tracing a chain (PDF, HTML, etc.) must be saved to disk under:

```
/source-cache/<page-slug>/<hop_source_slug>.<ext>
```

- `<page-slug>` is the Wikipedia page's slug (e.g., `indus-valley-civilisation`).
- `<hop_source_slug>` should be derived from the source's author/year/title so it's recognizable without opening the file (e.g., `kenoyer-1991-urban-process`, `marshall-1931-mohenjo-daro-vol1`).
- The original file extension is preserved (`.pdf`, `.html`, etc.).
- `source.local_cache_path` in the JSON must record this path exactly, so a rescan can check for the file's existence before making any network request.
- Sources that are already-cached from a prior page's run should be reused (same file, same path) rather than re-downloaded — citation chains frequently converge on the same underlying source from different pages (e.g., the same excavation report cited by multiple site articles).
- Web pages fetched only for their text (not downloaded as a file, e.g., a live HTML page read directly) should still have their raw HTML saved to the cache under the same convention, so a rescan doesn't need to re-fetch the network resource at all.

### Shared technical_log file (separate from per-page files, appended across all pages processed)

```
{
  "schema_version": "1.0",
  "entries": [ <TechnicalLogEntry>, ... ]
}
```

### TechnicalLogEntry object

```
{
  "id": string,                            // globally unique, e.g. "T1", "T2", ...
  "source_page": string,                   // originating Wikipedia page title
  "claim_ref": string,                     // claim_id this entry supports
  "site": string | null,
  "project_or_excavation": string | null,
  "years_active": string | null,
  "director_or_lead": [string, ...] | null,
  "publishing_source": string,             // short citation of the paper this was extracted from
  "sample_count": integer | null,
  "sample_material": string | null,
  "method": string,                        // e.g. "radiocarbon (AMS)", "radiocarbon (conventional)", "OSL"
  "calibration_method": string | null,
  "laboratory": string | null,
  "lab_code_prefixes": [string, ...] | null,
  "funding": string | null,
  "earliest_date_reported": string | null,
  "latest_date_reported": string | null,
  "notes": string | null                   // brief, factual, non-evaluative
}
```

---

## Worked example

`indus-valley-civilisation.json` alongside this spec is a real run of the reference implementation over Wikipedia's "Indus Valley Civilisation" page (48 claims). It was produced in local-only mode — no AI — so it is a *mechanical baseline*, not a gold standard: most chains stop at the source the Wikipedia footnote cites (`"status": "pending"`) because, per Rule 6, the extractor will not advance a hop without an explicit onward citation it can locate; a handful of chains dead-end on paywalled sources; two reach a physical dating method by regex heuristic and should be human-checked. Use it to validate your output *shape* against the schema and to see how each field is populated in practice; do not treat its `status` values or terminal classifications as authoritative.

Wikipedia's inline citation numbers are a rendering artefact of the current reference list — adding, removing, merging or reordering references anywhere earlier in the article shifts them. Treat the `[n]` markers as valid only as of `page.retrieved_at`; a later reader may see the same source under a different number.

## Explicit non-goals

- This process does not judge whether a dating claim is correct, contested, or reliable. Fields like `terminal_type` and `structured_facts` are descriptive only.
- This process does not attempt to reproduce entire source documents. It is a citation-tracing and fact-extraction protocol, not an archival mirror.
- This process should not be used to circumvent paywalls or access-restricted sources through unauthorized means. Mark such sources `"retrieval_status": "unreachable"`.
- **This process does not produce presentation artefacts.** The output is the JSON described above and the cached source files. Anything that can be derived mechanically afterwards from those two things — screenshots of a quoted passage or of the Wikipedia sentence, thumbnails, page renders, rebuilt HTML — is the job of a later local step (the viewer, or a build script), not of the extraction, and is not part of this format. The entity constructing the JSON does the reading-and-judgement work only.
