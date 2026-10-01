/* ---- Build stamp + crash visibility ----------------------------------
   If ANYTHING crashes, a red banner shows the actual error message on
   screen instead of the app silently dying. The build number makes it
   possible to verify which version a device is actually running.
   Version scheme: MAJOR.MINOR.PATCH — PATCH for small fixes (2.0.1),
   MINOR for new features (2.1.0), MAJOR for big changes (3.0.0). */
const BUILD = '2.0.1';
function showFatal(msg) {
  try {
    let b = document.getElementById('errBanner');
    if (!b) {
      b = document.createElement('div');
      b.id = 'errBanner';
      b.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:9999;background:#B3261E;color:#fff;font:12.5px/1.45 system-ui;padding:10px 14px;white-space:pre-wrap;word-break:break-word';
      (document.body || document.documentElement).appendChild(b);
    }
    b.textContent = 'App error — screenshot this and send it: ' + msg + '  [build ' + BUILD + ']';
  } catch (e) { /* never let the reporter itself crash */ }
}
window.addEventListener('error', e => showFatal((e.message || 'unknown error') + (e.filename ? ' @ ' + e.filename.split('/').pop() + ':' + e.lineno : '')));
window.addEventListener('unhandledrejection', e => showFatal(String((e.reason && (e.reason.stack || e.reason.message)) || e.reason).split('\n').slice(0, 3).join(' | ')));

/* ============================================================
   app.js — BuddyBoard
   Views: Dashboard · Inventory (Stock / Incoming purchases)
          Orders · Customers
   ============================================================ */

const STATUSES = ['In production', 'Ready for shipping', 'Shipped', 'Delivered'];
const fmtMoney = n => '฿' + (n || 0).toLocaleString('en-US', { maximumFractionDigits: 2 });
const fmtDate = ts => {
  const d = new Date(ts);
  const opts = { day: 'numeric', month: 'short' };
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
  return d.toLocaleDateString(undefined, opts);
};
const timeAgo = ts => {
  const m = Math.floor((Date.now() - ts) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return m + ' min ago';
  const h = Math.floor(m / 60);
  if (h < 24) return h + ' h ago';
  const d = Math.floor(h / 24);
  return d === 1 ? 'yesterday' : d + ' days ago';
};
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmtGrams = g => g >= 1000
  ? (g / 1000).toLocaleString(undefined, { maximumFractionDigits: 3 }) + ' kg'
  : g + ' g';
// How an order line reads: "2 × Oak shelf" for pieces, "1.104 kg Sea salt" for weight.
const itemLabel = (i, qty = i.qty) => i.unitType === 'weight'
  ? `${fmtGrams(qty)} ${esc(i.name)}`
  : `${qty} × ${esc(i.name)}`;
// Line price: weight items are priced per kg on actual grams, always rounded DOWN.
const lineTotal = l => l.unitType === 'weight' || l.weightBased
  ? Math.floor((l.qty || 0) / 1000 * (l.unitPrice || 0))
  : (l.qty || 0) * (l.unitPrice || 0);
const $ = sel => document.querySelector(sel);
/* Settings shared by every device (stored in the cloud, see db.js) — same
   interface as localStorage so call sites read the same. Per-device
   preferences (theme, collapsed sections) stay in localStorage. */
const shared = {
  getItem: k => DB.setting(k),
  setItem: (k, v) => DB.setSetting(k, String(v)),
  removeItem: k => DB.removeSetting(k)
};

/* Date-input helpers: today keeps the exact current time (natural activity
   ordering); a backdated day is stored at noon local time. */
const fmtTime = ts => {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
const tsToTimeInput = ts => fmtTime(ts);
/* Order number format: DNBB + 2-digit year of the order date + 4-digit
   sequence. IMPORTANT: this uses order.seq, a number BuddyBoard assigns
   and manages itself — never the database's internal id/key. The internal
   id is IndexedDB's auto-increment key and must never be shown or edited:
   IndexedDB permanently raises its key generator to match the highest key
   ever used, so editing it (even once, even by mistake) can make every
   later order jump to a huge number. seq has no such trap — it's just a
   number in a field, safe to reassign freely. */
const orderNo = o => `DNBB${String(new Date(o.createdAt).getFullYear()).slice(-2)}${String(o.seq ?? o.id).padStart(4, '0')}`;

/* One-time self-heal: assigns clean sequential seq numbers (1, 2, 3…) to
   every order by creation date, and fixes the counter. Runs once ever;
   also exposed as a manual "Renumber orders" tool for later cleanup. */
async function renumberAllOrders() {
  const orders = await DB.getAll('orders');
  orders.sort((a, b) => a.createdAt - b.createdAt || a.id - b.id);
  let seq = 1;
  for (const o of orders) {
    if (o.seq !== seq) { o.seq = seq; await DB.put('orders', o); }
    seq++;
  }
  shared.setItem('erp_order_seq_next', String(seq));
  return orders.length;
}
/* Gentle self-heal, safe to run at every boot AND after every import:
   - any order missing a seq (e.g. imported from a v1 backup) gets the next
     free number, oldest first
   - the counter is forced past the highest seq in use
   User-chosen numbers are never touched; full clean-up stays available via
   Settings → Renumber orders. */
/* Next free order number: past both the shared counter and every number
   already in use (another device may just have created an order). */
async function nextOrderSeq() {
  const orders = await DB.getAll('orders');
  const maxSeq = orders.reduce((m, o) => Number.isFinite(o.seq) ? Math.max(m, o.seq) : m, 0);
  return Math.max(Number(shared.getItem('erp_order_seq_next') || '1'), maxSeq + 1);
}
async function ensureOrderSeq() {
  const orders = await DB.getAll('orders');
  let maxSeq = 0;
  orders.forEach(o => { if (Number.isFinite(o.seq)) maxSeq = Math.max(maxSeq, o.seq); });
  const missing = orders.filter(o => !Number.isFinite(o.seq))
    .sort((a, b) => a.createdAt - b.createdAt || a.id - b.id);
  for (const o of missing) {
    o.seq = ++maxSeq;
    await DB.put('orders', o);
  }
  const next = Number(shared.getItem('erp_order_seq_next') || '1');
  if (next <= maxSeq) shared.setItem('erp_order_seq_next', String(maxSeq + 1));
}
const tsToDateInput = ts => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const dateInputToTs = str => {
  if (!str) return null;
  const [y, m, d] = str.split('-').map(Number);
  const t = new Date();
  const isToday = y === t.getFullYear() && m === t.getMonth() + 1 && d === t.getDate();
  return isToday ? Date.now() : new Date(y, m - 1, d, 12).getTime();
};

const state = {
  view: 'home',
  moneyTab: 'reports',
  stockFilter: 'all',
  purchaseFilter: 'all',
  statusFilter: 'open', // default: everything that isn't Delivered yet
  period: 'month', // stats: 'month' | 'quarter' | 'year'
  periodOffset: 0, // 0 = current period, -1 = previous, etc.
  search: { product: '', order: '', customer: '' }
};

/* ---------------- Theme (auto / light / dark) ---------------- */
function applyTheme(pref) {
  localStorage.setItem('erp_theme', pref);
  document.documentElement.dataset.theme = pref === 'auto' ? '' : pref;
  const dark = pref === 'dark' || (pref === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.querySelector('meta[name="theme-color"]').content = dark ? '#121318' : '#FBF8FF';
}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if ((localStorage.getItem('erp_theme') || 'auto') === 'auto') applyTheme('auto');
});
/* ---------------- Settings (sectioned) ---------------- */
const THEME_LABELS = { auto: 'System (auto)', light: 'Light', dark: 'Dark' };

function openSettings() {
  const theme = localStorage.getItem('erp_theme') || 'auto';
  const bank = bankCfg();
  openSheet(`
    <h2>Settings</h2>

    <h2 class="section-label" style="margin-top:0">Appearance</h2>
    <div class="card set-card">
      <div class="set-row">
        <div class="set-main"><div class="set-title">Theme</div></div>
        <div class="chip-row" style="padding:0;margin:0">
          <button class="chip ${theme === 'auto' ? 'is-selected' : ''}" data-theme-pick="auto">Auto</button>
          <button class="chip ${theme === 'light' ? 'is-selected' : ''}" data-theme-pick="light">Light</button>
          <button class="chip ${theme === 'dark' ? 'is-selected' : ''}" data-theme-pick="dark">Dark</button>
        </div>
      </div>
    </div>

    <h2 class="section-label">Finance</h2>
    <div class="card set-card">
      <button class="set-row" id="setBank">
        <div class="set-main">
          <div class="set-title">Bank balance</div>
          <div class="set-sub">${bank ? 'baseline set ' + fmtDate(bank.ts) : 'not set up yet'}</div>
        </div>
        <span class="set-chevron">›</span>
      </button>
      <button class="set-row" id="setSplit">
        <div class="set-main">
          <div class="set-title">Profit split percentages</div>
          <div class="set-sub">tax, buffer and share distribution</div>
        </div>
        <span class="set-chevron">›</span>
      </button>
    </div>

    <h2 class="section-label">Receipts</h2>
    <div class="card set-card">
      <button class="set-row" id="setFooter">
        <div class="set-main">
          <div class="set-title">Receipt footer</div>
          <div class="set-sub">${(shared.getItem('erp_receipt_footer') || '').trim() ? 'configured' : 'name & bank account for receipts'}</div>
        </div>
        <span class="set-chevron">›</span>
      </button>
    </div>

    <h2 class="section-label">Data & backup</h2>
    <div class="card set-card">
      <button class="set-row" id="stExport">
        <div class="set-main">
          <div class="set-title">Export all data</div>
          <div class="set-sub">share or save a JSON backup</div>
        </div>
        <span class="set-chevron">›</span>
      </button>
      <button class="set-row" id="stImport">
        <div class="set-main">
          <div class="set-title">Import backup…</div>
          <div class="set-sub">replaces everything in this app</div>
        </div>
        <span class="set-chevron">›</span>
      </button>
      <input type="file" id="stImportFile" accept=".json,application/json" hidden>
      <button class="set-row" id="stRenumber">
        <div class="set-main">
          <div class="set-title">Renumber orders</div>
          <div class="set-sub">clean up order numbers into 1, 2, 3… by date</div>
        </div>
        <span class="set-chevron">›</span>
      </button>
    </div>
    <h2 class="section-label">Account</h2>
    <div class="card set-card">
      <button class="set-row" id="stSignOut">
        <div class="set-main">
          <div class="set-title">Sign out</div>
          <div class="set-sub">signed in as ${esc(Cloud.email())}</div>
        </div>
        <span class="set-chevron">›</span>
      </button>
    </div>
    <div class="sub" style="font-size:12.5px;color:var(--md-on-surface-variant);margin-top:10px;padding:0 4px">Your data is shared live with every device signed in to this BuddyBoard, and keeps working offline. An occasional exported backup is still a good idea.<br><br>BuddyBoard ${BUILD}</div>`);

  document.querySelectorAll('[data-theme-pick]').forEach(c =>
    c.addEventListener('click', () => {
      applyTheme(c.dataset.themePick);
      document.querySelectorAll('[data-theme-pick]').forEach(x => x.classList.toggle('is-selected', x === c));
    }));

  $('#setBank').onclick = () => openBankSheet();
  $('#setSplit').onclick = () => openSplitSettings();
  $('#setFooter').onclick = () => openFooterSheet();
  $('#stSignOut').onclick = () => showConfirm('Sign out of BuddyBoard on this device?', () => Cloud.signOut(), 'Sign out');
  $('#stRenumber').onclick = () => {
    showConfirm(
      'Renumber all orders into a clean 1, 2, 3… sequence, ordered by their order date? This changes the DNBB number shown on every order.',
      async () => { const n = await renumberAllOrders(); snack(`Renumbered ${n} orders`); render(); },
      'Renumber'
    );
  };

  $('#stExport').onclick = async () => {
    const data = await DB.exportAll();
    data.settings = {
      theme: localStorage.getItem('erp_theme') || 'auto',
      receiptFooter: shared.getItem('erp_receipt_footer') || '',
      splitCfg: shared.getItem('erp_split_cfg') || '',
      bank: shared.getItem('erp_bank') || ''
    };
    const name = `buddyboard-backup-${tsToDateInput(Date.now())}.json`;
    const blob = new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' });
    const file = new File([blob], name, { type: 'application/json' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: name }); return; } catch (e) { /* cancelled */ }
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    snack('Backup exported');
  };

  $('#stImport').onclick = () => $('#stImportFile').click();
  $('#stImportFile').onchange = async e => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    let data;
    try {
      data = JSON.parse(await f.text());
      if (data.app !== 'buddyboard' || !Array.isArray(data.orders)) throw new Error();
    } catch { return snack('Not a valid BuddyBoard backup file'); }
    const when = data.exportedAt ? new Date(data.exportedAt).toLocaleDateString() : 'unknown date';
    showConfirm(
      `Import backup from ${when} (${(data.orders || []).length} orders, ${(data.products || []).length} products)? This REPLACES everything currently in the app — on every device.`,
      async () => {
        await DB.importAll(data);
        await ensureOrderSeq(); // v1 backups have no seq numbers — assign them now
        if (data.settings) {
          if (data.settings.theme) applyTheme(data.settings.theme);
          if (data.settings.receiptFooter != null) shared.setItem('erp_receipt_footer', data.settings.receiptFooter);
          if (data.settings.splitCfg) shared.setItem('erp_split_cfg', data.settings.splitCfg);
          if (data.settings.bank) shared.setItem('erp_bank', data.settings.bank);
        }
        shared.setItem('erp_delivery_seeded', '1');
        closeSheet(); snack('Backup imported'); render();
      },
      'Import'
    );
  };
}

function openFooterSheet() {
  const footer = shared.getItem('erp_receipt_footer') || '';
  openSheet(`
    <h2>Receipt footer</h2>
    <div class="form-card">
      <label class="field"><span>Shown at the bottom of every shared receipt (name, bank account…)</span>
        <textarea id="stFooter" rows="4" placeholder="Name:&#10;Your name&#10;Accountnumber SCB 1234567890">${esc(footer)}</textarea>
      </label>
      <button class="btn-filled" id="stFooterSave">Save</button>
    </div>`);
  $('#stFooterSave').onclick = () => {
    shared.setItem('erp_receipt_footer', $('#stFooter').value);
    closeSheet(); snack('Receipt footer saved');
  };
}

$('#themeBtn').addEventListener('click', openSettings);
applyTheme(localStorage.getItem('erp_theme') || 'auto');

/* ---------------- Navigation ---------------- */
const VIEW_TITLES = { home: 'BuddyBoard', orders: 'Orders', stock: 'Stock', money: 'Money', customers: 'Customers' };
const FAB_CONFIG = {
  home:      { label: 'Order',    action: () => openOrderForm() },
  orders:    { label: 'Order',    action: () => openOrderForm() },
  stock:     { label: 'Product',  action: () => openProductForm() },
  customers: { label: 'Customer', action: () => openCustomerForm() }
  // money: FAB depends on sub-tab, handled below
};

