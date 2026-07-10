// ============================================================
// Firebase layer — auth + Firestore, with a demo-mode fallback.
//
// >>> ONE-TIME SETUP <<<
// 1. Go to https://console.firebase.google.com and create a free project.
// 2. Build → Authentication → Sign-in method → enable "Google".
// 3. Build → Firestore Database → Create database (production mode).
// 4. Project settings (gear icon) → Your apps → Web app (</>) → register,
//    then copy the firebaseConfig object and paste it below.
// 5. In Firestore → Rules, paste the contents of firestore.rules.
// 6. Build → App Check → register your web app with the reCAPTCHA v3
//    provider, then paste the site key into RECAPTCHA_SITE_KEY below.
// ============================================================

const firebaseConfig = {
  apiKey: "AIzaSyCxEWaVL0OmX_dJzqQwsfRRlm8yDSUo5qg",
  authDomain: "finance-766b0.firebaseapp.com",
  projectId: "finance-766b0",
  storageBucket: "finance-766b0.firebasestorage.app",
  messagingSenderId: "385123316925",
  appId: "1:385123316925:web:91b1fe7d0d007b2c73f3d4",
  measurementId: "G-Z3CB3PH7JD",
};

// App Check: proves requests come from your real deployed app, not a
// copy of this public code running elsewhere. Get this key from
// Firebase console → Build → App Check → your web app → reCAPTCHA v3.
const RECAPTCHA_SITE_KEY = "6LfZLEwtAAAAAHBarXTsHwaNGkCXr-v5qe3U5YS1";

export const isConfigured = !firebaseConfig.apiKey.startsWith("PASTE_");
export const isDemo = new URLSearchParams(location.search).has("demo");

// ---------- Demo mode (in-memory only, nothing saved) ----------
function demoBackend() {
  const today = new Date();
  const d = (offset) => {
    const dt = new Date(today);
    dt.setDate(dt.getDate() - offset);
    return dt.toISOString().slice(0, 10);
  };
  let txs = [
    { id: "d1", date: d(0), vendor: "Tim Hortons", category: "Dining", type: "expense", cardType: "debit", cents: 745, note: "" },
    { id: "d2", date: d(1), vendor: "Loblaws", category: "Groceries", type: "expense", cardType: "debit", cents: 8632, note: "weekly groceries" },
    { id: "d3", date: d(2), vendor: "Presto", category: "Transport", type: "expense", cardType: "debit", cents: 4000, note: "transit top-up" },
    { id: "d4", date: d(3), vendor: "Netflix", category: "Entertainment", type: "expense", cardType: "credit", cents: 1899, note: "" },
    { id: "d5", date: d(5), vendor: "Payroll Deposit", category: "Other", type: "income", cardType: "debit", cents: 185000, note: "bi-weekly pay" },
    { id: "d6", date: d(6), vendor: "Uber Eats", category: "Dining", type: "expense", cardType: "credit", cents: 3240, note: "" },
    { id: "d7", date: d(9), vendor: "Shoppers Drug Mart", category: "Health", type: "expense", cardType: "debit", cents: 2310, note: "" },
    { id: "d8", date: d(12), vendor: "Amazon.ca", category: "Shopping", type: "expense", cardType: "credit", cents: 5687, note: "" },
    { id: "d9", date: d(34), vendor: "Bell Canada", category: "Bills", type: "expense", cardType: "debit", cents: 9500, note: "internet" },
    { id: "d10", date: d(36), vendor: "Loblaws", category: "Groceries", type: "expense", cardType: "debit", cents: 10420, note: "" },
    { id: "d11", date: d(38), vendor: "Cineplex", category: "Entertainment", type: "expense", cardType: "credit", cents: 2850, note: "" },
    { id: "d12", date: d(65), vendor: "Canadian Tire", category: "Shopping", type: "expense", cardType: "credit", cents: 7823, note: "" },
    { id: "d13", date: d(68), vendor: "Petro-Canada", category: "Transport", type: "expense", cardType: "debit", cents: 6200, note: "gas" },
    { id: "d14", date: d(95), vendor: "Rogers", category: "Bills", type: "expense", cardType: "debit", cents: 6500, note: "phone" },
  ];
  let settings = { debitBalanceCents: 234580, debitBalanceAsOf: d(200), limitCents: 500000, usedCents: 89060, usedAsOf: d(200) };
  let txCb = null, settingsCb = null;
  let nextId = 100;
  const emitTx = () => txCb && txCb([...txs]);
  const emitSettings = () => settingsCb && settingsCb({ ...settings });

  return {
    demo: true,
    onAuth(cb) {
      cb({ uid: "demo", displayName: "Demo User", email: "demo@example.com", photoURL: "" });
    },
    async signIn() {},
    async signOut() { location.href = location.pathname; },
    subscribeTransactions(cb) { txCb = cb; emitTx(); return () => (txCb = null); },
    subscribeSettings(cb) { settingsCb = cb; emitSettings(); return () => (settingsCb = null); },
    async addTransaction(tx) { txs.push({ ...tx, id: "demo-" + nextId++ }); emitTx(); },
    async addTransactions(list) { for (const tx of list) txs.push({ ...tx, id: "demo-" + nextId++ }); emitTx(); },
    async updateTransaction(id, patch) {
      txs = txs.map((t) => (t.id === id ? { ...t, ...patch } : t));
      emitTx();
    },
    async deleteTransaction(id) { txs = txs.filter((t) => t.id !== id); emitTx(); },
    async saveSettings(patch) { settings = { ...settings, ...patch }; emitSettings(); },
  };
}

