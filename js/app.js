// ============================================================
// Finance Tracker — main app: state, rendering, filters, dialogs.
// ============================================================

import { createBackend, isConfigured, isDemo } from "./firebase.js?v=49";
import { parseCibcCsv, exportJson, guessCategory as guessCategoryCibc, cleanVendor as cleanVendorCibc } from "./csv.js?v=49";
import { parseHdfcPdf, guessCategoryHdfc, cleanVendorHdfc, PdfPasswordRequiredError } from "./hdfc.js?v=49";
import { renderCategoryChart, renderTrendChart, refreshTheme } from "./charts.js?v=49";
import { askGemini, hasGeminiKey, setGeminiKey, clearGeminiKey, askGeminiRecurringPrediction } from "./gemini.js?v=49";

// ---------- Banks ----------
// Two fully separate banks, switchable from the top bar. Each has its own
// Firestore-scoped data (see js/firebase.js), currency, and import format —
// transactions never mix between them.
const BANKS = {
  cibc: {
    id: "cibc", label: "CIBC", country: "Canada", currency: "CAD", symbol: "$", locale: "en-CA",
    importLabel: "Import CIBC CSV",
    importTitle: "Import CIBC CSV",
    importHint: "In CIBC online banking, open your account → Download transactions → CSV, then choose the file here.",
    fileAccept: ".csv,text/csv",
    pickLabel: "Choose CSV file",
    notFoundHint: "Couldn't find any transactions in this file. Make sure it's the CSV downloaded from CIBC online banking.",
  },
  hdfc: {
    id: "hdfc", label: "HDFC", country: "India", currency: "INR", symbol: "₹", locale: "en-IN",
    importLabel: "Import HDFC PDF Statement",
    importTitle: "Import HDFC PDF statement",
    importHint: "In HDFC NetBanking, download your account statement as a PDF, then choose the file here.",
    fileAccept: ".pdf,application/pdf",
    pickLabel: "Choose PDF statement",
    notFoundHint: "Couldn't find any transactions in this file, or the statement summary block was missing. Make sure it's an HDFC account statement PDF.",
  },
};
let activeBank = "cibc";
function loadActiveBank() {
  try {
    const saved = localStorage.getItem("ft-active-bank");
    if (saved && BANKS[saved]) activeBank = saved;
  } catch {}
}
function saveActiveBank() {
  try { localStorage.setItem("ft-active-bank", activeBank); } catch {}
}

export const CATEGORIES = [
  "Groceries", "Dining", "Transport", "Bills",
  "Shopping", "Entertainment", "Health", "Other",
];

// Only these Google accounts may use the app. Add more emails if needed.
const ALLOWED_EMAILS = ["abilashabilash009@gmail.com"];

const CATEGORY_ICONS = {
  Groceries: "grocery",
  Dining: "restaurant",
  Transport: "directions_bus",
  Bills: "receipt_long",
  Shopping: "shopping_bag",
  Entertainment: "movie",
  Health: "favorite",
  Other: "category",
};

const CARD_TYPE_ICONS = { debit: "account_balance_wallet", credit: "credit_card" };
const CARD_TYPE_LABELS = { debit: "Debit", credit: "Credit" };

// Known brands → their real brand color, matched case-insensitively
// against the (already-cleaned) vendor name. Anything unmatched falls
// back to the default neutral chip styling.
const VENDOR_BRAND_COLORS = [
  [/doordash/i, "#EB1700"],
  [/uber eats/i, "#06C167"],
  [/\buber\b/i, "#1A1A1A"],
  [/\blyft\b/i, "#EA0B8C"],
  [/presto/i, "#00A9E0"],
  [/go transit|metrolinx/i, "#00853F"],
  [/\bttc\b/i, "#DA251D"],
  [/netflix/i, "#E50914"],
  [/spotify/i, "#1DB954"],
  [/amazon|amzn/i, "#FF9900"],
  [/costco/i, "#E31837"],
  [/walmart|wal-mart/i, "#0071CE"],
  [/tim hortons/i, "#C8102E"],
  [/starbucks/i, "#00704A"],
  [/mcdonald/i, "#DA291C"],
  [/rogers/i, "#D22630"],
  [/\bbell canada\b|\bbell mobility\b/i, "#00549A"],
  [/telus/i, "#4B286D"],
  [/fido/i, "#EE3A29"],
  [/koodo/i, "#00AEEF"],
  [/freedom mobile/i, "#EE7623"],
  [/public mobile/i, "#EC008C"],
  [/virgin plus/i, "#E10A0A"],
  [/shoppers drug mart/i, "#EC1C24"],
  [/cineplex/i, "#E4002B"],
  [/apple\.com/i, "#A2AAAD"],
  [/petro-?canada/i, "#ED1C24"],
  [/canadian tire/i, "#D3161B"],
  [/dollar tree/i, "#00A650"],
  [/dollarama/i, "#007A3D"],
  [/best buy/i, "#0046BE"],
  [/home depot/i, "#F96302"],
  [/\bikea\b/i, "#0058A3"],
  [/h&m/i, "#E50010"],
  [/youtube/i, "#FF0000"],
  [/playstation/i, "#003791"],
  [/\bxbox\b/i, "#107C10"],
  [/nintendo/i, "#E60012"],
  [/\bsteam\b/i, "#1B2838"],
  [/disney/i, "#113CCF"],
];

function vendorBrandColor(vendor) {
  for (const [re, color] of VENDOR_BRAND_COLORS) if (re.test(vendor)) return color;
  return null;
}

// Precompute rgba() tints in JS rather than relying on CSS color-mix()
// with a `transparent` endpoint, which some engines fail to repaint
// correctly when driven by a var()-based custom property.
function hexToRgbaString(hex, alpha) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

// ---------- Utilities ----------
const $ = (sel) => document.querySelector(sel);
let moneyFmt = new Intl.NumberFormat(BANKS.cibc.locale, { style: "currency", currency: BANKS.cibc.currency });
function updateMoneyFormatter() {
  const b = BANKS[activeBank];
  moneyFmt = new Intl.NumberFormat(b.locale, { style: "currency", currency: b.currency });
}
const fmtMoney = (cents) => moneyFmt.format(cents / 100);
const activeCleanVendor = (v) => (activeBank === "hdfc" ? cleanVendorHdfc(v) : cleanVendorCibc(v));
const activeGuessCategory = (v) => (activeBank === "hdfc" ? guessCategoryHdfc(v) : guessCategoryCibc(v));
const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const monthKey = (dateStr) => dateStr.slice(0, 7); // YYYY-MM
const monthLabel = (key) => {
  const [y, m] = key.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString("en-CA", { month: "long", year: "numeric" });
};
const shortDate = (dateStr) => {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  const opts = { month: "short", day: "numeric" };
  if (y !== new Date().getFullYear()) opts.year = "numeric";
  const base = dt.toLocaleDateString("en-CA", opts);
  const weekday = dt.toLocaleDateString("en-CA", { weekday: "short" });
  return `${base} (${weekday})`;
};
const escapeHtml = (s) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ---------- Ripple effect ----------
document.addEventListener("pointerdown", (e) => {
  const host = e.target.closest(".btn-filled, .btn-tonal, .btn-text, .chip, .fab, .icon-btn, .menu-item, .btn-google");
  if (!host) return;
  const rect = host.getBoundingClientRect();
  const size = Math.max(rect.width, rect.height);
  const ripple = document.createElement("span");
  ripple.className = "ripple";
  ripple.style.width = ripple.style.height = size + "px";
  ripple.style.left = e.clientX - rect.left - size / 2 + "px";
  ripple.style.top = e.clientY - rect.top - size / 2 + "px";
  host.appendChild(ripple);
  setTimeout(() => ripple.remove(), 550);
});

// ---------- Theme ----------
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  $("#btn-theme .material-symbols-rounded").textContent = theme === "dark" ? "light_mode" : "dark_mode";
  try { localStorage.setItem("ft-theme", theme); } catch {}
  refreshTheme();
  renderCharts(); // repaint with new palette
}
function initTheme() {
  let theme;
  try { theme = localStorage.getItem("ft-theme"); } catch {}
  if (!theme) theme = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  document.documentElement.dataset.theme = theme;
  $("#btn-theme .material-symbols-rounded").textContent = theme === "dark" ? "light_mode" : "dark_mode";
}
initTheme();