function switchView(view) {
  state.view = view;
  document.querySelectorAll('.view').forEach(v => v.hidden = true);
  $('#view-' + view).hidden = false;
  document.querySelectorAll('.nav-item').forEach(b => b.classList.toggle('is-active', b.dataset.view === view));
  $('#viewTitle').textContent = VIEW_TITLES[view];

  const fab = $('#fab');
  let cfg = FAB_CONFIG[view];
  if (view === 'money' && state.moneyTab === 'expenses') cfg = null; // expenses has its own inline form
  fab.hidden = !cfg;
  if (cfg) { $('#fabLabel').textContent = cfg.label; fab.onclick = cfg.action; }

  render();
}

document.querySelectorAll('.nav-item').forEach(b =>
  b.addEventListener('click', () => switchView(b.dataset.view)));

/* Jump to a specific Money sub-tab from elsewhere (e.g. Home cards). */
function setMoneyTab(name) {
  state.moneyTab = name;
  document.querySelectorAll('[data-moneytab]').forEach(t => t.classList.toggle('is-active', t.dataset.moneytab === name));
  $('#money-reports').hidden = name !== 'reports';
  $('#money-bank').hidden = name !== 'bank';
  $('#money-split').hidden = name !== 'split';
  $('#money-expenses').hidden = name !== 'expenses';
}

/* ---------------- Sheet (modal) ---------------- */
function openSheet(html) {
  $('#sheetContent').innerHTML = html;
  const sheet = $('#sheet');
  sheet.style.transition = 'none';
  sheet.style.transform = '';
  sheet.hidden = false;
  sheet.scrollTop = 0; // a previous long sheet may have left it scrolled down
  // Force a layout pass so the browser anchors the fixed sheet to the
  // viewport (not the page) before the entrance animation runs. Without
  // this, opening straight from a swipe gesture could mis-position it.
  void sheet.offsetHeight;
  sheet.style.transition = '';
  $('#scrim').hidden = false;
}
function closeSheet() {
  const sheet = $('#sheet');
  sheet.hidden = true;
  sheet.style.transition = '';
  sheet.style.transform = '';
  $('#scrim').hidden = true;
}
$('#scrim').addEventListener('click', closeSheet);
{ const b = $('#sheetClose'); if (b) b.addEventListener('click', closeSheet); }

/* The handle strip is a guaranteed dismiss zone: dragging it down always
   closes the sheet, regardless of where the content is scrolled. */
(function enableHandleDrag() {
  const sheet = $('#sheet');
  const handle = $('#sheetHandle');
  if (!sheet || !handle) return; // older index.html — degrade gracefully
  let startY = 0, dy = 0, active = false;
  handle.addEventListener('touchstart', e => {
    active = true; dy = 0;
    startY = e.touches[0].clientY;
    sheet.style.transition = 'none';
  }, { passive: true });
  handle.addEventListener('touchmove', e => {
    if (!active) return;
    e.preventDefault();
    dy = e.touches[0].clientY - startY;
    sheet.style.transform = `translateY(${Math.max(0, dy)}px)`;
  }, { passive: false });
  const end = () => {
    if (!active) return;
    active = false;
    sheet.style.transition = 'transform .2s ease';
    if (dy > 90) closeSheet();
    else sheet.style.transform = '';
  };
  handle.addEventListener('touchend', end);
  handle.addEventListener('touchcancel', end);
})();

/* Swipe down to dismiss the sheet. Non-passive touchmove lets us take over
   from native scrolling; drag only engages when content is at the top. */
(function enableSheetDrag() {
  const sheet = $('#sheet');
  let startY = 0, dy = 0, active = false, engaged = false;

  sheet.addEventListener('touchstart', e => {
    active = sheet.scrollTop <= 0;
    engaged = false;
    startY = e.touches[0].clientY;
    dy = 0;
  }, { passive: true });

  sheet.addEventListener('touchmove', e => {
    if (!active) return;
    dy = e.touches[0].clientY - startY;
    if (!engaged) {
      if (dy > 8) {           // clearly downward: take over the gesture
        engaged = true;
        sheet.style.transition = 'none';
      } else if (dy < -8) {   // upward: this is a scroll, leave it alone
        active = false;
        return;
      } else return;
    }
    e.preventDefault();       // stop native scroll / pull-to-refresh
    sheet.style.transform = `translateY(${Math.max(0, dy)}px)`;
  }, { passive: false });

  const end = () => {
    if (!engaged) { active = false; return; }
    active = false; engaged = false;
    sheet.style.transition = 'transform .2s ease';
    if (dy > 110) closeSheet();
    else sheet.style.transform = '';
  };
  sheet.addEventListener('touchend', end);
  sheet.addEventListener('touchcancel', end);
})();

/* Long-press helper: fires after 550 ms of holding still; the click that
   follows a long-press is swallowed so it doesn't also open the item. */
function attachLongPress(el, fn) {
  let timer = null, fired = false;
  const start = () => {
    fired = false;
    timer = setTimeout(() => {
      fired = true;
      if (navigator.vibrate) navigator.vibrate(30);
      fn();
    }, 400);
  };
  const cancel = () => clearTimeout(timer);
  el.addEventListener('touchstart', start, { passive: true });
  el.addEventListener('touchmove', cancel, { passive: true });
  el.addEventListener('touchend', cancel);
  el.addEventListener('touchcancel', cancel);
  el.addEventListener('mousedown', start);   // desktop testing
  el.addEventListener('mouseup', cancel);
  el.addEventListener('mouseleave', cancel);
  el.addEventListener('contextmenu', e => e.preventDefault());
  el.addEventListener('click', e => {
    if (fired) { e.stopImmediatePropagation(); e.preventDefault(); fired = false; }
  }, true);
}

/* Confirm dialog for destructive actions. */
function showConfirm(message, onConfirm, okLabel = 'Delete') {
  $('#confirmText').textContent = message;
  $('#confirmOk').textContent = okLabel;
  $('#confirmDialog').hidden = false;
  $('#confirmScrim').hidden = false;
  const close = () => { $('#confirmDialog').hidden = true; $('#confirmScrim').hidden = true; };
  $('#confirmCancel').onclick = close;
  $('#confirmScrim').onclick = close;
  $('#confirmOk').onclick = () => { close(); onConfirm(); };
}

/* Swipe was removed — it fought with scrolling and mis-anchored sheets on
   Android. attachSwipe is now a no-op so existing call sites keep working;
   edit/delete run through long-press (attachLongPress) instead. */
function attachSwipe() { /* intentionally empty */ }
const SWIPE_PANES = '';

let snackTimer = null;
function snack(msg) {
  const el = $('#snackbar');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(snackTimer);
  snackTimer = setTimeout(() => { el.hidden = true; }, Math.min(6000, 2800 + msg.length * 25));
}

/* ---------------- Rendering ---------------- */
async function render() {
  if (state.view === 'home') renderHome();
  if (state.view === 'orders') renderOrders();
  if (state.view === 'stock') { renderProducts(); renderStockOutlook(); }
  if (state.view === 'money') { renderReports(); renderBank(); renderSplit(); renderPurchases(); }
  if (state.view === 'customers') renderCustomers();
}

/* ----- Shared period computation ----- */
function computePeriod() {
  const now = new Date();
  const off = state.periodOffset;
  let pStart, pEnd, periodLabel;
  if (state.period === 'month') {
    pStart = new Date(now.getFullYear(), now.getMonth() + off, 1);
    pEnd = new Date(now.getFullYear(), now.getMonth() + off + 1, 1);
    periodLabel = pStart.toLocaleDateString(undefined, { month: 'long', ...(pStart.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) });
  } else if (state.period === 'quarter') {
    const qBase = Math.floor(now.getMonth() / 3) * 3 + off * 3;
    pStart = new Date(now.getFullYear(), qBase, 1);
    pEnd = new Date(now.getFullYear(), qBase + 3, 1);
    periodLabel = 'Q' + (Math.floor(pStart.getMonth() / 3) + 1) + ' ' + pStart.getFullYear();
  } else {
    pStart = new Date(now.getFullYear() + off, 0, 1);
    pEnd = new Date(now.getFullYear() + off + 1, 0, 1);
    periodLabel = String(pStart.getFullYear());
  }
  return { start: pStart.getTime(), end: pEnd.getTime(), label: periodLabel, off };
}
const fmtCompact = n => n >= 10000 ? '฿' + Math.round(n / 1000) + 'k' : n >= 1000 ? '฿' + (n / 1000).toFixed(1) + 'k' : '฿' + n;
// Products flagged to be left out of sales reports (e.g. Delivery/Shipping).
const inReports = i => !i.excludeReports;

/* ----- HOME (slim: current status only) ----- */
async function renderHome() {
  const [orders, products, purchases] = await Promise.all([
    DB.getAll('orders'), DB.getAll('products'), DB.getAll('purchases')
  ]);

  const empty = !orders.length && !products.length;
  if (empty) {
    $('#view-home').innerHTML = `
      <div class="empty">
        <div class="title">BuddyBoard is empty</div>
        <div>Add products and orders, or start with sample data to explore the app.</div>
        <button class="btn-tonal" id="seedBtn">Load sample data</button>
      </div>`;
    const seed = $('#seedBtn');
    if (seed) seed.onclick = seedSampleData;
    return;
  }

  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const monthOrders = orders.filter(o => o.createdAt >= monthStart);
  const revenue = monthOrders.reduce((s, o) => s + o.total, 0);
  const costs = purchases.filter(pu => pu.receivedAt >= monthStart).reduce((s, pu) => s + (pu.amount || 0), 0);
  const profit = revenue - costs;
  const monthLabel = now.toLocaleDateString(undefined, { month: 'long' });

  const inProduction = orders.filter(o => o.status === STATUSES[0]).length;
  const readyToShip = orders.filter(o => o.status === STATUSES[1]).length;
  const completed = orders.filter(o => o.status === STATUSES[2]).length;
  const openTotal = orders.filter(o => o.status !== 'Delivered').length;
  const lowStock = products.filter(p => p.trackStock !== false && p.stock > 0 && p.stock <= p.lowStock).length;
  const outOfStock = products.filter(p => p.trackStock !== false && p.stock === 0).length;
  const awaiting = orders.filter(o => o.items.some(i => i.pendingQty > 0)).length;

  // Live bank balance (only when tracking is set up).
  const bank = bankCfg();
  let bankBalance = null;
  if (bank) {
    const inflow = orders.filter(o => o.createdAt >= bank.ts).reduce((s, o) => s + o.total, 0);
    const outflow = purchases.filter(p => p.receivedAt >= bank.ts && hitsBank(p)).reduce((s, p) => s + (p.amount || 0), 0);
    bankBalance = bank.amount + inflow - outflow;
  }

  // Recent activity, kept on home as the quick "what happened" glance.
  const events = [];
  orders.forEach(o => {
    events.push({ ts: o.createdAt, type: 'sale', text: `${orderNo(o)} — ${esc(o.customerName)}, ${fmtMoney(o.total)}` });
    if (o.statusChangedAt && o.status !== STATUSES[0])
      events.push({ ts: o.statusChangedAt, type: 'status', text: `${orderNo(o)} moved to “${o.status}”` });
  });
  purchases.forEach(p => events.push({ ts: p.receivedAt, type: 'stock', text: `Spent ${fmtMoney(p.amount)} on ${esc(p.description)}` }));
  events.sort((a, b) => b.ts - a.ts);

  $('#view-home').innerHTML = `
    <div class="stat-grid">
      <div class="stat-card hero">
        <div class="label">Profit · ${monthLabel}</div>
        <div class="value">${profit < 0 ? '−' + fmtMoney(-profit) : fmtMoney(profit)}</div>
        <div class="hint">${fmtMoney(revenue)} revenue · ${fmtMoney(costs)} costs</div>
      </div>
      <div class="stat-card tappable" data-goto="orders" data-status="open">
        <div class="label">Open orders</div>
        <div class="value">${openTotal}</div>
        <div class="hint">${inProduction} in production · ${readyToShip} ready</div>
      </div>
      <div class="stat-card tappable" data-goto="orders" data-status="Shipped">
        <div class="label">Shipped</div>
        <div class="value">${completed}</div>
        <div class="hint">on the way, not delivered yet</div>
      </div>
      ${bankBalance !== null ? `
      <div class="stat-card tappable" data-goto="money" data-moneysub="bank" style="grid-column:1/-1">
        <div class="label">Bank balance (tracked)</div>
        <div class="value">${bankBalance < 0 ? '−' + fmtMoney(-bankBalance) : fmtMoney(bankBalance)}</div>
        <div class="hint">tap for movements & re-anchor</div>
      </div>` : ''}
      ${(lowStock + outOfStock) ? `
      <div class="stat-card warn tappable" data-goto="stock" data-stock="low" style="grid-column:1/-1">
        <div class="label">Stock alerts</div>
        <div class="value">${lowStock + outOfStock}</div>
        <div class="hint">${lowStock} low · ${outOfStock} out of stock — tap to review</div>
      </div>` : ''}
      ${awaiting ? `
      <div class="stat-card tappable" data-goto="orders" data-status="open" style="grid-column:1/-1">
        <div class="label">Awaiting stock</div>
        <div class="value">${awaiting}</div>
        <div class="hint">order${awaiting === 1 ? '' : 's'} waiting for incoming stock</div>
      </div>` : ''}
    </div>
    <h2 class="section-label">Recent activity</h2>
    <div class="card">
      ${events.slice(0, 6).map(e => `
        <div class="activity-item">
          <span class="activity-ico ${e.type === 'sale' ? 'sale' : ''}">
            ${e.type === 'stock'
              ? '<svg viewBox="0 0 24 24"><path d="M20 2H4c-1 0-2 .9-2 2v3c0 .7.4 1.3 1 1.7V20c0 1.1 1.1 2 2 2h14c.9 0 2-.9 2-2V8.7c.6-.4 1-1 1-1.7V4c0-1.1-1-2-2-2m-5 12H9v-2h6zm5-7H4V4h16z"/></svg>'
              : e.type === 'status'
              ? '<svg viewBox="0 0 24 24"><path d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z"/></svg>'
              : '<svg viewBox="0 0 24 24"><path d="M11.8 10.9c-2.27-.59-3-1.2-3-2.15 0-1.09 1.01-1.85 2.7-1.85 1.78 0 2.44.85 2.5 2.1h2.21c-.07-1.72-1.12-3.3-3.21-3.81V3h-3v2.16c-1.94.42-3.5 1.68-3.5 3.61 0 2.31 1.91 3.46 4.7 4.13 2.5.6 3 1.48 3 2.41 0 .69-.49 1.79-2.7 1.79-2.06 0-2.87-.92-2.98-2.1H6.32c.12 2.19 1.76 3.42 3.68 3.83V21h3v-2.15c1.95-.37 3.5-1.5 3.5-3.55 0-2.84-2.43-3.81-4.7-4.4"/></svg>'}
          </span>
          <div class="activity-body">
            <div>${e.text}</div>
            <div class="when">${timeAgo(e.ts)}</div>
          </div>
        </div>`).join('') || '<div class="empty">No activity yet.</div>'}
    </div>`;

  document.querySelectorAll('#view-home .tappable').forEach(card =>
    card.addEventListener('click', () => {
      if (card.dataset.status) state.statusFilter = card.dataset.status;
      if (card.dataset.stock) { state.stockFilter = card.dataset.stock; }
      if (card.dataset.moneysub) setMoneyTab(card.dataset.moneysub);
      switchView(card.dataset.goto);
      if (card.dataset.status) syncStatusChips();
      if (card.dataset.stock) syncStockChips();
    }));
}