// ---------- Real Firebase backend ----------
async function firebaseBackend() {
  const { initializeApp } = await import(
    "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js"
  );
  const {
    getAuth, onAuthStateChanged, signInWithPopup, signInWithRedirect,
    GoogleAuthProvider, signOut: fbSignOut,
  } = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js");
  const {
    initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
    collection, doc, onSnapshot, addDoc, updateDoc, deleteDoc, setDoc,
    writeBatch, query, orderBy,
  } = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js");

  const app = initializeApp(firebaseConfig);

  if (!RECAPTCHA_SITE_KEY.startsWith("PASTE_")) {
    const { initializeAppCheck, ReCaptchaV3Provider } = await import(
      "https://www.gstatic.com/firebasejs/10.12.2/firebase-app-check.js"
    );
    // Lets you test locally before enforcement is turned on in the console:
    // https://firebase.google.com/docs/app-check/web/debug-provider
    if (location.hostname === "localhost") {
      self.FIREBASE_APPCHECK_DEBUG_TOKEN = true;
    }
    initializeAppCheck(app, {
      provider: new ReCaptchaV3Provider(RECAPTCHA_SITE_KEY),
      isTokenAutoRefreshEnabled: true,
    });
  }

  const auth = getAuth(app);
  // Offline cache: keeps working without internet, syncs when back online.
  const db = initializeFirestore(app, {
    localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
  });
  const provider = new GoogleAuthProvider();

  let uid = null;
  const txCol = () => collection(db, "users", uid, "transactions");
  const settingsDoc = () => doc(db, "users", uid, "settings", "profile");

  return {
    demo: false,
    onAuth(cb) {
      onAuthStateChanged(auth, (user) => {
        uid = user ? user.uid : null;
        cb(user);
      });
    },
    async signIn() {
      try {
        await signInWithPopup(auth, provider);
      } catch (e) {
        // Popup blockers / some mobile browsers: fall back to redirect.
        if (e.code === "auth/popup-blocked" || e.code === "auth/operation-not-supported-in-this-environment") {
          await signInWithRedirect(auth, provider);
        } else if (e.code !== "auth/popup-closed-by-user" && e.code !== "auth/cancelled-popup-request") {
          throw e;
        }
      }
    },
    async signOut() { await fbSignOut(auth); },
    subscribeTransactions(cb) {
      const q = query(txCol(), orderBy("date", "desc"));
      return onSnapshot(q, (snap) => {
        cb(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
      });
    },
    subscribeSettings(cb) {
      return onSnapshot(settingsDoc(), (snap) => {
        cb(snap.exists() ? snap.data() : null);
      });
    },
    async addTransaction(tx) { await addDoc(txCol(), tx); },
    async addTransactions(list) {
      // Firestore batches max 500 writes.
      for (let i = 0; i < list.length; i += 450) {
        const batch = writeBatch(db);
        for (const tx of list.slice(i, i + 450)) batch.set(doc(txCol()), tx);
        await batch.commit();
      }
    },
    async updateTransaction(id, patch) {
      await updateDoc(doc(db, "users", uid, "transactions", id), patch);
    },
    async deleteTransaction(id) {
      await deleteDoc(doc(db, "users", uid, "transactions", id));
    },
    async saveSettings(patch) {
      await setDoc(settingsDoc(), patch, { merge: true });
    },
  };
}

export async function createBackend() {
  if (isDemo || !isConfigured) return demoBackend();
  return firebaseBackend();
}
