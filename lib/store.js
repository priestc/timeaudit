/*
 * store.js — read/write chronology JSON documents in Firestore.
 *
 * Each source .json file becomes one Firestore document in the
 * `chronology_documents` collection:
 *
 *   {
 *     doc_id:        "<slug of filename>"   (also the Firestore document id)
 *     source_file:   "indus-valley-civilisation.json"
 *     title:         "Indus Valley Civilisation"
 *     kind:          "page" | "technical log"
 *     schema_version:"1.0"
 *     claim_count:   2          // pages only
 *     entry_count:   0          // technical logs only
 *     raw_json:      "<the exact file contents, verbatim>"   <- the raw data
 *     updated_at:    <server timestamp>
 *   }
 *
 * raw_json is the canonical, lossless copy of the file. The other fields are
 * derived from it for listing and future querying.
 */
"use strict";

const {
  doc,
  getDoc,
  getDocs,
  setDoc,
  deleteDoc,
  collection,
  serverTimestamp,
} = require("firebase/firestore");
const { getDb, collectionName } = require("./firebase");
const { slug } = require("./render");

function summarize(data) {
  if (data && Array.isArray(data.entries)) {
    return {
      kind: "technical log",
      title: "Shared Technical Log",
      entry_count: data.entries.length,
      claim_count: 0,
    };
  }
  const claims = (data && data.claims) || [];
  return {
    kind: "page",
    title: (data && data.page && data.page.title) || "Untitled",
    claim_count: claims.length,
    entry_count: 0,
  };
}

/** Build the Firestore record for a file's contents. `rawText` is verbatim. */
function toRecord(sourceFile, rawText) {
  const data = JSON.parse(rawText);
  const s = summarize(data);
  return {
    doc_id: slug(sourceFile.replace(/\.json$/i, "")),
    source_file: sourceFile,
    title: s.title,
    kind: s.kind,
    schema_version: data.schema_version || null,
    generator_mode: (data.generator && data.generator.mode) || null,
    generator_model: (data.generator && data.generator.ai_model) || null,
    claim_count: s.claim_count,
    entry_count: s.entry_count,
    raw_json: rawText,
  };
}

async function putDocument(record) {
  const ref = doc(getDb(), collectionName(), record.doc_id);
  await setDoc(ref, Object.assign({}, record, { updated_at: serverTimestamp() }));
  return record.doc_id;
}

async function listDocuments() {
  const snap = await getDocs(collection(getDb(), collectionName()));
  return snap.docs
    .map((d) => {
      const v = d.data();
      return {
        id: d.id,
        source_file: v.source_file || d.id + ".json",
        title: v.title || d.id,
        kind: v.kind || "page",
        generator_mode: v.generator_mode || null,
        claim_count: v.claim_count || 0,
        entry_count: v.entry_count || 0,
      };
    })
    .sort((a, b) => a.title.localeCompare(b.title));
}

async function getDocument(id) {
  const ref = doc(getDb(), collectionName(), id);
  const snap = await getDoc(ref);
  if (!snap.exists()) return null;
  return snap.data();
}

async function deleteDocument(id) {
  await deleteDoc(doc(getDb(), collectionName(), id));
}

module.exports = {
  toRecord,
  putDocument,
  listDocuments,
  getDocument,
  deleteDocument,
  summarize,
};
