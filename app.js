/* ---- Build stamp + crash visibility ----------------------------------
   If ANYTHING crashes, a red banner shows the actual error message on
   screen instead of the app silently dying. The build number makes it
   possible to verify which version a device is actually running.
   Version scheme: MAJOR.MINOR.PATCH — PATCH for small fixes (2.0.1),
   MINOR for new features (2.1.0), MAJOR for big changes (3.0.0). */
const BUILD = '2.15.0';
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
/* Admin vs member (see supabase/schema.sql → team). Members do the daily
   work; the profit split, payouts, bank balance, receipt footer, paying
   back expenses, imports and renumbering are for the admin. The database
   enforces this too — hiding the buttons is just so nobody hits a wall. */
const isAdmin = () => Cloud.isAdmin();
const ADMIN_NOTE = '<span class="admin-note">admin only</span>';
function requireAdmin() {
  if (isAdmin()) return true;
  snack('Only the admin can change this');
  return false;
}

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
const orderNo = o => `DNBB${String(new Date(o.createdAt).getFullYear()).slice(-2)}${(Number.isFinite(o.seq) ? String(o.seq).padStart(4, '0') : '----')}`;

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
${isAdmin() ? `      <button class="set-row" id="setBank" >
        <div class="set-main">
          <div class="set-title">Bank balance</div>
          <div class="set-sub">${bank ? 'baseline set ' + fmtDate(bank.ts) : 'not set up yet'}</div>
        </div>
        <span class="set-chevron">›</span>
      </button>` : ''}
      <button class="set-row" id="setSettle" ${isAdmin() ? '' : 'disabled'}>
        <div class="set-main">
          <div class="set-title">Mark as settled up to… ${isAdmin() ? '' : ADMIN_NOTE}</div>
          <div class="set-sub">pay-backs / payouts already done outside the app</div>
        </div>
        <span class="set-chevron">›</span>
      </button>
      <button class="set-row" id="setSplit" ${isAdmin() ? '' : 'disabled'}>
        <div class="set-main">
          <div class="set-title">Profit split percentages ${isAdmin() ? '' : ADMIN_NOTE}</div>
          <div class="set-sub">tax, buffer and share distribution</div>
        </div>
        <span class="set-chevron">›</span>
      </button>
    </div>

    <h2 class="section-label">Receipts</h2>
    <div class="card set-card">
      <button class="set-row" id="setFooter" ${isAdmin() ? '' : 'disabled'}>
        <div class="set-main">
          <div class="set-title">Receipt footer ${isAdmin() ? '' : ADMIN_NOTE}</div>
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
      ${isAdmin() ? `<button class="set-row" id="stSources">
        <div class="set-main">
          <div class="set-title">Customer sources</div>
          <div class="set-sub">organic vs referred, best referrers</div>
        </div>
        <span class="set-chevron">›</span>
      </button>` : ''}
      <button class="set-row" id="stImport" ${isAdmin() ? '' : 'disabled'}>
        <div class="set-main">
          <div class="set-title">Import backup… ${isAdmin() ? '' : ADMIN_NOTE}</div>
          <div class="set-sub">replaces everything in this app</div>
        </div>
        <span class="set-chevron">›</span>
      </button>
      <input type="file" id="stImportFile" accept=".json,application/json" hidden>
      <button class="set-row" id="stRenumber" ${isAdmin() ? '' : 'disabled'}>
        <div class="set-main">
          <div class="set-title">Renumber orders ${isAdmin() ? '' : ADMIN_NOTE}</div>
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
          <div class="set-sub">signed in as ${esc(Cloud.email())} · ${isAdmin() ? 'admin' : 'member'}</div>
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

  if ($('#setBank')) $('#setBank').onclick = () => openBankSheet();
  $('#setSplit').onclick = () => openSplitSettings();
  $('#setSettle').onclick = () => openSettleSheet();
  $('#setFooter').onclick = () => openFooterSheet();
  $('#stSignOut').onclick = () => showConfirm('Sign out of BuddyBoard on this device?', () => Cloud.signOut(), 'Sign out');
  $('#stRenumber').onclick = () => {
    if (!requireAdmin()) return;
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

  $('#stImport').onclick = () => { if (requireAdmin()) $('#stImportFile').click(); };
  if ($('#stSources')) $('#stSources').onclick = () => openCustomerSources();
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
        await ensureCustomerNos();
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
  if (!requireAdmin()) return;
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
  customers: { label: 'Customer', action: () => openCustomerForm() },
  money:     { label: 'Expense',  action: () => openPurchaseForm() }
};