/* ----- MONEY: reports ----- */
async function renderReports() {
  const [orders, products, purchases] = await Promise.all([
    DB.getAll('orders'), DB.getAll('products'), DB.getAll('purchases')
  ]);
  const now = new Date();
  const per = computePeriod();

  const periodOrders = orders.filter(o => o.createdAt >= per.start && o.createdAt < per.end);
  const revenue = periodOrders.reduce((s, o) => s + o.total, 0);
  const periodPurchases = purchases.filter(pu => pu.receivedAt >= per.start && pu.receivedAt < per.end);
  const costs = periodPurchases.reduce((s, pu) => s + (pu.amount || 0), 0);
  const profit = revenue - costs;

  const stockValue = products.reduce((s, p) => {
    if (p.trackStock === false) return s;
    return s + (p.unit === 'weight' ? Math.floor(p.stock / 1000 * (p.price || 0)) : p.stock * (p.price || 0));
  }, 0);

  const monthly = [...Array(6)].map((_, k) => {
    const s = new Date(now.getFullYear(), now.getMonth() - 5 + k, 1).getTime();
    const e = new Date(now.getFullYear(), now.getMonth() - 4 + k, 1).getTime();
    const rev = orders.filter(o => o.createdAt >= s && o.createdAt < e).reduce((sum, o) => sum + o.total, 0);
    const cost = purchases.filter(pu => pu.receivedAt >= s && pu.receivedAt < e).reduce((sum, pu) => sum + (pu.amount || 0), 0);
    return { label: new Date(s).toLocaleDateString(undefined, { month: 'short' }), rev, cost, current: k === 5 };
  });
  const maxRev = Math.max(1, ...monthly.map(m => Math.max(m.rev, m.cost)));

  // Best & worst sellers — excludes items flagged out of reports (Delivery etc.)
  const perf = {};
  periodOrders.forEach(o => o.items.filter(inReports).forEach(i => {
    const lt = i.lineTotal !== undefined ? i.lineTotal : i.qty * i.unitPrice;
    if (!perf[i.name]) perf[i.name] = { name: i.name, revenue: 0, qty: 0, weight: i.unitType === 'weight' };
    perf[i.name].revenue += lt;
    perf[i.name].qty += i.qty;
  }));
  const perfRows = Object.values(perf).sort((a, b) => b.revenue - a.revenue);
  const maxPerf = perfRows.length ? perfRows[0].revenue : 1;
  const topRows = perfRows.slice(0, 5);
  const bottomRows = perfRows.length > 6 ? perfRows.slice(-3) : [];

  const byCat = {};
  periodPurchases.forEach(pu => { const c = pu.category || 'Other'; byCat[c] = (byCat[c] || 0) + (pu.amount || 0); });
  const catRows = Object.entries(byCat).sort((a, b) => b[1] - a[1]);
  const maxCat = catRows.length ? catRows[0][1] : 1;

  $('#money-reports').innerHTML = `
    <div class="chip-row" id="periodChips">
      <button class="chip ${state.period === 'month' ? 'is-selected' : ''}" data-period="month">Month</button>
      <button class="chip ${state.period === 'quarter' ? 'is-selected' : ''}" data-period="quarter">Quarter</button>
      <button class="chip ${state.period === 'year' ? 'is-selected' : ''}" data-period="year">Year</button>
    </div>
    <div class="period-nav">
      <button id="periodPrev" title="Previous">‹</button>
      <span class="label">${per.label}</span>
      <button id="periodNext" title="Next" ${per.off >= 0 ? 'disabled' : ''}>›</button>
    </div>
    <div class="stat-grid">
      <div class="stat-card hero">
        <div class="label">Revenue · ${per.label}</div>
        <div class="value">${fmtMoney(revenue)}</div>
        <div class="hint">${periodOrders.length} order${periodOrders.length === 1 ? '' : 's'}</div>
      </div>
      <div class="stat-card">
        <div class="label">Costs · ${per.label}</div>
        <div class="value">${fmtMoney(costs)}</div>
        <div class="hint">${periodPurchases.length} expense${periodPurchases.length === 1 ? '' : 's'}</div>
      </div>
      <div class="stat-card ${profit < 0 ? 'warn' : ''}">
        <div class="label">Profit · ${per.label}</div>
        <div class="value">${profit < 0 ? '−' + fmtMoney(-profit) : fmtMoney(profit)}</div>
        <div class="hint">revenue − costs</div>
      </div>
      <div class="stat-card">
        <div class="label">Stock value</div>
        <div class="value">${fmtMoney(stockValue)}</div>
        <div class="hint">stock × selling price</div>
      </div>
    </div>
    <h2 class="section-label">Revenue vs costs · last 6 months</h2>
    <div class="card">
      <div class="chart">
        ${monthly.map(m => `
          <div class="chart-col ${m.current ? 'is-current' : ''}">
            <span class="chart-val">${m.rev ? fmtCompact(m.rev) : ''}</span>
            <div class="chart-bars">
              <div class="chart-bar" style="height:${Math.round(m.rev / maxRev * 100)}%"></div>
              <div class="chart-bar cost" style="height:${Math.round(m.cost / maxRev * 100)}%"></div>
            </div>
            <span class="chart-label">${m.label}</span>
          </div>`).join('')}
      </div>
      <div class="chart-legend">
        <span><span class="legend-dot rev"></span>Revenue</span>
        <span><span class="legend-dot cost"></span>Costs</span>
      </div>
    </div>
    ${catRows.length ? `
    <h2 class="section-label">Costs by category · ${per.label}</h2>
    <div class="card">
      ${catRows.map(([c, amt]) => `
        <div class="tc-row">
          <div class="tc-name">${c}</div>
          <div class="tc-track"><div class="tc-fill cost" style="width:${Math.max(4, Math.round(amt / maxCat * 100))}%"></div></div>
          <div class="tc-amount">${fmtMoney(amt)}</div>
        </div>`).join('')}
    </div>` : ''}
    ${topRows.length ? `
    <h2 class="section-label">Top sellers · ${per.label}</h2>
    <div class="card">
      ${topRows.map(r => `
        <div class="tc-row">
          <div class="tc-name">${esc(r.name)}</div>
          <div class="tc-track"><div class="tc-fill" style="width:${Math.max(4, Math.round(r.revenue / maxPerf * 100))}%"></div></div>
          <div class="tc-amount">${fmtMoney(r.revenue)}<div class="sub" style="font-weight:400;font-size:11px;color:var(--md-on-surface-variant)">${r.weight ? fmtGrams(r.qty) : r.qty + '×'}</div></div>
        </div>`).join('')}
    </div>` : ''}
    ${bottomRows.length ? `
    <h2 class="section-label">Slowest movers · ${per.label}</h2>
    <div class="card">
      ${bottomRows.map(r => `
        <div class="tc-row">
          <div class="tc-name">${esc(r.name)}</div>
          <div class="tc-track"><div class="tc-fill" style="width:${Math.max(4, Math.round(r.revenue / maxPerf * 100))}%"></div></div>
          <div class="tc-amount">${fmtMoney(r.revenue)}<div class="sub" style="font-weight:400;font-size:11px;color:var(--md-on-surface-variant)">${r.weight ? fmtGrams(r.qty) : r.qty + '×'}</div></div>
        </div>`).join('')}
    </div>` : ''}`;

  document.querySelectorAll('#periodChips [data-period]').forEach(chip =>
    chip.addEventListener('click', () => { state.period = chip.dataset.period; state.periodOffset = 0; renderReports(); }));
  const prev = $('#periodPrev'), next = $('#periodNext');
  if (prev) prev.onclick = () => { state.periodOffset--; renderReports(); };
  if (next) next.onclick = () => { if (state.periodOffset < 0) { state.periodOffset++; renderReports(); } };
}

/* ----- MONEY: profit split ----- */
/* Waterfall: base (profit or revenue) → minus tax reserve % → minus buffer
   reserve % → remainder split between two shares. All percentages and the
   base are configurable and stored locally. Amounts always sum exactly:
   each step rounds the set-aside and keeps the remainder intact. */
const SPLIT_DEFAULTS = { base: 'profit', taxPct: 7, resPct: 2.5, sharePct: 60, name1: 'Share 1', name2: 'Share 2' };
function splitCfg() {
  try { return { ...SPLIT_DEFAULTS, ...JSON.parse(shared.getItem('erp_split_cfg') || '{}') }; }
  catch { return { ...SPLIT_DEFAULTS }; }
}

async function renderSplit() {
  const [orders, purchases] = await Promise.all([DB.getAll('orders'), DB.getAll('purchases')]);
  const per = computePeriod();
  const cfg = splitCfg();

  const revenue = orders.filter(o => o.createdAt >= per.start && o.createdAt < per.end)
    .reduce((s, o) => s + o.total, 0);
  const costs = purchases.filter(pu => pu.receivedAt >= per.start && pu.receivedAt < per.end)
    .reduce((s, pu) => s + (pu.amount || 0), 0);
  const profit = revenue - costs;
  const base = cfg.base === 'revenue' ? revenue : profit;

  const tax = base > 0 ? Math.round(base * cfg.taxPct / 100) : 0;
  const afterTax = base - tax;
  const reserve = afterTax > 0 ? Math.round(afterTax * cfg.resPct / 100) : 0;
  const toSplit = afterTax - reserve;
  const share1 = toSplit > 0 ? Math.round(toSplit * cfg.sharePct / 100) : 0;
  const share2 = toSplit > 0 ? toSplit - share1 : 0;
  const fmtSigned = n => n < 0 ? '−' + fmtMoney(-n) : fmtMoney(n);

  $('#money-split').innerHTML = `
    <div class="chip-row" id="splitChips">
      <button class="chip ${state.period === 'month' ? 'is-selected' : ''}" data-speriod="month">Month</button>
      <button class="chip ${state.period === 'quarter' ? 'is-selected' : ''}" data-speriod="quarter">Quarter</button>
      <button class="chip ${state.period === 'year' ? 'is-selected' : ''}" data-speriod="year">Year</button>
    </div>
    <div class="period-nav">
      <button id="splitPrev" title="Previous">‹</button>
      <span class="label">${per.label}</span>
      <button id="splitNext" title="Next" ${per.off >= 0 ? 'disabled' : ''}>›</button>
    </div>
    <div class="card">
      <div class="flow-row start">
        <span>${cfg.base === 'revenue' ? 'Revenue' : 'Profit'} · ${per.label}</span>
        <span>${fmtSigned(base)}</span>
      </div>
      <div class="flow-row minus">
        <span>Tax reserve · ${cfg.taxPct}%</span>
        <span>−${fmtMoney(tax)}</span>
      </div>
      <div class="flow-row sub">
        <span>After tax</span>
        <span>${fmtSigned(afterTax)}</span>
      </div>
      <div class="flow-row minus">
        <span>Buffer reserve · ${cfg.resPct}%</span>
        <span>−${fmtMoney(reserve)}</span>
      </div>
      <div class="flow-row sub">
        <span>To distribute</span>
        <span>${fmtSigned(toSplit)}</span>
      </div>
      <div class="flow-row share">
        <span>${esc(cfg.name1)} · ${cfg.sharePct}%</span>
        <span>${fmtMoney(share1)}</span>
      </div>
      <div class="flow-row share">
        <span>${esc(cfg.name2)} · ${(100 - cfg.sharePct).toLocaleString(undefined, { maximumFractionDigits: 2 })}%</span>
        <span>${fmtMoney(share2)}</span>
      </div>
    </div>
    <div class="stat-grid" style="margin-top:12px">
      <div class="stat-card warn">
        <div class="label">Set aside · tax + buffer</div>
        <div class="value">${fmtMoney(tax + reserve)}</div>
        <div class="hint">park this before spending anything</div>
      </div>
      <div class="stat-card">
        <div class="label">Payout total</div>
        <div class="value">${fmtMoney(share1 + share2)}</div>
        <div class="hint">${esc(cfg.name1)} ${fmtMoney(share1)} · ${esc(cfg.name2)} ${fmtMoney(share2)}</div>
      </div>
    </div>
    ${base <= 0 ? '<div class="sub" style="font-size:13px;color:var(--md-on-surface-variant);margin-top:10px">No positive amount this period — nothing is set aside or distributed.</div>' : ''}
    <button class="btn-tonal" id="splitSettings" style="margin-top:14px">Adjust percentages…</button>`;

  document.querySelectorAll('#splitChips [data-speriod]').forEach(chip =>
    chip.addEventListener('click', () => { state.period = chip.dataset.speriod; state.periodOffset = 0; renderSplit(); renderReports(); }));
  $('#splitPrev').onclick = () => { state.periodOffset--; renderSplit(); renderReports(); };
  $('#splitNext').onclick = () => { if (state.periodOffset < 0) { state.periodOffset++; renderSplit(); renderReports(); } };
  $('#splitSettings').onclick = openSplitSettings;
}

function openSplitSettings() {
  const cfg = splitCfg();
  openSheet(`
    <h2>Split settings</h2>
    <div class="form-card">
      <label class="field"><span>Base amount</span>
        <select id="spBase">
          <option value="profit" ${cfg.base === 'profit' ? 'selected' : ''}>Profit (revenue − costs)</option>
          <option value="revenue" ${cfg.base === 'revenue' ? 'selected' : ''}>Revenue</option>
        </select>
      </label>
      <div class="field-row">
        <label class="field"><span>Tax reserve (%)</span>
          <input id="spTax" type="number" min="0" max="100" step="0.1" inputmode="decimal" value="${cfg.taxPct}">
        </label>
        <label class="field"><span>Buffer reserve (%)</span>
          <input id="spRes" type="number" min="0" max="100" step="0.1" inputmode="decimal" value="${cfg.resPct}">
        </label>
      </div>
      <label class="field"><span>First share (%) — the rest goes to the second share</span>
        <input id="spShare" type="number" min="0" max="100" step="0.5" inputmode="decimal" value="${cfg.sharePct}">
      </label>
      <div class="field-row">
        <label class="field"><span>Name first share</span><input id="spName1" value="${esc(cfg.name1)}"></label>
        <label class="field"><span>Name second share</span><input id="spName2" value="${esc(cfg.name2)}"></label>
      </div>
      <button class="btn-filled" id="spSave">Save</button>
    </div>`);
  $('#spSave').onclick = () => {
    const clampPct = v => Math.min(100, Math.max(0, Number(v) || 0));
    shared.setItem('erp_split_cfg', JSON.stringify({
      base: $('#spBase').value,
      taxPct: clampPct($('#spTax').value),
      resPct: clampPct($('#spRes').value),
      sharePct: clampPct($('#spShare').value),
      name1: $('#spName1').value.trim() || 'Share 1',
      name2: $('#spName2').value.trim() || 'Share 2'
    }));
    closeSheet(); snack('Split settings saved'); renderSplit();
  };
}

