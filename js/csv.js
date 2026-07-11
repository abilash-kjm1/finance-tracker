// ============================================================
// CIBC CSV import + JSON export.
//
// CIBC's "Download transactions" CSV typically has NO header row:
//   Credit card: MM/DD/YYYY, Description, Debit, Credit, Card#
//   Chequing:    MM/DD/YYYY, Description, Debit, Credit
// Some exports use YYYY-MM-DD. Both are handled, header row optional.
// ============================================================

import { CATEGORIES } from "./app.js?v=9";

// Vendor keyword → category guesser (financial-analyst autopilot).
const CATEGORY_RULES = [
  [/tim hortons|starbucks|mcdonald|subway|a\s*&?\s*w\b|wendy|pizza|uber\s*eats|skip.?the.?dishes|doordash|restaurant|cafe|coffee|popeyes|kfc|burger|shawarma|sushi|thai|osmow|biryani|dosa|roti|chicken|kairali|saravanaa|ustad ji|chipotle|taco bell|vending/i, "Dining"],
  [/loblaws|no frills|nofrills|walmart|wal-mart|costco|food basics|freshco|metro\b|sobeys|superstore|farm boy|t&t|grocery|supermarket|giant tiger|kibo market|convenie/i, "Groceries"],
  [/presto|\bpres\/|metrolinx|uber(?!\s*eats)|lyft|petro|esso|shell|gas bar|go transit|ttc|via rail|parking|impark|husky|ultramar|canadian tire gas|megabus/i, "Transport"],
  [/bell canada|bell mobility|rogers|telus|fido|freedom mobile|koodo|hydro|enbridge|utility|insurance|mortgage|wealthsimple|virgin plus|public mobile|teksavvy|distributel|cogeco|affirm canada|niagara region/i, "Bills"],
  [/amazon|amzn mktp|alibaba|best buy|canadian tire|ikea|dollarama|dollar tree|winners|marshalls|home depot|shein|temu|aliexpress|ebay|indigo|sport chek|zara|h&m|uniqlo|crocs|lovisa|bluenotes|ups\s*\*|ups store|canada computer/i, "Shopping"],
  [/netflix|spotify|disney|crave|cineplex|cinema|prime video|youtube|playstation|xbox|steam|nintendo|apple\.com|movie|theatre/i, "Entertainment"],
  [/shoppers drug|pharmacy|rexall|dental|clinic|physio|optometr|goodlife|gym|fitness|medical|barber|hair salon|silk hair/i, "Health"],
];

export function guessCategory(vendor) {
  for (const [re, cat] of CATEGORY_RULES) if (re.test(vendor)) return cat;
  return "Other";
}

// Strips CIBC's boilerplate transaction-type prefixes, foreign-exchange
// suffixes, and long auth/reference numbers so only the merchant name
// (or transfer recipient) remains.
const BOILERPLATE_PATTERNS = [
  /point of sale - visa debit/gi,
  /point of sale - interac/gi,
  /intl visa deb/gi,
  /int visa deb/gi,
  /visa debit/gi,
  /retail purchase/gi,
  /merchandise ret rev/gi,
  /purchase reversal/gi,
  /mdse return/gi,
  /electronic funds transfer/gi,
  /internet banking/gi,
  /branch transaction/gi,
  /preauthorized debit/gi,
  /interac e-transfer/gi,
  /e-transfer/gi,
  /fulfill request/gi,
  /internet transfer/gi,
  /^\s*pay\b/gi,
  /^\s*correction\b/gi,
];

// Recognized brands/services get normalized to one clean, consistent
// name regardless of how CIBC mangled the raw description. Order
// matters — more specific patterns (e.g. "Uber Eats") must come before
// their broader parent ("Uber").
const VENDOR_ALIASES = [
  [/doordash/i, "DoorDash"],
  [/uber\s*eats/i, "Uber Eats"],
  [/\blyft\b/i, "Lyft"],
  [/\bmetrolinx\b|\bgo transit\b/i, "GO Transit"],
  [/\bttc\b/i, "TTC"],
  [/\bpresto\b|\bpres\//i, "Presto"],
  [/\buber\b/i, "Uber"],
];

function normalizeVendor(v) {
  for (const [re, name] of VENDOR_ALIASES) if (re.test(v)) return name;
  return v;
}

export function cleanVendor(raw) {
  let v = raw;
  // Foreign-exchange suffix, e.g. "13.55 USD @ 1.458303"
  v = v.replace(/\s*[\d,]+\.\d{2}\s*(USD|CAD)\s*@\s*[\d.]+\s*$/i, "");
  for (const re of BOILERPLATE_PATTERNS) v = v.replace(re, "");
  // Long auth/reference numbers (6+ consecutive digits), anywhere in the string
  v = v.replace(/\b\d{6,}\S*/g, "");
  v = v.replace(/\s+/g, " ").trim();
  v = v.replace(/^[-/,\s]+/, "").trim();
  v = v || raw.trim();
  return normalizeVendor(v);
}

// CIBC chequing-account CSV exports have 4 columns (date, description,
// debit, credit); credit-card exports add a 5th column with the masked
// card number. That column's presence is the reliable signal for which
// account a row belongs to.
function detectCardType(cols) {
  return cols.length >= 5 && cols[4] && cols[4].trim() ? "credit" : "debit";
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

    const rawVendor = (cols[1] || "Unknown").replace(/\s+/g, " ").trim() || "Unknown";
    const vendor = cleanVendor(rawVendor);
    const debit = parseMoneyToCents(cols[2]);
    const credit = parseMoneyToCents(cols[3]);

    let type, cents;
    if (debit != null) { type = "expense"; cents = debit; }
    else if (credit != null) { type = "income"; cents = credit; }
    else { skipped++; continue; }

    const category = type === "income" ? "Other" : guessCategory(rawVendor);
    if (!CATEGORIES.includes(category)) { skipped++; continue; }

    const cardType = detectCardType(cols);

    transactions.push({ date, vendor, category, type, cents, cardType, note: "" });
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