function switchView(view) {
  state.view = view;
  document.querySelectorAll('.view').forEach(v => v.hidden = true);
  $('#view-' + view).hidden = false;
  document.querySelectorAll('.nav-item').forEach(b => b.classList.toggle('is-active', b.dataset.view === view));
  $('#viewTitle').textContent = VIEW_TITLES[view];

  const fab = $('#fab');
  let cfg = FAB_CONFIG[view];
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

/* "Mark paid" — ask when, and whether the money left the tracked bank
   account or was paid some other way (cash, a private account…).
   onPick(offBook, paidAtTs). Admin only. */
function askPaidHow(title, sub, onPick) {
  const today = tsToDateInput(Date.now());
  openSheet(`
    <h2>${esc(title)}</h2>
    <p class="sheet-sub">${esc(sub)}</p>
    <div class="form-card">
      <label class="field"><span>Paid on — pick an earlier day if it was already paid before</span><input type="date" id="phDate" value="${today}" max="${today}"></label>
      <button class="btn-filled" id="phBank">Paid from the bank<small style="display:block;font-weight:400;opacity:.85">comes off the bank balance on that day</small></button>
      <button class="btn-tonal" id="phOff">Paid outside the bank<small style="display:block;font-weight:400;opacity:.85">cash or private account — bank balance stays the same</small></button>
      <button class="btn-text" id="phCancel">Cancel</button>
    </div>`);
  const pick = offBook => {
    const ts = dateInputToTs($('#phDate').value);
    if (!ts) return snack('Pick a date');
    if (ts > Date.now()) return snack('That date is in the future');
    closeSheet(); onPick(offBook, ts);
  };
  $('#phBank').onclick = () => pick(false);
  $('#phOff').onclick = () => pick(true);
  $('#phCancel').onclick = closeSheet;
}
const offBookLabel = x => x.note || 'settled earlier';
/* Where money went out (bank / outside) is only shown to the admin. */
const viaText = (offBook, bankWord = 'from the bank') => isAdmin() ? (offBook ? ' outside the bank' : ' ' + bankWord) : '';
const paidOnText = ts => ts ? ` on ${fmtDate(ts)}` : '';

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
  // Bank & cash are admin only; members get Reports, Split and Expenses.
  const bankTab = document.querySelector('[data-moneytab="bank"]');
  if (bankTab) bankTab.hidden = !isAdmin();
  if (!isAdmin() && state.moneyTab === 'bank') setMoneyTab('reports');
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
  const [orders, products, purchases, payouts] = await Promise.all([
    DB.getAll('orders'), DB.getAll('products'), DB.getAll('purchases'), DB.getAll('payouts')
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

  // Live bank balance — admin only (members see profit, not money balances).
  const bank = isAdmin() ? bankCfg() : null;
  let bankBalance = null;
  if (bank) {
    const inflow = bankInflowSince(orders, payouts, bank.ts);
    const outflow = bankOutflowSince(purchases, payouts, bank.ts);
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
/* Value of an amount of a product at its selling price (weight: per kg). */
const stockLineValue = (p, qty) => p.unit === 'weight' ? Math.floor(qty / 1000 * (p.price || 0)) : qty * (p.price || 0);

async function renderReports() {
  const [orders, products, purchases, stocklog] = await Promise.all([
    DB.getAll('orders'), DB.getAll('products'), DB.getAll('purchases'), DB.getAll('stocklog')
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
    return s + stockLineValue(p, p.stock);
  }, 0);

  const monthly = [...Array(6)].map((_, k) => {
    const s = new Date(now.getFullYear(), now.getMonth() - 5 + k, 1).getTime();
    const e = new Date(now.getFullYear(), now.getMonth() - 4 + k, 1).getTime();
    const rev = orders.filter(o => o.createdAt >= s && o.createdAt < e).reduce((sum, o) => sum + o.total, 0);
    const cost = purchases.filter(pu => pu.receivedAt >= s && pu.receivedAt < e).reduce((sum, pu) => sum + (pu.amount || 0), 0);
    const made = stocklog.filter(x => x.ts >= s && x.ts < e).reduce((sum, x) => sum + (x.value || 0), 0);
    return { label: new Date(s).toLocaleDateString(undefined, { month: 'short' }), rev, cost, made, current: k === 5 };
  });
  const maxRev = Math.max(1, ...monthly.map(m => Math.max(m.rev, m.cost, m.made)));
  const periodMade = stocklog.filter(x => x.ts >= per.start && x.ts < per.end).reduce((sum, x) => sum + (x.value || 0), 0);

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
    <div class="report-actions">
      <button class="btn-tonal" id="reportPrint">Print / PDF</button>
      <button class="btn-tonal" id="reportXlsx">Excel</button>
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
      <div class="stat-card">
        <div class="label">Stock made · ${per.label}</div>
        <div class="value">${fmtMoney(periodMade)}</div>
        <div class="hint">added to stock, at selling price</div>
      </div>
    </div>
    <h2 class="section-label">Revenue, costs & stock made · last 6 months</h2>
    <div class="card">
      <div class="chart">
        ${monthly.map(m => `
          <div class="chart-col ${m.current ? 'is-current' : ''}">
            <span class="chart-val">${m.rev ? fmtCompact(m.rev) : ''}</span>
            <div class="chart-bars">
              <div class="chart-bar" style="height:${Math.round(m.rev / maxRev * 100)}%"></div>
              <div class="chart-bar cost" style="height:${Math.round(m.cost / maxRev * 100)}%"></div>
              <div class="chart-bar stock" style="height:${Math.round(m.made / maxRev * 100)}%"></div>
            </div>
            <span class="chart-label">${m.label}</span>
          </div>`).join('')}
      </div>
      <div class="chart-legend">
        <span><span class="legend-dot rev"></span>Revenue</span>
        <span><span class="legend-dot cost"></span>Costs</span>
        <span><span class="legend-dot stock"></span>Stock made</span>
      </div>
      <div class="sub" style="font-size:12px;color:var(--md-on-surface-variant);text-align:center;margin-top:6px">Stock made = what you added with “Add stock”, at selling price. Not sold yet, so not in profit.</div>
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
  $('#reportPrint').onclick = () => printReport();
  $('#reportXlsx').onclick = () => downloadReportXlsx();
}

/* ----- MONEY: report for the chosen period (print/PDF + Excel) ----- */
async function reportData() {
  const [orders, purchases] = await Promise.all([DB.getAll('orders'), DB.getAll('purchases')]);
  const per = computePeriod();
  const inPer = ts => ts >= per.start && ts < per.end;
  const pOrders = orders.filter(o => inPer(o.createdAt)).sort((a, b) => a.createdAt - b.createdAt);
  const pExpenses = purchases.filter(p => inPer(p.receivedAt)).sort((a, b) => a.receivedAt - b.receivedAt);
  const revenue = pOrders.reduce((s, o) => s + o.total, 0);
  const costs = pExpenses.reduce((s, p) => s + (p.amount || 0), 0);
  const byCat = {};
  pExpenses.forEach(p => { const c = p.category || 'Other'; byCat[c] = (byCat[c] || 0) + (p.amount || 0); });
  const perf = {};
  pOrders.forEach(o => o.items.filter(inReports).forEach(i => {
    if (!perf[i.name]) perf[i.name] = { name: i.name, revenue: 0, qty: 0, weight: i.unitType === 'weight' };
    perf[i.name].revenue += i.lineTotal !== undefined ? i.lineTotal : i.qty * i.unitPrice;
    perf[i.name].qty += i.qty;
  }));
  const reimbursed = purchases.filter(p => isPersonal(p) && p.reimbursed && p.reimbursedAt && inPer(p.reimbursedAt));
  const owedNow = purchases.filter(p => isPersonal(p) && !p.reimbursed);
  // Reports always name the year ("October 2026"), also for the current year.
  const label = state.period === 'month'
    ? new Date(per.start).toLocaleDateString(undefined, { month: 'long', year: 'numeric' }) : per.label;
  return {
    per: { ...per, label }, pOrders, pExpenses, revenue, costs, profit: revenue - costs,
    cats: Object.entries(byCat).sort((a, b) => b[1] - a[1]),
    sellers: Object.values(perf).sort((a, b) => b.revenue - a.revenue),
    split: computeSplitBetween(orders, purchases, per.start, per.end), cfg: splitCfgAt(Math.min(per.end - 1, Date.now())), reimbursed, owedNow,
    endDay: new Date(per.end - 1)
  };
}
const fmtDay = ts => new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const signed = n => n < 0 ? '−' + fmtMoney(-n) : fmtMoney(n);
const expensePaidBy = p => isPersonal(p) ? `${paidByLabel(p.paidBy)} (${p.reimbursed ? 'paid back' : 'not paid back'})` : 'Company';

/* Printable report: rendered into #printArea, which is the only thing
   shown when printing (see @media print). "Save as PDF" in the print
   dialog turns it into a PDF. */
async function printReport() {
  const d = await reportData();
  const { per, cfg, split } = d;
  const table = (head, rows, foot) => `<table><thead><tr>${head.map(h => `<th${/^(Amount|Total|Revenue|Sold)$/.test(h) ? ' class="num"' : ''}>${h}</th>`).join('')}</tr></thead>
    <tbody>${rows.join('') || `<tr><td colspan="${head.length}" class="muted">None</td></tr>`}${foot || ''}</tbody></table>`;
  $('#printArea').innerHTML = `
    <h1>BuddyBoard report · ${esc(per.label)}</h1>
    <p class="muted">${fmtDay(per.start)} – ${fmtDay(d.endDay)} · printed ${fmtDay(Date.now())} ${fmtTime(Date.now())}</p>
    <h2>Summary</h2>
    ${table(['', 'Amount'], [
      `<tr><td>Revenue (${d.pOrders.length} order${d.pOrders.length === 1 ? '' : 's'})</td><td class="num">${fmtMoney(d.revenue)}</td></tr>`,
      `<tr><td>Costs (${d.pExpenses.length} expense${d.pExpenses.length === 1 ? '' : 's'})</td><td class="num">−${fmtMoney(d.costs)}</td></tr>`,
      `<tr class="total"><td>Profit</td><td class="num">${signed(d.profit)}</td></tr>`
    ])}
    <h2>Profit split</h2>
    ${table(['', 'Amount'], [
      `<tr><td>${cfg.base === 'revenue' ? 'Revenue' : 'Profit'}</td><td class="num">${signed(split.base)}</td></tr>`,
      `<tr><td>Tax reserve · ${cfg.taxPct}%</td><td class="num">−${fmtMoney(split.tax)}</td></tr>`,
      `<tr><td>Buffer reserve · ${cfg.resPct}%</td><td class="num">−${fmtMoney(split.reserve)}</td></tr>`,
      `<tr><td>${esc(cfg.name1)} · ${cfg.sharePct}%</td><td class="num">${fmtMoney(split.share1)}</td></tr>`,
      `<tr><td>${esc(cfg.name2)} · ${100 - cfg.sharePct}%</td><td class="num">${fmtMoney(split.share2)}</td></tr>`
    ])}
    ${d.cats.length ? `<h2>Costs by category</h2>${table(['Category', 'Amount'], d.cats.map(([c, a]) => `<tr><td>${esc(c)}</td><td class="num">${fmtMoney(a)}</td></tr>`))}` : ''}
    ${d.sellers.length ? `<h2>Sales per product</h2>${table(['Product', 'Sold', 'Revenue'], d.sellers.map(r => `<tr><td>${esc(r.name)}</td><td class="num">${r.weight ? fmtGrams(r.qty) : r.qty + '×'}</td><td class="num">${fmtMoney(r.revenue)}</td></tr>`))}` : ''}
    <h2>Orders</h2>
    ${table(['Date', 'Order', 'Customer', 'Items', 'Total'], d.pOrders.map(o => `<tr><td>${fmtDay(o.createdAt)}</td><td>${orderNo(o)}</td><td>${esc(o.customerName)}</td><td>${o.items.map(i => itemLabel(i)).join(', ')}</td><td class="num">${fmtMoney(o.total)}</td></tr>`),
      `<tr class="total"><td colspan="4">Total</td><td class="num">${fmtMoney(d.revenue)}</td></tr>`)}
    <h2>Expenses</h2>
    ${table(['Date', 'Description', 'Category', 'Supplier', 'Paid by', 'Amount'], d.pExpenses.map(p => `<tr><td>${fmtDay(p.receivedAt)}</td><td>${esc(p.description)}</td><td>${esc(p.category || 'Other')}</td><td>${esc(p.supplier || '')}</td><td>${esc(expensePaidBy(p))}</td><td class="num">${fmtMoney(p.amount)}</td></tr>`),
      `<tr class="total"><td colspan="5">Total</td><td class="num">${fmtMoney(d.costs)}</td></tr>`)}
    ${d.reimbursed.length ? `<h2>Paid back to partners in this period</h2>${table(['Paid back on', 'To', 'Expense', 'Amount'], d.reimbursed.map(p => `<tr><td>${fmtDay(p.reimbursedAt)}</td><td>${esc(paidByLabel(p.paidBy))}</td><td>${esc(p.description)}</td><td class="num">${fmtMoney(p.amount)}</td></tr>`))}` : ''}
    ${d.owedNow.length ? `<h2>Still to pay back (today)</h2>${table(['Expense date', 'To', 'Expense', 'Amount'], d.owedNow.map(p => `<tr><td>${fmtDay(p.receivedAt)}</td><td>${esc(paidByLabel(p.paidBy))}</td><td>${esc(p.description)}</td><td class="num">${fmtMoney(p.amount)}</td></tr>`))}` : ''}`;
  const title = document.title;
  document.title = `BuddyBoard report ${per.label}`; // default PDF file name
  window.print();
  document.title = title;
}

/* Excel export (.xlsx): Summary, Orders, Expenses and Products sheets.
   Amounts are real numbers, so Excel/Sheets/Numbers can sum and filter. */
async function downloadReportXlsx() {
  const d = await reportData();
  const { cfg, split } = d;
  const day = ts => tsToDateInput(ts);
  const summary = [
    ['BuddyBoard report', d.per.label],
    ['Period', `${day(d.per.start)} to ${day(d.endDay)}`],
    [],
    ['Revenue', d.revenue], ['Orders', d.pOrders.length],
    ['Costs', d.costs], ['Expenses', d.pExpenses.length],
    ['Profit', d.profit],
    [],
    ['Profit split', ''],
    [cfg.base === 'revenue' ? 'Revenue' : 'Profit', split.base],
    [`Tax reserve ${cfg.taxPct}%`, -split.tax],
    [`Buffer reserve ${cfg.resPct}%`, -split.reserve],
    [`${cfg.name1} ${cfg.sharePct}%`, split.share1],
    [`${cfg.name2} ${100 - cfg.sharePct}%`, split.share2],
    [],
    ['Costs by category', ''],
    ...d.cats
  ];
  const orders = [['Date', 'Order', 'Customer', 'Items', 'Subtotal', 'Discount %', 'Total', 'Status'],
    ...d.pOrders.map(o => [day(o.createdAt), orderNo(o), o.customerName,
      o.items.map(i => i.unitType === 'weight' ? `${fmtGrams(i.qty)} ${i.name}` : `${i.qty}x ${i.name}`).join(', '),
      o.subtotal ?? o.total, o.discountPct || 0, o.total, o.status]),
    [], ['Total', '', '', '', '', '', d.revenue]];
  const expenses = [['Date', 'Description', 'Category', 'Supplier', 'Paid by', 'Paid back on', 'Amount'],
    ...d.pExpenses.map(p => [day(p.receivedAt), p.description, p.category || 'Other', p.supplier || '',
      expensePaidBy(p), isPersonal(p) && p.reimbursedAt ? day(p.reimbursedAt) : '', p.amount || 0]),
    [], ['Total', '', '', '', '', '', d.costs]];
  const products = [['Product', 'Sold', 'Unit', 'Revenue'],
    ...d.sellers.map(r => [r.name, r.weight ? r.qty / 1000 : r.qty, r.weight ? 'kg' : 'pcs', r.revenue])];
  const blob = buildXlsx([
    { name: 'Summary', rows: summary, widths: [28, 18] },
    { name: 'Orders', rows: orders, widths: [12, 14, 22, 44, 11, 10, 11, 18] },
    { name: 'Expenses', rows: expenses, widths: [12, 30, 13, 20, 24, 13, 11] },
    { name: 'Products', rows: products, widths: [28, 10, 8, 12] }
  ]);
  await saveFile(`BuddyBoard ${d.per.label}.xlsx`, blob, 'Report');
}

/* Share (phone) or download (computer) a generated file. */
async function saveFile(name, blob, what = 'File') {
  const file = new File([blob], name, { type: blob.type });
  if (navigator.canShare && navigator.canShare({ files: [file] }) && matchMedia('(pointer: coarse)').matches) {
    try { await navigator.share({ files: [file], title: name }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  snack(`${what} saved: ${name}`);
}

/* ----- MONEY: profit split ----- */
/* Waterfall: base (profit or revenue) → minus tax reserve % → minus buffer
   reserve % → remainder split between two shares. All percentages and the
   base are configurable and stored locally. Amounts always sum exactly:
   each step rounds the set-aside and keeps the remainder intact. */
// taxStays: the tax reserve simply stays in the company account, so it
// never needs to be marked as set aside.
const SPLIT_DEFAULTS = { base: 'profit', taxPct: 7, resPct: 2.5, sharePct: 60, name1: 'Share 1', name2: 'Share 2', taxStays: true };
const taxStays = () => splitCfg().taxStays !== false;
function splitCfg() {
  try { return { ...SPLIT_DEFAULTS, ...JSON.parse(shared.getItem('erp_split_cfg') || '{}') }; }
  catch { return { ...SPLIT_DEFAULTS }; }
}

/* Percentage changes apply from the moment they are saved: earlier sales
   keep the percentages that were valid then. erp_split_cfg holds the
   current percentages plus `previous: [{ until, base, taxPct, resPct,
   sharePct }]` (oldest first) — the versions that applied before. */
function splitCfgAt(ts) {
  const cfg = splitCfg();
  const old = (cfg.previous || []).find(p => ts < p.until);
  return old ? { ...cfg, ...old } : cfg;
}
/* The split of everything between start and end, computed piece by piece
   where the percentages changed in between. */
function computeSplitBetween(orders, purchases, start, end) {
  const cuts = (splitCfg().previous || []).map(p => p.until).filter(t => t > start && t < end);
  const edges = [start, ...cuts, end];
  const total = { base: 0, tax: 0, afterTax: 0, reserve: 0, toSplit: 0, share1: 0, share2: 0 };
  for (let i = 0; i < edges.length - 1; i++) {
    const a = edges[i], b = edges[i + 1];
    const rev = orders.filter(o => o.createdAt >= a && o.createdAt < b).reduce((t, o) => t + o.total, 0);
    const cost = purchases.filter(p => p.receivedAt >= a && p.receivedAt < b).reduce((t, p) => t + (p.amount || 0), 0);
    const part = computeSplit(rev, cost, splitCfgAt(a));
    Object.keys(total).forEach(k => { total[k] += part[k]; });
  }
  return { ...total, changedAt: cuts };
}

function computeSplit(revenue, costs, cfg = splitCfg()) {
  const base = cfg.base === 'revenue' ? revenue : revenue - costs;
  const tax = base > 0 ? Math.round(base * cfg.taxPct / 100) : 0;
  const afterTax = base - tax;
  const reserve = afterTax > 0 ? Math.round(afterTax * cfg.resPct / 100) : 0;
  const toSplit = afterTax - reserve;
  const share1 = toSplit > 0 ? Math.round(toSplit * cfg.sharePct / 100) : 0;
  const share2 = toSplit > 0 ? toSplit - share1 : 0;
  return { base, tax, afterTax, reserve, toSplit, share1, share2 };
}

/* ----- Split payouts: recording that a share was paid, or that tax/buffer
   money was set aside. One record per payment:
   { kind: 'tax'|'buffer'|'share1'|'share2', amount, periodStart, periodEnd,
     periodLabel, paidAt, withdrawal? (buffer money taken back out), note? } */
const PAYOUT_KINDS = ['tax', 'buffer', 'share1', 'share2'];
const payoutLabel = kind => {
  const cfg = splitCfg();
  return { tax: 'Tax reserve', buffer: 'Buffer', share1: cfg.name1, share2: cfg.name2 }[kind];
};
const isShareKind = kind => kind === 'share1' || kind === 'share2';
const splitAmounts = sp => ({ tax: sp.tax, buffer: sp.reserve, share1: sp.share1, share2: sp.share2 });

/* What the split says per kind, summed month by month from the first order
   or expense up to and including this month (each month split on its own). */
function splitDueAllTime(orders, purchases) {
  const first = Math.min(...orders.map(o => o.createdAt), ...purchases.map(p => p.receivedAt));
  const due = { tax: 0, buffer: 0, share1: 0, share2: 0 };
  if (!isFinite(first)) return due;
  monthsFrom(first, Date.now()).forEach(m => {
    const a = splitAmounts(computeSplitBetween(orders, purchases, m.start, m.end));
    PAYOUT_KINDS.forEach(k => { due[k] += a[k]; });
  });
  return due;
}
/* Calendar months [{ start, end, label }] from the month of `from` up to
   and including the month of `to`. */
function monthsFrom(from, to) {
  const out = [];
  for (let d = new Date(new Date(from).getFullYear(), new Date(from).getMonth(), 1); d.getTime() <= to; d = new Date(d.getFullYear(), d.getMonth() + 1, 1)) {
    out.push({ start: d.getTime(), end: new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime(),
      label: d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }) });
  }
  return out;
}

/* Catch up with history: mark everything up to (and including) a chosen
   month as already settled — fronted expenses as paid back, and/or the
   split as paid out / set aside — WITHOUT changing the tracked bank
   balance (that money moved before the app tracked it). */
async function openSettleSheet() {
  if (!requireAdmin()) return;
  const [orders, purchases, payouts] = await Promise.all([DB.getAll('orders'), DB.getAll('purchases'), DB.getAll('payouts')]);
  const first = Math.min(...orders.map(o => o.createdAt), ...purchases.map(p => p.receivedAt));
  if (!isFinite(first)) return snack('Nothing to settle yet');
  const months = monthsFrom(first, Date.now());
  const def = Math.max(0, months.length - 2); // last complete month
  const plan = idx => {
    const until = months[idx].end;
    const fronted = purchases.filter(p => isPersonal(p) && !p.reimbursed && p.receivedAt < until);
    const perKind = Object.fromEntries(PAYOUT_KINDS.map(k => [k, []]));
    months.slice(0, idx + 1).forEach(m => {
      const due = splitAmounts(computeSplitBetween(orders, purchases, m.start, m.end));
      PAYOUT_KINDS.forEach(k => {
        const paid = payouts.filter(x => x.kind === k && !x.withdrawal && x.periodStart >= m.start && x.periodEnd <= m.end).reduce((t, x) => t + x.amount, 0);
        if (due[k] - paid > 0) perKind[k].push({ m, amount: due[k] - paid });
      });
    });
    // Already marked in the app with today's date (so counted as leaving
    // the bank now), although it was really done before.
    const marked = [
      ...payouts.filter(x => PAYOUT_KINDS.includes(x.kind) && !x.withdrawal && !x.offBook && x.periodEnd <= until).map(x => ({ store: 'payouts', rec: x, amount: x.amount })),
      ...purchases.filter(p => isPersonal(p) && p.reimbursed && !p.offBook && p.receivedAt < until).map(p => ({ store: 'purchases', rec: p, amount: p.amount || 0 }))
    ];
    return { fronted, perKind, marked };
  };
  const sum = list => list.reduce((t, x) => t + (x.amount || 0), 0);
  openSheet(`
    <h2>Mark as settled</h2>
    <p class="sheet-sub">For things that were already handled outside the app. The bank balance is <b>not</b> changed.</p>
    <div class="form-card">
      <label class="field"><span>Settled up to and including</span>
        <select id="stlMonth">${months.map((m, i) => `<option value="${i}" ${i === def ? 'selected' : ''}>${m.label}</option>`).join('')}</select>
      </label>
      <div id="stlOptions"></div>
      <button class="btn-filled" id="stlSave">Mark as settled</button>
    </div>`);
  const draw = () => {
    const { fronted, perKind, marked } = plan(Number($('#stlMonth').value));
    const opt = (id, label, amount, n, checked) => `
      <label class="field-checkbox"><input type="checkbox" id="${id}" ${checked && amount ? 'checked' : ''} ${amount ? '' : 'disabled'}>
        <span><b>${label}</b> — ${amount ? `${fmtMoney(amount)}${n !== undefined ? ` (${n} expense${n === 1 ? '' : 's'})` : ''}` : 'nothing open'}</span></label>`;
    $('#stlOptions').innerHTML =
      opt('stlFronted', 'Pay-backs of fronted expenses', sum(fronted), fronted.length, true) +
      opt('stlShare1', `${esc(payoutLabel('share1'))}'s share paid`, sum(perKind.share1), undefined, true) +
      opt('stlShare2', `${esc(payoutLabel('share2'))}'s share paid`, sum(perKind.share2), undefined, true) +
      opt('stlBuffer', 'Buffer set aside', sum(perKind.buffer), undefined, false) +
      (taxStays() ? '' : opt('stlTax', 'Tax reserve set aside', sum(perKind.tax), undefined, false)) +
      (marked.length ? `
      <label class="field-checkbox stl-marked"><input type="checkbox" id="stlMarked" checked>
        <span><b>Already marked in the app, but done before</b> — ${marked.length} item${marked.length === 1 ? '' : 's'}, ${fmtMoney(sum(marked))}. Keeps them as paid, but takes them out of the bank movements (they were not paid from the bank on the day you tapped).</span></label>` : '');
  };
  $('#stlMonth').onchange = draw;
  draw();
  $('#stlSave').onclick = () => {
    const idx = Number($('#stlMonth').value);
    const { fronted, perKind, marked } = plan(idx);
    const picked = { fronted: $('#stlFronted').checked, share1: $('#stlShare1').checked, share2: $('#stlShare2').checked, buffer: $('#stlBuffer').checked, tax: !!($('#stlTax') && $('#stlTax').checked), marked: !!($('#stlMarked') && $('#stlMarked').checked) };
    if (!Object.values(picked).some(Boolean)) return snack('Tick at least one item');
    showConfirm(`Mark the ticked items as settled up to and including ${months[idx].label}? The bank balance stays the same.`, async () => {
      const now = Date.now();
      if (picked.marked) for (const { store, rec } of marked) {
        await DB.put(store, store === 'purchases' ? { ...rec, reimbursedAt: rec.receivedAt, offBook: true } : { ...rec, offBook: true, note: rec.note || 'settled earlier' });
      }
      if (picked.fronted) for (const p of fronted) await DB.put('purchases', { ...p, reimbursed: true, reimbursedAt: p.receivedAt, offBook: true });
      for (const k of PAYOUT_KINDS) {
        if (!picked[k]) continue;
        for (const { m, amount } of perKind[k]) {
          await DB.add('payouts', { kind: k, amount, periodStart: m.start, periodEnd: m.end, periodLabel: m.label, paidAt: now, offBook: true, note: 'settled earlier' });
        }
      }
      closeSheet(); snack(`Settled up to ${months[idx].label}`); render();
    }, 'Mark settled');
  };
}

function recordPayout(kind, amount, per) {
  if (!requireAdmin()) return;
  const verb = isShareKind(kind) ? `Paid ${payoutLabel(kind)}` : `${payoutLabel(kind)} set aside`;
  if (isShareKind(kind)) {
    askPaidHow(`${verb}: ${fmtMoney(amount)}`, `Profit share for ${per.label}`, async (offBook, paidAt) => {
      await DB.add('payouts', { kind, amount, periodStart: per.start, periodEnd: per.end, periodLabel: per.label, paidAt,
        ...(offBook ? { offBook: true, note: 'paid outside the bank' } : {}) });
      snack(`${verb} — ${fmtMoney(amount)}${offBook ? ' (outside the bank)' : ''}`); render();
    });
    return;
  }
  showConfirm(
    `${verb}: ${fmtMoney(amount)} for ${per.label}?${isShareKind(kind) ? ' This comes off the bank balance today.' : ''}`,
    async () => {
      await DB.add('payouts', { kind, amount, periodStart: per.start, periodEnd: per.end, periodLabel: per.label, paidAt: Date.now() });
      snack(`${verb} — ${fmtMoney(amount)}`); render();
    },
    isShareKind(kind) ? 'Mark paid' : 'Mark set aside'
  );
}

function openBufferWithdraw(available) {
  if (!requireAdmin()) return;
  openSheet(`
    <h2>Take money from the buffer</h2>
    <p class="sheet-sub">In the buffer now: ${fmtMoney(available)}</p>
    <div class="form-card">
      <label class="field"><span>Amount (฿)</span><input id="bwAmount" type="number" min="1" step="1" inputmode="numeric"></label>
      <label class="field"><span>What for (optional)</span><input id="bwNote" placeholder="e.g. new machine"></label>
      <button class="btn-filled" id="bwSave">Take from buffer</button>
    </div>`);
  $('#bwSave').onclick = async () => {
    const amount = Math.round(Number($('#bwAmount').value));
    if (!(amount > 0)) return snack('Enter an amount greater than 0');
    const now = Date.now();
    await DB.add('payouts', { kind: 'buffer', withdrawal: true, amount, note: $('#bwNote').value.trim(), periodStart: now, periodEnd: now, periodLabel: fmtDate(now), paidAt: now });
    closeSheet(); snack(`Took ${fmtMoney(amount)} from the buffer`); render();
  };
}

async function renderSplit() {
  const [orders, purchases, payouts] = await Promise.all([DB.getAll('orders'), DB.getAll('purchases'), DB.getAll('payouts')]);
  const per = computePeriod();
  // Percentages as they were at the end of this period (or now).
  const cfg = splitCfgAt(Math.min(per.end - 1, Date.now()));
  const sp = computeSplitBetween(orders, purchases, per.start, per.end);
  const { base, tax, afterTax, reserve, toSplit, share1, share2 } = sp;
  const fmtSigned = n => n < 0 ? '−' + fmtMoney(-n) : fmtMoney(n);

  // Paid / set aside for this period (payouts recorded for it or for a part of it).
  const due = splitAmounts(sp);
  const inPeriod = x => !x.withdrawal && x.periodStart >= per.start && x.periodEnd <= per.end;
  const paidHere = Object.fromEntries(PAYOUT_KINDS.map(k => [k, payouts.filter(x => x.kind === k && inPeriod(x))]));
  const status = kind => {
    if (kind === 'tax' && taxStays()) return due.tax > 0 ? '<span class="pay-status is-done">✓ Stays in the account</span>' : '';
    const list = paidHere[kind], paid = list.reduce((t, x) => t + x.amount, 0), left = due[kind] - paid;
    const done = isShareKind(kind) ? 'Paid' : 'Set aside';
    if (due[kind] <= 0 && !paid) return '';
    if (left <= 0) return `<button class="pay-status is-done" ${isAdmin() ? `data-undo="${kind}"` : 'disabled'}>✓ ${done} ${fmtMoney(paid)} · ${isAdmin() && list.every(x => x.offBook) ? esc(offBookLabel(list[0])) + ' · ' : ''}${fmtDate(Math.max(...list.map(x => x.paidAt)))}</button>`;
    if (!isAdmin()) return `<span class="pay-status is-open">${paid ? `${done} ${fmtMoney(paid)} · ` : ''}${fmtMoney(left)} not ${isShareKind(kind) ? 'paid' : 'set aside'} yet</span>`;
    return `<button class="pay-status" data-pay="${kind}" data-amount="${left}">${paid ? `${done} ${fmtMoney(paid)} · ` : ''}Mark ${fmtMoney(left)} ${isShareKind(kind) ? 'paid' : 'set aside'}</button>`;
  };

  // All-time totals.
  const allDue = splitDueAllTime(orders, purchases);
  const sum = (kind, w = false) => payouts.filter(x => x.kind === kind && !!x.withdrawal === w).reduce((t, x) => t + x.amount, 0);
  const tot = Object.fromEntries(PAYOUT_KINDS.map(k => [k, sum(k)]));
  const withdrawn = sum('buffer', true);
  const inBuffer = tot.buffer - withdrawn;
  const openAmt = k => Math.max(0, allDue[k] - tot[k]);
  const history = payouts.filter(x => !isDeposit(x) && !isCashMove(x)).sort((a, b) => b.paidAt - a.paidAt).slice(0, 12);

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
      ${status('tax')}
      <div class="flow-row sub">
        <span>After tax</span>
        <span>${fmtSigned(afterTax)}</span>
      </div>
      <div class="flow-row minus">
        <span>Buffer reserve · ${cfg.resPct}%</span>
        <span>−${fmtMoney(reserve)}</span>
      </div>
      ${status('buffer')}
      <div class="flow-row sub">
        <span>To distribute</span>
        <span>${fmtSigned(toSplit)}</span>
      </div>
      <div class="flow-row share">
        <span>${esc(cfg.name1)} · ${cfg.sharePct}%</span>
        <span>${fmtMoney(share1)}</span>
      </div>
      ${status('share1')}
      <div class="flow-row share">
        <span>${esc(cfg.name2)} · ${(100 - cfg.sharePct).toLocaleString(undefined, { maximumFractionDigits: 2 })}%</span>
        <span>${fmtMoney(share2)}</span>
      </div>
      ${status('share2')}
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
    ${sp.changedAt.length ? `<div class="admin-hint">Percentages changed on ${sp.changedAt.map(t => fmtDate(t) + ' ' + fmtTime(t)).join(', ')} — sales before that use the old percentages; the % shown are the newest.</div>` : ''}
    <h2 class="section-label">Totals · all time</h2>
    <div class="card totals-card">
      ${['share1', 'share2'].map(k => `
        <div class="tot-row">
          <span class="tot-name">${esc(payoutLabel(k))}</span>
          <span class="tot-main">${fmtMoney(tot[k])} <small>paid out</small></span>
          <span class="tot-open ${openAmt(k) ? 'is-open' : ''}">${openAmt(k) ? fmtMoney(openAmt(k)) + ' still to pay' : 'all paid'}</span>
        </div>`).join('')}
      <div class="tot-row">
        <span class="tot-name">Buffer</span>
        <span class="tot-main">${fmtMoney(inBuffer)} <small>in the buffer</small></span>
        <span class="tot-open ${openAmt('buffer') ? 'is-open' : ''}">${openAmt('buffer') ? fmtMoney(openAmt('buffer')) + ' still to set aside' : 'all set aside'}${withdrawn ? ` · ${fmtMoney(withdrawn)} taken out` : ''}</span>
      </div>
      <div class="tot-row">
        <span class="tot-name">Tax reserve</span>
        ${taxStays() ? `<span class="tot-main">${fmtMoney(allDue.tax)} <small>reserved</small></span>
        <span class="tot-open">stays in the company account</span>` : `<span class="tot-main">${fmtMoney(tot.tax)} <small>set aside</small></span>
        <span class="tot-open ${openAmt('tax') ? 'is-open' : ''}">${openAmt('tax') ? fmtMoney(openAmt('tax')) + ' still to set aside' : 'all set aside'}</span>`}
      </div>
      ${isAdmin() ? `<button class="btn-tonal" id="bufferTake" ${inBuffer > 0 ? '' : 'disabled'}>Take from buffer…</button>` : ''}
      <div class="sub" style="font-size:12px;color:var(--md-on-surface-variant);margin-top:8px">“Still to pay” adds up every month's split up to today. Paid-out shares come off the bank balance; tax and buffer stay company money.</div>
    </div>
    ${history.length ? `
    <h2 class="section-label">Recent payouts</h2>
    <div class="card">
      ${history.map(x => `
        <button class="flow-row payout-row" data-payout="${x.id}" ${isAdmin() ? '' : 'disabled'}>
          <span>${x.withdrawal ? `Taken from buffer${x.note ? ': ' + esc(x.note) : ''}` : `${esc(payoutLabel(x.kind))} · ${esc(x.periodLabel)}`}<small> · ${x.offBook && isAdmin() ? esc(offBookLabel(x)) + (x.note ? ' · ' + fmtDate(x.paidAt) : '') : fmtDate(x.paidAt)}</small></span>
          <span>${x.withdrawal ? '−' : ''}${fmtMoney(x.amount)}</span>
        </button>`).join('')}
    </div>` : ''}
    ${isAdmin() ? '<button class="btn-tonal" id="splitSettings" style="margin-top:14px">Adjust percentages…</button>' : '<div class="admin-hint">Only the admin can mark payouts or change the percentages.</div>'}`;

  document.querySelectorAll('[data-pay]').forEach(b => b.onclick = () => recordPayout(b.dataset.pay, Number(b.dataset.amount), per));
  document.querySelectorAll('[data-undo]').forEach(b => b.onclick = () => {
    const list = paidHere[b.dataset.undo];
    showConfirm(`Undo “${payoutLabel(b.dataset.undo)} ${isShareKind(b.dataset.undo) ? 'paid' : 'set aside'}” for ${per.label} (${fmtMoney(list.reduce((t, x) => t + x.amount, 0))})?`, async () => {
      for (const x of list) await DB.delete('payouts', x.id);
      snack('Undone'); render();
    }, 'Undo');
  });
  document.querySelectorAll('[data-payout]').forEach(b => b.onclick = () => {
    const x = payouts.find(y => y.id === Number(b.dataset.payout));
    const title = x.withdrawal ? 'Taken from buffer' : `${payoutLabel(x.kind)} · ${x.periodLabel}`;
    openSheet(`
      <h2>${esc(title)}</h2>
      <p class="sheet-sub">${fmtMoney(x.amount)} · ${x.offBook ? esc(offBookLabel(x)) + ' (not via the tracked bank)' : 'from the bank'} · ${fmtDate(x.paidAt)}</p>
      <div class="form-card">
        <div class="field-row" style="align-items:flex-end">
          <label class="field"><span>Paid on</span><input type="date" id="poDate" value="${tsToDateInput(x.paidAt)}" max="${tsToDateInput(Date.now())}"></label>
          <button class="btn-tonal" id="poDateSave">Save date</button>
        </div>
        ${!x.withdrawal && !x.offBook ? `<button class="btn-tonal" id="poOffBook">It was paid outside the bank — take it out of the bank movements</button>` : ''}
        ${!x.withdrawal && x.offBook ? `<button class="btn-tonal" id="poOnBook">It was paid from the bank</button>` : ''}
        <button class="btn-text danger" id="poDelete">Delete record</button>
      </div>`);
    $('#poDateSave').onclick = async () => {
      const ts = dateInputToTs($('#poDate').value);
      if (!ts || ts > Date.now()) return snack('Pick a date that is not in the future');
      await DB.put('payouts', { ...x, paidAt: ts }); closeSheet(); snack('Date changed to ' + fmtDate(ts)); render();
    };
    if ($('#poOffBook')) $('#poOffBook').onclick = async () => { await DB.put('payouts', { ...x, offBook: true, note: x.note || 'paid outside the bank' }); closeSheet(); snack('Marked as paid outside the bank'); render(); };
    if ($('#poOnBook')) $('#poOnBook').onclick = async () => { const { note, ...rest } = x; await DB.put('payouts', { ...rest, offBook: false }); closeSheet(); snack('Counted from the bank again'); render(); };
    $('#poDelete').onclick = () => showConfirm(`Delete this record (${title}, ${fmtMoney(x.amount)})?`, async () => {
      await DB.delete('payouts', x.id); closeSheet(); snack('Record deleted'); render();
    });
  });
  if ($('#bufferTake')) $('#bufferTake').onclick = () => openBufferWithdraw(inBuffer);

  document.querySelectorAll('#splitChips [data-speriod]').forEach(chip =>
    chip.addEventListener('click', () => { state.period = chip.dataset.speriod; state.periodOffset = 0; renderSplit(); renderReports(); }));
  $('#splitPrev').onclick = () => { state.periodOffset--; renderSplit(); renderReports(); };
  $('#splitNext').onclick = () => { if (state.periodOffset < 0) { state.periodOffset++; renderSplit(); renderReports(); } };
  if ($('#splitSettings')) $('#splitSettings').onclick = openSplitSettings;
}

function openSplitSettings() {
  if (!requireAdmin()) return;
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
      <label class="field-checkbox"><input type="checkbox" id="spTaxStays" ${cfg.taxStays !== false ? 'checked' : ''}>
        <span>Tax reserve stays in the company account — no need to mark it as set aside</span></label>
      <div class="field-row">
        <label class="field"><span>Name first share</span><input id="spName1" value="${esc(cfg.name1)}"></label>
        <label class="field"><span>Name second share</span><input id="spName2" value="${esc(cfg.name2)}"></label>
      </div>
      <div class="sub" style="font-size:12.5px;color:var(--md-on-surface-variant)">New percentages apply from the moment you save. Everything sold before keeps the percentages that applied then.</div>
      <button class="btn-filled" id="spSave">Save</button>
      ${(cfg.previous || []).length ? `
      <h2 class="section-label" style="margin:8px 0 0">Earlier percentages</h2>
      <div class="card">
        ${cfg.previous.slice().reverse().map(p => `
          <div class="flow-row"><span>until ${fmtDate(p.until)} ${fmtTime(p.until)}</span>
          <span style="font-size:13px">${p.base === 'revenue' ? 'revenue' : 'profit'} · tax ${p.taxPct}% · buffer ${p.resPct}% · ${esc(cfg.name1)} ${p.sharePct}%</span></div>`).join('')}
      </div>` : ''}
    </div>`);
  $('#spSave').onclick = () => {
    const clampPct = v => Math.min(100, Math.max(0, Number(v) || 0));
    const next = {
      base: $('#spBase').value,
      taxPct: clampPct($('#spTax').value),
      resPct: clampPct($('#spRes').value),
      sharePct: clampPct($('#spShare').value)
    };
    const previous = [...(cfg.previous || [])];
    const changed = ['base', 'taxPct', 'resPct', 'sharePct'].some(k => next[k] !== cfg[k]);
    // Keep the old percentages for everything before now (only if anything
    // was ever calculated with them, i.e. not on a brand-new setup).
    if (changed && shared.getItem('erp_split_cfg')) {
      previous.push({ until: Date.now(), base: cfg.base, taxPct: cfg.taxPct, resPct: cfg.resPct, sharePct: cfg.sharePct });
    }
    shared.setItem('erp_split_cfg', JSON.stringify({
      ...next,
      name1: $('#spName1').value.trim() || 'Share 1',
      name2: $('#spName2').value.trim() || 'Share 2',
      taxStays: $('#spTaxStays').checked,
      previous
    }));
    closeSheet(); snack(changed ? 'New percentages apply from now on' : 'Split settings saved'); render();
  };
}

/* Who paid an expense. 'company' (default for old records) hits the bank
   immediately; a person fronting money only hits the bank once reimbursed. */
const paidByLabel = pb => {
  const cfg = splitCfg();
  return pb === 'p1' ? cfg.name1 : pb === 'p2' ? cfg.name2 : 'Company';
};
const isPersonal = p => p.paidBy === 'p1' || p.paidBy === 'p2';
// offBook: settled outside the app (before it was tracked) — never touches the bank.
// cash: a company expense paid with cash taken out earlier — it comes out of
// the cash box, the bank was already hit by the cash withdrawal.
const isCashExpense = p => !isPersonal(p) && !!p.cash;
const hitsBank = p => isPersonal(p) ? (p.reimbursed && !p.offBook) : !p.cash;
/* When an expense leaves the bank: company-paid on the expense date; fronted
   by a person on the day the company paid them back (older records without
   that date fall back to the expense date). */
const bankTs = p => (isPersonal(p) && p.reimbursedAt) || p.receivedAt;
/* Money out of the bank since ts: expenses, reimbursements and profit
   shares paid out to the partners. (Tax and buffer stay company money.) */
const isSharePayout = x => (x.kind === 'share1' || x.kind === 'share2') && !x.offBook;
/* Private money put into the company account (stored with the payouts,
   kind 'deposit', so only the admin can record it). Not revenue. */
const isDeposit = x => x.kind === 'deposit';
/* Cash moved between the bank and the company cash box (kind 'cash', admin
   only like all payouts). Normally a withdrawal (bank → cash); toBank: true
   is leftover cash put back (cash → bank). Not an expense, not revenue. */
const isCashMove = x => x.kind === 'cash';
const cashBankAmt = x => x.toBank ? x.amount : -x.amount;   // effect on the bank
const bankInflowSince = (orders, payouts, ts) =>
  orders.filter(o => o.createdAt >= ts).reduce((s, o) => s + o.total, 0)
  + payouts.filter(x => isDeposit(x) && x.paidAt >= ts).reduce((s, x) => s + x.amount, 0)
  + payouts.filter(x => isCashMove(x) && x.toBank && x.paidAt >= ts).reduce((s, x) => s + x.amount, 0);
const bankOutflowSince = (purchases, payouts, ts) =>
  purchases.filter(p => hitsBank(p) && bankTs(p) >= ts).reduce((s, p) => s + (p.amount || 0), 0)
  + payouts.filter(x => isSharePayout(x) && x.paidAt >= ts).reduce((s, x) => s + x.amount, 0)
  + payouts.filter(x => isCashMove(x) && !x.toBank && x.paidAt >= ts).reduce((s, x) => s + x.amount, 0);
/* Cash box: everything taken out of the bank minus cash spent / put back. */
function cashBox(purchases, payouts) {
  const moves = [
    ...payouts.filter(isCashMove).map(x => ({ ts: x.paidAt, text: x.toBank ? `Cash put back in the bank${x.note ? ': ' + esc(x.note) : ''}` : `Cash withdrawal${x.note ? ': ' + esc(x.note) : ''}`, amt: -cashBankAmt(x), cashId: x.id })),
    ...purchases.filter(isCashExpense).map(p => ({ ts: p.receivedAt, text: esc(p.description), amt: -(p.amount || 0) }))
  ].sort((a, b) => b.ts - a.ts);
  return { moves, balance: moves.reduce((t, m) => t + m.amt, 0), used: moves.length > 0 };
}
/* Mark expenses as paid back, dated today. From the bank (default) they
   count against the bank balance; offBook (cash / private) they never do. */
async function markReimbursed(list, offBook = false, at = Date.now()) {
  if (!requireAdmin()) return;
  for (const p of list) await DB.put('purchases', { ...p, reimbursed: true, reimbursedAt: at, offBook });
}

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
  const [orders, purchases, payouts] = await Promise.all([DB.getAll('orders'), DB.getAll('purchases'), DB.getAll('payouts')]);
  const inflow = bankInflowSince(orders, payouts, cfg.ts);
  const outflow = bankOutflowSince(purchases, payouts, cfg.ts);
  return { cfg, inflow, outflow, balance: cfg.amount + inflow - outflow, orders, purchases, payouts };
}

/* Everything that moved money in or out of the company since ts:
   orders in; company expenses, pay-backs and paid-out shares out. */
function bankMoves(orders, purchases, payouts, ts) {
  const moves = [];
  orders.forEach(o => { if (o.createdAt >= ts) moves.push({ ts: o.createdAt, text: `${orderNo(o)} — ${esc(o.customerName)}`, amt: o.total }); });
  purchases.forEach(p => {
    if (hitsBank(p) && bankTs(p) >= ts) moves.push({
      ts: bankTs(p),
      text: isPersonal(p) ? `Paid back to ${esc(paidByLabel(p.paidBy))}: ${esc(p.description)}` : esc(p.description),
      amt: -(p.amount || 0)
    });
  });
  payouts.forEach(x => {
    if (isSharePayout(x) && x.paidAt >= ts) moves.push({ ts: x.paidAt, text: `Profit share to ${esc(payoutLabel(x.kind))} · ${esc(x.periodLabel)}`, amt: -x.amount });
    if (isDeposit(x) && x.paidAt >= ts) moves.push({ ts: x.paidAt, text: `Deposit from ${esc(x.from || 'private')}${x.note ? ': ' + esc(x.note) : ''}`, amt: x.amount, depositId: x.id });
    if (isCashMove(x) && x.paidAt >= ts) moves.push({ ts: x.paidAt, text: x.toBank ? `Cash put back${x.note ? ': ' + esc(x.note) : ''}` : `Cash withdrawal${x.note ? ': ' + esc(x.note) : ''}`, amt: cashBankAmt(x), cashId: x.id });
  });
  return moves.sort((a, b) => b.ts - a.ts);
}
const signedMoney = n => (n < 0 ? '−' : '') + fmtMoney(Math.abs(n));
/* Month-by-month in / out / net table, newest month first. */
function monthlyFlowsHTML(moves, fromTs) {
  const rows = monthsFrom(fromTs, Date.now()).reverse().map(m => {
    const inM = moves.filter(x => x.ts >= m.start && x.ts < m.end);
    const inn = inM.filter(x => x.amt > 0).reduce((t, x) => t + x.amt, 0);
    const out = -inM.filter(x => x.amt < 0).reduce((t, x) => t + x.amt, 0);
    return `<div class="month-flow">
      <span class="mf-name">${m.label}</span>
      <span class="mf-in">+${fmtMoney(inn)}</span>
      <span class="mf-out">−${fmtMoney(out)}</span>
      <span class="mf-net">${signedMoney(inn - out)}</span>
    </div>`;
  });
  return `<div class="card month-flows">
    <div class="month-flow mf-head"><span>Month</span><span>In</span><span>Out</span><span>Net</span></div>
    ${rows.join('')}
  </div>`;
}
const movesListHTML = moves => `
  <div class="card">
    ${moves.slice(0, 15).map(m => `
      <div class="flow-row ${(m.depositId || m.cashId) && isAdmin() ? 'is-tappable' : ''}" ${m.depositId && isAdmin() ? `data-deposit="${m.depositId}"` : ''} ${m.cashId && isAdmin() ? `data-cashmove="${m.cashId}"` : ''} style="padding:8px 4px">
        <span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${m.text}<span style="color:var(--md-on-surface-variant);font-size:12px"> · ${fmtDate(m.ts)}</span></span>
        <span style="flex:none;font-weight:600;${m.amt >= 0 ? 'color:var(--md-primary)' : 'color:var(--md-tertiary)'}">${m.amt >= 0 ? '+' : '−'}${fmtMoney(Math.abs(m.amt))}</span>
      </div>`).join('') || '<div class="empty">Nothing has moved yet.</div>'}
  </div>`;

async function renderBank() {
  if (!isAdmin()) { $('#money-bank').innerHTML = ''; return; }
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

  const { cfg, inflow, outflow, balance, orders, purchases, payouts } = data;
  const moves = bankMoves(orders, purchases, payouts, cfg.ts);
  const cash = cashBox(purchases, payouts);

  $('#money-bank').innerHTML = `
    <div class="stat-grid">
      <div class="stat-card hero">
        <div class="label">Bank balance (tracked)</div>
        <div class="value">${signedMoney(balance)}</div>
        <div class="hint">baseline ${fmtMoney(cfg.amount)} set ${fmtDate(cfg.ts)} ${fmtTime(cfg.ts)}</div>
      </div>
      <div class="stat-card">
        <div class="label">In since baseline</div>
        <div class="value">${fmtMoney(inflow)}</div>
        <div class="hint">orders, deposits, cash put back</div>
      </div>
      <div class="stat-card">
        <div class="label">Out since baseline</div>
        <div class="value">${fmtMoney(outflow)}</div>
        <div class="hint">pin expenses, cash withdrawals, pay-backs, profit shares</div>
      </div>
      <div class="stat-card">
        <div class="label">Cash on hand</div>
        <div class="value">${signedMoney(cash.balance)}</div>
        <div class="hint">withdrawn minus spent in cash</div>
      </div>
    </div>
    <div class="report-actions" style="margin:12px 0 0">
      <button class="btn-tonal" id="bankCash">Cash withdrawal…</button>
      <button class="btn-tonal" id="bankDeposit">Add deposit…</button>
      <button class="btn-tonal" id="bankUpdate">Update balance…</button>
    </div>
    <h2 class="section-label">Per month</h2>
    ${monthlyFlowsHTML(moves, cfg.ts)}
    <h2 class="section-label">Movements since baseline</h2>
    ${movesListHTML(moves)}
    ${cash.used ? `<h2 class="section-label">Cash · ${signedMoney(cash.balance)} on hand</h2>${movesListHTML(cash.moves)}` : ''}
    <div class="sub" style="font-size:12.5px;color:var(--md-on-surface-variant);margin-top:10px;padding:0 4px">Only you (admin) see the bank and cash. Members see profit in Reports and their share in Split.</div>
    <div class="sub" style="font-size:12.5px;color:var(--md-on-surface-variant);margin-top:10px;padding:0 4px">Doesn't match your real bank? Private spending and fees aren't tracked here. Expenses someone paid personally come off the balance on the day the company pays them back (“Pay back” under Expenses) — just tap “Update balance” and re-enter the real number to re-anchor.</div>`;

  $('#bankUpdate').onclick = () => openBankSheet(balance);
  $('#bankDeposit').onclick = () => openDepositSheet();
  $('#bankCash').onclick = () => openCashSheet(cash.balance);
  document.querySelectorAll('[data-cashmove]').forEach(r => r.onclick = () => {
    const x = payouts.find(y => y.id === Number(r.dataset.cashmove));
    showConfirm(`Delete this ${x.toBank ? 'cash put back' : 'cash withdrawal'} of ${fmtMoney(x.amount)} (${fmtDate(x.paidAt)})?`, async () => {
      await DB.delete('payouts', x.id); snack('Deleted'); render();
    });
  });
  document.querySelectorAll('[data-deposit]').forEach(r => r.onclick = () => {
    const x = payouts.find(y => y.id === Number(r.dataset.deposit));
    showConfirm(`Delete the deposit of ${fmtMoney(x.amount)} from ${x.from || 'private'} (${fmtDate(x.paidAt)})?`, async () => {
      await DB.delete('payouts', x.id); snack('Deposit deleted'); render();
    });
  });
}

/* Admin: record private money put into the company account. */
function openDepositSheet() {
  if (!requireAdmin()) return;
  const cfg = splitCfg();
  openSheet(`
    <h2>Add deposit</h2>
    <p class="sheet-sub">Private money put into the company account. It raises the bank balance (and what members see), but is not revenue.</p>
    <div class="form-card">
      <div class="field-row">
        <label class="field"><span>Amount (฿)</span><input id="dpAmount" type="number" min="1" step="1" inputmode="numeric" placeholder="1000"></label>
        <label class="field"><span>Date</span><input id="dpDate" type="date" value="${tsToDateInput(Date.now())}"></label>
      </div>
      <label class="field"><span>From</span>
        <select id="dpFrom"><option>${esc(cfg.name1)}</option><option>${esc(cfg.name2)}</option><option value="">Other / private</option></select>
      </label>
      <label class="field"><span>Note (optional)</span><input id="dpNote" placeholder="e.g. extra for stock"></label>
      <button class="btn-filled" id="dpSave">Add deposit</button>
    </div>`);
  $('#dpSave').onclick = async () => {
    const amount = Math.round(Number($('#dpAmount').value));
    const ts = dateInputToTs($('#dpDate').value);
    if (!(amount > 0)) return snack('Enter an amount greater than 0');
    if (!ts) return snack('Pick a date');
    await DB.add('payouts', { kind: 'deposit', amount, from: $('#dpFrom').value, note: $('#dpNote').value.trim(), paidAt: ts, periodStart: ts, periodEnd: ts, periodLabel: fmtDate(ts) });
    closeSheet(); snack(`Deposit of ${fmtMoney(amount)} added`); render();
  };
}

/* Admin: take cash out of the bank for purchases (or put leftover back). */
function openCashSheet(onHand = 0) {
  if (!requireAdmin()) return;
  openSheet(`
    <h2>Cash withdrawal</h2>
    <p class="sheet-sub">Money taken out of the bank to pay in cash. It comes off the bank balance and goes into the cash box. Expenses you then log as “Company — cash” come out of the cash box, not the bank. Cash on hand now: ${signedMoney(onHand)}.</p>
    <div class="form-card">
      <div class="field-row">
        <label class="field"><span>Amount (฿)</span><input id="csAmount" type="number" min="1" step="1" inputmode="numeric" placeholder="2000"></label>
        <label class="field"><span>Date</span><input id="csDate" type="date" value="${tsToDateInput(Date.now())}" max="${tsToDateInput(Date.now())}"></label>
      </div>
      <label class="field"><span>Direction</span>
        <select id="csDir"><option value="out">Taken out of the bank (ATM)</option><option value="back">Leftover cash put back in the bank</option></select>
      </label>
      <label class="field"><span>Note (optional)</span><input id="csNote" placeholder="e.g. market purchases"></label>
      <button class="btn-filled" id="csSave">Save</button>
    </div>`);
  $('#csSave').onclick = async () => {
    const amount = Math.round(Number($('#csAmount').value));
    const ts = dateInputToTs($('#csDate').value);
    if (!(amount > 0)) return snack('Enter an amount greater than 0');
    if (!ts || ts > Date.now()) return snack('Pick a date that is not in the future');
    const toBank = $('#csDir').value === 'back';
    await DB.add('payouts', { kind: 'cash', amount, ...(toBank ? { toBank: true } : {}), note: $('#csNote').value.trim(), paidAt: ts, periodStart: ts, periodEnd: ts, periodLabel: fmtDate(ts) });
    closeSheet(); snack(toBank ? `${fmtMoney(amount)} cash put back in the bank` : `${fmtMoney(amount)} withdrawn — now in the cash box`); render();
  };
}

function openBankSheet(prefill) {
  if (!requireAdmin()) return;
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
    const openOptions = () => {
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
    };
    card.addEventListener('click', openOptions);
    attachLongPress(card, openOptions);
  });
}

/* ----- Inventory: incoming purchases (a pure expense log — no stock effect) ----- */
async function renderPurchases() {
  const purchases = await DB.getAll('purchases');
  purchases.sort((a, b) => b.receivedAt - a.receivedAt);
  const cat = p => p.category || 'Other';
  const cfg = splitCfg();


  // Outstanding reimbursements per person.
  const owed = { p1: 0, p2: 0 };
  purchases.forEach(p => { if (isPersonal(p) && !p.reimbursed) owed[p.paidBy] += (p.amount || 0); });
  const owedTotal = owed.p1 + owed.p2;
  $('#owedCard').innerHTML = owedTotal > 0 ? `
    <div class="card" style="margin:12px 0 16px;background:var(--md-tertiary-container);color:var(--md-on-tertiary-container)">
      <div style="font-weight:600;margin-bottom:4px">Outstanding reimbursements · ${fmtMoney(owedTotal)}</div>
      ${['p1', 'p2'].filter(k => owed[k] > 0).map(k => `
        <div class="row owed-row" style="font-size:14px">
          <span>${esc(k === 'p1' ? cfg.name1 : cfg.name2)} fronted <b>${fmtMoney(owed[k])}</b></span>
          ${isAdmin() ? `<button class="btn-tonal owed-pay" data-payback="${k}">Pay back</button>` : ''}
        </div>`).join('')}
      <div style="font-size:12px;opacity:.8;margin-top:6px">${isAdmin() ? '“Pay back” once the money is paid — from the bank it comes off the bank balance, paid outside the bank (cash, private) it doesn’t. To pay back a single expense, tap it in the list.' : 'The admin marks these as paid back once the company has transferred the money.'}</div>
    </div>` : '';
  document.querySelectorAll('[data-payback]').forEach(btn => btn.onclick = () => {
    const who = btn.dataset.payback;
    const open = purchases.filter(p => p.paidBy === who && !p.reimbursed);
    const total = open.reduce((s, p) => s + (p.amount || 0), 0);
    askPaidHow(`Pay back ${paidByLabel(who)} ${fmtMoney(total)}`, `${open.length} expense${open.length === 1 ? '' : 's'} fronted by ${paidByLabel(who)}`,
      async (offBook, at) => { await markReimbursed(open, offBook, at); snack(`${paidByLabel(who)} paid back ${fmtMoney(total)}${offBook ? ' (outside the bank)' : ''}`); render(); });
  });

  let list = purchases;
  if (state.purchaseFilter === '__owed') list = purchases.filter(p => isPersonal(p) && !p.reimbursed);
  else if (state.purchaseFilter !== 'all') list = purchases.filter(p => cat(p) === state.purchaseFilter);

  $('#purchaseList').innerHTML = list.slice(0, 50).map(p => `
    <div class="swipe" data-puid="${p.id}">
      <div class="card is-tappable">
        <div class="row">
          <div class="row-main">
            <div class="name">${esc(p.description)}</div>
            <div class="sub">${cat(p)}${p.supplier ? ' · ' + esc(p.supplier) : ''} · ${fmtDate(p.receivedAt)}${isAdmin() && isCashExpense(p) ? ' · cash' : ''}</div>
            ${isPersonal(p) ? (p.reimbursed
              ? `<span class="badge badge-ok"><span class="dot"></span>Paid by ${esc(paidByLabel(p.paidBy))} · reimbursed${isAdmin() && p.offBook ? ' outside the bank' : ''}</span>`
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
    const openOptions = () => {
      const canReimburse = isPersonal(p) && !p.reimbursed && isAdmin();
      openSheet(`
        <h2>${esc(p.description)}</h2>
        <p class="sheet-sub">${fmtMoney(p.amount)} · ${esc(cat(p))} · ${fmtDate(p.receivedAt)}${isPersonal(p) ? ` · paid by ${esc(paidByLabel(p.paidBy))}${p.reimbursed ? `, paid back${viaText(p.offBook)}${paidOnText(p.reimbursedAt)}` : ''}` : ''}</p>
        <div class="form-card">
          ${canReimburse ? `<button class="btn-tonal" id="ioReimburse">Pay back ${esc(paidByLabel(p.paidBy))} ${fmtMoney(p.amount)}</button>` : ''}
          ${isPersonal(p) && p.reimbursed && isAdmin() ? `<button class="btn-tonal" id="ioBankToggle">${p.offBook ? 'It was paid back from the bank' : 'It was paid back outside the bank'}</button>` : ''}
          <button class="btn-tonal" id="ioEdit">Edit</button>
          <button class="btn-text danger" id="ioDelete">Delete</button>
        </div>`);
      const r = $('#ioReimburse');
      if (r) r.onclick = () => askPaidHow(`Pay back ${paidByLabel(p.paidBy)} ${fmtMoney(p.amount)}`, p.description, async (offBook, at) => {
        await markReimbursed([p], offBook, at);
        snack(`Reimbursed — ${paidByLabel(p.paidBy)} is paid back ${fmtMoney(p.amount)}${offBook ? ' (outside the bank)' : ''}`); render();
      });
      const bt = $('#ioBankToggle');
      if (bt) bt.onclick = async () => {
        await DB.put('purchases', { ...p, offBook: !p.offBook });
        closeSheet(); snack(p.offBook ? 'Counted from the bank again' : 'Taken out of the bank movements'); render();
      };
      $('#ioEdit').onclick = () => { closeSheet(); openPurchaseForm(p); };
      $('#ioDelete').onclick = () => { closeSheet(); confirmDelete(); };
    };
    card.addEventListener('click', openOptions);
    attachLongPress(card, openOptions);
  });
}

const CATEGORY_OPTIONS = ['Materials', 'Packaging', 'Equipment', 'Shipping', 'Other'];

/* Log a new expense (no argument) or edit an existing one. */
function openPurchaseForm(p) {
  const isNew = !p;
  if (isNew) p = { description: '', amount: '', category: 'Materials', paidBy: 'company', supplier: '', receivedAt: Date.now() };
  const cfg = splitCfg();
  const pb = p.paidBy || 'company';
  openSheet(`
    <h2>${isNew ? 'Log an expense' : 'Edit expense'}</h2>
    <div class="form-card">
      <label class="field"><span>What did you buy</span><input id="peDescription" value="${esc(p.description)}" placeholder="e.g. Sand 10kg"></label>
      <div class="field-row">
        <label class="field"><span>Amount spent (฿)</span><input id="peAmount" type="number" min="0" step="1" inputmode="numeric" value="${p.amount}" placeholder="100"></label>
        <label class="field"><span>Category</span>
          <select id="peCategory">${CATEGORY_OPTIONS.map(c => `<option value="${c}" ${(p.category || 'Other') === c ? 'selected' : ''}>${c}</option>`).join('')}</select>
        </label>
      </div>
      <div class="field-row">
        <label class="field"><span>Date</span><input type="date" id="peDate" value="${tsToDateInput(p.receivedAt)}"></label>
        <label class="field"><span>Paid by</span>
          <select id="pePaidBy">
            <option value="company" ${pb === 'company' && !(isAdmin() && p.cash) ? 'selected' : ''}>${isAdmin() ? 'Company — pin / bank' : 'Company'}</option>
            ${isAdmin() ? `<option value="company_cash" ${pb === 'company' && p.cash ? 'selected' : ''}>Company — cash</option>` : ''}
            <option value="p1" ${pb === 'p1' ? 'selected' : ''}>${esc(cfg.name1)}</option>
            <option value="p2" ${pb === 'p2' ? 'selected' : ''}>${esc(cfg.name2)}</option>
          </select>
        </label>
      </div>
      <label class="field-checkbox" id="peReimburseWrap" ${pb === 'company' ? 'hidden' : ''}>
        <input type="checkbox" id="peReimbursed" ${p.reimbursed ? 'checked' : ''} ${isAdmin() ? '' : 'disabled'}>
        <span>Reimbursed — the company has paid this person back ${isAdmin() ? '' : ADMIN_NOTE}</span>
      </label>
      ${isAdmin() ? `<div class="field-row" id="peReimbDetails" ${pb !== 'company' && p.reimbursed ? '' : 'hidden'}>
        <label class="field"><span>Paid back on</span><input type="date" id="peReimbDate" value="${tsToDateInput(p.reimbursedAt || Date.now())}" max="${tsToDateInput(Date.now())}"></label>
        <label class="field"><span>Paid back</span>
          <select id="peReimbVia">
            <option value="bank" ${p.offBook ? '' : 'selected'}>From the bank</option>
            <option value="off" ${p.offBook ? 'selected' : ''}>Cash / private</option>
          </select>
        </label>
      </div>` : ''}
      <label class="field"><span>Supplier (optional)</span><input id="peSupplier" value="${esc(p.supplier || '')}" placeholder="e.g. Northline Supply"></label>
      <button class="btn-filled" id="peSave">${isNew ? 'Log expense' : 'Save changes'}</button>
    </div>`);
  const isCo = v => v === 'company' || v === 'company_cash';
  const syncReimb = () => { if ($('#peReimbDetails')) $('#peReimbDetails').hidden = isCo($('#pePaidBy').value) || !$('#peReimbursed').checked; };
  $('#pePaidBy').onchange = e => { $('#peReimburseWrap').hidden = isCo(e.target.value); syncReimb(); };
  $('#peReimbursed').onchange = syncReimb;
  if (isNew && matchMedia('(pointer: fine)').matches) $('#peDescription').focus();
  $('#peSave').onclick = async () => {
    const description = $('#peDescription').value.trim();
    const amount = Number($('#peAmount').value);
    const ts = dateInputToTs($('#peDate').value);
    if (!description) return snack('Enter what you bought');
    if (!(amount > 0)) return snack('Enter an amount greater than 0');
    if (!ts) return snack('Pick a date');
    const pbVal = $('#pePaidBy').value;
    const paidBy = pbVal === 'company_cash' ? 'company' : pbVal;
    // Only the admin chooses pin or cash; a member's edit keeps what was stored.
    const cash = paidBy === 'company' && (isAdmin() ? pbVal === 'company_cash' : !!p.cash);
    const reimbursed = paidBy === 'company' ? false : $('#peReimbursed').checked;
    // The admin picks when and how it was paid back; otherwise keep what was stored.
    let reimbursedAt, offBook = false;
    if (reimbursed) {
      if ($('#peReimbDate')) {
        reimbursedAt = dateInputToTs($('#peReimbDate').value);
        if (!reimbursedAt || reimbursedAt > Date.now()) return snack('Pick a paid-back date that is not in the future');
        offBook = $('#peReimbVia').value === 'off';
      } else { reimbursedAt = p.reimbursedAt || Date.now(); offBook = !!p.offBook; }
    }
    await DB.put('purchases', {
      ...p, description, amount, category: $('#peCategory').value,
      paidBy, cash, reimbursed, reimbursedAt, offBook,
      supplier: $('#peSupplier').value.trim(), receivedAt: ts
    });
    closeSheet();
    snack(!isNew ? 'Expense updated'
      : paidBy === 'company' ? `Logged ${fmtMoney(amount)} — ${description}${cash && isAdmin() ? ' (cash)' : ''}`
      : `Logged ${fmtMoney(amount)} — fronted by ${paidByLabel(paidBy)}${reimbursed ? ', already paid back' : ' (not paid back yet)'}`);
    render();
  };
}

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
    // Log it for the "stock made" bar in Reports (value at today's selling price).
    await DB.add('stocklog', { productId: p.id, name: fresh.name, qty: grams, unitType: isW ? 'weight' : 'piece',
      value: stockLineValue(fresh, grams), ts: Date.now() });
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
      .filter(c => customerMatches(c, t))
      // an exact customer-number match ("12", "c12") goes first
      .sort((a, b) => (Number(b.no) === Number(t.replace(/^c/, '')) && /\d/.test(t)) - (Number(a.no) === Number(t.replace(/^c/, '')) && /\d/.test(t)))
      .slice(0, 6);
    const exact = customers.some(c => c.name.toLowerCase() === t);
    drop.innerHTML =
      (allowNew && t && !exact ? `<div class="combo-item combo-new" data-new>＋ Create “${esc(input.value.trim())}” as new customer</div>` : '') +
      hits.map(c => `<div class="combo-item" data-cid="${c.id}"><div>${esc(c.name)}</div>${c.phone || c.no ? `<div class="sub">${[custNo(c), esc(c.phone || '')].filter(Boolean).join(' · ')}</div>` : ''}</div>`).join('') +
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
          <input type="number" id="onNew" min="1" inputmode="numeric" value="${o.seq ?? ''}">
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
        ${referrerFieldHTML('of')}
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
      <div class="field-hint" id="ofDiscountHint" hidden></div>
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
  // A customer's standard discount is filled in when they are picked.
  let autoDiscount = null;
  const setAutoDiscount = c => {
    const pct = c && c.discountPct > 0 ? c.discountPct : 0;
    if (pct) {
      $('#ofDiscount').value = pct;
      $('#ofDiscountHint').textContent = `${c.name}'s standard discount: ${pct}%`;
    } else if (autoDiscount !== null && Number($('#ofDiscount').value) === autoDiscount) {
      $('#ofDiscount').value = 0; // undo a discount we filled in for a previous pick
    }
    $('#ofDiscountHint').hidden = !pct;
    autoDiscount = pct || null;
    $('#ofDiscount').dispatchEvent(new Event('input'));
  };
  const getOrderReferrer = attachReferrerField('of', [...customers].sort((a, b) => a.name.localeCompare(b.name)));
  attachCustomerPicker({
    input: $('#ofCustomerSearch'),
    drop: $('#ofCustomerDrop'),
    customers, allowNew: true,
    onPick: c => {
      pickedCustomer = c;
      $('#ofNewCustomer').hidden = true;
      $('#ofAddress').value = c.address || '';
      setAutoDiscount(c);
    },
    onType: name => {
      pickedCustomer = null;
      if (autoDiscount !== null) setAutoDiscount(null);
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
        const referredBy = getOrderReferrer();
        if (referredBy === undefined) return snack('Pick “Referred by” from the list, or leave it empty');
        customerName = typed;
        customerId = await DB.add('customers', {
          name: customerName, phone, email: $('#ofEmail').value.trim(),
          address, createdAt: Date.now(), referredBy: referredBy || undefined,
          no: nextCustomerNo(await DB.getAll('customers'))
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
  const nameOf = id => (customers.find(x => x.id === id) || {}).name;
  const all = customers.map(c => {
    const theirOrders = orders.filter(o => o.customerId === c.id);
    return { ...c, orderCount: theirOrders.length, spent: theirOrders.reduce((s, o) => s + o.total, 0),
      via: nameOf(c.referredBy), brought: referralsOf(customers, c.id).length };
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
    .filter(c => customerMatches(c, q) || (c.address || '').toLowerCase().includes(q))
    .sort((a, b) => b.spent - a.spent);

  $('#customerList').innerHTML = list.map(c => `
    <div class="swipe" data-cid="${c.id}">
      ${SWIPE_PANES}
      <div class="card is-tappable" role="button" tabindex="0">
        <div class="row">
          <div class="row-main">
            <div class="name">${esc(c.name)}</div>
            <div class="sub">${[custNo(c), esc(c.phone || 'No phone on file')].filter(Boolean).join(' · ')}</div>
            ${c.via || c.brought || c.discountPct > 0 ? `<div class="ref-tags">
              ${c.via ? `<span class="ref-tag">via ${esc(c.via)}</span>` : ''}
              ${c.brought ? `<span class="ref-tag is-star">★ brought ${c.brought}</span>` : ''}
              ${c.discountPct > 0 ? `<span class="ref-tag">${c.discountPct}% off</span>` : ''}
            </div>` : ''}
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
    card.addEventListener('click', () => openCustomerDetail(c.id));
    attachLongPress(card, () => openCustomerDetail(c.id));
  });
}

async function openCustomerDetail(id) {
  const [c, orders, customers] = await Promise.all([DB.get('customers', id), DB.getAll('orders'), DB.getAll('customers')]);
  const theirs = orders.filter(o => o.customerId === id).sort((a, b) => b.createdAt - a.createdAt);
  const spent = theirs.reduce((s, o) => s + o.total, 0);
  const spentBy = cid => orders.filter(o => o.customerId === cid).reduce((s, o) => s + o.total, 0);
  const referrer = customers.find(x => x.id === c.referredBy);
  const brought = referralsOf(customers, id).sort((a, b) => spentBy(b.id) - spentBy(a.id));
  const chain = referralChain(customers, id);
  const refRev = referralRevenue(customers, orders, id);
  openSheet(`
    <h2>${esc(c.name)}</h2>
    <div class="sub" style="color:var(--md-on-surface-variant);margin:-8px 0 2px">${custNo(c) ? `<b>${custNo(c)}</b> · ` : ''}${esc(c.phone || 'No phone on file')}${c.email ? ' · ' + esc(c.email) : ''}</div>
    <div class="sub" style="color:var(--md-on-surface-variant);margin:0 0 16px">${esc(c.address || 'No address on file')}</div>
    ${c.notes ? `<div class="card" style="margin-bottom:16px;background:var(--md-secondary-container);color:var(--md-on-secondary-container);font-size:14px">${esc(c.notes)}</div>` : ''}
    ${referrer || c.discountPct > 0 ? `<div class="chip-row" style="padding:0;margin:0 0 14px">
      ${referrer ? `<button class="chip ref-chip" data-open-customer="${referrer.id}">via ${esc(referrer.name)} ›</button>` : ''}
      ${c.discountPct > 0 ? `<span class="chip is-selected">${c.discountPct}% standard discount</span>` : ''}
    </div>` : ''}
    <div class="chip-row" style="padding:0;margin:0 0 14px;flex-wrap:wrap;overflow:visible">
      ${referrer ? '' : '<button class="chip" id="cdSetRef">＋ Referred by…</button>'}
      <button class="chip" id="cdAddRef">＋ Someone they brought…</button>
    </div>
    <div class="stat-grid">
      <div class="stat-card"><div class="label">Total spent</div><div class="value" style="font-size:24px">${fmtMoney(spent)}</div></div>
      <div class="stat-card"><div class="label">Orders</div><div class="value" style="font-size:24px">${theirs.length}</div></div>
    </div>
    ${brought.length ? `
    <h2 class="section-label">Brought in ${brought.length} customer${brought.length === 1 ? '' : 's'}${chain.size > brought.length ? ` · ${chain.size} incl. via via` : ''}</h2>
    <div class="card">
      ${referralTreeHTML(customers, orders, id)}
      <div class="ref-totals">
        <span><i class="ref-key d"></i>Direct <b>${fmtMoney(refRev.direct)}</b></span>
        <span><i class="ref-key i"></i>Via via <b>${fmtMoney(refRev.indirect)}</b></span>
        <span>Total through ${esc(c.name)} <b>${fmtMoney(refRev.total)}</b></span>
      </div>
    </div>` : ''}
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
    <div class="sheet-actions">
      <button class="btn-tonal" id="cdEdit">Edit customer</button>
      <button class="btn-text danger" id="cdDelete">Delete</button>
    </div>`);

  $('#cdEdit').onclick = () => openCustomerForm(id);
  if ($('#cdSetRef')) $('#cdSetRef').onclick = () => openLinkSheet(c, customers, 'referrer');
  $('#cdAddRef').onclick = () => openLinkSheet(c, customers, 'referral');
  document.querySelectorAll('[data-open-customer]').forEach(b => b.onclick = () => openCustomerDetail(Number(b.dataset.openCustomer)));
  $('#cdDelete').onclick = () => showConfirm(`Delete customer “${c.name}”? Their past orders stay in the order list.`, async () => {
    await DB.delete('customers', id);
    closeSheet(); snack('Customer deleted'); render();
  });
}

/* Money that came in through a customer: from the people they brought in
   themselves (direct) and from the people those brought in, and so on
   (via via). Their own orders are not included. */
function referralRevenue(customers, orders, id) {
  const spentBy = cid => orders.filter(o => o.customerId === cid).reduce((t, o) => t + o.total, 0);
  const directIds = referralsOf(customers, id).map(c => c.id);
  const all = referralChain(customers, id);
  const direct = directIds.reduce((t, cid) => t + spentBy(cid), 0);
  const total = [...all].reduce((t, cid) => t + spentBy(cid), 0);
  return { direct, indirect: total - direct, total, people: all.size, directPeople: directIds.length };
}
/* Nested list of everyone brought in through id (with what each spent). */
function referralTreeHTML(customers, orders, id, seen = new Set([id])) {
  const kids = referralsOf(customers, id).filter(k => !seen.has(k.id));
  if (!kids.length) return '';
  kids.forEach(k => seen.add(k.id));
  const spentBy = cid => orders.filter(o => o.customerId === cid).reduce((t, o) => t + o.total, 0);
  return `<ul class="ref-tree">${kids.sort((a, b) => spentBy(b.id) - spentBy(a.id)).map(k => `
    <li><button class="ref-node" data-open-customer="${k.id}">
      <span>${esc(k.name)} <small>${custNo(k)}</small></span><span class="amt">${fmtMoney(spentBy(k.id))}</span>
    </button>${referralTreeHTML(customers, orders, k.id, seen)}</li>`).join('')}</ul>`;
}

/* Quick linking from a customer's detail:
   mode 'referrer' → pick who sent c;  mode 'referral' → pick someone c brought in. */
function openLinkSheet(c, customers, mode) {
  const chainDown = referralChain(customers, c.id, new Set([c.id]));      // c + everyone c brought
  const up = new Set(); for (let x = c; x && x.referredBy && !up.has(x.referredBy); x = customers.find(y => y.id === x.referredBy)) up.add(x.referredBy);
  const candidates = customers
    .filter(x => mode === 'referrer' ? !chainDown.has(x.id) : (x.id !== c.id && !up.has(x.id) && x.referredBy !== c.id))
    .sort((a, b) => a.name.localeCompare(b.name));
  openSheet(`
    <h2>${mode === 'referrer' ? `Who sent ${esc(c.name)}?` : `Who did ${esc(c.name)} bring in?`}</h2>
    <p class="sheet-sub">Search by name, phone or customer number.</p>
    <div class="form-card">
      <label class="field" style="position:relative"><span>Customer</span>
        <input id="lkSearch" placeholder="e.g. Lena or 12" autocomplete="off">
        <div class="combo-drop" id="lkDrop" hidden></div>
      </label>
    </div>`);
  attachCustomerPicker({
    input: $('#lkSearch'), drop: $('#lkDrop'), customers: candidates, allowNew: false,
    onPick: async x => {
      if (mode === 'referrer') {
        await DB.put('customers', { ...c, referredBy: x.id });
        snack(`${c.name} — referred by ${x.name}`);
      } else {
        const prev = customers.find(y => y.id === x.referredBy);
        const apply = async () => { await DB.put('customers', { ...x, referredBy: c.id }); snack(`${x.name} — brought in by ${c.name}`); openCustomerDetail(c.id); render(); };
        if (prev) return showConfirm(`${x.name} is now linked to ${prev.name}. Change it to ${c.name}?`, apply, 'Change');
        return apply();
      }
      openCustomerDetail(c.id); render();
    }
  });
  $('#lkSearch').focus();
}

/* Admin overview (Settings → Customer sources): organic vs referred
   customers, revenue from each, best referrers and new customers per month. */
async function customerSources() {
  const [customers, orders] = await Promise.all([DB.getAll('customers'), DB.getAll('orders')]);
  const spentBy = id => orders.filter(o => o.customerId === id).reduce((t, o) => t + o.total, 0);
  const referred = customers.filter(c => customers.some(x => x.id === c.referredBy));
  const organic = customers.filter(c => !referred.includes(c));
  const revOf = list => list.reduce((t, c) => t + spentBy(c.id), 0);
  const referrers = customers.map(c => {
    const rr = referralRevenue(customers, orders, c.id);
    return { c, direct: rr.directPeople, chain: rr.people, revenue: rr.total, revDirect: rr.direct, revIndirect: rr.indirect };
  }).filter(r => r.direct > 0).sort((a, b) => b.direct - a.direct || b.revenue - a.revenue);
  const first = Math.min(...customers.map(c => c.createdAt || Date.now()));
  const months = isFinite(first) ? monthsFrom(first, Date.now()).reverse().map(m => {
    const added = customers.filter(c => (c.createdAt || 0) >= m.start && (c.createdAt || 0) < m.end);
    return { label: m.label, organic: added.filter(c => organic.includes(c)).length, referred: added.filter(c => referred.includes(c)).length };
  }).filter(m => m.organic + m.referred) : [];
  return { customers, organic, referred, orgRev: revOf(organic), refRev: revOf(referred), referrers, months };
}

/* Horizontal stacked bars: revenue through each top referrer, split into
   direct (people they brought) and via via (people those brought). */
function refChartHTML(referrers) {
  const top = referrers.filter(r => r.revenue > 0).sort((a, b) => b.revenue - a.revenue).slice(0, 8);
  if (!top.length) return '';
  const max = top[0].revenue;
  return `
    <h2 class="section-label">Revenue through referrals</h2>
    <div class="card ref-chart" id="refChart">
      <div class="ref-legend"><span><i class="d"></i>Direct</span><span><i class="i"></i>Via via</span></div>
      ${top.map((r, i) => `
        <div class="ref-bar-row" data-ref-i="${i}" data-open-customer="${r.c.id}" role="button" tabindex="0"
             aria-label="${esc(r.c.name)}: direct ${fmtMoney(r.revDirect)}, via via ${fmtMoney(r.revIndirect)}, total ${fmtMoney(r.revenue)}">
          <span class="ref-bar-name">${esc(r.c.name)} <small>${custNo(r.c)}</small></span>
          <span class="ref-bar-track">
            ${r.revDirect > 0 ? `<span class="ref-seg d ${r.revIndirect > 0 ? '' : 'end'}" style="width:${(r.revDirect / max * 66).toFixed(2)}%"></span>` : ''}
            ${r.revIndirect > 0 ? `<span class="ref-seg i end ${r.revDirect > 0 ? '' : 'first'}" style="width:${(r.revIndirect / max * 66).toFixed(2)}%"></span>` : ''}
            <span class="ref-bar-val">${fmtMoney(r.revenue)}</span>
          </span>
        </div>`).join('')}
      <div class="ref-tip" id="refTip" hidden></div>
    </div>`;
}
function wireRefChart(referrers) {
  const chart = $('#refChart');
  if (!chart) return;
  const top = referrers.filter(r => r.revenue > 0).sort((a, b) => b.revenue - a.revenue).slice(0, 8);
  const tip = $('#refTip');
  chart.querySelectorAll('.ref-bar-row').forEach(row => {
    const r = top[Number(row.dataset.refI)];
    const show = () => {
      tip.innerHTML = `<b>${esc(r.c.name)}</b> ${custNo(r.c)}<br>Direct ${fmtMoney(r.revDirect)} · ${r.direct} ${r.direct === 1 ? 'person' : 'people'}<br>Via via ${fmtMoney(r.revIndirect)} · ${r.chain - r.direct} ${r.chain - r.direct === 1 ? 'person' : 'people'}`;
      tip.hidden = false;
      const top_ = row.offsetTop + row.offsetHeight + 2;
      tip.style.top = top_ + 'px'; tip.style.left = '12px';
    };
    row.addEventListener('mouseenter', show);
    row.addEventListener('focus', show);
    row.addEventListener('mouseleave', () => { tip.hidden = true; });
    row.addEventListener('blur', () => { tip.hidden = true; });
  });
}

async function openCustomerSources() {
  if (!requireAdmin()) return;
  const d = await customerSources();
  const pct = n => d.customers.length ? Math.round(n / d.customers.length * 100) + '%' : '0%';
  openSheet(`
    <h2>Customer sources</h2>
    <p class="sheet-sub">Organic = came on their own · Referred = sent by another customer</p>
    <div class="stat-grid">
      <div class="stat-card"><div class="label">Organic</div><div class="value" style="font-size:24px">${d.organic.length}</div><div class="hint">${pct(d.organic.length)} · ${fmtMoney(d.orgRev)} revenue</div></div>
      <div class="stat-card"><div class="label">Referred</div><div class="value" style="font-size:24px">${d.referred.length}</div><div class="hint">${pct(d.referred.length)} · ${fmtMoney(d.refRev)} revenue</div></div>
    </div>
    ${refChartHTML(d.referrers)}
    <h2 class="section-label">Best referrers</h2>
    <div class="card">
      ${d.referrers.slice(0, 15).map(r => `
        <button class="flow-row ref-row" data-open-customer="${r.c.id}">
          <span>${esc(r.c.name)} <small>${custNo(r.c)} · brought ${r.direct}${r.chain > r.direct ? ` (${r.chain} incl. via via)` : ''}<br>direct ${fmtMoney(r.revDirect)} · via via ${fmtMoney(r.revIndirect)}</small></span>
          <span>${fmtMoney(r.revenue)} ›</span>
        </button>`).join('') || '<div class="empty">No referrals recorded yet.</div>'}
    </div>
    <h2 class="section-label">New customers per month</h2>
    <div class="card month-flows">
      <div class="month-flow mf-head" style="grid-template-columns:1.6fr 1fr 1fr"><span>Month</span><span>Organic</span><span>Referred</span></div>
      ${d.months.map(m => `<div class="month-flow" style="grid-template-columns:1.6fr 1fr 1fr"><span class="mf-name">${m.label}</span><span>${m.organic}</span><span>${m.referred}</span></div>`).join('') || '<div class="empty">No customers yet.</div>'}
    </div>
    <button class="btn-tonal" id="csXlsx" style="margin-top:14px">Download as Excel</button>`);
  document.querySelectorAll('[data-open-customer]').forEach(b => b.onclick = () => openCustomerDetail(Number(b.dataset.openCustomer)));
  wireRefChart(d.referrers);
  $('#csXlsx').onclick = async () => {
    const [orders] = await Promise.all([DB.getAll('orders')]);
    const spentBy = id => orders.filter(o => o.customerId === id).reduce((t, o) => t + o.total, 0);
    const byId = id => d.customers.find(c => c.id === id);
    const rows = [['No.', 'Customer', 'Source', 'Referred by', 'Brought in', 'Joined', 'Spent', 'Revenue via direct referrals', 'Revenue via via', 'Revenue through them (total)'],
      ...d.customers.slice().sort((a, b) => (a.no || 0) - (b.no || 0)).map(c => {
        const rr = referralRevenue(d.customers, orders, c.id);
        return [custNo(c), c.name,
          d.referred.includes(c) ? 'Referred' : 'Organic', byId(c.referredBy) ? `${byId(c.referredBy).name} (${custNo(byId(c.referredBy))})` : '',
          referralsOf(d.customers, c.id).length, c.createdAt ? tsToDateInput(c.createdAt) : '', spentBy(c.id), rr.direct, rr.indirect, rr.total];
      })];
    const summary = [['', 'Customers', 'Revenue'], ['Organic', d.organic.length, d.orgRev], ['Referred', d.referred.length, d.refRev], [],
      ['Month', 'Organic', 'Referred'], ...d.months.map(m => [m.label, m.organic, m.referred])];
    await saveFile(`BuddyBoard customer sources ${tsToDateInput(Date.now())}.xlsx`,
      buildXlsx([{ name: 'Summary', rows: summary, widths: [22, 12, 12] }, { name: 'Customers', rows, widths: [8, 24, 10, 28, 10, 12, 10, 14, 12, 14] }]), 'Overview');
  };
}

/* ----- Customer numbers: C0001, C0002… in order of creation ----- */
const custNo = c => Number.isFinite(c && c.no) ? 'C' + String(c.no).padStart(4, '0') : '';
const nextCustomerNo = customers => customers.reduce((m, c) => Number.isFinite(c.no) ? Math.max(m, c.no) : m, 0) + 1;
/* Search helper: name, phone or customer number ("12", "c12", "C0012"). */
function customerMatches(c, term) {
  const t = term.trim().toLowerCase();
  if (!t) return true;
  if (c.name.toLowerCase().includes(t) || (c.phone || '').includes(t)) return true;
  const n = t.replace(/^c/, '');
  return /^\d+$/.test(n) && Number.isFinite(c.no) && c.no === Number(n);
}
/* Give every customer without a number one, oldest first. Only the admin's
   device does this, so two phones never hand out the same numbers. */
async function ensureCustomerNos() {
  if (!isAdmin()) return;
  const customers = await DB.getAll('customers');
  const missing = customers.filter(c => !Number.isFinite(c.no))
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0) || a.id - b.id);
  let next = nextCustomerNo(customers);
  for (const c of missing) await DB.put('customers', { ...c, no: next++ });
}

/* ----- Referrals: which customer brought in which ----- */
/* customer.referredBy = id of the customer who sent them. */
const referralsOf = (customers, id) => customers.filter(c => c.referredBy === id);
// Everyone brought in by id, directly or further down the chain.
function referralChain(customers, id, seen = new Set()) {
  referralsOf(customers, id).forEach(c => { if (!seen.has(c.id)) { seen.add(c.id); referralChain(customers, c.id, seen); } });
  return seen;
}
const referrerFieldHTML = (prefix, current) => `
  <label class="field" style="position:relative"><span>Referred by (optional)</span>
    <input id="${prefix}Ref" value="${esc(current ? current.name : '')}" placeholder="Search the customer who sent them" autocomplete="off">
    <div class="combo-drop" id="${prefix}RefDrop" hidden></div>
  </label>`;
/* Wires the field; returns a getter → customer id, null (empty) or
   undefined (typed a name that isn't a customer). */
function attachReferrerField(prefix, customers, initialId) {
  const input = $(`#${prefix}Ref`);
  let picked = initialId ?? null;
  attachCustomerPicker({
    input, drop: $(`#${prefix}RefDrop`), customers, allowNew: false,
    onPick: c => { picked = c.id; }, onType: () => { picked = null; }
  });
  return () => {
    const v = input.value.trim();
    if (!v) return null;
    if (picked) return picked;
    const exact = customers.find(c => c.name.toLowerCase() === v.toLowerCase());
    return exact ? exact.id : undefined;
  };
}

async function openCustomerForm(id) {
  const c = id ? await DB.get('customers', id) : { name: '', phone: '', email: '', address: '', notes: '' };
  const all = await DB.getAll('customers');
  // Can't be referred by yourself or by someone you brought in.
  const blocked = id ? referralChain(all, id, new Set([id])) : new Set();
  const candidates = all.filter(x => !blocked.has(x.id)).sort((a, b) => a.name.localeCompare(b.name));
  const referrer = all.find(x => x.id === c.referredBy);
  openSheet(`
    <h2>${id ? 'Edit customer' : 'New customer'}</h2>
    <div class="form-card">
      <label class="field"><span>Name</span><input id="cfName" value="${esc(c.name)}"></label>
      <label class="field"><span>Phone number</span><input id="cfPhone" type="tel" inputmode="tel" value="${esc(c.phone || '')}" placeholder="08x-xxx-xxxx"></label>
      <label class="field"><span>Email (optional)</span><input id="cfEmail" type="email" inputmode="email" value="${esc(c.email || '')}" placeholder="name@example.com"></label>
      <label class="field"><span>Address</span><input id="cfAddress" value="${esc(c.address || '')}"></label>
      ${referrerFieldHTML('cf', referrer)}
      <label class="field"><span>Standard discount (%) — filled in automatically on their new orders</span>
        <input id="cfDiscount" type="number" min="0" max="100" step="1" inputmode="numeric" value="${c.discountPct || ''}" placeholder="0">
      </label>
      <label class="field"><span>Notes (optional)</span><textarea id="cfNotes" rows="3" placeholder="e.g. prefers extra spicy, always ships to office">${esc(c.notes || '')}</textarea></label>
      <button class="btn-filled" id="cfSave">${id ? 'Save changes' : 'Add customer'}</button>
    </div>`);
  const getReferrer = attachReferrerField('cf', candidates, c.referredBy);
  $('#cfSave').onclick = async () => {
    const name = $('#cfName').value.trim();
    const phone = $('#cfPhone').value.trim();
    if (!name) return snack('Enter the customer name');
    if (!phone) return snack('Enter a phone number');
    const referredBy = getReferrer();
    if (referredBy === undefined) return snack('Pick “Referred by” from the list, or leave it empty');
    const discountPct = Math.min(100, Math.max(0, Number($('#cfDiscount').value) || 0));
    await DB.put('customers', {
      ...c, ...(id ? { id } : {}), name, phone,
      email: $('#cfEmail').value.trim(),
      address: $('#cfAddress').value.trim(),
      notes: $('#cfNotes').value.trim(),
      referredBy: referredBy || undefined,
      discountPct: discountPct || undefined,
      createdAt: c.createdAt || Date.now(),
      no: Number.isFinite(c.no) ? c.no : nextCustomerNo(all)
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
  await ensureOrderSeq(); // give the sample orders proper order numbers
  await ensureCustomerNos();

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
  .then(() => Promise.all([ensureDeliveryProduct(), ensureOrderSeq(), ensureMigrations(), ensureCustomerNos()]))
  .then(() => switchView('home'));