/* Who paid an expense. 'company' (default for old records) hits the bank
   immediately; a person fronting money only hits the bank once reimbursed. */
const paidByLabel = pb => {
  const cfg = splitCfg();
  return pb === 'p1' ? cfg.name1 : pb === 'p2' ? cfg.name2 : 'Company';
};
const isPersonal = p => p.paidBy === 'p1' || p.paidBy === 'p2';
const hitsBank = p => !isPersonal(p) || p.reimbursed;

/* ----- MONEY: bank balance ----- */
/* The user anchors a real balance at a moment in time. From then on the
   app tracks it live: baseline + order revenue since − expenses since.
   Drift (private spending, fees) is fixed by simply re-anchoring. */
function bankCfg() {
  try { return JSON.parse(shared.getItem('erp_bank')) || null; } catch { return null; }
}
async function computeBank() {
  const cfg = bankCfg();
  if (!cfg) return null;
  const [orders, purchases] = await Promise.all([DB.getAll('orders'), DB.getAll('purchases')]);
  const inflow = orders.filter(o => o.createdAt >= cfg.ts).reduce((s, o) => s + o.total, 0);
  const outflow = purchases.filter(p => p.receivedAt >= cfg.ts && hitsBank(p)).reduce((s, p) => s + (p.amount || 0), 0);
  return { cfg, inflow, outflow, balance: cfg.amount + inflow - outflow, orders, purchases };
}

async function renderBank() {
  const data = await computeBank();
  if (!data) {
    $('#money-bank').innerHTML = `
      <div class="empty">
        <div class="title">Track your bank balance</div>
        <div>Set your current balance once — every order and expense you log will then move it automatically.</div>
        <button class="btn-tonal" id="bankSetup">Set current balance</button>
      </div>`;
    $('#bankSetup').onclick = () => openBankSheet();
    return;
  }

  const { cfg, inflow, outflow, balance, orders, purchases } = data;
  // Ledger: everything that moved the balance since the baseline.
  const moves = [];
  orders.forEach(o => { if (o.createdAt >= cfg.ts) moves.push({ ts: o.createdAt, text: `${orderNo(o)} — ${esc(o.customerName)}`, amt: o.total }); });
  purchases.forEach(p => { if (p.receivedAt >= cfg.ts && hitsBank(p)) moves.push({ ts: p.receivedAt, text: esc(p.description) + (isPersonal(p) ? ' (reimbursed)' : ''), amt: -(p.amount || 0) }); });
  moves.sort((a, b) => b.ts - a.ts);

  $('#money-bank').innerHTML = `
    <div class="stat-grid">
      <div class="stat-card hero">
        <div class="label">Bank balance (tracked)</div>
        <div class="value">${balance < 0 ? '−' + fmtMoney(-balance) : fmtMoney(balance)}</div>
        <div class="hint">baseline ${fmtMoney(cfg.amount)} set ${fmtDate(cfg.ts)} ${fmtTime(cfg.ts)}</div>
      </div>
      <div class="stat-card">
        <div class="label">In since baseline</div>
        <div class="value">${fmtMoney(inflow)}</div>
        <div class="hint">orders</div>
      </div>
      <div class="stat-card">
        <div class="label">Out since baseline</div>
        <div class="value">${fmtMoney(outflow)}</div>
        <div class="hint">expenses</div>
      </div>
    </div>
    <button class="btn-tonal" id="bankUpdate" style="margin-top:12px">Update balance…</button>
    <h2 class="section-label">Movements since baseline</h2>
    <div class="card">
      ${moves.slice(0, 15).map(m => `
        <div class="flow-row" style="padding:8px 4px">
          <span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${m.text}<span style="color:var(--md-on-surface-variant);font-size:12px"> · ${fmtDate(m.ts)}</span></span>
          <span style="flex:none;font-weight:600;${m.amt >= 0 ? 'color:var(--md-primary)' : 'color:var(--md-tertiary)'}">${m.amt >= 0 ? '+' : '−'}${fmtMoney(Math.abs(m.amt))}</span>
        </div>`).join('') || '<div class="empty">Nothing has moved the balance yet.</div>'}
    </div>
    <div class="sub" style="font-size:12.5px;color:var(--md-on-surface-variant);margin-top:10px;padding:0 4px">Doesn't match your real bank? Private spending and fees aren't tracked here, and expenses fronted personally only count once marked reimbursed — just tap “Update balance” and re-enter the real number to re-anchor.</div>`;

  $('#bankUpdate').onclick = () => openBankSheet(balance);
}

function openBankSheet(prefill) {
  const cfg = bankCfg();
  openSheet(`
    <h2>${cfg ? 'Update bank balance' : 'Set bank balance'}</h2>
    <div class="form-card">
      <label class="field"><span>Current balance (฿) — check your banking app and copy it here</span>
        <input id="bkAmount" type="number" step="1" inputmode="numeric" value="${prefill !== undefined ? Math.round(prefill) : (cfg ? cfg.amount : '')}" placeholder="e.g. 45000">
      </label>
      <button class="btn-filled" id="bkSave">${cfg ? 'Re-anchor from now' : 'Start tracking'}</button>
      ${cfg ? '<button class="btn-text danger" id="bkStop">Stop tracking balance</button>' : ''}
      <div class="sub" style="font-size:12.5px;color:var(--md-on-surface-variant)">From this moment, every order adds to this number and every expense subtracts from it. Orders and expenses dated before now don't affect it.</div>
    </div>`);
  $('#bkSave').onclick = () => {
    const amount = Number($('#bkAmount').value);
    if (!Number.isFinite(amount)) return snack('Enter your current balance');
    shared.setItem('erp_bank', JSON.stringify({ amount: Math.round(amount), ts: Date.now() }));
    closeSheet(); snack('Bank balance anchored'); render();
  };
  const stop = $('#bkStop');
  if (stop) stop.onclick = () => {
    shared.removeItem('erp_bank');
    closeSheet(); snack('Balance tracking stopped'); render();
  };
}

/* ----- STOCK: outlook (moved from dashboard) ----- */
async function renderStockOutlook() {
  const [orders, products] = await Promise.all([DB.getAll('orders'), DB.getAll('products')]);
  const OUTLOOK_DAYS = 90;
  const soldSince = Date.now() - OUTLOOK_DAYS * 86400000;
  const soldPer = {};
  orders.forEach(o => {
    if (o.createdAt < soldSince) return;
    o.items.forEach(i => { soldPer[i.productId] = (soldPer[i.productId] || 0) + i.qty; });
  });
  const outlook = products
    .filter(p => p.trackStock !== false && soldPer[p.id] > 0)
    .map(p => { const perDay = soldPer[p.id] / OUTLOOK_DAYS; return { p, perMonth: perDay * 30, daysLeft: p.stock / perDay }; })
    .sort((a, b) => a.daysLeft - b.daysLeft)
    .slice(0, 5);

  $('#stockOutlook').innerHTML = outlook.length ? `
    <details class="section" data-sec="outlook" ${isSecOpen('outlook') ? 'open' : ''}>
    <summary class="section-label">Stock outlook · at current sales pace</summary>
    <div class="card" style="margin-bottom:12px">
      ${outlook.map(x => `
        <div class="tc-row">
          <div class="tc-name">${esc(x.p.name)}</div>
          <div class="tc-track"><div class="tc-fill ${x.daysLeft < 14 ? 'cost' : ''}" style="width:${Math.max(4, Math.min(100, Math.round(x.daysLeft / 60 * 100)))}%"></div></div>
          <div class="tc-amount">${x.p.stock === 0 ? 'out now' : '~' + Math.round(x.daysLeft) + ' days'}<div class="sub" style="font-weight:400;font-size:11px;color:var(--md-on-surface-variant)">sells ${x.p.unit === 'weight' ? fmtGrams(Math.round(x.perMonth)) : Math.round(x.perMonth)}/mo</div></div>
        </div>`).join('')}
      <div class="sub" style="font-size:12px;color:var(--md-on-surface-variant);margin-top:6px">based on the last 90 days — amber = under 2 weeks left</div>
    </div>
    </details>` : '';
  const d = $('#stockOutlook details');
  if (d) d.addEventListener('toggle', () => localStorage.setItem('erp_sec_outlook', d.open ? '1' : '0'));
}

const SEC_DEFAULTS = { outlook: '0' };
const isSecOpen = k => (localStorage.getItem('erp_sec_' + k) ?? SEC_DEFAULTS[k]) === '1';

/* ----- Inventory: products ----- */
// Weight-type products store stock in grams internally; show it humanized.
function fmtStock(p) {
  if (p.unit === 'weight') return fmtGrams(p.stock);
  return String(p.stock);
}

// 'tracked' | 'made' (made to order, never stocked) | 'service' (e.g. Delivery)
const stockMode = p => p.stockMode || (p.trackStock === false ? 'service' : 'tracked');
const MODE_TAGS = { made: 'made to order', service: 'service' };

function stockBadge(p) {
  if (p.trackStock === false) return '';
  if (p.stock === 0) return '<span class="badge badge-out"><span class="dot"></span>Out of stock</span>';
  if (p.stock <= p.lowStock) return `<span class="badge badge-low"><span class="dot"></span>Low stock — ${fmtStock(p)} left</span>`;
  return '';
}

async function renderProducts() {
  const products = await DB.getAll('products');
  const q = state.search.product.toLowerCase();
  let list = products.filter(p =>
    p.name.toLowerCase().includes(q) || (p.sku || '').toLowerCase().includes(q));
  if (state.stockFilter === 'low') list = list.filter(p => p.trackStock !== false && p.stock > 0 && p.stock <= p.lowStock);
  if (state.stockFilter === 'out') list = list.filter(p => p.trackStock !== false && p.stock === 0);
  list.sort((a, b) => a.name.localeCompare(b.name));

  $('#productList').innerHTML = list.map(p => `
    <div class="swipe" data-pid="${p.id}">
      ${SWIPE_PANES}
      <div class="card is-tappable" role="button" tabindex="0">
        <div class="row">
          <div class="row-main">
            <div class="name">${esc(p.name)}</div>
            <div class="sub">${esc(p.sku || 'No SKU')} · ${p.unit === 'weight' ? fmtMoney(p.price / 2) + ' / 500g' : fmtMoney(p.price) + ' / unit'}</div>
            ${stockBadge(p)}
          </div>
          <div class="row-end">
            ${p.trackStock === false
              ? `<div class="big">∞</div><div class="sub">${MODE_TAGS[stockMode(p)]}</div>`
              : `<div class="big">${fmtStock(p)}</div><div class="sub">in stock</div>`}
          </div>
        </div>
      </div>
    </div>`).join('') || `<div class="empty"><div class="title">No products found</div><div>${products.length ? 'Try a different search or filter.' : 'Add your first product with the button below.'}</div></div>`;

  document.querySelectorAll('#productList .swipe[data-pid]').forEach(wrap => {
    const p = list.find(x => x.id === Number(wrap.dataset.pid));
    const card = wrap.querySelector('.card');
    const confirmDelete = () => showConfirm(`Delete “${p.name}”?`, async () => {
      await DB.delete('products', p.id);
      snack('Product deleted'); render();
    });
    card.addEventListener('click', () => openProductForm(p.id));
    attachLongPress(card, () => {
      openSheet(`
        <h2>${esc(p.name)}</h2>
        <div class="form-card">
          ${p.trackStock !== false ? '<button class="btn-tonal" id="ioAddStock">Add stock…</button>' : ''}
          <button class="btn-tonal" id="ioEdit">Edit</button>
          <button class="btn-text danger" id="ioDelete">Delete</button>
        </div>`);
      const a = $('#ioAddStock');
      if (a) a.onclick = () => openAddStockSheet(p);
      $('#ioEdit').onclick = () => { closeSheet(); openProductForm(p.id); };
      $('#ioDelete').onclick = () => { closeSheet(); confirmDelete(); };
    });
  });
}

/* ----- Inventory: incoming purchases (a pure expense log — no stock effect) ----- */
async function renderPurchases() {
  const purchases = await DB.getAll('purchases');
  purchases.sort((a, b) => b.receivedAt - a.receivedAt);
  const cat = p => p.category || 'Other';
  const cfg = splitCfg();

  // Keep the "Paid by" dropdown labels in sync with the split names.
  const sel = $('#poPaidBy');
  if (sel) {
    const cur = sel.value || 'company';
    sel.innerHTML = `<option value="company">Company</option><option value="p1">${esc(cfg.name1)}</option><option value="p2">${esc(cfg.name2)}</option>`;
    sel.value = cur;
  }

  // Outstanding reimbursements per person.
  const owed = { p1: 0, p2: 0 };
  purchases.forEach(p => { if (isPersonal(p) && !p.reimbursed) owed[p.paidBy] += (p.amount || 0); });
  const owedTotal = owed.p1 + owed.p2;
  $('#owedCard').innerHTML = owedTotal > 0 ? `
    <div class="card" style="margin-top:12px;background:var(--md-tertiary-container);color:var(--md-on-tertiary-container)">
      <div style="font-weight:600;margin-bottom:4px">Outstanding reimbursements · ${fmtMoney(owedTotal)}</div>
      ${owed.p1 > 0 ? `<div class="row" style="font-size:14px"><span>${esc(cfg.name1)} fronted</span><span style="font-weight:600">${fmtMoney(owed.p1)}</span></div>` : ''}
      ${owed.p2 > 0 ? `<div class="row" style="font-size:14px"><span>${esc(cfg.name2)} fronted</span><span style="font-weight:600">${fmtMoney(owed.p2)}</span></div>` : ''}
      <div style="font-size:12px;opacity:.8;margin-top:6px">long-press an expense to mark it reimbursed</div>
    </div>` : '';

  let list = purchases;
  if (state.purchaseFilter === '__owed') list = purchases.filter(p => isPersonal(p) && !p.reimbursed);
  else if (state.purchaseFilter !== 'all') list = purchases.filter(p => cat(p) === state.purchaseFilter);

  $('#purchaseList').innerHTML = list.slice(0, 50).map(p => `
    <div class="swipe" data-puid="${p.id}">
      <div class="card is-tappable">
        <div class="row">
          <div class="row-main">
            <div class="name">${esc(p.description)}</div>
            <div class="sub">${cat(p)}${p.supplier ? ' · ' + esc(p.supplier) : ''} · ${fmtDate(p.receivedAt)}</div>
            ${isPersonal(p) ? (p.reimbursed
              ? `<span class="badge badge-ok"><span class="dot"></span>Paid by ${esc(paidByLabel(p.paidBy))} · reimbursed</span>`
              : `<span class="badge badge-low"><span class="dot"></span>Paid by ${esc(paidByLabel(p.paidBy))} · not reimbursed</span>`) : ''}
          </div>
          <div class="row-end"><div class="big">${fmtMoney(p.amount)}</div></div>
        </div>
      </div>
    </div>`).join('') || `<div class="empty"><div class="title">No expenses found</div><div>${purchases.length ? 'Try a different filter.' : 'Money you spend (stock, materials, equipment…) will appear here.'}</div></div>`;

  document.querySelectorAll('#purchaseList .swipe[data-puid]').forEach(wrap => {
    const p = purchases.find(x => x.id === Number(wrap.dataset.puid));
    const card = wrap.querySelector('.card');
    const confirmDelete = () => showConfirm(`Delete expense “${p.description}” (${fmtMoney(p.amount)})?`, async () => {
      await DB.delete('purchases', p.id);
      snack('Expense deleted'); render();
    });
    card.addEventListener('click', () => openPurchaseForm(p));
    attachLongPress(card, () => {
      const canReimburse = isPersonal(p) && !p.reimbursed;
      openSheet(`
        <h2>${esc(p.description)}</h2>
        <div class="form-card">
          ${canReimburse ? '<button class="btn-tonal" id="ioReimburse">Mark as reimbursed</button>' : ''}
          <button class="btn-tonal" id="ioEdit">Edit</button>
          <button class="btn-text danger" id="ioDelete">Delete</button>
        </div>`);
      const r = $('#ioReimburse');
      if (r) r.onclick = async () => {
        p.reimbursed = true;
        await DB.put('purchases', p);
        closeSheet(); snack(`Reimbursed — ${paidByLabel(p.paidBy)} is paid back ${fmtMoney(p.amount)}`); render();
      };
      $('#ioEdit').onclick = () => { closeSheet(); openPurchaseForm(p); };
      $('#ioDelete').onclick = () => { closeSheet(); confirmDelete(); };
    });
  });

  // Prefill the log form's date with today
  if (!$('#poDate').value) $('#poDate').value = tsToDateInput(Date.now());
}

