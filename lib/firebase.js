/*
 * firebase.js — lazy Firestore handle, mirroring the Roadtripapp pattern
 * (~/Documents/GitHub/Roadtripapp/src/lib/firebase.ts).
 *
 * Config comes from environment variables (see .env.example / SETUP.md). It is
 * read lazily so that scripts which never touch the database still run with no
 * credentials configured.
 */
"use strict";

const { initializeApp, getApps, getApp } = require("firebase/app");
const { getFirestore } = require("firebase/firestore");

function firebaseConfig() {
  return {
    apiKey: process.env.FIREBASE_API_KEY,
    authDomain: process.env.FIREBASE_AUTH_DOMAIN,
    projectId: process.env.FIREBASE_PROJECT_ID,
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
    messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
    appId: process.env.FIREBASE_APP_ID,
  };
}

/** Firestore collection the chronology documents live in. */
function collectionName() {
  return process.env.FIRESTORE_COLLECTION || "chronology_documents";
}

let app;
let db;

function getFirebaseApp() {
  if (!app) {
    const cfg = firebaseConfig();
    if (!cfg.projectId || !cfg.apiKey) {
      throw new Error(
        "Firebase is not configured. Set FIREBASE_* variables in a .env file " +
          "(copy .env.example) — see SETUP.md for how to create the project."
      );
    }
    app = getApps().length ? getApp() : initializeApp(cfg);
  }
  return app;
}

function getDb() {
  if (!db) db = getFirestore(getFirebaseApp());
  return db;
}

function isConfigured() {
  const cfg = firebaseConfig();
  return Boolean(cfg.projectId && cfg.apiKey);
}

module.exports = { getDb, firebaseConfig, collectionName, isConfigured };
