/*
 * firebase-admin.js — Firebase Admin SDK handle: Firestore access that
 * bypasses Security Rules (governed by IAM instead), and ID token
 * verification for the voting feature.
 *
 * Two callers, two credential sources, same module:
 *   - db.js push/delete, run from a trusted machine (this Mac, tank2): a
 *     downloaded service-account key file via GOOGLE_APPLICATION_CREDENTIALS
 *     (see SETUP.md/DEPLOY.md). Never commit that file.
 *   - serve.js itself, verifying a voter's ID token and writing their vote:
 *     on Cloud Run this runs as the service's own attached runtime service
 *     account (see DEPLOY.md) with no key file at all — Application Default
 *     Credentials resolves it automatically via the metadata server.
 * Both paths go through admin.credential.applicationDefault(); which one
 * applies depends only on where the process is running.
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

function getAdminAuth() {
  return getAdminApp().auth();
}

module.exports = { admin, getAdminApp, getAdminDb, getAdminAuth };
