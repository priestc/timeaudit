/*
 * firebase-admin.js — Firestore handle for WRITE operations (db.js push /
 * delete) using the Firebase Admin SDK, which authenticates with a service
 * account and bypasses Firestore Security Rules entirely.
 *
 * This is deliberately separate from lib/firebase.js (the client SDK used by
 * serve.js and read-only db.js commands). Once Security Rules are locked down
 * to `allow read: if true; allow write: if false;` (see SETUP.md — required
 * before a public deploy), the client SDK can no longer write, so pushing
 * data has to go through here instead, from a trusted machine only.
 *
 * Credentials: standard Application Default Credentials resolution —
 *   - GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json, or
 *   - `gcloud auth application-default login` (local dev), or
 *   - the metadata server (automatic when running ON Google Cloud, e.g. a
 *     Cloud Run job or a GCE/tank2-style VM with a service account attached).
 * Never commit a service-account key file — keep it outside the repo or make
 * sure its filename matches the .gitignore patterns added for this.
 */
"use strict";

const admin = require("firebase-admin");

let app;
function getAdminApp() {
  if (!app) {
    if (admin.apps.length) {
      app = admin.app();
    } else {
      try {
        app = admin.initializeApp({
          credential: admin.credential.applicationDefault(),
          projectId: process.env.FIREBASE_PROJECT_ID,
        });
      } catch (e) {
        throw new Error(
          "Could not load Google Application Default Credentials for the Admin SDK. " +
            "Set GOOGLE_APPLICATION_CREDENTIALS to a service-account key file, or run " +
            "`gcloud auth application-default login`. See SETUP.md. (" + e.message + ")"
        );
      }
    }
  }
  return app;
}

function getAdminDb() {
  return getAdminApp().firestore();
}

module.exports = { admin, getAdminApp, getAdminDb };