// ---------- State ----------
let backend = null;
let transactions = [];
let settings = null; // { debitBalanceCents, debitBalanceAsOf, limitCents, usedCents, usedAsOf }
let filters = { month: "current", from: "", to: "", categories: new Set(), vendors: new Set(), search: "" };
// Ordered list of active sort columns — empty means "no sort applied,
// show transactions in the order the backend returns them."
let sortKeys = [];
let editingId = null;
let pendingCsv = null;
let undoTx = null;
let aiHistory = []; // [{ role: "user"|"model", text }]
let aiBusy = false;
let snackbarTimer = null;
let vendorChipsExpanded = false;
// Rendering thousands of <tr> at once (e.g. "All time" on a large import)
// is what actually freezes the browser — paginate so only one page of
// rows ever hits the DOM.
const ROWS_PER_PAGE = 100;
let tablePage = 0;
let calendarViewDate = new Date(); // month currently shown in the floating calendar
let calendarSelectedDate = null; // "YYYY-MM-DD" or null

// ---------- Derived data ----------
// Just the month/date-range scoping — used both for the main table and
// to compute which vendor chips are worth showing for the current period.
function dateScopedTransactions() {
  const now = todayStr();
  const curMonth = monthKey(now);
  let list = transactions;

  if (filters.from || filters.to) {
    list = list.filter((t) => (!filters.from || t.date >= filters.from) && (!filters.to || t.date <= filters.to));
  } else if (filters.month === "current") {
    list = list.filter((t) => monthKey(t.date) === curMonth);
  } else if (filters.month === "last") {
    const d = new Date(); d.setMonth(d.getMonth() - 1);
    const lastKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    list = list.filter((t) => monthKey(t.date) === lastKey);
  } else if (filters.month !== "all") {
    list = list.filter((t) => monthKey(t.date) === filters.month);
  }
  return list;
}

// Every distinct vendor within the current date scope, A→Z — powers the
// dynamic "Vendors this period" chips. Capped so a large "All time"
// import (thousands of transactions, possibly with un-normalized
// vendor text) can't render enough chips to lock up the browser.
const MAX_VENDOR_CHIPS = 150;
function topVendorsForPeriod() {
  const counts = new Map();
  for (const t of dateScopedTransactions()) counts.set(t.vendor, (counts.get(t.vendor) || 0) + 1);

  let vendors = [...counts.keys()];
  let truncated = false;
  if (vendors.length > MAX_VENDOR_CHIPS) {
    truncated = true;
    vendors = [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_VENDOR_CHIPS)
      .map(([v]) => v);
  }
  return { vendors: vendors.sort((a, b) => a.localeCompare(b)), truncated };
}

function filteredTransactions() {
  let list = dateScopedTransactions();

  if (filters.categories.size) list = list.filter((t) => filters.categories.has(t.category));

  // Vendor chips and the search box both narrow by vendor, so treat them
  // as one combined OR: selecting "Rajeevmalik" while searching "PayProp"
  // should show both, not the (usually empty) intersection of the two.
  if (filters.vendors.size || filters.search) {
    const q = filters.search.toLowerCase();
    list = list.filter((t) => {
      const matchesSearch = !!filters.search && (t.vendor.toLowerCase().includes(q) || (t.note || "").toLowerCase().includes(q));
      const matchesVendor = filters.vendors.has(t.vendor);
      return matchesSearch || matchesVendor;
    });
  }

  if (!sortKeys.length) return list; // no sort chosen — natural backend order

  // Once at least one column is chosen, fall back to date so ties land
  // in a stable order.
  const keys = sortKeys.some((k) => k.field === "date") ? sortKeys : [...sortKeys, { field: "date", dir: "desc" }];
  return [...list].sort((a, b) => {
    for (const { field, dir } of keys) {
      let cmp;
      if (field === "amount") cmp = (a.type === "expense" ? -a.cents : a.cents) - (b.type === "expense" ? -b.cents : b.cents);
      else if (field === "vendor") cmp = a.vendor.localeCompare(b.vendor);
      else if (field === "category") cmp = a.category.localeCompare(b.category);
      else if (field === "cardtype") cmp = (a.cardType || "debit").localeCompare(b.cardType || "debit");
      else cmp = a.date < b.date ? -1 : a.date > b.date ? 1 : 0;
      if (cmp !== 0) return dir === "asc" ? cmp : -cmp;
    }
    return 0;
  });
}

function computeDebitBalance() {
  if (!settings || settings.debitBalanceCents == null) return null;
  const asOf = settings.debitBalanceAsOf || "1900-01-01";
  let bal = settings.debitBalanceCents;
  for (const t of transactions) {
    if ((t.cardType || "debit") !== "debit") continue;
    if (t.date >= asOf) bal += t.type === "income" ? t.cents : -t.cents;
  }
  return bal;
}

function computeCreditUsed() {
  const base = settings?.usedCents ?? 0;
  const asOf = settings?.usedAsOf;
  if (!asOf) return base; // no auto-adjustment until saved once via the dialog
  let used = base;
  for (const t of transactions) {
    if (t.cardType !== "credit") continue;
    if (t.date >= asOf) used += t.type === "expense" ? t.cents : -t.cents;
  }
  return Math.max(0, used);
}

// ---------- Rendering ----------
const countUpHandles = new WeakMap();
function countUp(el, targetCents) {
  const prev = Number(el.dataset.cents || 0);
  el.dataset.cents = targetCents;
  const existing = countUpHandles.get(el);
  if (existing) cancelAnimationFrame(existing);
  const start = performance.now(), dur = 600;
  const step = (now) => {
    const p = Math.min(1, (now - start) / dur);
    const eased = 1 - Math.pow(1 - p, 3);
    el.textContent = fmtMoney(Math.round(prev + (targetCents - prev) * eased));
    if (p < 1) countUpHandles.set(el, requestAnimationFrame(step));
  };
  countUpHandles.set(el, requestAnimationFrame(step));
}

function renderSummary() {
  const balance = computeDebitBalance();
  if (balance == null) {
    $("#sum-balance").textContent = "— —";
    $("#sum-balance-foot").textContent = "Tap to set your debit balance";
  } else {
    countUp($("#sum-balance"), balance);
    const asOf = settings.debitBalanceAsOf ? `updated from ${shortDate(settings.debitBalanceAsOf)}` : "";
    $("#sum-balance-foot").textContent = asOf || "Auto-updates as you log debit transactions";
  }

  const limit = settings?.limitCents ?? 0;
  const used = computeCreditUsed();
  $("#sum-credit").textContent = limit ? fmtMoney(Math.max(0, limit - used)) : "— —";
  const fill = $("#util-fill");
  if (limit > 0) {
    const pct = Math.min(100, Math.round((used / limit) * 100));
    fill.style.width = pct + "%";
    fill.style.background = pct < 30 ? "var(--util-ok)" : pct < 70 ? "var(--util-warn)" : "var(--util-bad)";
    const hint = pct < 30 ? "healthy" : pct < 70 ? "getting high" : "high — hurts credit score";
    $("#sum-credit-foot").textContent = `${fmtMoney(used)} used of ${fmtMoney(limit)} · ${pct}% — ${hint}`;
  } else {
    fill.style.width = "0%";
    $("#sum-credit-foot").textContent = "Tap to set your credit limit";
  }

  // This month vs last month
  const cur = monthKey(todayStr());
  const d = new Date(); d.setMonth(d.getMonth() - 1);
  const last = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  const sumFor = (key) =>
    transactions.filter((t) => t.type === "expense" && monthKey(t.date) === key).reduce((a, t) => a + t.cents, 0);
  const curSpent = sumFor(cur), lastSpent = sumFor(last);
  countUp($("#sum-month"), curSpent);
  const foot = $("#sum-month-foot");
  foot.className = "card-foot";
  if (lastSpent > 0) {
    const diff = curSpent - lastSpent;
    const pct = Math.abs(Math.round((diff / lastSpent) * 100));
    if (diff > 0) { foot.textContent = `▲ ${pct}% vs last month (${fmtMoney(lastSpent)})`; foot.classList.add("delta-up"); }
    else if (diff < 0) { foot.textContent = `▼ ${pct}% vs last month (${fmtMoney(lastSpent)})`; foot.classList.add("delta-down"); }
    else foot.textContent = "Same as last month";
  } else {
    foot.textContent = "No spending last month";
  }
}

function renderMonthOptions() {
  const sel = $("#filter-month");
  const months = [...new Set(transactions.map((t) => monthKey(t.date)))].sort().reverse();
  const cur = monthKey(todayStr());
  const d = new Date(); d.setMonth(d.getMonth() - 1);
  const last = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  const prevVal = filters.month;

  let html = `<option value="current">This month</option><option value="last">Last month</option><option value="all">All time</option>`;
  for (const m of months) {
    if (m === cur || m === last) continue;
    html += `<option value="${m}">${monthLabel(m)}</option>`;
  }
  sel.innerHTML = html;
  sel.value = [...sel.options].some((o) => o.value === prevVal) ? prevVal : "current";
  filters.month = sel.value;
}

