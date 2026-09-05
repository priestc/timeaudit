# CLAUDE.md

## What this repo is

Tools for viewing **Wikipedia Chronology Extraction Protocol** JSON files (see
`SPEC.md`) as HTML.

- `lib/render.js` — shared renderer (JSON → HTML), runs in Node and the browser
- `json-to-html.js` — CLI: convert one JSON file (or a directory) to standalone HTML
- `build.js` — batch-render the whole project to a static `dist/` site + gallery
- `serve.js` + `web/index.html` — the web service: reads chronology JSON documents
  from a directory (default) or from Firestore, and serves a browsable UI that
  renders any of them on the fly
- `db.js` + `lib/firebase.js` + `lib/store.js` — store the raw JSON in a Google
  Cloud (Firestore) database; see `SETUP.md`
- Runtime dependency: `firebase` (only loaded when the database is used). Node 18+.

## Local development

```
npm run serve          # node serve.js --port 8080 --dir .  ->  http://localhost:8080/
npm run build          # -> dist/
node json-to-html.js indus-valley-civilisation.json
```

## Report generator (`timeaudit <url>`)

`timeaudit.js` turns a Wikipedia URL into a SPEC-conforming chronology report.
Full design notes in **`PIPELINE.md`**. Key points:

- **Three-phase analysis; the code implements phases 1 and 2 only.**
  - **Phase 1 — find + classify claims.** MediaWiki fetch, numeric dated-claim
    detection, 1450 CE cutoff, COinS/footnote citation parsing (`lib/wiki.js`).
  - **Phase 2 — fetch the cited sources.** Download + cache the raw text of
    every source the Wikipedia sentence cites, one hop per source, all parallel
    citations attempted (`lib/scholar.js`): direct URL, Wikipedia `archive-url`,
    OA lookups (OpenAlex / Europe PMC / Unpaywall), Wayback Machine fallback.
    `extractText()` writes a `.txt` beside each cached file for phase 3.
  - **Phase 3 — read the sources — NOT IMPLEMENTED YET.** Returns once phase-2
    retrieval is stronger. Until then there is no onward (multi-hop) citation
    chasing, no terminal-method classification, no text-mined quotes; a traced
    claim is `status:"pending"` (source in hand) or `"dead_end"` (every cited
    source unreachable). `scholar.classifyText` / `findOnwardLeads` and the
    `hybrid` mode + `ai.refineClaim` were removed; `is_terminal` /
    `terminal_type` / `structured_facts` / `verbatim_quotes` /
    `citation_in_previous_verbatim` are no longer emitted on hops.
- **Two modes, recorded in `generator.mode`.** `--mode` / aliases `--no-ai` /
  `--local`, `--ai-only`. Default: `local` (`--ai` / `--hybrid` now error).
  - `local` — the local software (`lib/wiki.js` + `lib/scholar.js` +
    `lib/assemble.js`), phases 1-2 as above. No AI.
  - `ai-only` — no local analysis; `lib/ai.js` hands the model just the wiki
    URL + `SPEC.md` link with `web_search`/`web_fetch` and takes back the whole
    report JSON. No `source-cache/`. Needs `ANTHROPIC_API_KEY`.
- **Shared technical log: disabled for now** (returns later). No
  `technical-log.json` is written, `claim.technical_log_refs` stays `[]`,
  `assemble.mergeTechnicalLog()` is dormant, and the viewer's stats page has no
  technical-log tally. `lib/render.js` / `lib/store.js` still know how to render
  an `entries` document if one is dropped in.
- Firestore records carry `generator_mode` / `generator_model`; `db.js list`
  and the web viewer show the mode.
- **Academic material is cached** under `source-cache/<slug>/` (PDF/HTML/XML +
  extracted `.txt`), and the Wikipedia API response under
  `source-cache/_wikipedia/`.
