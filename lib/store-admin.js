/*
 * store-admin.js — the WRITE half of store.js, via the Firebase Admin SDK.
 *
 * Used only by `db.js push` / `db.js delete`, which must keep working once
 * Firestore Security Rules deny client-SDK writes (required before a public
 * deploy — see SETUP.md "Locking it down"). Reads (`db.js list` / `pull`,
 * and serve.js) stay on the ordinary client SDK in store.js, unauthenticated,
 * governed by the `allow read: if true` rule.
 */
"use strict";

const { admin, getAdminDb } = require("./firebase-admin");
const { collectionName } = require("./firebase");

async function putDocument(record) {
  const db = getAdminDb();
  await db
    .collection(collectionName())
    .doc(record.doc_id)
    .set(Object.assign({}, record, { updated_at: admin.firestore.FieldValue.serverTimestamp() }));
  return record.doc_id;
}

async function deleteDocument(id) {
  await getAdminDb().collection(collectionName()).doc(id).delete();
}

module.exports = { putDocument, deleteDocument };
