# Public deployment (Cloud Run, free tier)

This puts a **read-only** copy of the viewer on the public internet, backed by
the same Firestore data tank2 uses. The extraction pipeline (adding/re-analyzing
articles) stays private — it never runs on the public instance. See "What
changes in public mode" below for exactly what that disables.

Cloud Run is used because this project already lives on Firebase/Firestore —
same project, same console, no new account. It scales to zero (no cost while
idle) and its free tier (2M requests/month, 360k GiB-seconds, 180k vCPU-seconds)
comfortably covers a low-traffic public site. **Caveat:** Cloud Run requires the
project to be on the Blaze (pay-as-you-go) plan — usage inside the free tier
still costs $0, but you must attach a billing account. Step 4 sets a budget
alert so you'd know immediately if that ever changed.

## 1. Lock down Firestore (do this first)

The project has been running on Firestore's open **test-mode** rules (anyone
with the config can read *and write*). Before anything is public-facing, switch
to read-only:

Firebase console → **Firestore Database → Rules** → paste the contents of
[`firestore.rules`](./firestore.rules) → **Publish**.

(Or, with the Firebase CLI installed and `firebase login` + `firebase use
<project-id>` run once: `firebase deploy --only firestore:rules`.)

This breaks `node db.js push`/`delete` under the plain client SDK — that's
expected, see step 2.

## 2. Give `db.js push`/`delete` a service account (Admin SDK)

Locking down the rules means only the **Firebase Admin SDK**, authenticated
with a service account, can still write. `db.js` already uses it (via
`lib/store-admin.js`) for `push`/`delete`; `list`/`pull` are unaffected (they
only read, which stays open).

1. Firebase console → gear icon → **Project settings → Service accounts →
   Generate new private key**. Downloads a JSON file.
2. Save it **outside the repo** — e.g. `~/.config/timeaudit/service-account.json`
   — never inside this directory. (`.gitignore` also blocks the common
   filename patterns as a backstop, but "outside the repo" is the real safety
   margin.)
3. Add one line to your `.env` (this machine only — never deployed anywhere):
   ```
   GOOGLE_APPLICATION_CREDENTIALS=/Users/you/.config/timeaudit/service-account.json
   ```
4. Confirm: `node db.js push` should still work exactly as before.

## 3. Install the Google Cloud CLI, if you don't have it

