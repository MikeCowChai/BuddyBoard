/* ============================================================
   db.js — data layer: local copy on this device + sync via Supabase
   Stores: products, customers, orders, purchases, payouts (+ shared settings)

   How it works:
   - Everything is kept in memory and in a local IndexedDB copy, so the
     app opens and works without a connection.
   - Every change is applied locally right away and also put in an
     "outbox" (also stored on the device). The outbox is uploaded to
     Supabase as soon as there is a connection, one atomic batch at a
     time (supabase/schema.sql → apply_ops).
   - Changes from the other devices arrive live (Supabase Realtime) and
     are also fetched on start, on reconnect and when the app comes back
     to the foreground, so nothing is missed.

   IDs stay numbers (the rest of the app compares ids with Number(...)),
   generated from the clock + a random part so two devices never hand
   out the same id.
   ============================================================ */
const DB = (() => {
  // stocklog: one row per "Add stock" — when, how much, and its value at the
// selling price then — so reports can show how much stock was made per month.
const STORES = ['products', 'customers', 'orders', 'purchases', 'payouts', 'stocklog'];
  const cache = Object.fromEntries(STORES.map(s => [s, new Map()]));
  let settings = {};
  let outbox = [];                 // [{ seq, op }] in upload order
  const pending = new Map();       // "store/key" -> number of queued ops
  let sb = null;                   // Supabase client (null until signed in)
  let idbp = null;
  let lastSync = null;             // newest server updated_at seen
  let flushing = false, flushTimer = null, pullTimer = null, channel = null;
  const changeListeners = new Set();
  const statusListeners = new Set();
  let onSyncError = err => console.error(err);

  const clone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  const pkey = (store, key) => store + '/' + key;
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID()
    : '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, c =>
        (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16)));

  function genId() {
    let id;
    do { id = Date.now() * 1000 + Math.floor(Math.random() * 1000); }
    while (STORES.some(s => cache[s].has(id)));
    return id;
  }

  /* ---------------- Local copy (IndexedDB) ---------------- */
  function idb() {
    if (idbp) return idbp;
    idbp = new Promise((resolve, reject) => {
      const req = indexedDB.open('buddyboard-sync', 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore('records', { keyPath: ['store', 'key'] });
        db.createObjectStore('outbox', { keyPath: 'seq', autoIncrement: true });
        db.createObjectStore('meta');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return idbp;
  }
  async function idbTx(stores, fn) {
    const db = await idb();
    return new Promise((resolve, reject) => {
      const t = db.transaction(stores, 'readwrite');
      const out = fn(t);
      t.oncomplete = () => resolve(out);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error('Local save aborted'));
    });
  }
  const getAllFrom = (t, s) => new Promise(r => { t.objectStore(s).getAll().onsuccess = e => r(e.target.result); });

  function setLocal(store, key, data) {
    if (store === 'settings') {
      if (data === null || data === undefined) delete settings[key]; else settings[key] = data;
    } else if (data === null || data === undefined) cache[store].delete(Number(key));
    else cache[store].set(Number(key), data);
  }
  function getLocal(store, key) {
    return store === 'settings' ? settings[key] : cache[store].get(Number(key));
  }

  /* ---------------- Writing ---------------- */
  /* ops (as the app layer builds them):
       { set: [store, obj] } | { del: [store, id] } | { stock: [id, delta] }
       | { setting: [key, value|undefined] }
     All are applied locally + queued in ONE local transaction, and later
     uploaded together in one server transaction. */
  async function commit(ops) {
    const queued = [], rows = [];
    for (const op of ops) {
      if (op.set) {
        const [store, obj] = op.set;
        const data = clone(obj);
        setLocal(store, obj.id, data);
        rows.push([store, String(obj.id), data]);
        queued.push({ t: 'upsert', store, key: String(obj.id), data });
      } else if (op.del) {
        const [store, id] = op.del;
        setLocal(store, id, null);
        rows.push([store, String(id), null]);
        queued.push({ t: 'delete', store, key: String(id) });
      } else if (op.stock) {
        const [id, delta] = op.stock;
        const p = cache.products.get(id);
        if (!delta || !p) continue;
        p.stock = (p.stock || 0) + delta;
        rows.push(['products', String(id), p]);
        queued.push({ t: 'stock', store: 'products', key: String(id), delta });
      } else if (op.setting) {
        const [key, value] = op.setting;
        const v = value === undefined ? null : value;
        setLocal('settings', key, v);
        rows.push(['settings', key, v]);
        queued.push(v === null ? { t: 'delete', store: 'settings', key } : { t: 'upsert', store: 'settings', key, data: v });
      }
    }
    if (!queued.length) return;
    queued.forEach(q => { q.opId = uuid(); });
    const added = await idbTx(['records', 'outbox'], t => {
      const r = t.objectStore('records'), o = t.objectStore('outbox');
      rows.forEach(([store, key, data]) => {
        if (data === null) r.delete([store, key]); else r.put({ store, key, data });
      });
      const out = [];
      queued.forEach(op => { const req = o.add({ op }); req.onsuccess = () => out.push({ seq: req.result, op }); });
      return out;
    });
    added.sort((a, b) => a.seq - b.seq).forEach(e => {
      outbox.push(e);
      pending.set(pkey(e.op.store, e.op.key), (pending.get(pkey(e.op.store, e.op.key)) || 0) + 1);
    });
    notifyStatus();
    flush();
  }

  /* ---------------- Uploading ---------------- */
  const isNetworkError = err => !err || err instanceof TypeError ||
    /fetch|network|load failed|timeout/i.test(String(err.message || err));

  async function flush() {
    clearTimeout(flushTimer);
    if (!sb || flushing || !outbox.length) return;
    flushing = true;
    try {
      while (outbox.length) {
        const batch = outbox.slice(0, 200);
        const { error } = await sb.rpc('apply_ops', { ops: batch.map(e => e.op) });
        if (error) throw error;
        await idbTx(['outbox'], t => batch.forEach(e => t.objectStore('outbox').delete(e.seq)));
        outbox.splice(0, batch.length);
        batch.forEach(e => {
          const k = pkey(e.op.store, e.op.key);
          const n = (pending.get(k) || 1) - 1;
          if (n > 0) pending.set(k, n); else pending.delete(k);
        });
        notifyStatus();
      }
      flushing = false;
      pull(); // pick up the server's version (e.g. stock after other devices' changes)
    } catch (err) {
      flushing = false;
      if (isAdminOnly(err)) return dropRefused();
      if (!isNetworkError(err)) onSyncError(err);
      flushTimer = setTimeout(flush, 15000);
    }
  }

  /* The server refused a change this account may not make (e.g. a member
     editing the profit split). Send the queued changes one by one, drop
     the refused ones and put the server's version back on this device. */
  const isAdminOnly = err => err && err.code === '42501' && /admin only/i.test(err.message || '');
  async function dropRefused() {
    flushing = true;
    const refused = [];
    try {
      while (outbox.length) {
        const e = outbox[0];
        const { error } = await sb.rpc('apply_ops', { ops: [e.op] });
        if (error && !isAdminOnly(error)) throw error;
        if (error) refused.push(e.op);
        await idbTx(['outbox'], t => t.objectStore('outbox').delete(e.seq));
        outbox.shift();
        const k = pkey(e.op.store, e.op.key);
        const n = (pending.get(k) || 1) - 1;
        if (n > 0) pending.set(k, n); else pending.delete(k);
      }
    } catch (err) {
      flushing = false;
      flushTimer = setTimeout(flush, 15000);
      return;
    }
    flushing = false;
    notifyStatus();
    for (const op of refused) {
      const { data } = await sb.from('records').select('store,key,data,deleted,updated_at')
        .eq('store', op.store).eq('key', op.key).maybeSingle();
      applyRemote([data || { store: op.store, key: op.key, data: null, deleted: true }]);
    }
    if (refused.length) onSyncError(new Error('admin only'));
    pull();
  }

  /* ---------------- Downloading ---------------- */
  // Rows changed by others. Rows with our own changes still queued are
  // skipped — our upload is newer and the next pull brings the result.
  function applyRemote(rows) {
    let changed = false;
    const puts = [];
    for (const row of rows) {
      if (row.updated_at && (!lastSync || row.updated_at > lastSync)) lastSync = row.updated_at;
      if (pending.has(pkey(row.store, row.key))) continue;
      if (row.store !== 'settings' && !cache[row.store]) continue;
      const data = row.deleted ? null : row.data;
      if (JSON.stringify(getLocal(row.store, row.key) ?? null) === JSON.stringify(data ?? null)) continue;
      setLocal(row.store, row.key, data);
      puts.push([row.store, row.key, data]);
      changed = true;
    }
    const ls = lastSync;
    idbTx(['records', 'meta'], t => {
      const r = t.objectStore('records');
      puts.forEach(([store, key, data]) => {
        if (data === null) r.delete([store, key]); else r.put({ store, key, data });
      });
      if (ls) t.objectStore('meta').put(ls, 'lastSync');
    }).catch(err => console.error(err));
    if (changed) notifyChange();
    return changed;
  }

  let pulling = null;
  function pull() {
    if (!sb) return Promise.resolve();
    if (pulling) return pulling;
    pulling = (async () => {
      try {
        // Re-read a short overlap: a change saved just before our last read
        // can carry a slightly older timestamp.
        let since = lastSync ? new Date(new Date(lastSync).getTime() - 30000).toISOString() : null;
        for (;;) {
          let q = sb.from('records').select('store,key,data,deleted,updated_at').order('updated_at').limit(1000);
          if (since) q = q.gt('updated_at', since);
          const { data, error } = await q;
          if (error) throw error;
          applyRemote(data);
          if (data.length < 1000) break;
          since = data[data.length - 1].updated_at;
        }
        lastPullOk = Date.now();
        notifyStatus();
      } catch (err) {
        if (!isNetworkError(err)) onSyncError(err);
      } finally {
        pulling = null;
      }
    })();
    return pulling;
  }
  let lastPullOk = 0;

  function listen() {
    if (channel) sb.removeChannel(channel);
    channel = sb.channel('buddyboard-records')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'records' }, payload => {
        const row = payload.new;
        if (!row || !row.store) return;
        // Realtime unpacks a JSON column holding a JSON-looking string
        // ('{"a":1}', '2') into an object/number. Settings are always
        // strings, so turn them back into the text that was saved.
        if (row.store === 'settings' && row.data !== null && row.data !== undefined && typeof row.data !== 'string') {
          row.data = JSON.stringify(row.data);
        }
        applyRemote([row]);
      })
      .subscribe(status => { if (status === 'SUBSCRIBED') pull(); });
  }

  /* ---------------- Status / change listeners ---------------- */
  const notifyChange = () => changeListeners.forEach(fn => { try { fn(); } catch (e) { console.error(e); } });
  const notifyStatus = () => {
    const s = api.status();
    statusListeners.forEach(fn => { try { fn(s); } catch (e) { console.error(e); } });
  };

  const api = {
    /* Load the local copy of the data (works offline). */
    async load() {
      const db = await idb();
      const t = db.transaction(['records', 'outbox', 'meta']);
      const [records, queued, ls] = await Promise.all([
        getAllFrom(t, 'records'), getAllFrom(t, 'outbox'),
        new Promise(r => { t.objectStore('meta').get('lastSync').onsuccess = e => r(e.target.result); })
      ]);
      records.forEach(r => setLocal(r.store, r.key, r.data));
      outbox = queued.sort((a, b) => a.seq - b.seq);
      outbox.forEach(e => {
        const k = pkey(e.op.store, e.op.key);
        pending.set(k, (pending.get(k) || 0) + 1);
      });
      lastSync = ls || null;
    },

    /* Start syncing with Supabase (after sign-in). Resolves after the
       first download attempt. */
    async connect(client, { onError } = {}) {
      if (onError) onSyncError = onError;
      if (!sb) {
        const kick = () => { flush(); pull(); };
        window.addEventListener('online', kick);
        document.addEventListener('visibilitychange', () => { if (!document.hidden) kick(); });
        pullTimer = setInterval(kick, 60000); // safety net if a live update was missed
      }
      sb = client;
      listen();
      flush();
      await pull();
    },

    hasData() { return STORES.some(s => cache[s].size) || Object.keys(settings).length > 0; },
    pendingCount() { return outbox.length; },
    status() { return { pending: outbox.length, lastPullOk }; },
    onStatus(fn) { statusListeners.add(fn); return () => statusListeners.delete(fn); },
    onChange(fn) { changeListeners.add(fn); return () => changeListeners.delete(fn); },
    syncNow() { flush(); return pull(); },

    /* Forget everything stored on this device (on sign-out). */
    async wipeLocal() {
      STORES.forEach(s => cache[s].clear());
      settings = {}; outbox = []; pending.clear(); lastSync = null;
      await idbTx(['records', 'outbox', 'meta'], t => ['records', 'outbox', 'meta'].forEach(s => t.objectStore(s).clear()));
    },

    /* Shared settings (receipt footer, profit split, bank baseline, order
       counter…) — the same on every device. */
    setting(key) { return settings[key] ?? null; },
    setSetting(key, value) { return commit([{ setting: [key, value] }]); },
    removeSetting(key) { return commit([{ setting: [key, undefined] }]); },

    async getAll(store) { return [...cache[store].values()].map(clone); },
    async get(store, id) { return clone(cache[store].get(id)); },
    async add(store, value) {
      value.id = genId();
      await commit([{ set: [store, value] }]);
      return value.id;
    },
    async put(store, value) {
      if (value.id == null) return api.add(store, value);
      await commit([{ set: [store, value] }]);
      return value.id;
    },
    async delete(store, id) { await commit([{ del: [store, id] }]); },
    async addStock(productId, delta) { await commit([{ stock: [productId, delta] }]); },

    /* Create an order and reserve stock in one atomic change.
       - deduct=false: past orders that were already fulfilled — stock untouched.
       - deduct=true: take what's available; any shortfall is stored on the
         item as pendingQty ("awaiting stock") instead of failing the order. */
    async createOrderWithStock(order, deduct = true) {
      const ops = [];
      if (!deduct) {
        order.items.forEach(i => { i.pendingQty = 0; });
        order.skipStock = true;
      } else {
        const stock = new Map(); // running stock per product within this order
        for (const item of order.items) {
          const p = cache.products.get(item.productId);
          if (!p) throw new Error(`Product not found: ${item.name}`);
          if (p.trackStock === false) { item.pendingQty = 0; continue; } // services never wait
          const have = stock.has(p.id) ? stock.get(p.id) : (p.stock || 0);
          const take = Math.max(0, Math.min(have, item.qty));
          stock.set(p.id, have - take);
          item.pendingQty = item.qty - take;
          ops.push({ stock: [p.id, -take] });
        }
      }
      order.id = genId();
      ops.unshift({ set: ['orders', order] });
      await commit(ops);
      return order.id;
    },

    /* After a product's stock is raised, hand the new stock to orders still
       awaiting it (oldest order first). Returns what was allocated so the
       UI can report it. */
    async allocatePending(productId) {
      const p = cache.products.get(productId);
      const allocations = [];
      if (!p || p.trackStock === false || !(p.stock > 0)) return allocations;
      let stock = p.stock;
      const ops = [];
      const waiting = [...cache.orders.values()]
        .filter(o => o.items.some(i => i.productId === productId && i.pendingQty > 0))
        .sort((a, b) => a.createdAt - b.createdAt)
        .map(clone);
      for (const o of waiting) {
        let changed = false;
        for (const i of o.items) {
          if (i.productId !== productId || !(i.pendingQty > 0)) continue;
          const take = Math.min(stock, i.pendingQty);
          if (take > 0) {
            stock -= take;
            i.pendingQty -= take;
            changed = true;
            allocations.push({ orderId: o.id, name: i.name, qty: take });
          }
        }
        if (changed) ops.push({ set: ['orders', o] });
        if (stock === 0) break;
      }
      ops.push({ stock: [productId, stock - p.stock] });
      await commit(ops);
      return allocations;
    },

    /* Purchases are a pure expense log — they record money spent, not stock. */
    async receivePurchase(purchase) {
      return api.add('purchases', purchase);
    },

    /* Full backup: every store in one JSON-able object. */
    async exportAll() {
      const all = await Promise.all(STORES.map(s => api.getAll(s)));
      return { app: 'buddyboard', version: 1, exportedAt: Date.now(), ...Object.fromEntries(STORES.map((s, i) => [s, all[i]])) };
    },

    /* Restore a backup: REPLACES all shared data in every store the backup
       contains (an older backup without e.g. payouts leaves those alone). */
    async importAll(data) {
      const ops = [];
      STORES.filter(store => Array.isArray(data[store])).forEach(store => {
        const keep = new Set((data[store] || []).map(r => r.id));
        cache[store].forEach((_, id) => { if (!keep.has(id)) ops.push({ del: [store, id] }); });
        (data[store] || []).forEach(r => {
          if (r.id == null) r.id = genId();
          ops.push({ set: [store, r] });
        });
      });
      await commit(ops);
    },

    /* Replace an order's items/customer/totals. Stock handling: first give
       back what the OLD items actually took (qty minus what was still
       pending), then deduct for the NEW items — shortfalls become
       pendingQty again, exactly like order creation. Orders created with
       "don't deduct stock" (skipStock) keep not touching stock at all. */
    async updateOrderItems(orderId, patch) {
      const o = clone(cache.orders.get(orderId));
      if (!o) throw new Error('Order not found');
      const skip = !!o.skipStock;

      const giveBack = new Map();
      if (!skip) o.items.forEach(i => {
        const took = i.qty - (i.pendingQty || 0);
        if (took > 0) giveBack.set(i.productId, (giveBack.get(i.productId) || 0) + took);
      });

      Object.assign(o, patch);

      const ops = [];
      const productIds = new Set([...giveBack.keys(), ...o.items.map(i => i.productId)]);
      productIds.forEach(pid => {
        const p = cache.products.get(pid);
        const mine = o.items.filter(i => i.productId === pid);
        if (p && p.trackStock !== false && !skip) {
          const before = p.stock || 0;
          let stock = before + (giveBack.get(pid) || 0);
          mine.forEach(i => {
            const take = Math.max(0, Math.min(stock, i.qty));
            stock -= take;
            i.pendingQty = i.qty - take;
          });
          ops.push({ stock: [pid, stock - before] });
        } else {
          mine.forEach(i => { i.pendingQty = 0; });
        }
      });
      ops.unshift({ set: ['orders', o] });
      await commit(ops);
    },

    /* Update the actual sold grams of weight items on an order.
       newQtys: { itemIndex: grams }. Recomputes line and order totals and
       moves the stock difference for tracked products (unless the order
       skipped stock). */
    async updateOrderWeights(orderId, newQtys) {
      const o = clone(cache.orders.get(orderId));
      if (!o) throw new Error('Order not found');
      const deltas = new Map(); // productId -> grams delta
      Object.entries(newQtys).forEach(([idx, grams]) => {
        const item = o.items[Number(idx)];
        if (!item || item.unitType !== 'weight' || !(grams > 0)) return;
        const delta = grams - item.qty;
        if (delta !== 0 && !o.skipStock) {
          deltas.set(item.productId, (deltas.get(item.productId) || 0) + delta);
        }
        item.qty = grams;
        item.lineTotal = Math.floor(grams / 1000 * item.unitPrice);
      });
      const subtotal = o.items.reduce((s, i) => s + (i.lineTotal !== undefined ? i.lineTotal : i.qty * i.unitPrice), 0);
      o.subtotal = subtotal;
      const pct = o.discountPct || 0;
      o.total = subtotal - Math.ceil(subtotal * pct / 100);
      const ops = [{ set: ['orders', o] }];
      deltas.forEach((delta, productId) => {
        const p = cache.products.get(productId);
        if (!p || p.trackStock === false) return;
        const before = p.stock || 0;
        ops.push({ stock: [productId, Math.max(0, before - delta) - before] });
      });
      await commit(ops);
    }
  };

  return api;
})();