const CATEGORY_OPTIONS = ['Materials', 'Packaging', 'Equipment', 'Shipping', 'Other'];

/* Edit an existing expense entry. */
function openPurchaseForm(p) {
  const cfg = splitCfg();
  const pb = p.paidBy || 'company';
  openSheet(`
    <h2>Edit expense</h2>
    <div class="form-card">
      <label class="field"><span>What did you buy</span><input id="peDescription" value="${esc(p.description)}"></label>
      <div class="field-row">
        <label class="field"><span>Amount spent (฿)</span><input id="peAmount" type="number" min="0" step="1" inputmode="numeric" value="${p.amount}"></label>
        <label class="field"><span>Category</span>
          <select id="peCategory">${CATEGORY_OPTIONS.map(c => `<option value="${c}" ${(p.category || 'Other') === c ? 'selected' : ''}>${c}</option>`).join('')}</select>
        </label>
      </div>
      <div class="field-row">
        <label class="field"><span>Date</span><input type="date" id="peDate" value="${tsToDateInput(p.receivedAt)}"></label>
        <label class="field"><span>Paid by</span>
          <select id="pePaidBy">
            <option value="company" ${pb === 'company' ? 'selected' : ''}>Company</option>
            <option value="p1" ${pb === 'p1' ? 'selected' : ''}>${esc(cfg.name1)}</option>
            <option value="p2" ${pb === 'p2' ? 'selected' : ''}>${esc(cfg.name2)}</option>
          </select>
        </label>
      </div>
      <label class="field-checkbox" id="peReimburseWrap" ${pb === 'company' ? 'hidden' : ''}>
        <input type="checkbox" id="peReimbursed" ${p.reimbursed ? 'checked' : ''}>
        <span>Reimbursed — the company has paid this person back</span>
      </label>
      <label class="field"><span>Supplier (optional)</span><input id="peSupplier" value="${esc(p.supplier || '')}"></label>
      <button class="btn-filled" id="peSave">Save changes</button>
    </div>`);
  $('#pePaidBy').onchange = e => { $('#peReimburseWrap').hidden = e.target.value === 'company'; };
  $('#peSave').onclick = async () => {
    const description = $('#peDescription').value.trim();
    const amount = Number($('#peAmount').value);
    const ts = dateInputToTs($('#peDate').value);
    if (!description) return snack('Enter what you bought');
    if (!(amount > 0)) return snack('Enter an amount greater than 0');
    if (!ts) return snack('Pick a date');
    const paidBy = $('#pePaidBy').value;
    await DB.put('purchases', {
      ...p, description, amount, category: $('#peCategory').value,
      paidBy, reimbursed: paidBy === 'company' ? false : $('#peReimbursed').checked,
      supplier: $('#peSupplier').value.trim(), receivedAt: ts
    });
    closeSheet(); snack('Expense updated'); render();
  };
}

$('#poReceive').addEventListener('click', async () => {
  const description = $('#poDescription').value.trim();
  const amount = Number($('#poAmount').value);
  const ts = dateInputToTs($('#poDate').value);
  if (!description) return snack('Enter what you bought');
  if (!(amount > 0)) return snack('Enter an amount greater than 0');
  if (!ts) return snack('Pick a date');

  const paidBy = $('#poPaidBy').value;
  await DB.add('purchases', {
    description, amount,
    category: $('#poCategory').value,
    paidBy, reimbursed: false,
    supplier: $('#poSupplier').value.trim(),
    receivedAt: ts
  });
  $('#poDescription').value = ''; $('#poAmount').value = ''; $('#poSupplier').value = '';
  $('#poDate').value = tsToDateInput(Date.now());
  snack(paidBy === 'company'
    ? `Logged ${fmtMoney(amount)} — ${description}`
    : `Logged ${fmtMoney(amount)} — fronted by ${paidByLabel(paidBy)} (not reimbursed yet)`);
  render();
});


/* Quick stock receipt: enter how much CAME IN, not the new total. */
function openAddStockSheet(p) {
  const isW = p.unit === 'weight';
  openSheet(`
    <h2>Add stock — ${esc(p.name)}</h2>
    <div class="form-card">
      <div class="sub" style="color:var(--md-on-surface-variant);margin-top:-8px">Currently ${fmtStock(p)} in stock. Enter what's being added.</div>
      ${isW ? `
      <div class="field-row">
        <label class="field"><span>Quantity to add</span><input id="asQty" type="number" min="0.001" step="0.001" inputmode="decimal" value="1"></label>
        <label class="field"><span>Unit</span><select id="asUnit"><option value="kg" selected>kg</option><option value="g">g</option></select></label>
      </div>` : `
      <label class="field"><span>Pieces to add</span><input id="asQty" type="number" min="1" inputmode="numeric" value="1"></label>`}
      <button class="btn-filled" id="asSave">Add to stock</button>
    </div>`);
  $('#asSave').onclick = async () => {
    const raw = Number($('#asQty').value);
    if (!(raw > 0)) return snack('Enter a quantity greater than 0');
    const grams = isW ? ($('#asUnit').value === 'kg' ? Math.round(raw * 1000) : Math.round(raw)) : raw;
    const fresh = await DB.get('products', p.id);
    await DB.addStock(p.id, grams);
    // New stock first goes to orders that were waiting for it.
    let allocMsg = '';
    const allocations = await DB.allocatePending(p.id);
    if (allocations.length) {
      const total = allocations.reduce((s, a) => s + a.qty, 0);
      allocMsg = ` — ${isW ? fmtGrams(total) : total + ' unit' + (total === 1 ? '' : 's')} went to waiting orders`;
    }
    const after = await DB.get('products', p.id);
    closeSheet();
    snack(`Added ${isW ? fmtGrams(grams) : grams + '×'} ${fresh.name} (now ${fmtStock(after)})${allocMsg}`);
    render();
  };
}

/* ----- Product form ----- */
async function openProductForm(id) {
  const p = id ? await DB.get('products', id) : { name: '', sku: '', price: '', unit: 'pcs', stock: 0, lowStock: 5, trackStock: true };
  const tracked = p.trackStock !== false;
  const unitType = p.unit === 'weight' ? 'weight' : 'pcs';
  let weightUnit = p.stock >= 1000 || p.lowStock >= 1000 || !p.stock ? 'kg' : 'g'; // display preference

  function stockFieldsHTML(ut, isTracked) {
    if (!isTracked) return '';
    if (ut === 'weight') {
      const div = weightUnit === 'kg' ? 1000 : 1;
      return `
        <div class="field-row">
          <label class="field"><span>Stock on hand</span><input id="pfStock" type="number" min="0" step="0.001" inputmode="decimal" value="${(p.stock || 0) / div}"></label>
          <label class="field"><span>Low-stock at</span><input id="pfLow" type="number" min="0" step="0.001" inputmode="decimal" value="${(p.lowStock || 0) / div}"></label>
        </div>
        <label class="field"><span>Entered in</span>
          <select id="pfWeightUnit"><option value="kg" ${weightUnit === 'kg' ? 'selected' : ''}>kg</option><option value="g" ${weightUnit === 'g' ? 'selected' : ''}>g</option></select>
        </label>`;
    }
    return `
      <div class="field-row">
        <label class="field"><span>Stock on hand</span><input id="pfStock" type="number" min="0" inputmode="numeric" value="${p.stock}"></label>
        <label class="field"><span>Low-stock alert at</span><input id="pfLow" type="number" min="0" inputmode="numeric" value="${p.lowStock}"></label>
      </div>`;
  }

  openSheet(`
    <h2>${id ? 'Edit product' : 'New product'}</h2>
    <div class="form-card">
      <label class="field"><span>Name</span><input id="pfName" value="${esc(p.name)}" placeholder="e.g. Oak shelf 80 cm"></label>
      <div class="field-row">
        <label class="field"><span>SKU (optional)</span><input id="pfSku" value="${esc(p.sku || '')}" placeholder="OAK-80"></label>
        <label class="field"><span id="pfPriceLabel">${unitType === 'weight' ? 'Price per 500g (฿)' : 'Unit price (฿)'}</span><input id="pfPrice" type="number" min="0" step="0.5" inputmode="decimal" value="${unitType === 'weight' ? p.price / 2 : p.price}"></label>
      </div>
      <label class="field"><span>Unit type</span>
        <select id="pfUnitType">
          <option value="pcs" ${unitType === 'pcs' ? 'selected' : ''}>Pieces</option>
          <option value="weight" ${unitType === 'weight' ? 'selected' : ''}>Weight (grams / kilograms)</option>
        </select>
      </label>
      <div id="pfPackWrap">${unitType === 'weight' ? `
        <label class="field"><span>Pack size on receipt (g) — e.g. 500 shows “(500g ฿…)”</span>
          <input id="pfPack" type="number" min="1" inputmode="numeric" value="${p.packG || 500}">
        </label>` : ''}
      </div>
      <label class="field"><span>Stock handling</span>
        <select id="pfStockMode">
          <option value="tracked" ${stockMode(p) === 'tracked' ? 'selected' : ''}>Track stock</option>
          <option value="made" ${stockMode(p) === 'made' ? 'selected' : ''}>Made to order — never stocked</option>
          <option value="service" ${stockMode(p) === 'service' ? 'selected' : ''}>Service / fee — e.g. Delivery</option>
        </select>
      </label>
      <div id="pfStockFields">${stockFieldsHTML(unitType, tracked)}</div>
      <label class="field-checkbox">
        <input type="checkbox" id="pfExclude" ${p.excludeReports ? 'checked' : ''}>
        <span>Exclude from sales reports — for shipping fees & extras that shouldn't count as a product sold</span>
      </label>
      <button class="btn-filled" id="pfSave">${id ? 'Save changes' : 'Add product'}</button>
      ${id ? '<button class="btn-text danger" id="pfDelete">Delete product</button>' : ''}
    </div>`);

  function redraw() {
    $('#pfStockFields').innerHTML = stockFieldsHTML($('#pfUnitType').value, $('#pfStockMode').value === 'tracked');
    $('#pfPriceLabel').textContent = $('#pfUnitType').value === 'weight' ? 'Price per 500g (฿)' : 'Unit price (฿)';
    const curPack = $('#pfPack') ? Number($('#pfPack').value) || 500 : (p.packG || 500);
    $('#pfPackWrap').innerHTML = $('#pfUnitType').value === 'weight' ? `
      <label class="field"><span>Pack size on receipt (g) — e.g. 500 shows “(500g ฿…)”</span>
        <input id="pfPack" type="number" min="1" inputmode="numeric" value="${curPack}">
      </label>` : '';
    bindWeightUnitToggle();
  }
  function bindWeightUnitToggle() {
    const sel = $('#pfWeightUnit');
    if (!sel) return;
    sel.onchange = e => {
      const newUnit = e.target.value;
      ['pfStock', 'pfLow'].forEach(id => {
        const el = $('#' + id);
        const grams = weightUnit === 'kg' ? Number(el.value || 0) * 1000 : Number(el.value || 0);
        el.value = newUnit === 'kg' ? grams / 1000 : grams;
      });
      weightUnit = newUnit;
    };
  }
  bindWeightUnitToggle();
  $('#pfUnitType').onchange = redraw;
  $('#pfStockMode').onchange = redraw;

  $('#pfSave').onclick = async () => {
    const name = $('#pfName').value.trim();
    const priceInput = Number($('#pfPrice').value);
    // Weight products are entered per 500g but stored per kg internally,
    // so existing orders and totals keep their exact meaning.
    const price = $('#pfUnitType') && $('#pfUnitType').value === 'weight' ? Math.round(priceInput * 2) : priceInput;
    if (!name) return snack('Give the product a name');
    if (!(price >= 0)) return snack('Enter a valid unit price');

    const finalUnitType = $('#pfUnitType').value;
    const mode = $('#pfStockMode').value;
    const trackStock = mode === 'tracked';
    let stock = 0, lowStock = 0;
    if (trackStock) {
      if (finalUnitType === 'weight') {
        const factor = weightUnit === 'kg' ? 1000 : 1;
        stock = Math.max(0, Math.round((Number($('#pfStock').value) || 0) * factor));
        lowStock = Math.max(0, Math.round((Number($('#pfLow').value) || 0) * factor));
      } else {
        stock = Math.max(0, Number($('#pfStock').value) || 0);
        lowStock = Math.max(0, Number($('#pfLow').value) || 0);
      }
    }

    const record = {
      ...(id ? { id } : {}),
      name, sku: $('#pfSku').value.trim(), price, trackStock, stockMode: mode,
      unit: finalUnitType, stock, lowStock,
      excludeReports: $('#pfExclude').checked,
      packG: finalUnitType === 'weight' ? Math.max(1, Number($('#pfPack') && $('#pfPack').value) || 500) : undefined,
      isDelivery: p.isDelivery || false
    };
    const savedId = await DB.put('products', record);
    // New stock first goes to orders that were waiting for it (oldest first).
    let allocMsg = '';
    if (record.trackStock && record.stock > 0) {
      const allocations = await DB.allocatePending(id || savedId);
      if (allocations.length) {
        const total = allocations.reduce((s, a) => s + a.qty, 0);
        const orderIds = [...new Set(allocations.map(a => '#' + a.orderId))].join(', ');
        allocMsg = ` — ${total} unit${total === 1 ? '' : 's'} assigned to waiting order${orderIds.includes(',') ? 's' : ''} ${orderIds}`;
      }
    }
    closeSheet(); snack((id ? 'Product saved' : 'Product added') + allocMsg); render();
  };
  const del = $('#pfDelete');
  if (del) del.onclick = async () => {
    await DB.delete('products', id);
    closeSheet(); snack('Product deleted'); render();
  };
}