function renderCategoryChips() {
  const wrap = $("#category-chips");
  wrap.innerHTML = CATEGORIES.map(
    (c) => `<button class="chip ${filters.categories.has(c) ? "selected" : ""}" data-cat="${c}">
      <span class="material-symbols-rounded">${CATEGORY_ICONS[c]}</span>${c}</button>`
  ).join("");
}

function renderVendorChips() {
  const { vendors, truncated } = topVendorsForPeriod();
  // Keep any currently-selected vendor visible even if it drops out of
  // the top list after a filter change, so the active state stays honest.
  for (const v of filters.vendors) if (!vendors.includes(v)) vendors.push(v);

  const toggle = $("#vendor-chips-toggle");
  toggle.classList.toggle("hidden", vendors.length === 0);
  toggle.querySelector(".chip-row-toggle-text").textContent = truncated
    ? `Vendors this period (top ${MAX_VENDOR_CHIPS} — run "Clean up vendor names" to consolidate more)`
    : "Vendors this period";
  // Auto-expand while a vendor filter is active, so its chip stays visible.
  const expanded = vendorChipsExpanded || filters.vendors.size > 0;
  toggle.setAttribute("aria-expanded", String(expanded));
  $("#vendor-chips").classList.toggle("hidden", !expanded);

  $("#vendor-chips").innerHTML = vendors
    .map((v) => {
      const color = vendorBrandColor(v);
      const cls = `chip${filters.vendors.has(v) ? " selected" : ""}${color ? " chip-branded" : ""}`;
      const style = color
        ? ` style="--chip-color:${color};--chip-bg-light:${hexToRgbaString(color, 0.2)};--chip-bg-dark:${hexToRgbaString(color, 0.3)}"`
        : "";
      return `<button class="${cls}"${style} data-vendor="${escapeHtml(v)}">${escapeHtml(v)}</button>`;
    })
    .join("");
}

// ---------- Recurring charge prediction ----------
// Detects vendors billed at a consistent interval and consistent amount
// (subscriptions, rent, phone bills, etc.) and projects when the next
// charge is likely to land. Deterministic and free — no AI call needed,
// so it can run instantly on every page load.
function detectRecurringCharges() {
  const byVendor = new Map();
  for (const t of transactions) {
    if (t.type !== "expense") continue;
    if (!byVendor.has(t.vendor)) byVendor.set(t.vendor, []);
    byVendor.get(t.vendor).push(t);
  }

  const today = new Date(todayStr() + "T00:00:00");
  const predictions = [];

  for (const [vendor, txs] of byVendor) {
    if (txs.length < 3) continue;
    const sorted = [...txs].sort((a, b) => a.date.localeCompare(b.date));
    const dates = sorted.map((t) => new Date(t.date + "T00:00:00"));

    const intervals = [];
    for (let i = 1; i < dates.length; i++) intervals.push((dates[i] - dates[i - 1]) / 86400000);
    const recentIntervals = intervals.slice(-4);
    const meanInterval = recentIntervals.reduce((a, b) => a + b, 0) / recentIntervals.length;
    if (meanInterval < 5 || meanInterval > 400) continue; // too frequent or too rare to call "recurring"
    const intervalCV = Math.sqrt(recentIntervals.reduce((a, b) => a + (b - meanInterval) ** 2, 0) / recentIntervals.length) / meanInterval;
    if (intervalCV > 0.3) continue; // interval too irregular

    const recentAmounts = sorted.slice(-4).map((t) => t.cents);
    const meanAmount = recentAmounts.reduce((a, b) => a + b, 0) / recentAmounts.length;
    const amountCV = Math.sqrt(recentAmounts.reduce((a, b) => a + (b - meanAmount) ** 2, 0) / recentAmounts.length) / meanAmount;
    if (amountCV > 0.2) continue; // amount too irregular to be a fixed bill/subscription

    const lastDate = dates[dates.length - 1];
    const nextDate = new Date(lastDate.getTime() + Math.round(meanInterval) * 86400000);
    const daysOut = Math.round((nextDate - today) / 86400000);
    if (daysOut < -15 || daysOut > 60) continue; // outside the useful prediction window

    predictions.push({
      vendor,
      predictedDate: `${nextDate.getFullYear()}-${String(nextDate.getMonth() + 1).padStart(2, "0")}-${String(nextDate.getDate()).padStart(2, "0")}`,
      predictedCents: Math.round(meanAmount),
      daysOut,
    });
  }

  predictions.sort((a, b) => a.daysOut - b.daysOut);
  return predictions.slice(0, 8);
}

// Shared row template for both the local heuristic and AI-parsed
// predictions, so they always look identical regardless of source.
// Groups predictions into "This month" / "Next month" / "Later" and
// renders each as a small card, color-coded per group, instead of a
// flat list — makes it easy to see what's due soon vs further out.
function recurringRowsHtml(predictions, { approximate }) {
  const curKey = monthKey(todayStr());
  const d = new Date(); d.setMonth(d.getMonth() + 1);
  const nextKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;

  const groups = [
    { key: "current", label: "This month", cls: "bucket-current", items: [] },
    { key: "next", label: "Next month", cls: "bucket-next", items: [] },
    { key: "later", label: "Later", cls: "bucket-later", items: [] },
  ];
  for (const p of predictions) {
    const mk = monthKey(p.predictedDate);
    const group = mk === curKey ? groups[0] : mk === nextKey ? groups[1] : groups[2];
    group.items.push(p);
  }

  return groups
    .filter((g) => g.items.length)
    .map((g) => {
      const cards = g.items
        .map((p) => {
          const overdue = p.daysOut < 0;
          const when = overdue
            ? `${Math.abs(p.daysOut)} day${Math.abs(p.daysOut) === 1 ? "" : "s"} overdue`
            : p.daysOut === 0
            ? "Due today"
            : p.daysOut === 1
            ? "Due tomorrow"
            : shortDate(p.predictedDate);
          return `<div class="recurring-card-item ${overdue ? "overdue" : g.cls}">
            <div class="recurring-card-top">
              <span class="material-symbols-rounded recurring-icon">${overdue ? "notification_important" : "event_repeat"}</span>
              <span class="recurring-amount">${approximate ? "~" : ""}${fmtMoney(p.predictedCents)}</span>
            </div>
            <span class="recurring-vendor">${escapeHtml(p.vendor)}</span>
            <span class="recurring-when">${when}</span>
          </div>`;
        })
        .join("");
      const groupTotal = g.items.reduce((a, p) => a + p.predictedCents, 0);
      return `<div class="recurring-group">
        <div class="recurring-group-header">
          <h3 class="recurring-group-label">${g.label}</h3>
          <span class="recurring-group-total">${approximate ? "~" : ""}${fmtMoney(groupTotal)}</span>
        </div>
        <div class="recurring-cards">${cards}</div>
      </div>`;
    })
    .join("");
}

function renderRecurringChargesLocal() {
  const predictions = detectRecurringCharges();
  const listEl = $("#recurring-list");
  if (!predictions.length) {
    listEl.innerHTML = `<p class="recurring-empty">Not enough billing history yet to predict recurring charges — this fills in once a vendor has charged you at least 3 times.</p>`;
    return;
  }
  listEl.innerHTML = recurringRowsHtml(predictions, { approximate: true });
}

// Parses Gemini's "* Month D, YYYY — Vendor — $XX.XX (Expense)" bullets
// (the exact format required in the prompt) into the same structured
// shape detectRecurringCharges() produces, so both render identically.
function parseAiRecurringPredictions(raw) {
  const today = new Date(todayStr() + "T00:00:00");
  const lineRe = /^(.+?)\s*—\s*(.+?)\s*—\s*\$?([\d,]+\.\d{2})\s*\(Expense\)/i;
  const predictions = [];

  for (const rawLine of raw.split("\n")) {
    const bullet = rawLine.match(/^\s*[*-]\s*(.+)$/);
    if (!bullet) continue;
    const m = bullet[1].match(lineRe);
    if (!m) continue;
    const parsedDate = new Date(m[1].trim());
    if (isNaN(parsedDate)) continue;
    predictions.push({
      vendor: m[2].trim(),
      predictedDate: `${parsedDate.getFullYear()}-${String(parsedDate.getMonth() + 1).padStart(2, "0")}-${String(parsedDate.getDate()).padStart(2, "0")}`,
      predictedCents: Math.round(parseFloat(m[3].replace(/,/g, "")) * 100),
      daysOut: Math.round((parsedDate - today) / 86400000),
    });
  }
  predictions.sort((a, b) => a.daysOut - b.daysOut);
  return predictions;
}

