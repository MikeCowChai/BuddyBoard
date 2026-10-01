/* ============================================================
   cloud.js — Firebase sign-in + start-up of the shared database
   Cloud.ready resolves once someone is signed in and all data has been
   loaded; app.js waits for it before rendering anything.
   ============================================================ */
const Cloud = (() => {
  const cfg = window.FIREBASE_CONFIG || {};
  let auth = null;
  let resolveReady;
  const ready = new Promise(r => { resolveReady = r; });

  const gate = () => document.getElementById('login');
  function showGate(html) {
    const g = gate();
    g.innerHTML = `<div class="login-card"><img src="icons/icon-192.png" alt="" class="login-logo"><h2>BuddyBoard</h2>${html}</div>`;
    g.hidden = false;
  }

  function showLogin(msg = '') {
    showGate(`
      <p class="login-sub">Sign in to open the shared BuddyBoard.</p>
      <form class="form-card" id="loginForm">
        <label class="field"><span>Email</span>
          <input type="email" id="loginEmail" autocomplete="username" required>
        </label>
        <label class="field"><span>Password</span>
          <input type="password" id="loginPass" autocomplete="current-password" required>
        </label>
        <div class="login-error" id="loginError">${msg}</div>
        <button class="btn-filled" type="submit" id="loginBtn">Sign in</button>
      </form>`);
    document.getElementById('loginForm').onsubmit = async e => {
      e.preventDefault();
      const btn = document.getElementById('loginBtn');
      btn.disabled = true;
      try {
        await auth.signInWithEmailAndPassword(
          document.getElementById('loginEmail').value.trim(),
          document.getElementById('loginPass').value);
      } catch (err) {
        document.getElementById('loginError').textContent =
          /invalid|wrong|not-found|user/.test(err.code || '') ? 'Wrong email or password.' : (err.message || String(err));
        btn.disabled = false;
      }
    };
  }

  /* ---- One-time move of data that lived only on this device ----
     Earlier versions kept everything in this browser (IndexedDB database
     "buddyboard-v2" + a few localStorage keys). When the shared database
     has no orders/customers yet, offer to upload it. */
  function readLocalData() {
    return new Promise(resolve => {
      if (!window.indexedDB) return resolve(null);
      let req;
      try { req = indexedDB.open('buddyboard-v2'); } catch { return resolve(null); }
      // Fires only if the database did not exist — abort so nothing is created.
      req.onupgradeneeded = e => { e.target.transaction.abort(); };
      req.onerror = () => resolve(null);
      req.onsuccess = () => {
        const db = req.result;
        const stores = ['products', 'customers', 'orders', 'purchases'];
        if (!stores.every(s => db.objectStoreNames.contains(s))) { db.close(); return resolve(null); }
        const t = db.transaction(stores);
        const out = {};
        stores.forEach(s => { t.objectStore(s).getAll().onsuccess = e => { out[s] = e.target.result; }; });
        t.oncomplete = () => { db.close(); resolve(out); };
        t.onerror = () => { db.close(); resolve(null); };
      };
    });
  }

  const LEGACY_SETTINGS = ['erp_receipt_footer', 'erp_split_cfg', 'erp_bank', 'erp_order_seq_next', 'erp_delivery_seeded', 'erp_pack500'];

  async function offerLocalUpload() {
    if (localStorage.getItem('bb_local_upload_done')) return;
    const [orders, customers] = await Promise.all([DB.getAll('orders'), DB.getAll('customers')]);
    if (orders.length || customers.length) return; // shared data already in use
    const local = await readLocalData();
    if (!local || !(local.orders.length || local.customers.length || local.products.length)) return;
    await new Promise(done => {
      showConfirm(
        `This device still has its own data (${local.orders.length} orders, ${local.products.length} products, ${local.customers.length} customers). Upload it to the shared BuddyBoard so every device sees it?`,
        async () => {
          await DB.importAll({ app: 'buddyboard', ...local });
          LEGACY_SETTINGS.forEach(k => {
            const v = localStorage.getItem(k);
            if (v != null) DB.setSetting(k, v);
          });
          localStorage.setItem('bb_local_upload_done', '1');
          snack('Data uploaded — it now syncs to every device');
          done();
        },
        'Upload'
      );
      // "Cancel" just closes the dialog — continue booting; it will ask again next start.
      document.getElementById('confirmCancel').addEventListener('click', done, { once: true });
      document.getElementById('confirmScrim').addEventListener('click', done, { once: true });
    });
  }

  /* ---- Offline indicator in the top bar ---- */
  function watchConnection() {
    const el = document.getElementById('syncState');
    const upd = () => { el.hidden = navigator.onLine; };
    window.addEventListener('online', upd);
    window.addEventListener('offline', upd);
    upd();
  }

  function start() {
    if (!cfg.apiKey || !cfg.projectId) {
      showGate(`<p class="login-sub">Cloud sync is not set up yet: fill in <b>firebase-config.js</b> with your Firebase project settings.</p>`);
      return;
    }
    firebase.initializeApp(cfg);
    auth = firebase.auth();
    const db = firebase.firestore();
    const emu = window.__BB_EMULATOR; // only set by automated tests
    if (emu) {
      auth.useEmulator(`http://${emu.host}:${emu.authPort}`, { disableWarnings: true });
      db.useEmulator(emu.host, emu.firestorePort);
    }
    db.settings({ ignoreUndefinedProperties: true, merge: true });
    // Keep a copy of the data on the device so the app also works offline.
    const persisted = db.enablePersistence({ synchronizeTabs: true }).catch(() => {});

    let started = false;
    auth.onAuthStateChanged(async user => {
      if (!user) { if (!started) showLogin(); else location.reload(); return; }
      if (started) return;
      started = true;
      showGate('<p class="login-sub">Loading…</p>');
      try {
        await persisted;
        await DB.start(db, {
          onError: err => snack(err.code === 'permission-denied'
            ? 'Sync refused: this account has no access (check firestore.rules)'
            : 'Sync problem: ' + (err.message || err))
        });
      } catch (err) {
        started = false;
        await auth.signOut();
        showLogin(err.code === 'permission-denied'
          ? `${user.email} has no access to this BuddyBoard. Ask to be added to firestore.rules.`
          : 'Could not load data: ' + (err.message || err));
        return;
      }
      gate().hidden = true;
      watchConnection();
      await offerLocalUpload();
      resolveReady();
    });
  }

  return {
    ready,
    start,
    email: () => auth && auth.currentUser ? auth.currentUser.email : '',
    signOut: () => auth.signOut()
  };
})();