/* ----- Orders ----- */
function railHTML(order) {
  const idx = STATUSES.indexOf(order.status);
  const last = STATUSES.length - 1;
  return `
    <div class="rail">
      ${STATUSES.map((s, i) => `<div class="rail-seg ${i < idx ? 'is-done' : i === idx ? (idx === last ? 'is-done' : 'is-current') : ''}"></div>`).join('')}
    </div>
    <div class="rail-labels"><span>Production</span><span>Ready</span><span>Shipped</span><span>Delivered</span></div>
    <div class="rail-status ${idx === last ? 'is-completed' : ''}">${order.status}</div>
    ${idx < last ? `<button class="advance-btn" data-advance="${order.id}">Mark as “${STATUSES[idx + 1]}”</button>` : ''}`;
}

async function renderOrders() {
  const orders = await DB.getAll('orders');
  const q = state.search.order.toLowerCase();
  let list = orders.filter(o =>
    o.customerName.toLowerCase().includes(q) ||
    String(o.seq ?? o.id).includes(q) ||
    orderNo(o).toLowerCase().includes(q) ||
    o.items.some(i => i.name.toLowerCase().includes(q)));
  if (state.statusFilter === 'open') list = list.filter(o => o.status !== 'Delivered');
  else if (state.statusFilter !== 'all') list = list.filter(o => o.status === state.statusFilter);
  list.sort((a, b) => b.createdAt - a.createdAt);

  $('#orderList').innerHTML = list.map(o => {
    const waiting = o.items.filter(i => i.pendingQty > 0);
    return `
    <div class="swipe" data-oid="${o.id}">
      ${SWIPE_PANES}
      <div class="card">
      <div class="row">
        <div class="row-main">
          <div class="name">${orderNo(o)} · ${esc(o.customerName)}</div>
          <div class="sub">${esc(o.address)}</div>
          <div class="sub">${o.items.map(i => itemLabel(i)).join(', ')}</div>
          ${waiting.length ? `<span class="badge badge-low"><span class="dot"></span>Awaiting stock: ${waiting.map(i => itemLabel(i, i.pendingQty)).join(', ')}</span>` : ''}
        </div>
        <div class="row-end">
          <div class="big">${fmtMoney(o.total)}</div>
          <div class="sub">${fmtDate(o.createdAt)} · ${fmtTime(o.createdAt)}</div>
          ${o.discountPct > 0 ? `<div class="sub">${o.discountPct}% discount</div>` : ''}
        </div>
      </div>
      ${railHTML(o)}
      </div>
    </div>`;
  }).join('') || `<div class="empty"><div class="title">No orders found</div><div>${orders.length ? (state.statusFilter === 'open' ? 'All orders are delivered — tap “All” to see them.' : 'Try a different search or status filter.') : 'Create your first order with the button below.'}</div></div>`;

  document.querySelectorAll('#orderList .swipe[data-oid]').forEach(wrap => {
    const o = list.find(x => x.id === Number(wrap.dataset.oid));
    const card = wrap.querySelector('.card');
    card.classList.add('is-tappable');
    card.addEventListener('click', () => openOrderOptions(o));
    attachLongPress(card, () => openOrderOptions(o));
  });

  document.querySelectorAll('[data-advance]').forEach(btn =>
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const o = await DB.get('orders', Number(btn.dataset.advance));
      const next = STATUSES[STATUSES.indexOf(o.status) + 1];
      o.status = next; o.statusChangedAt = Date.now();
      await DB.put('orders', o);
      snack(`${orderNo(o)} → ${next}`);
      render();
    }));
}

/* Small long-press menu: Edit / Delete. */
function openItemOptions(title, { onEdit, onDelete }) {
  openSheet(`
    <h2>${esc(title)}</h2>
    <div class="form-card">
      <button class="btn-tonal" id="ioEdit">Edit</button>
      <button class="btn-text danger" id="ioDelete">Delete</button>
    </div>`);
  $('#ioEdit').onclick = () => { closeSheet(); onEdit(); };
  $('#ioDelete').onclick = () => { closeSheet(); onDelete(); };
}

/* ----- Receipt sharing ----- */
/* Format (per the owner's spec):
   1x Chili Sticks (500g ฿995) = 1850g ฿3.680     ← weight item, pack reference
   2x Biltong Beef Fatty 500g ฿1.590              ← pieces item, line total
   1x Shipping free                                ← zero-priced line
   Discount 12.5%
   Total (฿11.420-12.5%) = ฿9.990
   + configurable payment footer                                        */
function buildReceipt(order, products) {
  const fmtN = n => n.toLocaleString('de-DE'); // 3.680-style thousands separator
  const itemLines = order.items.map(i => {
    const lt = i.lineTotal !== undefined ? i.lineTotal : i.qty * i.unitPrice;
    if (i.unitType === 'weight') {
      const p = products.find(x => x.id === i.productId);
      const pack = (p && p.packG) || 500;
      const packPrice = Math.round(i.unitPrice * pack / 1000);
      return `1x ${i.name} (${pack}g ฿${fmtN(packPrice)}) = ${i.qty}g ฿${fmtN(lt)}`;
    }
    return `${i.qty}x ${i.name}${lt === 0 ? ' free' : ' ฿' + fmtN(lt)}`;
  });

  const parts = [itemLines.join('\n')];
  if (order.discountPct > 0) parts.push(`\nDiscount ${order.discountPct}%`);
  const sub = order.subtotal !== undefined ? order.subtotal : order.total;
  parts.push('\n' + (order.discountPct > 0
    ? `Total (฿${fmtN(sub)}-${order.discountPct}%) = ฿${fmtN(order.total)}`
    : `Total = ฿${fmtN(order.total)}`));

  const footer = shared.getItem('erp_receipt_footer');
  if (footer && footer.trim()) parts.push('\n' + footer.trim());
  return parts.join('\n');
}

async function shareReceipt(o) {
  const products = await DB.getAll('products');
  const text = buildReceipt(o, products);
  if (navigator.share) {
    try { await navigator.share({ text }); } catch (e) { /* user cancelled */ }
  } else if (navigator.clipboard) {
    await navigator.clipboard.writeText(text);
    snack('Receipt copied to clipboard');
  } else {
    openSheet(`<h2>Receipt</h2><pre style="white-space:pre-wrap;font-family:inherit">${esc(text)}</pre>`);
  }
}

/* Compact searchable customer picker: replaces the native <select>, whose
   OS popup covers the whole screen once the customer list grows. Renders a
   small scrollable dropdown under the field instead. */
function attachCustomerPicker({ input, drop, customers, allowNew, onPick, onType, onNew }) {
  const render = () => {
    const t = input.value.trim().toLowerCase();
    const hits = customers
      .filter(c => !t || c.name.toLowerCase().includes(t) || (c.phone || '').includes(t))
      .slice(0, 6);
    const exact = customers.some(c => c.name.toLowerCase() === t);
    drop.innerHTML =
      (allowNew && t && !exact ? `<div class="combo-item combo-new" data-new>＋ Create “${esc(input.value.trim())}” as new customer</div>` : '') +
      hits.map(c => `<div class="combo-item" data-cid="${c.id}"><div>${esc(c.name)}</div>${c.phone ? `<div class="sub">${esc(c.phone)}</div>` : ''}</div>`).join('') +
      (!hits.length && !allowNew ? '<div class="combo-item" style="color:var(--md-on-surface-variant)">No matching customers</div>' : '');
    drop.hidden = false;
    drop.querySelectorAll('[data-cid]').forEach(el => el.addEventListener('pointerdown', e => {
      e.preventDefault();
      const c = customers.find(x => x.id === Number(el.dataset.cid));
      input.value = c.name;
      drop.hidden = true;
      input.blur();
      onPick(c);
    }));
    const n = drop.querySelector('[data-new]');
    if (n) n.addEventListener('pointerdown', e => {
      e.preventDefault();
      drop.hidden = true;
      input.blur();
      if (onType) onType(input.value.trim());
      if (onNew) onNew(input.value.trim());
    });
  };
  input.addEventListener('focus', render);
  input.addEventListener('input', () => { render(); if (onType) onType(input.value.trim()); });
  input.addEventListener('blur', () => setTimeout(() => { drop.hidden = true; }, 150));
}

/* ----- Order edit (customer, address, items, discount) ----- */
async function openOrderEdit(o) {
  const [products, customers] = await Promise.all([DB.getAll('products'), DB.getAll('customers')]);
  if (!products.length) return snack('No products available');
  products.sort((a, b) => a.name.localeCompare(b.name));

  const isWeight = p => p.unit === 'weight';
  const newLine = (p = products[0]) => ({
    productId: p.id,
    qty: isWeight(p) ? 1000 : 1,
    unitPrice: p.price,
    weightBased: isWeight(p)
  });

  // Start from the order's current items; skip items whose product was
  // deleted since (we can't reprice or restock those sensibly).
  let dropped = 0;
  let lines = o.items.map(i => {
    if (!products.find(p => p.id === i.productId)) { dropped++; return null; }
    return { productId: i.productId, qty: i.qty, unitPrice: i.unitPrice, weightBased: i.unitType === 'weight' };
  }).filter(Boolean);
  if (!lines.length) lines = [newLine()];
  if (dropped) snack(`${dropped} item(s) reference a deleted product and were left out`);

  const productOptions = sel => products.map(p =>
    `<option value="${p.id}" ${p.id === sel ? 'selected' : ''}>${esc(p.name)} (${p.trackStock === false ? MODE_TAGS[stockMode(p)] : fmtStock(p) + ' left'})</option>`).join('');

  openSheet(`
    <h2>Edit ${orderNo(o)}</h2>
    <div class="form-card">
      <label class="field" style="position:relative"><span>Customer</span>
        <input id="oeCustomerSearch" value="${esc(o.customerName)}" placeholder="Search customers" autocomplete="off">
        <div class="combo-drop" id="oeCustomerDrop" hidden></div>
      </label>
      <label class="field"><span>Delivery address</span><input id="oeAddress" value="${esc(o.address)}"></label>
      <h2 class="section-label" style="margin:8px 0 0">Items</h2>
      <div id="oeLines"></div>
      <button class="btn-tonal" id="oeAddLine">＋ Add item</button>
      <label class="field" style="margin-top:4px"><span>Discount (%)</span>
        <input id="oeDiscount" type="number" min="0" max="100" step="0.5" inputmode="decimal" value="${o.discountPct || 0}">
      </label>
      <div id="oeTotals"></div>
      <div class="sub" style="font-size:12.5px;color:var(--md-on-surface-variant)">${o.skipStock ? 'This order was created without touching stock — edits leave stock alone too.' : 'Stock is adjusted automatically: removed items go back, added items are taken (or marked awaiting).'}</div>
      <button class="btn-filled" id="oeSave">Save changes</button>
    </div>`);

  const linesEl = $('#oeLines');

  function drawLines() {
    linesEl.innerHTML = lines.map((l, i) => l.weightBased ? `
      <div class="line-item" style="margin-bottom:2px">
        <label class="field"><span>Product</span><select data-li="${i}" data-k="productId">${productOptions(l.productId)}</select></label>
        <label class="field"><span>Weight (g)</span><input data-li="${i}" data-k="qty" type="number" min="1" inputmode="numeric" value="${l.qty}"></label>
        <label class="field"><span>฿ / 500g</span><input data-li="${i}" data-k="unitPrice" type="number" min="0" step="0.5" inputmode="decimal" value="${l.unitPrice / 2}"></label>
        <button class="remove" data-rm="${i}" title="Remove item">✕</button>
      </div>
      <div class="line-hint" style="margin-bottom:10px">= ${fmtMoney(lineTotal(l))} (${fmtGrams(l.qty || 0)} at ${fmtMoney((l.unitPrice || 0) / 2)}/500g, rounded down)</div>` : `
      <div class="line-item" style="margin-bottom:10px">
        <label class="field"><span>Product</span><select data-li="${i}" data-k="productId">${productOptions(l.productId)}</select></label>
        <label class="field"><span>Qty</span><input data-li="${i}" data-k="qty" type="number" min="1" inputmode="numeric" value="${l.qty}"></label>
        <label class="field"><span>Unit price (฿)</span><input data-li="${i}" data-k="unitPrice" type="number" min="0" step="1" inputmode="numeric" value="${l.unitPrice}"></label>
        <button class="remove" data-rm="${i}" title="Remove item">✕</button>
      </div>`).join('');

    linesEl.querySelectorAll('[data-li]').forEach(el => el.addEventListener('input', () => {
      const i = Number(el.dataset.li), k = el.dataset.k;
      lines[i][k] = (k === 'unitPrice' && lines[i].weightBased) ? Number(el.value) * 2 : Number(el.value);
      if (k === 'productId') {
        const p = products.find(p => p.id === lines[i].productId);
        lines[i] = newLine(p);
        drawLines();
      } else if (lines[i].weightBased) {
        const hint = el.closest('.line-item').nextElementSibling;
        if (hint) hint.textContent = `= ${fmtMoney(lineTotal(lines[i]))} (${fmtGrams(lines[i].qty || 0)} at ${fmtMoney((lines[i].unitPrice || 0) / 2)}/500g, rounded down)`;
      }
      updateTotal();
    }));
    linesEl.querySelectorAll('[data-rm]').forEach(el => el.addEventListener('click', () => {
      lines.splice(Number(el.dataset.rm), 1);
      if (!lines.length) lines = [newLine()];
      drawLines(); updateTotal();
    }));
    updateTotal();
  }
  function updateTotal() {
    const subtotal = lines.reduce((s, l) => s + lineTotal(l), 0);
    const pct = Math.min(100, Math.max(0, Number($('#oeDiscount').value) || 0));
    const discount = Math.ceil(subtotal * pct / 100);
    const total = subtotal - discount;
    $('#oeTotals').innerHTML = pct > 0 ? `
      <div class="order-total" style="font-weight:400;font-size:14px;color:var(--md-on-surface-variant)"><span>Subtotal</span><span>${fmtMoney(subtotal)}</span></div>
      <div class="order-total" style="font-weight:400;font-size:14px;color:var(--md-on-surface-variant)"><span>Discount ${pct}%</span><span>−${fmtMoney(discount)}</span></div>
      <div class="order-total"><span>Total</span><span>${fmtMoney(total)}</span></div>` : `
      <div class="order-total"><span>Total</span><span>${fmtMoney(total)}</span></div>`;
  }

  $('#oeAddLine').onclick = () => { lines.push(newLine()); drawLines(); };
  $('#oeDiscount').addEventListener('input', updateTotal);
  let ePicked = customers.find(c => c.id === o.customerId) || null;
  attachCustomerPicker({
    input: $('#oeCustomerSearch'),
    drop: $('#oeCustomerDrop'),
    customers, allowNew: false,
    onPick: c => {
      ePicked = c;
      if (c.address) $('#oeAddress').value = c.address;
    }
  });
  // If they typed but didn't pick anyone, snap back to the last valid choice.
  $('#oeCustomerSearch').addEventListener('blur', () => setTimeout(() => {
    $('#oeCustomerSearch').value = ePicked ? ePicked.name : o.customerName;
  }, 160));
  drawLines();

  $('#oeSave').onclick = async () => {
    const customerId = ePicked ? ePicked.id : o.customerId;
    const customer = ePicked || { id: o.customerId, name: o.customerName };
    const address = $('#oeAddress').value.trim();
    if (!address) return snack('Enter a delivery address');

    const items = lines
      .filter(l => l.qty > 0)
      .map(l => {
        const p = products.find(p => p.id === l.productId);
        return {
          productId: p.id, name: p.name,
          qty: l.qty, unitPrice: l.unitPrice,
          unitType: l.weightBased ? 'weight' : 'pcs',
          excludeReports: !!p.excludeReports,
          lineTotal: lineTotal(l)
        };
      });
    if (!items.length) return snack('Add at least one item');

    const subtotal = items.reduce((s, i) => s + i.lineTotal, 0);
    const discountPct = Math.min(100, Math.max(0, Number($('#oeDiscount').value) || 0));
    const total = subtotal - Math.ceil(subtotal * discountPct / 100);

    await DB.updateOrderItems(o.id, {
      customerId, customerName: customer.name, address,
      items, subtotal, discountPct, total
    });
    closeSheet(); snack(`${orderNo(o)} updated`); render();
  };
}

