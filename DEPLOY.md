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

## 5. Deploy

From the repo root (`--source .` builds the `Dockerfile` via Cloud Build — no
local Docker install needed):

```
! gcloud run deploy timeaudit \
    --source . \
    --region us-central1 \
    --allow-unauthenticated \
    --min-instances 0 \
    --set-env-vars FIREBASE_API_KEY=<...>,FIREBASE_AUTH_DOMAIN=<...>.firebaseapp.com,FIREBASE_PROJECT_ID=<...>,FIREBASE_STORAGE_BUCKET=<...>.appspot.com,FIREBASE_MESSAGING_SENDER_ID=<...>,FIREBASE_APP_ID=<...>
```

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