// ---------- AI-powered recurring-charge predictions ----------
// Cached in localStorage and refreshed at most every ~12h automatically
// (plus a manual refresh button), since this is a static site with no
// backend to run a true fixed-time schedule — refreshing on app-open
// when the cache is stale is the closest free equivalent.
const recurringCacheKey = () => `ft-recurring-cache-${activeBank}`;
const RECURRING_CACHE_MAX_AGE_MS = 12 * 60 * 60 * 1000;
let recurringCache = null; // { text, timestamp }
let recurringCheckedThisSession = false;

function loadRecurringCache() {
  try {
    const raw = localStorage.getItem(recurringCacheKey());
    recurringCache = raw ? JSON.parse(raw) : null;
  } catch {
    recurringCache = null;
  }
}
function saveRecurringCache() {
  try { localStorage.setItem(recurringCacheKey(), JSON.stringify(recurringCache)); } catch {}
}

function relativeTimeSince(ts) {
  const mins = Math.round((Date.now() - ts) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function renderRecurringCharges() {
  const sub = $("#recurring-sub");
  if (!hasGeminiKey()) {
    renderRecurringChargesLocal();
    sub.textContent = "Estimated locally — add a Gemini key in Ask AI (✨) for smarter predictions.";
    return;
  }
  if (recurringCache?.text) {
    const predictions = parseAiRecurringPredictions(recurringCache.text);
    $("#recurring-list").innerHTML = predictions.length
      ? recurringRowsHtml(predictions, { approximate: false })
      : `<p class="recurring-empty">${escapeHtml(recurringCache.text.trim())}</p>`;
    sub.textContent = `AI-predicted · updated ${relativeTimeSince(recurringCache.timestamp)}`;
  } else {
    // First-ever load with a key but no cache yet: show the local
    // estimate immediately while the AI version loads in the background.
    renderRecurringChargesLocal();
    sub.textContent = "Estimated locally — checking AI predictions…";
  }
}

async function refreshRecurringChargesFromAI(force = false) {
  if (!hasGeminiKey()) {
    if (force) showSnackbar("Add a Gemini API key in Ask AI (✨) to get AI-predicted recurring charges");
    return;
  }
  if (!force && recurringCache && Date.now() - recurringCache.timestamp < RECURRING_CACHE_MAX_AGE_MS) return;

  const btn = $("#btn-recurring-refresh");
  btn.classList.add("spinning");
  try {
    const text = await askGeminiRecurringPrediction(transactions, BANKS[activeBank]);
    recurringCache = { text, timestamp: Date.now() };
    saveRecurringCache();
  } catch (err) {
    console.error(err);
    if (force) showSnackbar(`Couldn't refresh predictions: ${err.message}`);
  } finally {
    btn.classList.remove("spinning");
    renderRecurringCharges();
  }
}

// ---------- Sidebar calendar + independent day view ----------
// This panel is deliberately separate from the main filters/table above:
// clicking a day here never touches filters.from/to, so it's a quick
// "peek at this day" view without disturbing whatever you were browsing.
function renderCalendar() {
  const year = calendarViewDate.getFullYear();
  const month = calendarViewDate.getMonth();
  $("#calendar-month-label").textContent = calendarViewDate.toLocaleDateString("en-CA", { month: "long", year: "numeric" });

  const daysWithData = new Set(transactions.map((t) => t.date));
  const firstWeekday = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const today = todayStr();

  let html = "";
  for (let i = 0; i < firstWeekday; i++) html += `<span class="cal-day cal-empty"></span>`;
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${year}-${String(month + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    const cls = ["cal-day"];
    if (dateStr === today) cls.push("cal-today");
    if (daysWithData.has(dateStr)) cls.push("cal-has-data");
    if (dateStr === calendarSelectedDate) cls.push("cal-selected");
    html += `<button type="button" class="${cls.join(" ")}" data-date="${dateStr}">${d}</button>`;
  }
  $("#calendar-grid").innerHTML = html;
  $("#btn-cal-clear").classList.toggle("hidden", !calendarSelectedDate);
}

function renderDayPanel() {
  const titleEl = $("#day-panel-title");
  const totalEl = $("#day-panel-total");
  const listEl = $("#day-panel-list");

  if (!calendarSelectedDate) {
    titleEl.textContent = "Select a day";
    totalEl.textContent = "";
    listEl.innerHTML = `<p class="day-panel-empty">Click a day in the calendar to see its transactions here — this view is independent from the filters above.</p>`;
    return;
  }

  const dayTxs = transactions
    .filter((t) => t.date === calendarSelectedDate)
    .sort((a, b) => b.cents - a.cents);
  titleEl.textContent = shortDate(calendarSelectedDate);

  if (!dayTxs.length) {
    totalEl.textContent = "";
    listEl.innerHTML = `<p class="day-panel-empty">No transactions on this day.</p>`;
    return;
  }

  const spent = dayTxs.filter((t) => t.type === "expense").reduce((a, t) => a + t.cents, 0);
  const income = dayTxs.filter((t) => t.type === "income").reduce((a, t) => a + t.cents, 0);
  totalEl.textContent = `${dayTxs.length} transaction${dayTxs.length === 1 ? "" : "s"} · −${fmtMoney(spent)}${income ? ` · +${fmtMoney(income)}` : ""}`;

  listEl.innerHTML = dayTxs
    .map((t) => {
      const sign = t.type === "expense" ? "−" : "+";
      return `<div class="day-panel-row">
        <div class="day-panel-row-main">
          <span class="day-panel-vendor">${escapeHtml(t.vendor)}</span>
          <span class="day-panel-cat">${t.category} · ${CARD_TYPE_LABELS[t.cardType || "debit"]}</span>
        </div>
        <span class="day-panel-amount ${t.type}">${sign}${fmtMoney(t.cents)}</span>
      </div>`;
    })
    .join("");
}

function selectCalendarDay(dateStr) {
  calendarSelectedDate = calendarSelectedDate === dateStr ? null : dateStr;
  renderCalendar();
  renderDayPanel();
}

function renderTable(list) {
  const tbody = $("#tx-tbody");
  const empty = $("#tx-empty");
  $("#tx-count").textContent = list.length ? `(${list.length})` : "";

  const spent = list.filter((t) => t.type === "expense").reduce((a, t) => a + t.cents, 0);
  const income = list.filter((t) => t.type === "income").reduce((a, t) => a + t.cents, 0);
  $("#tx-total").innerHTML = list.length
    ? `<span class="tx-total-chip tx-total-spent"><span class="material-symbols-rounded">arrow_upward</span>${fmtMoney(spent)}</span>${
        income ? `<span class="tx-total-chip tx-total-income"><span class="material-symbols-rounded">arrow_downward</span>${fmtMoney(income)}</span>` : ""
      }`
    : "";

  if (!list.length) {
    tbody.innerHTML = "";
    empty.classList.remove("hidden");
    renderPagination(0, 0);
    return;
  }
  empty.classList.add("hidden");

  const pageCount = Math.max(1, Math.ceil(list.length / ROWS_PER_PAGE));
  tablePage = Math.min(tablePage, pageCount - 1);
  const pageList = list.slice(tablePage * ROWS_PER_PAGE, (tablePage + 1) * ROWS_PER_PAGE);
  renderPagination(tablePage, pageCount);

  tbody.innerHTML = pageList.map((t, i) => {
    const sign = t.type === "expense" ? "−" : "+";
    const catChip = `<span class="cat-chip"><span class="material-symbols-rounded">${CATEGORY_ICONS[t.category] || "category"}</span>${t.category}</span>`;
    const cardType = t.cardType || "debit";
    const cardChip = `<span class="card-type-chip tag-${cardType}"><span class="material-symbols-rounded">${CARD_TYPE_ICONS[cardType]}</span>${CARD_TYPE_LABELS[cardType]}</span>`;
    return `<tr data-id="${t.id}" style="animation-delay:${Math.min(i * 25, 250)}ms">
      <td class="td-date">${shortDate(t.date)}</td>
      <td class="td-vendor">${escapeHtml(t.vendor)}${t.note ? `<span class="td-note">${escapeHtml(t.note)}</span>` : ""}</td>
      <td class="td-cat">${catChip}</td>
      <td class="td-cardtype">${cardChip}</td>
      <td class="td-amount ${t.type}">${sign}${fmtMoney(t.cents)}</td>
      <td class="td-meta-mobile"><span class="td-date" style="display:inline">${shortDate(t.date)}</span>${catChip}${cardChip}</td>
      <td class="td-actions">
        <button class="icon-btn btn-edit" title="Edit" aria-label="Edit"><span class="material-symbols-rounded">edit</span></button>
        <button class="icon-btn btn-delete" title="Delete" aria-label="Delete"><span class="material-symbols-rounded">delete</span></button>
      </td>
    </tr>`;
  }).join("");

  // Update sort indicators
  document.querySelectorAll(".tx-table th.sortable").forEach((th) => {
    const icon = th.querySelector(".sort-icon");
    const idx = sortKeys.findIndex((k) => k.field === th.dataset.sort);
    icon.textContent = idx === -1 ? "" : sortKeys[idx].dir === "asc" ? "arrow_upward" : "arrow_downward";
  });
  const resetBtn = $("#btn-reset-sort");
  if (resetBtn) resetBtn.classList.toggle("hidden", sortKeys.length === 0);
}

function renderPagination(page, pageCount) {
  const wrap = $("#tx-pagination");
  if (!wrap) return;
  if (pageCount <= 1) {
    wrap.classList.add("hidden");
    wrap.innerHTML = "";
    return;
  }
  wrap.classList.remove("hidden");
  wrap.innerHTML = `
    <button class="icon-btn" id="btn-page-prev" ${page === 0 ? "disabled" : ""} aria-label="Previous page"><span class="material-symbols-rounded">chevron_left</span></button>
    <span class="pagination-label">Page ${page + 1} of ${pageCount}</span>
    <button class="icon-btn" id="btn-page-next" ${page >= pageCount - 1 ? "disabled" : ""} aria-label="Next page"><span class="material-symbols-rounded">chevron_right</span></button>
  `;
  $("#btn-page-prev").addEventListener("click", () => { tablePage = Math.max(0, tablePage - 1); renderTable(filteredTransactions()); });
  $("#btn-page-next").addEventListener("click", () => { tablePage += 1; renderTable(filteredTransactions()); });
}

function renderCharts() {
  if (!document.getElementById("chart-category")) return;
  const list = filteredTransactions();

  // Doughnut: expenses by category in the filtered period
  const byCategory = {};
  let totalSpent = 0;
  for (const t of list) {
    if (t.type !== "expense") continue;
    byCategory[t.category] = (byCategory[t.category] || 0) + t.cents;
    totalSpent += t.cents;
  }
  const hasData = totalSpent > 0;
  $("#chart-category-empty").classList.toggle("hidden", hasData);
  $("#chart-category").parentElement.style.display = hasData ? "" : "none";
  if (hasData) {
    const sorted = Object.fromEntries(Object.entries(byCategory).sort((a, b) => b[1] - a[1]));
    renderCategoryChart($("#chart-category"), sorted, fmtMoney);
    $("#doughnut-total").textContent = fmtMoney(totalSpent);
  }

  // Bar: last 6 months of expenses (all transactions, not filter-bound)
  const months = [];
  const now = new Date();
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    months.push({
      key,
      label: d.toLocaleDateString("en-CA", { month: "short" }),
      spentCents: transactions
        .filter((t) => t.type === "expense" && monthKey(t.date) === key)
        .reduce((a, t) => a + t.cents, 0),
    });
  }
  renderTrendChart($("#chart-trend"), months, fmtMoney);
}

function renderAll() {
  renderSummary();
  renderMonthOptions();
  renderCategoryChips();
  renderVendorChips();
  renderTable(filteredTransactions());
  renderCharts();
  renderCalendar();
  renderDayPanel();
  renderRecurringCharges();

  // Kick off the AI refresh check once per session (respects the 12h
  // cache internally) — not on every renderAll() call, which fires on
  // routine UI interactions too.
  if (!recurringCheckedThisSession) {
    recurringCheckedThisSession = true;
    refreshRecurringChargesFromAI(false);
  }
}

function rerenderFiltered() {
  tablePage = 0;
  renderTable(filteredTransactions());
  renderCharts();
}

// ---------- Snackbar ----------
function showSnackbar(text, actionLabel, onAction) {
  const bar = $("#snackbar"), btn = $("#snackbar-action");
  $("#snackbar-text").textContent = text;
  bar.classList.remove("hidden");
  if (actionLabel) {
    btn.textContent = actionLabel;
    btn.classList.remove("hidden");
    btn.onclick = () => { onAction?.(); hideSnackbar(); };
  } else {
    btn.classList.add("hidden");
  }
  clearTimeout(snackbarTimer);
  snackbarTimer = setTimeout(hideSnackbar, 5000);
}
function hideSnackbar() { $("#snackbar").classList.add("hidden"); }

// ---------- Dialogs ----------
function openTxDialog(tx = null) {
  editingId = tx?.id || null;
  $("#dialog-tx-title").textContent = tx ? "Edit transaction" : "Add transaction";
  $("#tx-amount").value = tx ? (tx.cents / 100).toFixed(2) : "";
  $("#tx-vendor").value = tx?.vendor || "";
  $("#tx-date").value = tx?.date || todayStr();
  $("#tx-category").value = tx?.category || "Other";
  $("#tx-note").value = tx?.note || "";
  (tx?.type === "income" ? $("#type-income") : $("#type-expense")).checked = true;
  (tx?.cardType === "credit" ? $("#card-credit-radio") : $("#card-debit")).checked = true;
  $("#dialog-tx").showModal();
  if (!tx) $("#tx-amount").focus();
}

async function saveTxFromForm(e) {
  e.preventDefault();
  const amount = parseFloat($("#tx-amount").value);
  const vendor = $("#tx-vendor").value.trim();
  const date = $("#tx-date").value;
  if (!amount || amount <= 0 || !vendor || !date) {
    showSnackbar("Please fill amount, vendor and date");
    return;
  }
  const tx = {
    date,
    vendor,
    category: $("#tx-category").value,
    type: document.querySelector('input[name="tx-type"]:checked').value,
    cardType: document.querySelector('input[name="tx-cardtype"]:checked').value,
    cents: Math.round(amount * 100),
    note: $("#tx-note").value.trim(),
  };
  $("#dialog-tx").close();
  try {
    if (editingId) {
      await backend.updateTransaction(editingId, tx);
      showSnackbar("Transaction updated");
    } else {
      await backend.addTransaction(tx);
      showSnackbar("Transaction added");
    }
  } catch (err) {
    console.error(err);
    showSnackbar("Couldn't save — check your connection");
  }
}

function openAccountsDialog() {
  $("#acc-balance").value = settings?.debitBalanceCents != null ? (computeDebitBalance() / 100).toFixed(2) : "";
  $("#acc-limit").value = settings?.limitCents ? (settings.limitCents / 100).toFixed(2) : "";
  $("#acc-used").value = computeCreditUsed() ? (computeCreditUsed() / 100).toFixed(2) : "";
  $("#dialog-accounts").showModal();
}

async function saveAccountsFromForm(e) {
  e.preventDefault();
  const patch = {};
  const bal = $("#acc-balance").value;
  const lim = $("#acc-limit").value;
  const used = $("#acc-used").value;
  if (bal !== "") { patch.debitBalanceCents = Math.round(parseFloat(bal) * 100); patch.debitBalanceAsOf = todayStr(); }
  if (lim !== "") patch.limitCents = Math.round(parseFloat(lim) * 100);
  if (used !== "") { patch.usedCents = Math.round(parseFloat(used) * 100); patch.usedAsOf = todayStr(); }
  $("#dialog-accounts").close();
  if (!Object.keys(patch).length) return;
  try {
    await backend.saveSettings(patch);
    showSnackbar("Saved");
  } catch (err) {
    console.error(err);
    showSnackbar("Couldn't save — check your connection");
  }
}

// ---------- CSV / PDF import ----------
// The same dialog markup is reused for both banks — CIBC imports a CSV,
// HDFC imports a PDF statement — swapping title/hint/accept-filter text
// based on which bank is currently active.
function applyBankToImportUI() {
  const b = BANKS[activeBank];
  $("#dialog-csv-title").textContent = b.importTitle;
  $("#dialog-csv-hint").textContent = b.importHint;
  $("#csv-file").setAttribute("accept", b.fileAccept);
  $("#btn-csv-pick").lastChild.textContent = b.pickLabel;
  $("#menu-import-csv").lastChild.textContent = b.importLabel;
}

let pendingCsvFile = null;

function openCsvDialog() {
  pendingCsv = null;
  pendingCsvFile = null;
  $("#csv-preview").classList.add("hidden");
  $("#btn-csv-import").classList.add("hidden");
  $("#csv-password-row").classList.add("hidden");
  $("#btn-csv-unlock").classList.add("hidden");
  $("#csv-password").value = "";
  $("#csv-file").value = "";
  applyBankToImportUI();
  $("#dialog-csv").showModal();
}

// Identifies "the same transaction" across imports so re-uploading a
// statement that overlaps a previous month doesn't create duplicates.
const txSignature = (t) => `${t.date}|${t.cents}|${t.type}|${activeCleanVendor(t.vendor)}`;

async function handleCsvFile(file, password) {
  pendingCsvFile = file;
  const preview = $("#csv-preview");
  preview.classList.remove("hidden");
  $("#csv-password-row").classList.add("hidden");
  $("#btn-csv-unlock").classList.add("hidden");

  let parsed, skipped, usedOcr, summaryVerified;
  try {
    if (activeBank === "hdfc") {
      preview.innerHTML = "Reading statement…";
      ({ transactions: parsed, skipped, usedOcr, summaryVerified } = await parseHdfcPdf(
        await file.arrayBuffer(),
        (page, total) => { preview.innerHTML = `Reading page ${page} of ${total} using text recognition (this PDF has no text layer)…`; },
        password
      ));
    } else {
      ({ transactions: parsed, skipped } = parseCibcCsv(await file.text()));
    }
  } catch (err) {
    if (err instanceof PdfPasswordRequiredError) {
      preview.innerHTML = err.wrongPassword ? "That password didn't work — try again." : "This PDF is password protected — enter the password below.";
      $("#csv-password-row").classList.remove("hidden");
      $("#btn-csv-unlock").classList.remove("hidden");
      $("#btn-csv-import").classList.add("hidden");
      $("#csv-password").value = "";
      $("#csv-password").focus();
      return;
    }
    console.error(err);
    preview.innerHTML = `Couldn't read this file: ${escapeHtml(err.message)}`;
    pendingCsv = null;
    $("#btn-csv-import").classList.add("hidden");
    return;
  }

  const ocrNote = usedOcr
    ? `<br /><em>${summaryVerified === false ? "⚠️ " : ""}This PDF had no text layer, so it was read using text recognition (OCR)${
        summaryVerified === false ? " and the totals didn't match the statement's own summary" : ""
      } — please double-check the imported amounts carefully.</em>`
    : "";

  if (!parsed.length) {
    preview.innerHTML = usedOcr
      ? "Text recognition couldn't find any transactions in this scanned PDF. Try a clearer scan, or re-download a digital statement if your bank offers one."
      : BANKS[activeBank].notFoundHint;
    pendingCsv = null;
    $("#btn-csv-import").classList.add("hidden");
    return;
  }

  const existingSigs = new Set(transactions.map(txSignature));
  const seenInFile = new Set();
  const deduped = [];
  let duplicateCount = 0;
  for (const tx of parsed) {
    const sig = txSignature(tx);
    if (existingSigs.has(sig) || seenInFile.has(sig)) { duplicateCount++; continue; }
    seenInFile.add(sig);
    deduped.push(tx);
  }

  pendingCsv = deduped;
  const dupNote = duplicateCount
    ? `<br /><em>${duplicateCount} already-imported transaction${duplicateCount === 1 ? "" : "s"} skipped as duplicates.</em>`
    : "";

  if (!deduped.length) {
    preview.innerHTML = `All ${parsed.length} transactions in this file were already imported — nothing new to add.${dupNote}${ocrNote}`;
    $("#btn-csv-import").classList.add("hidden");
    return;
  }

  const spent = deduped.filter((t) => t.type === "expense").reduce((a, t) => a + t.cents, 0);
  const dates = deduped.map((t) => t.date).sort();
  preview.innerHTML = `<strong>${deduped.length} new transaction${deduped.length === 1 ? "" : "s"}</strong> found (${shortDate(dates[0])} – ${shortDate(dates[dates.length - 1])})<br />
    Total spending: <strong>${fmtMoney(spent)}</strong><br />
    Categories auto-guessed from vendor names — you can edit any row later.${skipped ? `<br /><em>${skipped} unreadable line(s) skipped.</em>` : ""}${dupNote}${ocrNote}`;
  $("#btn-csv-import").classList.remove("hidden");
}

async function importCsv() {
  if (!pendingCsv) return;
  $("#dialog-csv").close();
  showSnackbar(`Importing ${pendingCsv.length} transactions…`);
  try {
    await backend.addTransactions(pendingCsv);
    showSnackbar(`Imported ${pendingCsv.length} transactions ✓`);
  } catch (err) {
    console.error(err);
    showSnackbar("Import failed — check your connection");
  }
  pendingCsv = null;
}

// One-time migration: re-cleans vendor text on transactions imported
// before the vendor-cleanup step existed (import doesn't retroactively
// touch already-saved rows).
async function cleanUpVendorNames() {
  const dirty = transactions
    .map((t) => ({ t, cleaned: activeCleanVendor(t.vendor) }))
    .filter(({ t, cleaned }) => cleaned && cleaned !== t.vendor);

  if (!dirty.length) {
    showSnackbar("Vendor names already clean");
    return;
  }
  showSnackbar(`Cleaning up ${dirty.length} vendor name${dirty.length === 1 ? "" : "s"}…`);
  try {
    for (const { t, cleaned } of dirty) {
      await backend.updateTransaction(t.id, { vendor: cleaned });
    }
    showSnackbar(`Cleaned up ${dirty.length} vendor name${dirty.length === 1 ? "" : "s"} ✓`);
  } catch (err) {
    console.error(err);
    showSnackbar("Couldn't finish — check your connection");
  }
}

// ---------- Delete transactions ----------
function deleteDialogScope() {
  return document.querySelector('input[name="delete-scope"]:checked').value;
}

function txsToDelete() {
  if (deleteDialogScope() === "all") return transactions;
  const from = $("#delete-from").value;
  const to = $("#delete-to").value;
  if (!from && !to) return [];
  return transactions.filter((t) => (!from || t.date >= from) && (!to || t.date <= to));
}

function updateDeleteSummary() {
  const n = txsToDelete().length;
  $("#delete-summary").textContent = n
    ? `This will delete ${n} transaction${n === 1 ? "" : "s"}.`
    : "No transactions match this range.";
  $("#btn-delete-confirm").disabled = n === 0;
}

function openDeleteDialog() {
  $("#delete-scope-all").checked = true;
  $("#delete-range-fields").classList.add("hidden");
  $("#delete-from").value = "";
  $("#delete-to").value = "";
  updateDeleteSummary();
  $("#dialog-delete").showModal();
}

async function confirmDeleteTransactions() {
  const targets = txsToDelete();
  if (!targets.length) return;
  const scope = deleteDialogScope();
  if (scope === "all" && !confirm(`Delete all ${targets.length} transactions? This can't be undone once you navigate away.`)) {
    return;
  }
  $("#dialog-delete").close();
  const ids = targets.map((t) => t.id);
  const backup = targets.map(({ id, ...rest }) => rest);
  try {
    await backend.deleteTransactions(ids);
    showSnackbar(`Deleted ${ids.length} transaction${ids.length === 1 ? "" : "s"}`, "Undo", async () => {
      await backend.addTransactions(backup);
    });
  } catch (err) {
    console.error(err);
    showSnackbar("Couldn't delete — check your connection");
  }
}

// ---------- Ask AI ----------
// Recognizes "Month D, YYYY" / "Mon D, YYYY" / "YYYY-MM-DD" style dates.
const AI_DATE_RE = /\b((?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept?|Oct|Nov|Dec)\.?\s+\d{1,2},?\s*\d{4}|\d{4}-\d{2}-\d{2})\b/g;

// Minimal, safe markdown → HTML for Gemini's replies (bold + bullet lists,
// plus color-coding dates and Income/Expense labels for scannability).
// Text is HTML-escaped first, so only the tags this function inserts exist.
function markdownLiteToHtml(raw) {
  let text = escapeHtml(raw);
  // Color every dollar amount on a line together with its (Income)/(Expense)
  // tag, whichever order they appear in — e.g. both "$600.00 (Expense)" and
  // "(Expense): $600.00" show up depending on how Gemini phrases it.
  text = text.split("\n").map((line) => {
    const tag = line.match(/\((Income|Expense)\)/);
    if (!tag) return line;
    const kind = tag[1].toLowerCase();
    return line
      .replace(/\*{0,2}\((Income|Expense)\)\*{0,2}/, `<span class="ai-tag-${kind}">($1)</span>`)
      .replace(/\*{0,2}(\$[\d,]+(?:\.\d{2})?)\*{0,2}/g, `<span class="ai-tag-${kind}">$1</span>`);
  }).join("\n");
  text = text.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  text = text.replace(AI_DATE_RE, '<span class="ai-date">$1</span>');
  const lines = text.split("\n");
  let html = "";
  let inList = false;
  for (const line of lines) {
    const bullet = line.match(/^\s*[*-]\s+(.*)/);
    if (bullet) {
      if (!inList) { html += "<ul>"; inList = true; }
      html += `<li>${bullet[1]}</li>`;
    } else {
      if (inList) { html += "</ul>"; inList = false; }
      if (line.trim()) html += `<p>${line}</p>`;
    }
  }
  if (inList) html += "</ul>";
  return html;
}

function appendAiMessage(role, text, { loading = false, error = false } = {}) {
  const wrap = $("#ai-messages");
  const row = document.createElement("div");
  row.className = `ai-msg ai-msg-${role}${error ? " ai-msg-error" : ""}${loading ? " ai-msg-loading" : ""}`;
  const icon = role === "user" ? "" : `<span class="material-symbols-rounded ai-msg-icon">auto_awesome</span>`;
  let bubble;
  if (loading) bubble = `<div class="ai-msg-bubble"><span class="ai-dot"></span><span class="ai-dot"></span><span class="ai-dot"></span></div>`;
  else if (role === "model" && !error) bubble = `<div class="ai-msg-bubble">${markdownLiteToHtml(text)}</div>`;
  else bubble = `<div class="ai-msg-bubble">${escapeHtml(text)}</div>`;
  row.innerHTML = icon + bubble;
  wrap.appendChild(row);
  wrap.scrollTop = wrap.scrollHeight;
  return row;
}

function refreshAiDialogView() {
  const configured = hasGeminiKey() || backend?.demo;
  $("#ai-setup").classList.toggle("hidden", configured);
  $("#ai-chat").classList.toggle("hidden", !configured);
  $("#btn-ai-forget-key").classList.toggle("hidden", !hasGeminiKey());
}

function openAiDialog() {
  refreshAiDialogView();
  $("#dialog-ai").showModal();
  if (hasGeminiKey() || backend?.demo) $("#ai-question").focus();
  else $("#ai-key-input").focus();
}

function saveAiKey(e) {
  e.preventDefault();
  const key = $("#ai-key-input").value.trim();
  if (!key) return;
  setGeminiKey(key);
  $("#ai-key-input").value = "";
  refreshAiDialogView();
  $("#ai-question").focus();
}

function forgetAiKey() {
  clearGeminiKey();
  aiHistory = [];
  refreshAiDialogView();
}

async function submitAiQuestion(e) {
  e.preventDefault();
  if (aiBusy) return;
  const input = $("#ai-question");
  const question = input.value.trim();
  if (!question) return;
  input.value = "";

  appendAiMessage("user", question);
  const loadingRow = appendAiMessage("model", "", { loading: true });
  aiBusy = true;
  $("#btn-ai-send").disabled = true;

  try {
    const answer = hasGeminiKey()
      ? await askGemini(question, transactions, settings, aiHistory, BANKS[activeBank])
      : "This is demo mode, so I can't actually call Gemini here — but once you add your API key, I'll answer using your real transaction data.";
    loadingRow.remove();
    appendAiMessage("model", answer);
    aiHistory.push({ role: "user", text: question }, { role: "model", text: answer });
    if (aiHistory.length > 20) aiHistory = aiHistory.slice(-20); // keep recent context only
  } catch (err) {
    console.error(err);
    loadingRow.remove();
    appendAiMessage("model", `Couldn't get an answer: ${err.message}`, { error: true });
  } finally {
    aiBusy = false;
    $("#btn-ai-send").disabled = false;
  }
}

// ---------- Menus ----------
function toggleMenu(menu) {
  const menus = ["#menu-more", "#menu-account", "#menu-bank"];
  for (const m of menus) if (m !== menu) $(m).classList.add("hidden");
  $(menu).classList.toggle("hidden");
}
document.addEventListener("click", (e) => {
  if (!e.target.closest(".top-bar-actions")) {
    $("#menu-more")?.classList.add("hidden");
    $("#menu-account")?.classList.add("hidden");
    $("#menu-bank")?.classList.add("hidden");
  }
});

// ---------- Bank switcher ----------
function renderBankMenu() {
  $("#bank-switch-label").textContent = BANKS[activeBank].label;
  $("#menu-bank").innerHTML = Object.values(BANKS)
    .map(
      (b) => `<button class="menu-item" data-bank="${b.id}">
        <span class="material-symbols-rounded">account_balance</span>${b.label}
        <span class="material-symbols-rounded menu-item-check${b.id === activeBank ? "" : " hidden"}">check</span>
      </button>`
    )
    .join("");
}

// Resets everything scoped to "the bank you're currently looking at" so
// switching never leaks state (filters, sort, cached AI predictions, the
// day/calendar selection) from one bank into the other.
function resetBankScopedState() {
  filters = { month: "current", from: "", to: "", categories: new Set(), vendors: new Set(), search: "" };
  sortKeys = [];
  tablePage = 0;
  vendorChipsExpanded = false;
  calendarViewDate = new Date();
  calendarSelectedDate = null;
  aiHistory = [];
  recurringCheckedThisSession = false;
}

function switchBank(bankId) {
  if (bankId === activeBank || !BANKS[bankId]) return;
  activeBank = bankId;
  saveActiveBank();
  updateMoneyFormatter();
  resetBankScopedState();
  loadRecurringCache();
  renderBankMenu();
  applyBankToImportUI();

  backend.setBank(activeBank);
  unsubTx?.(); unsubSettings?.();
  transactions = [];
  settings = null;
  unsubTx = backend.subscribeTransactions((list) => { transactions = list; renderAll(); });
  unsubSettings = backend.subscribeSettings((s) => { settings = s; renderSummary(); });
}

// ---------- Event wiring ----------
function wireEvents() {
  $("#btn-theme").addEventListener("click", () => {
    applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
  });
  $("#btn-more").addEventListener("click", (e) => { e.stopPropagation(); toggleMenu("#menu-more"); });
  $("#btn-avatar").addEventListener("click", (e) => { e.stopPropagation(); toggleMenu("#menu-account"); });
  $("#btn-bank").addEventListener("click", (e) => { e.stopPropagation(); toggleMenu("#menu-bank"); });
  $("#menu-bank").addEventListener("click", (e) => {
    const item = e.target.closest("[data-bank]");
    if (!item) return;
    toggleMenu("#menu-bank");
    switchBank(item.dataset.bank);
  });
  $("#menu-signout").addEventListener("click", () => backend.signOut());
  $("#menu-edit-accounts").addEventListener("click", () => { toggleMenu("#menu-more"); openAccountsDialog(); });
  $("#menu-import-csv").addEventListener("click", () => { toggleMenu("#menu-more"); openCsvDialog(); });
  $("#menu-export-json").addEventListener("click", () => {
    toggleMenu("#menu-more");
    exportJson(transactions, settings || {});
    showSnackbar("Backup downloaded");
  });
  $("#menu-clean-vendors").addEventListener("click", () => {
    toggleMenu("#menu-more");
    cleanUpVendorNames();
  });
  $("#menu-mobile-sidebar").addEventListener("click", () => {
    toggleMenu("#menu-more");
    $(".content-sidebar").classList.add("mobile-open");
  });
  $("#btn-sidebar-close").addEventListener("click", () => {
    $(".content-sidebar").classList.remove("mobile-open");
  });
  $("#menu-delete-tx").addEventListener("click", () => {
    toggleMenu("#menu-more");
    openDeleteDialog();
  });

  // Summary cards open accounts dialog
  $("#card-balance").addEventListener("click", openAccountsDialog);
  $("#card-credit").addEventListener("click", openAccountsDialog);

  // FAB + tx dialog
  $("#fab-add").addEventListener("click", () => openTxDialog());
  $("#form-tx").addEventListener("submit", saveTxFromForm);
  $("#btn-tx-cancel").addEventListener("click", () => $("#dialog-tx").close());
  $("#tx-vendor").addEventListener("blur", () => {
    // Auto-suggest category from vendor if user hasn't picked one
    if ($("#tx-category").value === "Other" && $("#tx-vendor").value.trim() && !editingId) {
      $("#tx-category").value = activeGuessCategory($("#tx-vendor").value);
    }
  });

  // Accounts dialog
  $("#form-accounts").addEventListener("submit", saveAccountsFromForm);
  $("#btn-acc-cancel").addEventListener("click", () => $("#dialog-accounts").close());

  // CSV dialog
  $("#btn-csv-pick").addEventListener("click", () => $("#csv-file").click());
  $("#csv-file").addEventListener("change", (e) => e.target.files[0] && handleCsvFile(e.target.files[0]));
  $("#btn-csv-unlock").addEventListener("click", () => {
    if (pendingCsvFile) handleCsvFile(pendingCsvFile, $("#csv-password").value);
  });
  $("#btn-csv-import").addEventListener("click", importCsv);
  $("#btn-csv-cancel").addEventListener("click", () => $("#dialog-csv").close());

  // Delete transactions dialog
  $("#delete-scope-all").addEventListener("change", () => {
    $("#delete-range-fields").classList.add("hidden");
    updateDeleteSummary();
  });
  $("#delete-scope-range").addEventListener("change", () => {
    $("#delete-range-fields").classList.remove("hidden");
    updateDeleteSummary();
  });
  $("#delete-from").addEventListener("change", updateDeleteSummary);
  $("#delete-to").addEventListener("change", updateDeleteSummary);
  $("#btn-delete-confirm").addEventListener("click", confirmDeleteTransactions);
  $("#btn-delete-cancel").addEventListener("click", () => $("#dialog-delete").close());

  $("#btn-reset-sort").addEventListener("click", () => {
    sortKeys = [];
    tablePage = 0;
    renderTable(filteredTransactions());
  });

  // Ask AI
  $("#btn-ask-ai").addEventListener("click", openAiDialog);
  $("#btn-ai-close").addEventListener("click", () => $("#dialog-ai").close());
  $("#form-ai-ask").addEventListener("submit", submitAiQuestion);
  $("#form-ai-key").addEventListener("submit", saveAiKey);
  $("#btn-ai-forget-key").addEventListener("click", forgetAiKey);

  // Filters
  $("#filter-month").addEventListener("change", (e) => {
    filters.month = e.target.value;
    filters.from = filters.to = "";
    filters.vendors.clear();
    $("#range-from").value = $("#range-to").value = "";
    $("#range-row").classList.add("hidden");
    renderVendorChips();
    rerenderFiltered();
  });
  $("#filter-search").addEventListener("input", (e) => {
    filters.search = e.target.value.trim();
    rerenderFiltered();
  });
  $("#btn-range").addEventListener("click", () => $("#range-row").classList.toggle("hidden"));
  const onRange = () => {
    filters.from = $("#range-from").value;
    filters.to = $("#range-to").value;
    filters.vendors.clear();
    renderVendorChips();
    rerenderFiltered();
  };
  $("#range-from").addEventListener("change", onRange);
  $("#range-to").addEventListener("change", onRange);
  $("#btn-range-clear").addEventListener("click", () => {
    filters.from = filters.to = "";
    filters.vendors.clear();
    $("#range-from").value = $("#range-to").value = "";
    $("#range-row").classList.add("hidden");
    renderVendorChips();
    rerenderFiltered();
  });

  $("#btn-recurring-refresh").addEventListener("click", () => refreshRecurringChargesFromAI(true));

  // Sidebar calendar + independent day view
  $("#btn-cal-prev").addEventListener("click", () => {
    calendarViewDate = new Date(calendarViewDate.getFullYear(), calendarViewDate.getMonth() - 1, 1);
    renderCalendar();
  });
  $("#btn-cal-next").addEventListener("click", () => {
    calendarViewDate = new Date(calendarViewDate.getFullYear(), calendarViewDate.getMonth() + 1, 1);
    renderCalendar();
  });
  $("#calendar-grid").addEventListener("click", (e) => {
    const day = e.target.closest(".cal-day:not(.cal-empty)");
    if (!day) return;
    selectCalendarDay(day.dataset.date);
  });
  $("#btn-cal-clear").addEventListener("click", () => {
    calendarSelectedDate = null;
    renderCalendar();
    renderDayPanel();
  });

  // Category chips (delegated)
  $("#category-chips").addEventListener("click", (e) => {
    const chip = e.target.closest(".chip");
    if (!chip) return;
    const cat = chip.dataset.cat;
    filters.categories.has(cat) ? filters.categories.delete(cat) : filters.categories.add(cat);
    chip.classList.toggle("selected");
    rerenderFiltered();
  });

  // Vendor chips (delegated)
  $("#vendor-chips").addEventListener("click", (e) => {
    const chip = e.target.closest(".chip");
    if (!chip) return;
    const vendor = chip.dataset.vendor;
    filters.vendors.has(vendor) ? filters.vendors.delete(vendor) : filters.vendors.add(vendor);
    chip.classList.toggle("selected");
    rerenderFiltered();
  });
  $("#vendor-chips-toggle").addEventListener("click", () => {
    vendorChipsExpanded = !vendorChipsExpanded;
    renderVendorChips();
  });

  // Table actions (delegated)
  $("#tx-tbody").addEventListener("click", async (e) => {
    const row = e.target.closest("tr[data-id]");
    if (!row) return;
    const id = row.dataset.id;
    const tx = transactions.find((t) => t.id === id);
    if (!tx) return;
    if (e.target.closest(".btn-edit")) {
      openTxDialog(tx);
    } else if (e.target.closest(".btn-delete")) {
      undoTx = { ...tx };
      try {
        await backend.deleteTransaction(id);
        showSnackbar(`Deleted ${tx.vendor}`, "Undo", async () => {
          const { id: _omit, ...rest } = undoTx;
          await backend.addTransaction(rest);
        });
      } catch (err) {
        console.error(err);
        showSnackbar("Couldn't delete — check your connection");
      }
    }
  });

  // Sorting — clicking a column adds it to the active sort (or toggles
  // its direction if already active), so multiple columns can be sorted
  // at once, e.g. date ascending and vendor ascending together.
  document.querySelectorAll(".tx-table th.sortable").forEach((th) => {
    th.addEventListener("click", () => {
      const field = th.dataset.sort;
      const defaultDir = field === "vendor" || field === "category" || field === "cardtype" ? "asc" : "desc";
      const idx = sortKeys.findIndex((k) => k.field === field);

      if (idx === -1) sortKeys.push({ field, dir: defaultDir });
      else sortKeys[idx].dir = sortKeys[idx].dir === "asc" ? "desc" : "asc";

      tablePage = 0;
      renderTable(filteredTransactions());
    });
  });

  // Populate category select in tx dialog
  $("#tx-category").innerHTML = CATEGORIES.map((c) => `<option>${c}</option>`).join("");
}

// ---------- Auth / boot ----------
function showScreen(which) {
  $("#auth-screen").classList.toggle("hidden", which !== "auth");
  $("#denied-screen").classList.toggle("hidden", which !== "denied");
  $("#setup-screen").classList.toggle("hidden", which !== "setup");
  $("#app").classList.toggle("hidden", which !== "app");
}

let unsubTx = null, unsubSettings = null;

async function main() {
  loadActiveBank();
  updateMoneyFormatter();
  renderBankMenu();
  applyBankToImportUI();
  loadRecurringCache();
  if (!isConfigured && !isDemo) {
    showScreen("setup");
    return;
  }

  backend = await createBackend();
  backend.setBank(activeBank);
  wireEvents();
  if (backend.demo) $("#demo-banner").classList.remove("hidden");

  $("#btn-google-signin").addEventListener("click", () => backend.signIn());
  $("#btn-denied-signout").addEventListener("click", () => backend.signOut());

  backend.onAuth((user) => {
    unsubTx?.(); unsubSettings?.();
    unsubTx = unsubSettings = null;

    if (!user) {
      transactions = [];
      settings = null;
      showScreen("auth");
      return;
    }

    if (!backend.demo && !ALLOWED_EMAILS.includes((user.email || "").toLowerCase())) {
      transactions = [];
      settings = null;
      $("#denied-email").textContent = user.email || "";
      showScreen("denied");
      return;
    }

    // Header identity
    const avatar = $("#user-avatar");
    if (user.photoURL) { avatar.src = user.photoURL; $("#user-initial").textContent = ""; }
    else { avatar.removeAttribute("src"); $("#user-initial").textContent = (user.displayName || user.email || "?")[0].toUpperCase(); }
    $("#menu-user-name").textContent = user.displayName || "";
    $("#menu-user-email").textContent = user.email || "";

    showScreen("app");

    unsubTx = backend.subscribeTransactions((list) => {
      transactions = list;
      renderAll();
    });
    unsubSettings = backend.subscribeSettings((s) => {
      settings = s;
      renderSummary();
    });
  });
}

main();