/* ----- Order options (long-press / swipe-edit) ----- */
function openOrderOptions(o) {
  const hasWeight = o.items.some(i => i.unitType === 'weight');
  openSheet(`
    <h2>${orderNo(o)} · ${esc(o.customerName)}</h2>
    <div class="form-card">
      <button class="btn-tonal" id="ooEdit">Edit order…</button>
      <button class="btn-tonal" id="ooShare">Share receipt</button>
      <button class="btn-tonal" id="ooDate">Change order date & time</button>
      <button class="btn-tonal" id="ooNumber">Change order number</button>
      ${hasWeight ? '<button class="btn-tonal" id="ooWeights">Adjust sold weights</button>' : ''}
      <button class="btn-text danger" id="ooDelete">Delete order</button>
    </div>`);

  $('#ooEdit').onclick = () => openOrderEdit(o);
  $('#ooShare').onclick = () => shareReceipt(o);

  $('#ooDate').onclick = () => {
    openSheet(`
      <h2>Change order date & time</h2>
      <div class="form-card">
        <div class="field-row">
          <label class="field"><span>Date</span><input type="date" id="odDate" value="${tsToDateInput(o.createdAt)}"></label>
          <label class="field"><span>Time</span><input type="time" id="odTime" value="${tsToTimeInput(o.createdAt)}"></label>
        </div>
        <button class="btn-filled" id="odSave">Save</button>
      </div>`);
    $('#odSave').onclick = async () => {
      const dStr = $('#odDate').value, tStr = $('#odTime').value || '12:00';
      if (!dStr) return snack('Pick a date');
      const [y, m, d] = dStr.split('-').map(Number);
      const [hh, mm] = tStr.split(':').map(Number);
      o.createdAt = new Date(y, m - 1, d, hh, mm).getTime();
      await DB.put('orders', o);
      closeSheet(); snack(`Order moved to ${fmtDate(o.createdAt)} ${fmtTime(o.createdAt)}`); render();
    };
  };

  $('#ooNumber').onclick = () => {
    openSheet(`
      <h2>Change order number</h2>
      <div class="form-card">
        <label class="field"><span>New sequence number for ${orderNo(o)}</span>
          <input type="number" id="onNew" min="1" inputmode="numeric" value="${o.seq ?? o.id}">
        </label>
        <button class="btn-filled" id="onSave">Save</button>
      </div>`);
    $('#onSave').onclick = async () => {
      const newSeq = Number($('#onNew').value);
      if (!(newSeq >= 1)) return snack('Enter a number of 1 or higher');
      if (newSeq === o.seq) return closeSheet();
      const all = await DB.getAll('orders');
      if (all.some(x => x.id !== o.id && x.seq === newSeq)) return snack(`Order number ${newSeq} is already in use`);
      o.seq = newSeq;
      await DB.put('orders', o);
      closeSheet(); snack(`Order is now ${orderNo(o)}`); render();
    };
  };

  const w = $('#ooWeights');
  if (w) w.onclick = () => {
    const weightItems = o.items
      .map((item, idx) => ({ item, idx }))
      .filter(x => x.item.unitType === 'weight');
    openSheet(`
      <h2>Adjust sold weights</h2>
      <div class="form-card">
        ${weightItems.map(x => `
          <label class="field">
            <span>${esc(x.item.name)} — actual weight (g), was ${fmtGrams(x.item.qty)} at ${fmtMoney(x.item.unitPrice / 2)}/500g</span>
            <input type="number" min="1" inputmode="numeric" data-widx="${x.idx}" value="${x.item.qty}">
          </label>`).join('')}
        <button class="btn-filled" id="owSave">Save weights</button>
      </div>`);
    $('#owSave').onclick = async () => {
      const newQtys = {};
      let bad = false;
      document.querySelectorAll('[data-widx]').forEach(inp => {
        const grams = Number(inp.value);
        if (!(grams > 0)) bad = true;
        newQtys[inp.dataset.widx] = grams;
      });
      if (bad) return snack('Weights must be greater than 0');
      await DB.updateOrderWeights(o.id, newQtys);
      closeSheet(); snack(`${orderNo(o)} updated — totals and stock adjusted`); render();
    };
  };

  $('#ooDelete').onclick = () => {
    closeSheet();
    showConfirm(`Delete order ${orderNo(o)} (${o.customerName}, ${fmtMoney(o.total)})? Stock is not restored.`, async () => {
      await DB.delete('orders', o.id);
      snack(`${orderNo(o)} deleted`); render();
    });
  };
}

/* ----- Order form ----- */
async function openOrderForm() {
  const [products, customers] = await Promise.all([DB.getAll('products'), DB.getAll('customers')]);
  if (!products.length) return snack('Add products in Inventory before creating orders');
  products.sort((a, b) => a.name.localeCompare(b.name));

  const isWeight = p => p.unit === 'weight';
  const newLine = (p = products[0]) => ({
    productId: p.id,
    qty: isWeight(p) ? 1000 : 1,          // grams for weight products, pieces otherwise
    unitPrice: p.price,                   // per kg for weight products, per piece otherwise
    weightBased: isWeight(p)
  });
  let lines = [newLine()];

  const productOptions = sel => products.map(p =>
    `<option value="${p.id}" ${p.id === sel ? 'selected' : ''}>${esc(p.name)} (${p.trackStock === false ? MODE_TAGS[stockMode(p)] : fmtStock(p) + ' left'})</option>`).join('');

  openSheet(`
    <h2>New order</h2>
    <div class="form-card">
      <label class="field" style="position:relative"><span>Customer</span>
        <input id="ofCustomerSearch" placeholder="Search customers, or type a new name" autocomplete="off">
        <div class="combo-drop" id="ofCustomerDrop" hidden></div>
      </label>
      <div id="ofNewCustomer" hidden>
        <div class="combo-notice" id="ofNewNotice"></div>
        <div class="field-row">
          <label class="field"><span>Phone number</span><input id="ofPhone" type="tel" inputmode="tel" placeholder="08x-xxx-xxxx"></label>
          <label class="field"><span>Email (optional)</span><input id="ofEmail" type="email" inputmode="email" placeholder="name@example.com"></label>
        </div>
      </div>
      <label class="field"><span>Delivery address</span><input id="ofAddress" placeholder="Street, city"></label>
      <div class="field-row">
        <label class="field"><span>Order date</span><input type="date" id="ofDate"></label>
        <label class="field"><span>Time</span><input type="time" id="ofTime"></label>
      </div>
      <h2 class="section-label" style="margin:8px 0 0">Items</h2>
      <div id="ofLines"></div>
      <button class="btn-tonal" id="ofAddLine">＋ Add item</button>
      <label class="field" style="margin-top:4px"><span>Discount (%)</span>
        <input id="ofDiscount" type="number" min="0" max="100" step="1" inputmode="numeric" value="0" placeholder="0">
      </label>
      <div id="ofTotals"></div>
      <label class="field-checkbox">
        <input type="checkbox" id="ofDeduct" checked>
        <span>Deduct items from stock — uncheck for past orders that were already fulfilled</span>
      </label>
      <button class="btn-filled" id="ofCreate">Create order</button>
    </div>`);

  const linesEl = $('#ofLines');

  function drawLines() {
    linesEl.innerHTML = lines.map((l, i) => l.weightBased ? `
      <div class="line-item" style="margin-bottom:2px">
        <label class="field"><span>Product</span><select data-li="${i}" data-k="productId">${productOptions(l.productId)}</select></label>
        <label class="field"><span>Weight (g)</span><input data-li="${i}" data-k="qty" type="number" min="1" inputmode="numeric" value="${l.qty}"></label>
        <label class="field"><span>฿ / 500g</span><input data-li="${i}" data-k="unitPrice" type="number" min="0" step="0.5" inputmode="decimal" value="${l.unitPrice / 2}"></label>
        <button class="remove" data-rm="${i}" title="Remove item">✕</button>
      </div>
      <div class="line-hint" style="margin-bottom:10px">= ${fmtMoney(lineTotal(l))} (${fmtGrams(l.qty || 0)} at ${fmtMoney((l.unitPrice || 0) / 2)}/500g, rounded down)</div>` : `
      <div class="line-item" style="margin-bottom:10px">
        <label class="field"><span>Product</span><select data-li="${i}" data-k="productId">${productOptions(l.productId)}</select></label>
        <label class="field"><span>Qty</span><input data-li="${i}" data-k="qty" type="number" min="1" inputmode="numeric" value="${l.qty}"></label>
        <label class="field"><span>Unit price (฿)</span><input data-li="${i}" data-k="unitPrice" type="number" min="0" step="1" inputmode="numeric" value="${l.unitPrice}"></label>
        <button class="remove" data-rm="${i}" title="Remove item">✕</button>
      </div>`).join('');

    linesEl.querySelectorAll('[data-li]').forEach(el => el.addEventListener('input', () => {
      const i = Number(el.dataset.li), k = el.dataset.k;
      lines[i][k] = (k === 'unitPrice' && lines[i].weightBased) ? Number(el.value) * 2 : Number(el.value);
      if (k === 'productId') {           // product switched: refill price/qty/type from the product card
        const p = products.find(p => p.id === lines[i].productId);
        lines[i] = newLine(p);
        drawLines();
      } else if (lines[i].weightBased) {
        // live-update the computed line price under the row
        const hint = el.closest('.line-item').nextElementSibling;
        if (hint) hint.textContent = `= ${fmtMoney(lineTotal(lines[i]))} (${fmtGrams(lines[i].qty || 0)} at ${fmtMoney((lines[i].unitPrice || 0) / 2)}/500g, rounded down)`;
      }
      updateTotal();
    }));
    linesEl.querySelectorAll('[data-rm]').forEach(el => el.addEventListener('click', () => {
      lines.splice(Number(el.dataset.rm), 1);
      if (!lines.length) lines = [newLine()];
      drawLines(); updateTotal();
    }));
    updateTotal();
  }
  function updateTotal() {
    const subtotal = lines.reduce((s, l) => s + lineTotal(l), 0);
    const pct = Math.min(100, Math.max(0, Number($('#ofDiscount').value) || 0));
    const discount = Math.ceil(subtotal * pct / 100); // discount rounds UP → total rounds down
    const total = subtotal - discount;
    $('#ofTotals').innerHTML = pct > 0 ? `
      <div class="order-total" style="font-weight:400;font-size:14px;color:var(--md-on-surface-variant)"><span>Subtotal</span><span>${fmtMoney(subtotal)}</span></div>
      <div class="order-total" style="font-weight:400;font-size:14px;color:var(--md-on-surface-variant)"><span>Discount ${pct}%</span><span>−${fmtMoney(discount)}</span></div>
      <div class="order-total"><span>Total</span><span>${fmtMoney(total)}</span></div>` : `
      <div class="order-total"><span>Total</span><span>${fmtMoney(total)}</span></div>`;
  }

  $('#ofAddLine').onclick = () => { lines.push(newLine()); drawLines(); };
  $('#ofDiscount').addEventListener('input', updateTotal);
  // Prefill order date & time with now (local time)
  $('#ofDate').value = tsToDateInput(Date.now());
  $('#ofTime').value = tsToTimeInput(Date.now());
  let pickedCustomer = null; // null = the typed name may become a new customer
  attachCustomerPicker({
    input: $('#ofCustomerSearch'),
    drop: $('#ofCustomerDrop'),
    customers, allowNew: true,
    onPick: c => {
      pickedCustomer = c;
      $('#ofNewCustomer').hidden = true;
      $('#ofAddress').value = c.address || '';
    },
    onType: name => {
      pickedCustomer = null;
      // Typed something that isn't an existing name → this becomes a new
      // customer, no extra tap needed. The search field IS the name field.
      const exact = customers.find(c => c.name.toLowerCase() === name.toLowerCase());
      const isNew = name && !exact;
      $('#ofNewCustomer').hidden = !isNew;
      if (isNew) $('#ofNewNotice').textContent = `＋ “${name}” will be added as a new customer`;
    },
    onNew: () => $('#ofPhone').focus()
  });

  $('#ofCreate').onclick = async () => {
    const typed = $('#ofCustomerSearch').value.trim();
    const address = $('#ofAddress').value.trim();
    if (!address) return snack('Enter a delivery address');

    let customerId, customerName;
    if (pickedCustomer && typed === pickedCustomer.name) {
      customerId = pickedCustomer.id;
      customerName = pickedCustomer.name;
    } else {
      if (!typed) return snack('Enter or pick a customer');
      // Typed exactly an existing name without tapping it? Use that customer
      // instead of creating a duplicate.
      const exact = customers.find(c => c.name.toLowerCase() === typed.toLowerCase());
      if (exact) {
        customerId = exact.id;
        customerName = exact.name;
      } else {
        const phone = $('#ofPhone').value.trim();
        if (!phone) return snack('Enter a phone number for the new customer');
        customerName = typed;
        customerId = await DB.add('customers', {
          name: customerName, phone, email: $('#ofEmail').value.trim(),
          address, createdAt: Date.now()
        });
      }
    }

    const items = lines
      .filter(l => l.qty > 0)
      .map(l => {
        const p = products.find(p => p.id === l.productId);
        return {
          productId: p.id, name: p.name,
          qty: l.qty,                                   // grams for weight items, pieces otherwise
          unitPrice: l.unitPrice,                       // per kg for weight items
          unitType: l.weightBased ? 'weight' : 'pcs',
          excludeReports: !!p.excludeReports,
          lineTotal: lineTotal(l)
        };
      });
    if (!items.length) return snack('Add at least one item');

    // Order date & time as chosen in the form.
    const dStr = $('#ofDate').value, tStr = $('#ofTime').value || '12:00';
    if (!dStr) return snack('Pick an order date');
    const [oy, om, od] = dStr.split('-').map(Number);
    const [oh, omin] = tStr.split(':').map(Number);
    const createdAt = new Date(oy, om - 1, od, oh, omin).getTime();

    const subtotal = items.reduce((s, i) => s + i.lineTotal, 0);
    const discountPct = Math.min(100, Math.max(0, Number($('#ofDiscount').value) || 0));
    const discount = Math.ceil(subtotal * discountPct / 100);
    const order = {
      customerId, customerName, address, items,
      subtotal, discountPct,
      total: subtotal - discount,
      status: STATUSES[0], createdAt, statusChangedAt: null,
      seq: await nextOrderSeq()
    };

    try {
      const deduct = $('#ofDeduct').checked;
      const orderId = await DB.createOrderWithStock(order, deduct);
      shared.setItem('erp_order_seq_next', String(order.seq + 1)); // commit the number only on success
      closeSheet();
      const waiting = order.items.filter(i => i.pendingQty > 0);
      if (waiting.length) {
        snack(`${orderNo(order)} created — awaiting stock: ${waiting.map(i => itemLabel(i, i.pendingQty)).join(', ')}`);
      } else {
        snack(`${orderNo(order)} created — in production`);
      }
      render();
    } catch (err) {
      snack(err.message);
    }
  };

  drawLines();
}

