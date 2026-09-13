/*
 * votes.js — upvote/downvote storage for claims.
 *
 * Two collections, both written ONLY by this module (server-side, via the
 * Admin SDK) — never touched by the browser's own Firestore access, so no
 * client-writable Security Rule for them is needed at all; Firestore's
 * default-deny handles it. The browser only ever calls serve.js's
 * /api/vote and /api/my-votes, which verify the caller's ID token first.
 *
 *   claim_votes/{claimKey}                  { up, down }           — aggregate
 *   claim_votes/{claimKey}/voters/{uid}      { value, updated_at }  — one vote/user
 *
 * claimKey identifies a claim across the whole corpus: `${docId}::${claimId}`
 * (see claimKey() in serve.js — kept in one place so server + client agree).
 */
"use strict";

const { admin, getAdminDb } = require("./firebase-admin");

const VALID_VALUES = new Set([1, -1, 0]);

/** Cast (or change, or retract with value 0) one user's vote on one claim. */
async function castVote(claimKey, uid, value) {
  if (!claimKey || !uid) throw new Error("claimKey and uid are required");
  if (!VALID_VALUES.has(value)) throw new Error("value must be 1, -1, or 0");
  const db = getAdminDb();
  const aggRef = db.collection("claim_votes").doc(claimKey);
  const voterRef = aggRef.collection("voters").doc(uid);
  return db.runTransaction(async (tx) => {
    const [aggSnap, voterSnap] = await Promise.all([tx.get(aggRef), tx.get(voterRef)]);
    const agg = { up: 0, down: 0, ...(aggSnap.exists ? aggSnap.data() : {}) };
    const prev = voterSnap.exists ? voterSnap.data().value : 0;
    if (prev === 1) agg.up -= 1;
    if (prev === -1) agg.down -= 1;
    if (value === 1) agg.up += 1;
    if (value === -1) agg.down += 1;
    agg.up = Math.max(0, agg.up);
    agg.down = Math.max(0, agg.down);
    tx.set(aggRef, agg, { merge: true });
    if (value === 0) tx.delete(voterRef);
    else tx.set(voterRef, { value, updated_at: admin.firestore.FieldValue.serverTimestamp() });
    return agg;
  });
}

/** Batch-read aggregate counts for a page's worth of claims in one round trip. */
async function getVoteCounts(claimKeys) {
  const out = {};
  if (!claimKeys.length) return out;
  const db = getAdminDb();
  const refs = claimKeys.map((k) => db.collection("claim_votes").doc(k));
  const snaps = await db.getAll(...refs);
  snaps.forEach((snap, i) => {
    out[claimKeys[i]] = snap.exists ? { up: snap.get("up") || 0, down: snap.get("down") || 0 } : { up: 0, down: 0 };
  });
  return out;
}

/** Batch-read one signed-in user's own votes for a page's worth of claims. */
async function getUserVotes(claimKeys, uid) {
  const out = {};
  if (!claimKeys.length || !uid) return out;
  const db = getAdminDb();
  const refs = claimKeys.map((k) => db.collection("claim_votes").doc(k).collection("voters").doc(uid));
  const snaps = await db.getAll(...refs);
  snaps.forEach((snap, i) => {
    if (snap.exists) out[claimKeys[i]] = snap.get("value");
  });
  return out;
}

module.exports = { castVote, getVoteCounts, getUserVotes };
