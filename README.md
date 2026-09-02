# timeaudit viewer

Tools for viewing the **Wikipedia Chronology Extraction Protocol** JSON files
described in [`SPEC.md`](./SPEC.md) as HTML.

Two shapes of document are recognised:

- a per-page file — `{ schema_version, page, claims: [...] }`
- the shared technical log — `{ schema_version, entries: [...] }`

Node 18+. The only dependency (`firebase`) is used just for the optional
database; the viewer and converters work without it.

**To generate a report from a Wikipedia URL**, see
[`PIPELINE.md`](./PIPELINE.md):

```
node timeaudit.js https://en.wikipedia.org/wiki/Ancient_Egypt
```

## 1. Web UI — browse every JSON in the project

```
npm run serve          # or: node serve.js --port 8080 --dir .
```

Open <http://localhost:8080/>. The server scans the given directory (default:
current dir) for chronology JSON files and lists them in a sidebar. Pick one to
see it rendered; toggle **Raw JSON**; **Download HTML** saves a standalone file.

## 2. `json-to-html.js` — convert one JSON file to a standalone HTML file

```
node json-to-html.js indus-valley-civilisation.json
# -> indus-valley-civilisation.html   (self-contained, styles inlined)

node json-to-html.js data.json out.html      # explicit output path
node json-to-html.js data.json --stdout      # write to stdout
node json-to-html.js ./some-dir --out ./html # batch: every *.json in a dir
```

## 3. `build.js` — render the whole project to a static site

```
npm run build          # or: node build.js [srcDir] [outDir]
```

Writes `dist/`: one HTML page per document plus `dist/index.html`, a gallery.
Serve `dist/` with any static file server.

## 4. `db.js` — store the raw JSON in a Google Cloud (Firestore) database

One-time cloud setup is in [`SETUP.md`](./SETUP.md). Then:

```
node db.js push            # upload every chronology *.json here into Firestore
node db.js list            # list documents in the DB
node db.js pull <id> [out] # download one document's raw JSON
node db.js delete <id>

node serve.js --source firestore   # serve the web UI from the DB instead of disk
```

## Layout

| File            | Role                                                        |
| --------------- | ---------------------------------------------------------- |
| `timeaudit.js`  | generate a report from a Wikipedia URL (see `PIPELINE.md`)  |
| `lib/wiki.js`   | fetch page, extract dated claims, apply cutoff, parse citations |
| `lib/scholar.js`| resolve/download/cache sources, classify dating method, multi-hop |
| `lib/assemble.js` | shape the SPEC JSON + shared technical log                |
| `lib/ai.js`     | optional one-call-per-claim AI gap-filler                   |
| `lib/sync.js`   | copy report + source cache to the tank2 folder              |
| `lib/render.js` | shared renderer (JSON → HTML); runs in Node and the browser |
| `lib/firebase.js` / `lib/store.js` | Firestore handle + document read/write   |
| `lib/env.js`    | minimal `.env` loader (Node 18 has no `--env-file`)         |
| `json-to-html.js` | CLI: single file / directory → standalone HTML           |
| `build.js`      | batch build + gallery into `dist/`                          |
| `serve.js`      | web service backing the browse UI (filesystem or Firestore) |
| `db.js`         | sync JSON files ⇄ Firestore                                 |
| `web/index.html`| the browse UI                                               |

Deployment to the **tank2** server (systemd, auto-start on boot) is documented in
[`CLAUDE.md`](./CLAUDE.md).