/* ----- Customers ----- */
async function renderCustomers() {
  const [customers, orders] = await Promise.all([DB.getAll('customers'), DB.getAll('orders')]);
  const q = state.search.customer.toLowerCase();
  // Spending overview: top 5 customers as horizontal bars (clearer than a
  // pie on a narrow screen), based on all customers, not the search filter.
  const all = customers.map(c => {
    const theirOrders = orders.filter(o => o.customerId === c.id);
    return { ...c, orderCount: theirOrders.length, spent: theirOrders.reduce((s, o) => s + o.total, 0) };
  });
  const top = [...all].sort((a, b) => b.spent - a.spent).filter(c => c.spent > 0).slice(0, 5);
  const grand = all.reduce((s, c) => s + c.spent, 0);
  $('#customerChart').innerHTML = top.length >= 2 ? `
    <div class="card" style="margin-bottom:12px">
      <h2 class="card-title" style="margin-bottom:4px">Top customers</h2>
      ${top.map(c => `
        <div class="tc-row">
          <div class="tc-name">${esc(c.name)}</div>
          <div class="tc-track"><div class="tc-fill" style="width:${Math.max(4, Math.round(c.spent / top[0].spent * 100))}%"></div></div>
          <div class="tc-amount">${fmtMoney(c.spent)}</div>
        </div>`).join('')}
      <div class="sub" style="font-size:12px;color:var(--md-on-surface-variant);margin-top:6px">${Math.round(top.reduce((s, c) => s + c.spent, 0) / grand * 100)}% of all revenue comes from these ${top.length}</div>
    </div>` : '';

  const list = all
    .filter(c => c.name.toLowerCase().includes(q) || (c.address || '').toLowerCase().includes(q) || (c.phone || '').includes(q))
    .sort((a, b) => b.spent - a.spent);

  $('#customerList').innerHTML = list.map(c => `
    <div class="swipe" data-cid="${c.id}">
      ${SWIPE_PANES}
      <div class="card is-tappable" role="button" tabindex="0">
        <div class="row">
          <div class="row-main">
            <div class="name">${esc(c.name)}</div>
            <div class="sub">${esc(c.phone || 'No phone on file')}</div>
          </div>
          <div class="row-end">
            <div class="big">${fmtMoney(c.spent)}</div>
            <div class="sub">${c.orderCount} order${c.orderCount === 1 ? '' : 's'}</div>
          </div>
        </div>
      </div>
    </div>`).join('') || `<div class="empty"><div class="title">No customers found</div><div>${customers.length ? 'Try a different search.' : 'Customers are added here or when you create an order.'}</div></div>`;

  document.querySelectorAll('#customerList .swipe[data-cid]').forEach(wrap => {
    const c = list.find(x => x.id === Number(wrap.dataset.cid));
    const card = wrap.querySelector('.card');
    const confirmDelete = () => showConfirm(`Delete customer “${c.name}”? Their past orders stay in the order list.`, async () => {
      await DB.delete('customers', c.id);
      snack('Customer deleted'); render();
    });
    card.addEventListener('click', () => openCustomerDetail(c.id));
    attachLongPress(card, () => openItemOptions(c.name, { onEdit: () => openCustomerForm(c.id), onDelete: confirmDelete }));
  });
}

async function openCustomerDetail(id) {
  const [c, orders] = await Promise.all([DB.get('customers', id), DB.getAll('orders')]);
  const theirs = orders.filter(o => o.customerId === id).sort((a, b) => b.createdAt - a.createdAt);
  const spent = theirs.reduce((s, o) => s + o.total, 0);
  openSheet(`
    <h2>${esc(c.name)}</h2>
    <div class="sub" style="color:var(--md-on-surface-variant);margin:-8px 0 2px">${esc(c.phone || 'No phone on file')}${c.email ? ' · ' + esc(c.email) : ''}</div>
    <div class="sub" style="color:var(--md-on-surface-variant);margin:0 0 16px">${esc(c.address || 'No address on file')}</div>
    ${c.notes ? `<div class="card" style="margin-bottom:16px;background:var(--md-secondary-container);color:var(--md-on-secondary-container);font-size:14px">${esc(c.notes)}</div>` : ''}
    <div class="stat-grid">
      <div class="stat-card"><div class="label">Total spent</div><div class="value" style="font-size:24px">${fmtMoney(spent)}</div></div>
      <div class="stat-card"><div class="label">Orders</div><div class="value" style="font-size:24px">${theirs.length}</div></div>
    </div>
    <h2 class="section-label">Order history</h2>
    <div class="card-list">
      ${theirs.map(o => `
        <div class="card">
          <div class="row">
            <div class="row-main">
              <div class="name">${orderNo(o)} · ${fmtDate(o.createdAt)}</div>
              <div class="sub">${o.items.map(i => itemLabel(i)).join(', ')}</div>
              <div class="sub" style="font-weight:600;color:var(--md-primary)">${o.status}</div>
            </div>
            <div class="row-end"><div class="big">${fmtMoney(o.total)}</div>${o.discountPct > 0 ? `<div class="sub">${o.discountPct}% discount</div>` : ''}</div>
          </div>
        </div>`).join('') || '<div class="empty">No orders yet.</div>'}
    </div>
    <button class="btn-text" id="cdEdit" style="margin-top:12px">Edit customer</button>`);

  $('#cdEdit').onclick = () => openCustomerForm(id);
}

async function openCustomerForm(id) {
  const c = id ? await DB.get('customers', id) : { name: '', phone: '', email: '', address: '', notes: '' };
  openSheet(`
    <h2>${id ? 'Edit customer' : 'New customer'}</h2>
    <div class="form-card">
      <label class="field"><span>Name</span><input id="cfName" value="${esc(c.name)}"></label>
      <label class="field"><span>Phone number</span><input id="cfPhone" type="tel" inputmode="tel" value="${esc(c.phone || '')}" placeholder="08x-xxx-xxxx"></label>
      <label class="field"><span>Email (optional)</span><input id="cfEmail" type="email" inputmode="email" value="${esc(c.email || '')}" placeholder="name@example.com"></label>
      <label class="field"><span>Address</span><input id="cfAddress" value="${esc(c.address || '')}"></label>
      <label class="field"><span>Notes (optional)</span><textarea id="cfNotes" rows="3" placeholder="e.g. prefers extra spicy, always ships to office">${esc(c.notes || '')}</textarea></label>
      <button class="btn-filled" id="cfSave">${id ? 'Save changes' : 'Add customer'}</button>
    </div>`);
  $('#cfSave').onclick = async () => {
    const name = $('#cfName').value.trim();
    const phone = $('#cfPhone').value.trim();
    if (!name) return snack('Enter the customer name');
    if (!phone) return snack('Enter a phone number');
    await DB.put('customers', {
      ...(id ? { id } : {}), name, phone,
      email: $('#cfEmail').value.trim(),
      address: $('#cfAddress').value.trim(),
      notes: $('#cfNotes').value.trim(),
      createdAt: c.createdAt || Date.now()
    });
    closeSheet(); snack(id ? 'Customer saved' : 'Customer added'); render();
  };
}

/* ---------------- Search & filter wiring ---------------- */
$('#productSearch').addEventListener('input', e => { state.search.product = e.target.value; renderProducts(); });
$('#orderSearch').addEventListener('input', e => { state.search.order = e.target.value; renderOrders(); });
$('#customerSearch').addEventListener('input', e => { state.search.customer = e.target.value; renderCustomers(); });

function syncStockChips() {
  document.querySelectorAll('[data-stockfilter]').forEach(c =>
    c.classList.toggle('is-selected', c.dataset.stockfilter === state.stockFilter));
}
function syncStatusChips() {
  document.querySelectorAll('[data-status]').forEach(c =>
    c.classList.toggle('is-selected', c.dataset.status === state.statusFilter));
}
document.querySelectorAll('[data-stockfilter]').forEach(chip =>
  chip.addEventListener('click', () => { state.stockFilter = chip.dataset.stockfilter; syncStockChips(); renderProducts(); }));

document.querySelectorAll('[data-pcat]').forEach(chip =>
  chip.addEventListener('click', () => {
    state.purchaseFilter = chip.dataset.pcat;
    document.querySelectorAll('[data-pcat]').forEach(c => c.classList.toggle('is-selected', c === chip));
    renderPurchases();
  }));

document.querySelectorAll('[data-status]').forEach(chip =>
  chip.addEventListener('click', () => {
    state.statusFilter = chip.dataset.status;
    syncStatusChips();
    renderOrders();
  }));

document.querySelectorAll('[data-moneytab]').forEach(tab =>
  tab.addEventListener('click', () => {
    state.moneyTab = tab.dataset.moneytab;
    document.querySelectorAll('[data-moneytab]').forEach(t => t.classList.toggle('is-active', t === tab));
    $('#money-reports').hidden = state.moneyTab !== 'reports';
    $('#money-bank').hidden = state.moneyTab !== 'bank';
    $('#money-split').hidden = state.moneyTab !== 'split';
    $('#money-expenses').hidden = state.moneyTab !== 'expenses';
    $('#fab').hidden = true; // money view has no FAB
  }));

/* ---------------- Sample data ---------------- */
async function seedSampleData() {
  const products = [
    { name: 'Oak shelf 80 cm', sku: 'OAK-80', price: 89, stock: 14, lowStock: 5 },
    { name: 'Walnut side table', sku: 'WAL-ST', price: 210, stock: 3, lowStock: 4 },
    { name: 'Pine bench 120 cm', sku: 'PIN-120', price: 145, stock: 0, lowStock: 3 },
    { name: 'Coat rack, steel', sku: 'CR-STL', price: 55, stock: 22, lowStock: 6 }
  ];
  const pids = [];
  for (const p of products) pids.push(await DB.add('products', p));

  const c1 = await DB.add('customers', { name: 'Maren Holt', phone: '081-234-5678', email: 'maren.holt@example.com', address: '14 Birch Lane, Riverton', createdAt: Date.now() - 86400000 * 20 });
  const c2 = await DB.add('customers', { name: 'Tobias Lind', phone: '089-876-5432', email: '', address: '3 Harbor St, Eastport', createdAt: Date.now() - 86400000 * 9 });

  const day = 86400000;
  await DB.add('orders', {
    customerId: c1, customerName: 'Maren Holt', address: '14 Birch Lane, Riverton',
    items: [{ productId: pids[0], name: 'Oak shelf 80 cm', qty: 2, unitPrice: 89 }],
    total: 178, status: 'Shipped', createdAt: Date.now() - day * 12, statusChangedAt: Date.now() - day * 8
  });
  await DB.add('orders', {
    customerId: c2, customerName: 'Tobias Lind', address: '3 Harbor St, Eastport',
    items: [{ productId: pids[1], name: 'Walnut side table', qty: 1, unitPrice: 210 },
            { productId: pids[3], name: 'Coat rack, steel', qty: 2, unitPrice: 55 }],
    total: 320, status: 'Ready for shipping', createdAt: Date.now() - day * 2, statusChangedAt: Date.now() - day
  });
  await DB.add('orders', {
    customerId: c1, customerName: 'Maren Holt', address: '14 Birch Lane, Riverton',
    items: [{ productId: pids[3], name: 'Coat rack, steel', qty: 1, unitPrice: 55 }],
    total: 55, status: 'In production', createdAt: Date.now() - 3600000, statusChangedAt: null
  });
  await DB.add('purchases', { description: 'Oak boards, 10 units', amount: 340, supplier: 'Northline Timber', receivedAt: Date.now() - day * 3 });

  snack('Sample data loaded');
  render();
}

/* ---------------- Bootstrap: default Delivery item ---------------- */
// Runs once ever (tracked via localStorage, not IndexedDB, since it's just
// an app-setup flag). Safe for both brand-new and already-in-use databases.
async function ensureDeliveryProduct() {
  if (shared.getItem('erp_delivery_seeded')) return;
  const products = await DB.getAll('products');
  if (!products.some(p => p.isDelivery)) {
    await DB.add('products', {
      name: 'Delivery', sku: 'DELIVERY', price: 99,
      stock: 0, lowStock: 0, trackStock: false, stockMode: 'service',
      excludeReports: true, isDelivery: true
    });
  }
  shared.setItem('erp_delivery_seeded', '1');
}

/* ---------------- PWA: service worker ---------------- */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js'));
}

/* ---------------- Live sync ---------------- */
/* Changes from another device (or a sync landing after being offline)
   re-render the current view. Batched so a burst of changes renders once. */
let syncRenderTimer = null;
DB.onChange(() => {
  clearTimeout(syncRenderTimer);
  syncRenderTimer = setTimeout(render, 150);
});

/* ---------------- Boot ---------------- */
/* One-off data migrations, safe to run repeatedly. */
async function ensureMigrations() {
  // Status rename: Completed -> Shipped (idempotent)
  const orders = await DB.getAll('orders');
  for (const o of orders) {
    if (o.status === 'Completed') { o.status = 'Shipped'; await DB.put('orders', o); }
  }
  // Weight pack size: old default 1000g becomes the new 500g default (once)
  if (!shared.getItem('erp_pack500')) {
    const products = await DB.getAll('products');
    for (const p of products) {
      if (p.unit === 'weight' && (!p.packG || p.packG === 1000)) {
        p.packG = 500;
        await DB.put('products', p);
      }
    }
    shared.setItem('erp_pack500', '1');
  }
}

Cloud.start();
Cloud.ready
  .then(() => Promise.all([ensureDeliveryProduct(), ensureOrderSeq(), ensureMigrations()]))
  .then(() => switchView('home'));
