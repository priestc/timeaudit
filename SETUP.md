# Database setup (Google Cloud / Firebase Firestore)

The raw contents of every chronology JSON file (see `SPEC.md`) can be stored in
**Cloud Firestore**, a Google Cloud database. This is the same mechanism the
Roadtripapp uses (`~/Documents/GitHub/Roadtripapp` — Firestore via the `firebase`
client SDK, configured from environment variables).

Creating the cloud project is a one-time manual step in the Firebase console —
it needs your Google login and a ToS acceptance, so it can't be scripted here.
After that, everything is CLI.

---

## 1. Create a Firebase project

1. Go to the [Firebase console](https://console.firebase.google.com/) and click
   **Add project**.
2. Name it (e.g. `timeaudit`). Google Analytics is optional and not needed.

A Firebase project *is* a Google Cloud project — it shows up at
<https://console.cloud.google.com/> under the same name/ID.

## 2. Create the Firestore database

1. In the Firebase console: **Build → Firestore Database → Create database**.
2. Pick a location (any; it can't be changed later).
3. Start in **test mode**. Test mode allows open read/write, which is fine for a
   read-only LAN tool. See "Locking it down" below before exposing it anywhere.

## 3. Register a web app and get the config

1. **Project settings** (gear icon) → **Your apps** → click the web icon
   (`</>`). Any nickname; no Hosting needed.
2. Firebase shows a `firebaseConfig` object. Keep it open for the next step.

## 4. Configure this project's environment

```bash
cp .env.example .env
```

Fill in `.env` from the `firebaseConfig` object:

| `.env` variable                | `firebaseConfig` key |
| ------------------------------ | -------------------- |
| `FIREBASE_API_KEY`             | `apiKey`             |
| `FIREBASE_AUTH_DOMAIN`         | `authDomain`         |
| `FIREBASE_PROJECT_ID`          | `projectId`          |
| `FIREBASE_STORAGE_BUCKET`      | `storageBucket`      |
| `FIREBASE_MESSAGING_SENDER_ID` | `messagingSenderId`  |
| `FIREBASE_APP_ID`              | `appId`              |

(Roadtripapp's `.env.local` uses the same values with a `NEXT_PUBLIC_` prefix —
that prefix is a Next.js requirement and is not used here.)

`.env` is git-ignored.

## 5. Install dependencies and push the data

```bash
npm install
node db.js push            # upload every chronology *.json in this directory
node db.js list            # confirm what's now in Firestore
```

Each file becomes one document in the `chronology_documents` collection, keyed by
a slug of its filename. The document stores the file verbatim in a `raw_json`
field plus derived fields (`title`, `kind`, `claim_count`, `schema_version`,
`updated_at`) for listing. You can see them in the Firebase console under
**Firestore Database → Data**.

### db.js commands

```
node db.js push [dir]        upload every *.json under dir (default: .)
node db.js list              list the documents in Firestore
node db.js pull <id> [out]   write one document's raw JSON back to a file
                             (out "-" = stdout)
node db.js delete <id>       remove one document
```

`push` is idempotent — re-running it overwrites each document with the current
file contents.

## 6. (Optional) Serve the web UI from Firestore instead of disk

By default `serve.js` reads JSON files from a directory. To make it read from
Firestore instead:

```bash
node serve.js --source firestore --port 8090
# or set TIMEAUDIT_SOURCE=firestore in .env
```

The browse UI is unchanged; `/api/files` and `/api/file` just get their data
from the database.

To switch the **tank2 deployment** over, see `CLAUDE.md` → "Backing the service
with Firestore".

---

## Locking it down (before exposing beyond the LAN)

Test-mode rules expire and allow anyone with the config to read/write. For a
public deployment, publish [`firestore.rules`](./firestore.rules) (read-only)
and switch `db.js push`/`delete` to the Firebase Admin SDK — see
[`DEPLOY.md`](./DEPLOY.md), which is the full walkthrough for deploying a
public, read-only instance to Cloud Run. For the current LAN-only tank2 use,
test mode is adequate and nothing here needs to change.