```
! brew install --cask google-cloud-sdk
! gcloud init                 # pick/create the project, sign in interactively
! gcloud auth login
```
(`gcloud init` will show the same project this repo's Firestore is already in
— pick it, don't create a new one.)

## 4. Attach billing + set a $0 budget alert

Cloud Run needs the Blaze plan attached even though your usage will sit inside
the free tier. Attach it, then immediately set a guardrail:

1. [console.cloud.google.com/billing](https://console.cloud.google.com/billing)
   → link a billing account to the project (upgrades Firebase Spark → Blaze).
2. **Billing → Budgets & alerts → Create budget** → scope to this project,
   amount **$1**, alert thresholds 50%/90%/100%. You'll get an email long
   before anything is ever actually charged.

**A budget alert only emails you — it does not stop billing or shut anything
off.** There is no built-in "hard cap" on Cloud Run/Firestore spend. If you
want an actual kill switch, the standard pattern is a budget → Pub/Sub topic →
small Cloud Function that either sets `--max-instances 0` on the service or
disables billing on the whole project; not set up here since section 7's
numbers suggest it isn't needed for this app.

## 5. Deploy

From the repo root (`--source .` builds the `Dockerfile` via Cloud Build — no
local Docker install needed):

```
! gcloud run deploy timeaudit \
    --source . \
    --region us-central1 \
    --allow-unauthenticated \
    --min-instances 0 \
    --max-instances 20 \
    --set-env-vars FIREBASE_API_KEY=<...>,FIREBASE_AUTH_DOMAIN=<...>.firebaseapp.com,FIREBASE_PROJECT_ID=<...>,FIREBASE_STORAGE_BUCKET=<...>.appspot.com,FIREBASE_MESSAGING_SENDER_ID=<...>,FIREBASE_APP_ID=<...>
```

`--max-instances 20` caps the worst case: past that many concurrent
containers (each handling up to 80 requests at once by default — 1,600
requests in flight) Cloud Run queues or sheds excess requests instead of
scaling further. That bounds a traffic spike's cost instead of letting it
scale unboundedly; raise it later if 20 genuinely isn't enough.

Pull those six values straight from `.env` (same `FIREBASE_*` values `serve.js`
already uses locally — they're the public web-app config, not secrets; access
control is the Firestore rules from step 1, not these values). `gcloud` prints
a `*.run.app` URL when it finishes — that's the public site.

To redeploy after code changes, re-run the same command.

## 6. (Optional) custom domain / nicer URL

```
! firebase init hosting        # choose "Set up as single-page app" = No
```
Set `firebase.json`'s `hosting.rewrites` to send all traffic to the Cloud Run
service (`{"source": "**", "run": {"serviceId": "timeaudit", "region":
"us-central1"}}`), then `firebase deploy --only hosting`. Free `*.web.app` /
`*.firebaseapp.com` URL and HTTPS, or attach your own domain in the Hosting
console.

## 7. Cost, and holding up to a traffic spike

Every GET page response in public mode carries
`Cache-Control: public, max-age=60, s-maxage=300, stale-while-revalidate=600`
(see `serve.js`'s `PAGE_CACHE`) instead of the admin instance's `no-store` —
this is what actually determines whether a spike is cheap. Cloud Run alone
gives you *more compute*, not a cache; a CDN in front of it (step 6's Firebase
Hosting rewrite, or Cloud CDN) is what lets the *second* visitor to a
trending article be served straight from Google's edge, never touching the
container or Firestore at all. Do step 6 before counting on this holding up —
without a CDN in front, every single request reaches Cloud Run.

Rough numbers for this app's shape (small SSR pages, no big downloads —
screenshots are absent, see the known limitation below), current published
pricing, **fronted by a CDN**:
- Cloud Run: request count, vCPU-seconds, and memory all stay inside the free
  tier until roughly 2M requests/month; a single-day spike of even a few
  hundred thousand requests barely registers.
- Firestore: only cache-miss requests reach it. With the CDN edge absorbing
  repeat hits on the same trending URL, a large spike (hundreds of thousands
  of views) still means at most a few thousand *distinct* first-hits reaching
  Firestore — a few dollars at most, likely under $1.
- **Ballpark for a genuine "slashdotting" (100K-1M requests in a burst) with
  the CDN in place: under $5, plausibly under $1.** Without the CDN (step 6
  skipped), every request is a live Cloud Run + Firestore round trip — still
  likely single digits to low tens of dollars for that volume given how small
  each page is, but meaningfully more, and closer to the `--max-instances`
  ceiling.

This assumes the admin endpoints stay disabled (they do, by default, in
`PUBLIC` mode) — those are the ones that would actually be expensive/dangerous
if reachable, since they spawn a full extraction run per request.

Compare to the road not taken: Render's free tier can't produce a surprise
bill (it's free with a hard resource ceiling), but a real slashdotting would
just make it slow or drop requests rather than scale. Cloud Run trades that
ceiling for elasticity — bounded here by `--max-instances` and cushioned by
the CDN — at a cost of low single-digit dollars in the worst realistic case.

## What changes in public mode

`TIMEAUDIT_PUBLIC=1` (set by the `Dockerfile`) turns off everything that would
let an anonymous internet visitor make the server do outbound work or write
data — a public host has no auth in front of it:

| Disabled | Why |
| --- | --- |
| "Add a Wikipedia article" form / `/api/analyze` | spawns the full `timeaudit.js` pipeline: live Wikipedia + academic-source fetches, disk writes, a Firestore push |
| "Re-analyze" button / `/api/reanalyze` | same |
| "Claim finder" page | runs a live fetch against whatever URL a visitor supplies |

Everything else — browsing articles, claims, statistics, document sources,
unreachable/radiocarbon lists, raw JSON, downloads — works exactly as on
tank2, just read-only and served from Firestore.

## Known limitation: no screenshots

Quote/claim screenshots (`lib/shots.js`) are cropped on demand from the cached
source PDFs under `source-cache/`, which lives only on tank2's disk — it isn't
pushed to Firestore and isn't in the container. On the public site those
`<img>` tags fail to load and quietly disappear (there's already an `onerror`
handler for this) rather than breaking the page. Bringing screenshots to the
public site would mean syncing `source-cache/` to a Cloud Storage bucket and
teaching `lib/shots.js` to read from there — not done here.
