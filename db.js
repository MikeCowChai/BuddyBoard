/* ============================================================
   db.js — shared cloud data layer (Firebase Firestore)
   Stores: products, customers, orders, purchases (+ shared settings)

   Every device signed in to the same Firebase project sees the same
   data, live. The app reads from an in-memory copy that Firestore keeps
   up to date (also offline — Firestore stores it on the device), so
   reads stay instant. Writes are applied to that copy immediately and
   synced in the background; while offline they queue on the device and
   upload once a connection is back.

   IDs stay numbers (the rest of the app compares ids with Number(...)),
   but are generated from the clock + a random part so two devices can
   never hand out the same id.
   ============================================================ */
const DB = (() => {
  const STORES = ['products', 'customers', 'orders', 'purchases'];
  const cache = Object.fromEntries(STORES.map(s => [s, new Map()]));
  let settings = {};
  let fs = null;
  const changeListeners = new Set();
  let onWriteError = err => console.error(err);

  const clone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  const ref = (store, id) => fs.collection(store).doc(String(id));
  const settingsRef = () => fs.collection('meta').doc('settings');

  function genId() {
    let id;
    do { id = Date.now() * 1000 + Math.floor(Math.random() * 1000); }
    while (STORES.some(s => cache[s].has(id)));
    return id;
  }

  /* Apply a list of writes: first to the local copy (so the very next read
     sees them), then to Firestore as one atomic batch. The batch is NOT
     awaited — offline it only resolves once back online, and the app must
     not hang until then. Firestore keeps queued writes across restarts.
     ops: { set: [store, obj] } | { del: [store, id] } | { stock: [id, delta] }
          | { setting: [key, value|undefined] } */
  function commit(ops) {
    const FV = firebase.firestore.FieldValue;
    const writes = [];
    for (const op of ops) {
      if (op.set) {
        const [store, obj] = op.set;
        cache[store].set(obj.id, clone(obj));
        writes.push(b => b.set(ref(store, obj.id), clone(obj)));
      } else if (op.del) {
        const [store, id] = op.del;
        cache[store].delete(id);
        writes.push(b => b.delete(ref(store, id)));
      } else if (op.stock) {
        // Stock changes are sent as increments, so two devices changing the
        // same product's stock at the same time add up instead of overwriting.
        const [id, delta] = op.stock;
        if (!delta) continue;
        const p = cache.products.get(id);
        if (!p) continue;
        p.stock = (p.stock || 0) + delta;
        writes.push(b => b.update(ref('products', id), { stock: FV.increment(delta) }));
      } else if (op.setting) {
        const [key, value] = op.setting;
        if (value === undefined) delete settings[key]; else settings[key] = value;
        writes.push(b => b.set(settingsRef(), { [key]: value === undefined ? FV.delete() : value }, { merge: true }));
      }
    }
    // Firestore allows 500 writes per batch; big imports are split up.
    for (let i = 0; i < writes.length; i += 450) {
      const b = fs.batch();
      writes.slice(i, i + 450).forEach(w => w(b));
      b.commit().catch(err => onWriteError(err));
    }
  }

  const notify = info => changeListeners.forEach(fn => { try { fn(info); } catch (e) { console.error(e); } });

  const api = {
    /* Connects to Firestore and resolves once every collection has been
       loaded (from the device cache or the server). After that, every
       change — local or from another device — calls the onChange
       listeners. Returns an unsubscribe function. */
    start(firestore, { onError } = {}) {
      fs = firestore;
      if (onError) onWriteError = onError;
      const unsubs = [];
      return new Promise((resolve, reject) => {
        let waiting = STORES.length + 1;
        const loaded = () => { if (--waiting === 0) resolve(() => unsubs.forEach(u => u())); };
        STORES.forEach(store => {
          let first = true;
          unsubs.push(fs.collection(store).onSnapshot(snap => {
            const m = new Map();
            snap.forEach(d => { const v = d.data(); m.set(v.id, v); });
            cache[store] = m;
            if (first) { first = false; loaded(); }
            else notify({ store, remote: !snap.metadata.hasPendingWrites });
          }, err => { if (first) reject(err); else onWriteError(err); }));
        });
        let firstS = true;
        unsubs.push(settingsRef().onSnapshot(d => {
          settings = d.exists ? d.data() : {};
          if (firstS) { firstS = false; loaded(); }
          else notify({ store: 'settings', remote: !d.metadata.hasPendingWrites });
        }, err => { if (firstS) reject(err); else onWriteError(err); }));
      });
    },

    onChange(fn) { changeListeners.add(fn); return () => changeListeners.delete(fn); },

    /* Shared settings (receipt footer, profit split, bank baseline, order
       counter…) — the same on every device. */
    setting(key) { return settings[key] ?? null; },
    setSetting(key, value) { commit([{ setting: [key, value] }]); },
    removeSetting(key) { commit([{ setting: [key, undefined] }]); },

    async getAll(store) { return [...cache[store].values()].map(clone); },
    async get(store, id) { return clone(cache[store].get(id)); },
    async add(store, value) {
      value.id = genId();
      commit([{ set: [store, value] }]);
      return value.id;
    },
    async put(store, value) {
      if (value.id == null) return api.add(store, value);
      commit([{ set: [store, value] }]);
      return value.id;
    },
    async delete(store, id) { commit([{ del: [store, id] }]); },
    async addStock(productId, delta) { commit([{ stock: [productId, delta] }]); },

    /* Create an order and reserve stock in one atomic write.
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
      commit(ops);
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
      commit(ops);
      return allocations;
    },

    /* Purchases are a pure expense log — they record money spent, not stock. */
    async receivePurchase(purchase) {
      return api.add('purchases', purchase);
    },

    /* Full backup: every store in one JSON-able object. */
    async exportAll() {
      const [products, customers, orders, purchases] = await Promise.all(STORES.map(s => api.getAll(s)));
      return { app: 'buddyboard', version: 1, exportedAt: Date.now(), products, customers, orders, purchases };
    },

    /* Restore a backup: REPLACES all shared data in every store. */
    async importAll(data) {
      const ops = [];
      STORES.forEach(store => {
        const keep = new Set((data[store] || []).map(r => r.id));
        cache[store].forEach((_, id) => { if (!keep.has(id)) ops.push({ del: [store, id] }); });
        (data[store] || []).forEach(r => {
          if (r.id == null) r.id = genId();
          ops.push({ set: [store, r] });
        });
      });
      commit(ops);
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
      commit(ops);
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
      commit(ops);
    }
  };

  return api;
})();