- **Screenshots are NOT in the JSON or the SPEC** — the extractor makes none.
  `lib/shots.js` derives them afterwards from the report + `source-cache/`:
  `pdftotext -bbox-layout` locates each quoted passage (a hop's cached source
  PDF, or the article's Wikimedia PDF render which it fetches on demand),
  `pdftoppm` crops it and the full page. Fixed file names under
  `source-cache/_shots/<slug>/` (`<claim>.wp.png`, `<claim>.h<hop>.q<n>.png`, …)
  so `lib/render.js` builds the `<img>` paths with nothing stored in the JSON.
  `serve.js` generates each shot lazily on first request;
  `json-to-html.js` / `build.js` call `shots.ensureShots()` then inline them as
  `data:` URIs (`lib/inline-assets.js`). `wikipedia_text_verbatim` keeps the
  inline `[n]` markers (that IS an analysis output).
- **Sync to tank2** (`lib/sync.js`, unless `--no-sync`): `rsync`s the report and
  the whole `source-cache/` tree to `tank2:/home/chris/timeaudit/` (host/dir
  overridable via `TIMEAUDIT_TANK2_HOST` / `TIMEAUDIT_TANK2_DIR`). The web
  service and `db.js push` then pick up the new report. `--push` runs
  `db.js push` too.
- `source-cache/` is git-ignored; the generated `<slug>.json` is left in the
  working tree for you to review and commit or discard.
- Set `TIMEAUDIT_CONTACT_EMAIL` in `.env` — the Unpaywall OA lookup roughly
  doubles source-download coverage (OpenAlex + Europe PMC need no key).

## Database (Google Cloud / Firestore)

Mirrors the Roadtripapp approach (`~/Documents/GitHub/Roadtripapp`): Cloud
Firestore via the `firebase` client SDK, configured from env vars in `.env`
(copy `.env.example`; git-ignored). Full walkthrough for creating the cloud
project is in **`SETUP.md`** — that part is a manual Firebase-console step
(needs a Google login + ToS acceptance, can't be scripted).

```
node db.js push            # upload every chronology *.json here into Firestore
node db.js list            # list documents in the DB
node db.js pull <id> [out] # download one document's raw JSON
node db.js delete <id>
```

Collection `chronology_documents`, one document per file, keyed by a filename
slug. The file is stored verbatim in `raw_json`; `title` / `kind` /
`claim_count` / `schema_version` / `updated_at` are derived for listing.

---

## Production deployment (tank2)

The web service runs on the **tank2** server as a **systemd user service** owned by
`chris`. It is reachable on the LAN at:

- <http://tank2.local:8090/>
- <http://192.168.1.190:8090/>

### Layout on tank2

| Path | Purpose |
| --- | --- |
| `/home/chris/timeaudit/` | deployed copy of this repo (rsync target) |
| `~/.config/systemd/user/timeaudit.service` | the unit file |
| — | serves JSON files found under `/home/chris/timeaudit` (the `--dir` arg) |

### The unit file (`~/.config/systemd/user/timeaudit.service`)

```ini
[Unit]
Description=timeaudit chronology JSON viewer
Documentation=file:///home/chris/timeaudit/CLAUDE.md
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/home/chris/timeaudit
ExecStart=/usr/bin/node /home/chris/timeaudit/serve.js --port 8090 --dir /home/chris/timeaudit
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
```

### Why it survives a reboot

Two independent mechanisms, both already in place — **no `sudo` was needed**:

1. **`systemctl --user enable timeaudit.service`** — links the unit into
   `default.target.wants`, so the user's systemd manager starts it automatically.
2. **`loginctl enable-linger chris`** (`Linger=yes`) — makes systemd start
   `chris`'s user manager at boot *without requiring a login session*. Without
   linger, a user service only runs while the user is logged in.

`Restart=on-failure` also brings the process back if `node` crashes at runtime.

Verify after a reboot:

```
ssh tank2 'systemctl --user status timeaudit.service'
ssh tank2 'curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8090/'
```

### First-time deployment steps (already done — for reference / rebuild)

```bash
# 1. copy the working tree to tank2 (run from the repo root on the dev machine)
rsync -az --include 'web/' --include 'web/index.html' \
  --exclude '.git' --exclude 'node_modules' --exclude 'dist' \
  --exclude 'scratchpad' --exclude '*.html' --exclude '.env' \
  ./ tank2:/home/chris/timeaudit/

# 2. install + enable the user service
ssh tank2 'mkdir -p ~/.config/systemd/user'
#   ... write ~/.config/systemd/user/timeaudit.service (contents above) ...
ssh tank2 'loginctl enable-linger chris'
ssh tank2 'systemctl --user daemon-reload'
ssh tank2 'systemctl --user enable --now timeaudit.service'
```

### Redeploying after code changes

```bash
# from the repo root on the dev machine:
rsync -az --include 'web/' --include 'web/index.html' \
  --exclude '.git' --exclude 'node_modules' --exclude 'dist' \
  --exclude 'scratchpad' --exclude '*.html' --exclude '.env' \
  ./ tank2:/home/chris/timeaudit/
ssh tank2 'systemctl --user restart timeaudit.service'
```

If the unit file itself changed, also run
`ssh tank2 'systemctl --user daemon-reload'` before the restart.

### Adding more chronology JSON files

Drop any `*.json` file conforming to `SPEC.md` into `/home/chris/timeaudit/` on
tank2 (or a subdirectory, up to 4 levels deep). The server rescans on every
request — no restart needed. The dev-machine `rsync` above also carries new JSON
files across.

### Managing the service

```bash
ssh tank2 'systemctl --user status  timeaudit.service'
ssh tank2 'systemctl --user restart timeaudit.service'
ssh tank2 'systemctl --user stop    timeaudit.service'
ssh tank2 'journalctl --user -u timeaudit.service -n 50 --no-pager'   # logs
```

### Backing the service with Firestore

By default the tank2 service reads JSON files straight off disk under
`/home/chris/timeaudit/` (the `--dir` arg). To make it serve from the Firestore
database instead:

1. Create the Firebase project and push the data once — see `SETUP.md`.
2. Put the filled-in `.env` on tank2 (it is git-ignored, so `rsync` skips it —
   copy it explicitly), and install the dep there:
   ```bash
   scp .env tank2:/home/chris/timeaudit/.env
   ssh tank2 'cd ~/timeaudit && /usr/bin/npm install --omit=dev'
   ```
   `firebase@^11` is pinned specifically so it runs on tank2's `/usr/bin/node`
   v18 (Roadtripapp's `firebase@12` needs the nvm Node 24 and its `nvm use`
   dance — avoided here on purpose).
3. Point the unit at the Firestore backend — edit
   `~/.config/systemd/user/timeaudit.service` `ExecStart` to:
   ```
   ExecStart=/usr/bin/node /home/chris/timeaudit/serve.js --port 8090 --source firestore
   ```
   then `systemctl --user daemon-reload && systemctl --user restart timeaudit.service`.

`serve.js` also honours `TIMEAUDIT_SOURCE=firestore` from `.env`, so adding that
line and restarting is an alternative to editing `ExecStart`.

Keeping the default (filesystem) backend is fine — the database is then just an
off-machine copy of the raw data that `node db.js push` keeps in sync.

### Notes / gotchas

- **Port 8090** was chosen because 8080 on tank2 is taken by qbittorrent-nox.
  Change it in `ExecStart` (and `daemon-reload` + `restart`) if it ever clashes.
- `node` is at `/usr/bin/node` (v18.19.1, distro package). If Node is upgraded to
  a path-managed install, update `ExecStart`.
- The service has **no auth and no TLS** — it is a read-only LAN tool. Do not
  expose port 8090 to the internet.
- `sudo` on tank2 requires a password; everything here is deliberately
  user-scoped so a deploy never needs it.
