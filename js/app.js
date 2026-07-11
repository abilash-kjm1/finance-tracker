// ============================================================
// Finance Tracker — main app: state, rendering, filters, dialogs.
// ============================================================

import { createBackend, isConfigured, isDemo } from "./firebase.js";
import { parseCibcCsv, exportJson, guessCategory, cleanVendor } from "./csv.js";
import { renderCategoryChart, renderTrendChart, refreshTheme } from "./charts.js";

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

// ---------- Utilities ----------
const $ = (sel) => document.querySelector(sel);
const moneyFmt = new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD" });
const fmtMoney = (cents) => moneyFmt.format(cents / 100);
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
  return dt.toLocaleDateString("en-CA", opts);
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
let filters = { month: "current", from: "", to: "", categories: new Set(), search: "" };
// Ordered list of sort keys — index 0 is primary. Shift+click a column
// header to layer it in as an additional tie-breaker.
let sortKeys = [{ field: "date", dir: "desc" }];
let editingId = null;
let pendingCsv = null;
let undoTx = null;
let snackbarTimer = null;

// ---------- Derived data ----------
function filteredTransactions() {
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

  if (filters.categories.size) list = list.filter((t) => filters.categories.has(t.category));
  if (filters.search) {
    const q = filters.search.toLowerCase();
    list = list.filter((t) => t.vendor.toLowerCase().includes(q) || (t.note || "").toLowerCase().includes(q));
  }

  // Always fall back to date so equal ties still land in a stable order.
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

function renderTable(list) {
  const tbody = $("#tx-tbody");
  const empty = $("#tx-empty");
  $("#tx-count").textContent = list.length ? `(${list.length})` : "";

  const spent = list.filter((t) => t.type === "expense").reduce((a, t) => a + t.cents, 0);
  const income = list.filter((t) => t.type === "income").reduce((a, t) => a + t.cents, 0);
  $("#tx-total").textContent = list.length
    ? `−${fmtMoney(spent)} spent${income ? ` · +${fmtMoney(income)} in` : ""}`
    : "";

  if (!list.length) {
    tbody.innerHTML = "";
    empty.classList.remove("hidden");
    return;
  }
  empty.classList.add("hidden");

  tbody.innerHTML = list.map((t, i) => {
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
  if (resetBtn) resetBtn.classList.toggle("hidden", sortKeys.length <= 1);
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
  renderTable(filteredTransactions());
  renderCharts();
}

function rerenderFiltered() {
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

// ---------- CSV ----------
function openCsvDialog() {
  pendingCsv = null;
  $("#csv-preview").classList.add("hidden");
  $("#btn-csv-import").classList.add("hidden");
  $("#csv-file").value = "";
  $("#dialog-csv").showModal();
}

// Identifies "the same transaction" across imports so re-uploading a
// statement that overlaps a previous month doesn't create duplicates.
const txSignature = (t) => `${t.date}|${t.cents}|${t.type}|${cleanVendor(t.vendor)}`;

async function handleCsvFile(file) {
  const text = await file.text();
  const { transactions: parsed, skipped } = parseCibcCsv(text);
  const preview = $("#csv-preview");
  preview.classList.remove("hidden");
  if (!parsed.length) {
    preview.innerHTML = `Couldn't find any transactions in this file. Make sure it's the CSV downloaded from CIBC online banking.`;
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
    preview.innerHTML = `All ${parsed.length} transactions in this file were already imported — nothing new to add.${dupNote}`;
    $("#btn-csv-import").classList.add("hidden");
    return;
  }

  const spent = deduped.filter((t) => t.type === "expense").reduce((a, t) => a + t.cents, 0);
  const dates = deduped.map((t) => t.date).sort();
  preview.innerHTML = `<strong>${deduped.length} new transaction${deduped.length === 1 ? "" : "s"}</strong> found (${shortDate(dates[0])} – ${shortDate(dates[dates.length - 1])})<br />
    Total spending: <strong>${fmtMoney(spent)}</strong><br />
    Categories auto-guessed from vendor names — you can edit any row later.${skipped ? `<br /><em>${skipped} unreadable line(s) skipped.</em>` : ""}${dupNote}`;
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
    .map((t) => ({ t, cleaned: cleanVendor(t.vendor) }))
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

// ---------- Menus ----------
function toggleMenu(menu) {
  const menus = ["#menu-more", "#menu-account"];
  for (const m of menus) if (m !== menu) $(m).classList.add("hidden");
  $(menu).classList.toggle("hidden");
}
document.addEventListener("click", (e) => {
  if (!e.target.closest(".top-bar-actions")) {
    $("#menu-more")?.classList.add("hidden");
    $("#menu-account")?.classList.add("hidden");
  }
});

// ---------- Event wiring ----------
function wireEvents() {
  $("#btn-theme").addEventListener("click", () => {
    applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
  });
  $("#btn-more").addEventListener("click", (e) => { e.stopPropagation(); toggleMenu("#menu-more"); });
  $("#btn-avatar").addEventListener("click", (e) => { e.stopPropagation(); toggleMenu("#menu-account"); });
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
      $("#tx-category").value = guessCategory($("#tx-vendor").value);
    }
  });

  // Accounts dialog
  $("#form-accounts").addEventListener("submit", saveAccountsFromForm);
  $("#btn-acc-cancel").addEventListener("click", () => $("#dialog-accounts").close());

  // CSV dialog
  $("#btn-csv-pick").addEventListener("click", () => $("#csv-file").click());
  $("#csv-file").addEventListener("change", (e) => e.target.files[0] && handleCsvFile(e.target.files[0]));
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
    sortKeys = [{ field: "date", dir: "desc" }];
    renderTable(filteredTransactions());
  });

  // Filters
  $("#filter-month").addEventListener("change", (e) => {
    filters.month = e.target.value;
    filters.from = filters.to = "";
    $("#range-from").value = $("#range-to").value = "";
    $("#range-row").classList.add("hidden");
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
    rerenderFiltered();
  };
  $("#range-from").addEventListener("change", onRange);
  $("#range-to").addEventListener("change", onRange);
  $("#btn-range-clear").addEventListener("click", () => {
    filters.from = filters.to = "";
    $("#range-from").value = $("#range-to").value = "";
    $("#range-row").classList.add("hidden");
    rerenderFiltered();
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
  if (!isConfigured && !isDemo) {
    showScreen("setup");
    return;
  }

  backend = await createBackend();
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
