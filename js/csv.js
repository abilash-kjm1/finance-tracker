// ============================================================
// CIBC CSV import + JSON export.
//
// CIBC's "Download transactions" CSV typically has NO header row:
//   Credit card: MM/DD/YYYY, Description, Debit, Credit, Card#
//   Chequing:    MM/DD/YYYY, Description, Debit, Credit
// Some exports use YYYY-MM-DD. Both are handled, header row optional.
// ============================================================

import { CATEGORIES } from "./app.js";

// Vendor keyword → category guesser (financial-analyst autopilot).
const CATEGORY_RULES = [
  [/tim hortons|starbucks|mcdonald|subway|a&w|wendy|pizza|uber\s*eats|skip.?the.?dishes|doordash|restaurant|cafe|coffee|popeyes|kfc|burger|shawarma|sushi|thai|osmow/i, "Dining"],
  [/loblaws|no frills|nofrills|walmart|costco|food basics|freshco|metro\b|sobeys|superstore|farm boy|t&t|grocery|supermarket|giant tiger/i, "Groceries"],
  [/presto|uber(?!\s*eats)|lyft|petro|esso|shell|gas bar|go transit|ttc|via rail|parking|impark|husky|ultramar|canadian tire gas/i, "Transport"],
  [/bell|rogers|telus|fido|freedom mobile|koodo|hydro|enbridge|utility|insurance|rent|mortgage|wealthsimple|virgin plus|public mobile|internet/i, "Bills"],
  [/amazon|best buy|canadian tire|ikea|dollarama|winners|marshalls|home depot|shein|temu|aliexpress|ebay|indigo|sport chek|zara|h&m|uniqlo/i, "Shopping"],
  [/netflix|spotify|disney|crave|cineplex|prime video|youtube|playstation|xbox|steam|nintendo|apple\.com|movie|theatre/i, "Entertainment"],
  [/shoppers drug|pharmacy|rexall|dental|clinic|physio|optometr|goodlife|gym|fitness|medical/i, "Health"],
];

export function guessCategory(vendor) {
  for (const [re, cat] of CATEGORY_RULES) if (re.test(vendor)) return cat;
  return "Other";
}

// Minimal CSV line parser handling quoted fields with commas.
function parseLine(line) {
  const out = [];
  let cur = "", inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') inQ = false;
      else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ",") { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

function parseDate(raw) {
  const s = raw.trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);           // YYYY-MM-DD
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);        // MM/DD/YYYY
  if (m) return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  return null;
}

function parseMoneyToCents(raw) {
  const s = String(raw || "").replace(/[$,\s]/g, "");
  if (!s) return null;
  const n = Number(s);
  if (!isFinite(n) || n === 0) return null;
  return Math.round(Math.abs(n) * 100);
}

// Returns { transactions: [...], skipped: n } — never throws on bad rows.
export function parseCibcCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  const transactions = [];
  let skipped = 0;

  for (const line of lines) {
    const cols = parseLine(line);
    if (cols.length < 3) { skipped++; continue; }

    const date = parseDate(cols[0]);
    if (!date) { skipped++; continue; } // header row or junk

    const vendor = (cols[1] || "Unknown").replace(/\s+/g, " ").trim() || "Unknown";
    const debit = parseMoneyToCents(cols[2]);
    const credit = parseMoneyToCents(cols[3]);

    let type, cents;
    if (debit != null) { type = "expense"; cents = debit; }
    else if (credit != null) { type = "income"; cents = credit; }
    else { skipped++; continue; }

    const category = type === "income" ? "Other" : guessCategory(vendor);
    if (!CATEGORIES.includes(category)) { skipped++; continue; }

    transactions.push({ date, vendor, category, type, cents, note: "" });
  }
  return { transactions, skipped };
}

export function exportJson(transactions, settings) {
  const payload = {
    exportedAt: new Date().toISOString(),
    app: "finance-tracker",
    version: 1,
    settings,
    transactions: transactions.map(({ id, ...rest }) => rest),
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `finance-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}
