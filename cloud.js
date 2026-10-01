/* ============================================================
   cloud.js — Supabase sign-in + start-up of the synced database
   Cloud.ready resolves once someone is signed in and the data is loaded;
   app.js waits for it before rendering anything. After the first sign-in
   the app also opens offline, from the copy stored on the device.
   ============================================================ */
const Cloud = (() => {
  const cfg = window.SUPABASE_CONFIG || {};
  let sb = null;
  let resolveReady;
  const ready = new Promise(r => { resolveReady = r; });
  const USER_KEY = 'bb_user';
  const ROLE_KEY = 'bb_role'; // 'admin' | 'member', remembered for offline starts

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
        <div class="login-error" id="loginError">${esc(msg)}</div>
        <button class="btn-filled" type="submit" id="loginBtn">Sign in</button>
      </form>`);
    document.getElementById('loginForm').onsubmit = async e => {
      e.preventDefault();
      const btn = document.getElementById('loginBtn');
      const errEl = document.getElementById('loginError');
      btn.disabled = true;
      errEl.textContent = '';
      const { data, error } = await sb.auth.signInWithPassword({
        email: document.getElementById('loginEmail').value.trim(),
        password: document.getElementById('loginPass').value
      });
      if (error) {
        errEl.textContent = /invalid/i.test(error.message) ? 'Wrong email or password.'
          : (!navigator.onLine ? 'No internet connection — the first sign-in needs internet.' : error.message);
        btn.disabled = false;
        return;
      }
      await afterSignIn(data.user.email, true);
    };
  }

  /* This account's role from the team list (supabase/schema.sql → team):
     'admin', 'member', or null when not on the team. A database that has
     no roles yet (before upgrade-2.4.0-roles.sql) treats everyone as admin. */
  async function fetchRole() {
    const { data, error } = await sb.rpc('my_role');
    if (!error) return data || null;
    if (error.code !== 'PGRST202' && !/my_role/.test(error.message || '')) throw error;
    const team = await sb.rpc('is_team');
    if (team.error) throw team.error;
    return team.data === true ? 'admin' : null;
  }
  function setRole(role) {
    const changed = localStorage.getItem(ROLE_KEY) !== role;
    localStorage.setItem(ROLE_KEY, role);
    if (changed && typeof render === 'function') render();
  }

  async function afterSignIn(email, fresh) {
    if (fresh) {
      showGate('<p class="login-sub">Loading…</p>');
      let role;
      try { role = await fetchRole(); } catch (err) {
        showLogin('Could not reach the server: ' + (err.message || err));
        return;
      }
      if (!role) {
        await sb.auth.signOut();
        showLogin(`${email} has no access to this BuddyBoard. Add it to the team list in Supabase (see SETUP.md).`);
        return;
      }
      if (localStorage.getItem(USER_KEY) !== email) await DB.wipeLocal(); // another account's copy
      localStorage.setItem(USER_KEY, email);
      setRole(role);
      await DB.connect(sb, { onError: syncError });
    } else {
      // Signed in before: open straight from the device copy, sync in the background.
      resumeSession(email);
    }
    gate().hidden = true;
    watchStatus();
    await offerLocalUpload();
    resolveReady();
  }

  /* Reconnect the stored session; offline, try again once back online. */
  async function resumeSession(email) {
    const { data } = await sb.auth.getSession().catch(() => ({ data: {} }));
    if (data && data.session) {
      fetchRole().then(role => { if (role) setRole(role); }).catch(() => {});
      return DB.connect(sb, { onError: syncError });
    }
    if (!navigator.onLine) {
      window.addEventListener('online', () => resumeSession(email), { once: true });
      return;
    }
    showLogin(`Please sign in again (${email}).`);
  }

  function syncError(err) {
    const msg = String(err.message || err);
    if (/admin only/i.test(msg)) {
      snack('Only the admin can change that — your change was undone');
    } else if (err.code === '42501' || /JWT|not on the BuddyBoard team|permission/i.test(msg)) {
      snack('Sync refused — sign out and sign in again, or check the team list in Supabase');
    } else {
      snack('Sync problem: ' + msg);
    }
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
          for (const k of LEGACY_SETTINGS) {
            const v = localStorage.getItem(k);
            if (v != null) await DB.setSetting(k, v);
          }
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

  /* ---- "Offline" / "Syncing" badge in the top bar ---- */
  function watchStatus() {
    const el = document.getElementById('syncState');
    const upd = () => {
      const n = DB.pendingCount();
      if (!navigator.onLine) {
        el.textContent = n ? `Offline · ${n} to sync` : 'Offline';
        el.hidden = false;
      } else if (n) {
        el.textContent = 'Syncing…';
        el.hidden = false;
      } else el.hidden = true;
    };
    window.addEventListener('online', upd);
    window.addEventListener('offline', upd);
    DB.onStatus(upd);
    upd();
  }

  async function start() {
    if (!cfg.url || !cfg.anonKey) {
      showGate(`<p class="login-sub">Sync is not set up yet: fill in <b>supabase-config.js</b> with your Supabase project URL and key (see SETUP.md).</p>`);
      return;
    }
    sb = supabase.createClient(cfg.url, cfg.anonKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false }
    });
    await DB.load();
    const known = localStorage.getItem(USER_KEY);
    if (known) {
      // Don't wait for the network: the stored session is enough to start.
      afterSignIn(known, false);
    } else {
      showLogin();
    }
  }

  /* Sign out = forget the account AND the data copy on this device. */
  async function signOut() {
    if (DB.pendingCount()) {
      await DB.syncNow();
      if (DB.pendingCount()) {
        snack(`${DB.pendingCount()} change(s) not synced yet — connect to the internet first`);
        return;
      }
    }
    await sb.auth.signOut().catch(() => {});
    localStorage.removeItem(USER_KEY);
    localStorage.removeItem(ROLE_KEY);
    await DB.wipeLocal();
    location.reload();
  }

  return {
    ready,
    start,
    email: () => localStorage.getItem(USER_KEY) || '',
    role: () => localStorage.getItem(ROLE_KEY) || 'admin',
    isAdmin: () => (localStorage.getItem(ROLE_KEY) || 'admin') === 'admin',
    signOut
  };
})();
