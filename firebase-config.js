// ============================================================
// FILL THIS IN with your own Firebase project's config.
// Get it from: Firebase Console -> Project Settings (gear icon)
// -> General tab -> "Your apps" -> the web app (</>) -> SDK setup
// ============================================================
const firebaseConfig = {
  apiKey: "AIzaSyBw61ZoWh-rFHZxiZGW9k9ctNgClfuvLy0",
  authDomain: "bozo-parlay-2.firebaseapp.com",
  projectId: "bozo-parlay-2",
  storageBucket: "bozo-parlay-2.firebasestorage.app",
  messagingSenderId: "403772002086",
  appId: "1:403772002086:web:da497e2604b66e3e77fbe7",
};
// ============================================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import {
  getFirestore, doc, getDoc, setDoc, onSnapshot,
  collection, getDocs, query,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword,
  createUserWithEmailAndPassword, signOut,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);

// Firebase Auth wants an email format. Nobody needs to know that —
// the UI only ever asks for a name + password.
function nameToEmail(name) {
  return `${name.trim().toLowerCase().replace(/[^a-z0-9]/g, "")}@bozoparlay.local`;
}

function metaRef(name) { return doc(db, "meta", name); }
function weekRef(id) { return doc(db, "weeks", id); }
function claimRef(name) { return doc(db, "claims", name); }
function pickRef(weekId, person) { return doc(db, "weeks", weekId, "picks", person); }
function voteRef(weekId, voter) { return doc(db, "weeks", weekId, "votes", voter); }

window.BozoDB = {
  // ---- meta ----
  async getMeta(name) {
    const snap = await getDoc(metaRef(name));
    return snap.exists() ? snap.data() : null;
  },
  async setMeta(name, data) {
    await setDoc(metaRef(name), data);
  },
  watchMeta(name, cb) {
    return onSnapshot(metaRef(name), (snap) => cb(snap.exists() ? snap.data() : null));
  },

  // ---- week metadata (label, bozo) ----
  async getWeekMeta(id) {
    const snap = await getDoc(weekRef(id));
    return snap.exists() ? snap.data() : null;
  },
  async setWeekMeta(id, data) {
    await setDoc(weekRef(id), data, { merge: true });
  },
  watchWeekMeta(id, cb) {
    return onSnapshot(weekRef(id), (snap) => cb(snap.exists() ? snap.data() : null));
  },

  // ---- picks (subcollection: one doc per person, so rules can enforce ownership) ----
  async setPick(weekId, person, pick) {
    await setDoc(pickRef(weekId, person), pick);
  },
  watchPicks(weekId, cb) {
    return onSnapshot(query(collection(db, "weeks", weekId, "picks")), (snap) => {
      const map = {};
      snap.forEach((d) => (map[d.id] = d.data()));
      cb(map);
    });
  },
  async getPicksOnce(weekId) {
    const snap = await getDocs(query(collection(db, "weeks", weekId, "picks")));
    const map = {};
    snap.forEach((d) => (map[d.id] = d.data()));
    return map;
  },

  // ---- votes (subcollection: one doc per voter) ----
  async setVote(weekId, voter, nominee) {
    await setDoc(voteRef(weekId, voter), { nominee });
  },
  watchVotes(weekId, cb) {
    return onSnapshot(query(collection(db, "weeks", weekId, "votes")), (snap) => {
      const map = {};
      snap.forEach((d) => (map[d.id] = d.data().nominee));
      cb(map);
    });
  },

  // ---- claims: which Firebase account "is" which roster name ----
  async claimName(name, uid) {
    await setDoc(claimRef(name), { uid });
  },
  watchClaims(cb) {
    return onSnapshot(query(collection(db, "claims")), (snap) => {
      const map = {};
      snap.forEach((d) => (map[d.id] = d.data().uid));
      cb(map);
    });
  },

  // ---- auth ----
  async signUp(name, password) {
    const cred = await createUserWithEmailAndPassword(auth, nameToEmail(name), password);
    await window.BozoDB.claimName(name, cred.user.uid);
    return cred.user;
  },
  async logIn(name, password) {
    const cred = await signInWithEmailAndPassword(auth, nameToEmail(name), password);
    return cred.user;
  },
  async logOut() {
    await signOut(auth);
  },
  onAuthChange(cb) {
    return onAuthStateChanged(auth, cb);
  },
};

window.dispatchEvent(new Event("bozo-db-ready"));
