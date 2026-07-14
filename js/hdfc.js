// ============================================================
// HDFC PDF statement import — a second, fully separate bank.
//
// HDFC's PDF text extraction is messy: narration frequently wraps across
// several lines with no clear terminator, and only one amount column
// survives extraction per row (withdrawal/deposit collapse into a single
// number), so debit vs. credit can't be read directly. This module:
//   1. Extracts raw text per page via pdf.js (CDN-loaded, see index.html).
//   2. Groups lines into per-transaction blocks (a line starting with
//      "DD/MM/YY " opens a new block; known page-boilerplate anchors and
//      the trailing STATEMENT SUMMARY close out the noise around them).
//   3. Infers debit vs. credit by walking the running balance forward
//      from the statement's own Opening Balance — validated against the
//      statement's own Debits/Credits/Closing Bal checksum.
// ============================================================

import { CATEGORIES } from "./app.js?v=43";

const PDFJS_VERSION = "4.4.168";
const PDFJS_LIB_URL = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/build/pdf.min.mjs`;
const PDFJS_WORKER_SRC = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/build/pdf.worker.min.mjs`;

// ---------- Vendor cleanup + category guessing for Indian vendors ----------
const SPECIAL_LABELS = [
  [/credit interest capitalised/i, "Credit Interest"],
  [/interest paid till/i, "Interest Paid"],
];

const VENDOR_ALIASES = [
  [/^credclub$|^cred[\s.]?club$/i, "CRED Club"],
  [/^youtube$/i, "YouTube"],
  [/^airtel\s*recharge$/i, "Airtel Recharge"],
  [/^jio\s*recharge$/i, "Jio Recharge"],
];

function normalizeVendor(v) {
  for (const [re, name] of VENDOR_ALIASES) if (re.test(v)) return name;
  return v;
}

// Drops any whitespace-separated token containing 4+ digits — catches ref
// numbers, masked card numbers ("463202XXXXXX5275"), and phone numbers
// embedded in a wrapped narration, while leaving plain name words alone.
function stripRefTokens(s) {
  return s
    .split(/\s+/)
    .filter((tok) => (tok.match(/\d/g) || []).length < 4)
    .join(" ")
    .trim();
}

// Keyword → category guesser, mirroring csv.js's guessCategory() but for
// Indian merchants/services. Most HDFC narrations here are person-to-person
// transfers (NEFT/RDA/UPI), which fall through to "Other" — same as CIBC's
// e-transfers do.
const CATEGORY_RULES = [
  [/swiggy|zomato|dominos|pizza|restaurant|cafe|starbucks|dosa|biryani/i, "Dining"],
  [/bigbasket|grofers|dmart|d-mart|reliance fresh|more supermarket|grocery|supermarket/i, "Groceries"],
  [/\bola\b|\buber\b|irctc|redbus|metro\b|petrol|fuel/i, "Transport"],
  [/ib billpay|autopay|fund trf|airtel|jio\b|\bvi\b|vodafone|recharge|electricity|water bill|gas bill|broadband/i, "Bills"],
  [/amazon|flipkart|myntra|ajio|nykaa/i, "Shopping"],
  [/youtube|netflix|hotstar|spotify|prime video|bookmyshow/i, "Entertainment"],
  [/apollo|pharmeasy|\b1mg\b|hospital|clinic|pharmacy/i, "Health"],
];

export function guessCategoryHdfc(narration) {
  for (const [re, cat] of CATEGORY_RULES) if (re.test(narration)) return cat;
  return "Other";
}

export function cleanVendorHdfc(raw) {
  for (const [re, label] of SPECIAL_LABELS) if (re.test(raw)) return label;

  const upi = raw.match(/^UPI-([^-]+)-/i);
  if (upi) return normalizeVendor(upi[1].trim());

  const neft = raw.match(/NEFT CR-[A-Z]{2,6}0\d+-(.+)/i);
  if (neft) return normalizeVendor(stripRefTokens(neft[1]) || "NEFT Transfer");

  const rda = raw.match(/RDA FIR INW-R\d+-(.+)/i);
  if (rda) return normalizeVendor(stripRefTokens(rda[1]) || "RDA Transfer");

  const inwremit = raw.match(/INWREMIT-R\d+-(.+?)-REMITL/i);
  if (inwremit) return normalizeVendor(stripRefTokens(inwremit[1]) || "Inward Remittance");

  if (/IB BILLPAY DR-HDFC8E/i.test(raw)) return "Credit Card Bill Payment";
  if (/CC \S+ AUTOPAY SI-MAD/i.test(raw)) return "Credit Card Autopay";
  if (/FUND TRF CC/i.test(raw)) return "Credit Card Fund Transfer";

  const v = stripRefTokens(raw);
  return normalizeVendor(v) || raw.trim();
}

// ---------- Raw PDF text → line-grouped transaction blocks ----------
const TX_START_RE = /^(\d{2}\/\d{2}\/\d{2})\s/;
// Lines that always mean "we've left transaction territory until the next
// date-prefixed line" — page headers/footers, account/address blocks, the
// closing disclaimer. Anchored on fixed template text (not the account
// holder's specific address), so it works regardless of whose statement it is.
const BOILERPLATE_ANCHOR_RE = /^(Page No|MR\.\s|JOINT HOLDERS|Generated On:|This is a computer generated|Date Narration)/i;
const SUMMARY_START_RE = /^STATEMENT SUMMARY/i;
const STRAY_FRAGMENT_RE = /^[A-Za-z]{1,2}$/; // leftover single/double-letter noise
// Last occurrence of "DD/MM/YY  amount  balance" in a joined transaction blob.
const TRAILING_RE = /(\d{2}\/\d{2}\/\d{2})\s+(-?[\d,]+\.\d{2})\s+(-?[\d,]+\.\d{2})(?!.*\d{2}\/\d{2}\/\d{2}\s+-?[\d,]+\.\d{2}\s+-?[\d,]+\.\d{2})/;

function parseMoneyToCents(raw) {
  const n = parseFloat(String(raw).replace(/,/g, ""));
  return Math.round(n * 100);
}

function ddmmyyToIso(ddmmyy) {
  const [d, m, yy] = ddmmyy.split("/");
  return `20${yy}-${m}-${d}`;
}

// Parses the full extracted text of an HDFC statement into raw transaction
// rows (date/narration/amount/balance, debit vs. credit not yet known) plus
// the statement's own summary block (used both as the Opening Balance to
// start the balance-delta walk from, and as a checksum to verify against).
function parseHdfcText(fullText) {
  const lines = fullText.split(/\r?\n/);
  const groups = [];
  let current = null;
  let skipping = false;
  let summary = null;
  let summaryStage = 0; // 0 = not in summary, 1 = expect header row, 2 = expect data row

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    if (summaryStage === 1) { summaryStage = 2; continue; }
    if (summaryStage === 2) {
      const nums = line.split(/\s+/);
      if (nums.length >= 6) {
        summary = {
          opening: parseMoneyToCents(nums[0]),
          debits: parseMoneyToCents(nums[3]),
          credits: parseMoneyToCents(nums[4]),
          closing: parseMoneyToCents(nums[5]),
        };
      }
      summaryStage = 0;
      continue;
    }

    const txStart = line.match(TX_START_RE);
    if (txStart) {
      skipping = false;
      if (current) groups.push(current);
      current = { date: txStart[1], parts: [line] };
      continue;
    }

    if (SUMMARY_START_RE.test(line)) { skipping = true; summaryStage = 1; continue; }
    if (skipping) continue;
    if (BOILERPLATE_ANCHOR_RE.test(line)) { skipping = true; continue; }
    if (STRAY_FRAGMENT_RE.test(line)) continue;

    if (current) current.parts.push(line);
  }
  if (current) groups.push(current);

  const rows = [];
  let skipped = 0;
  for (const g of groups) {
    const blob = g.parts.join(" ").replace(/\s+/g, " ").trim();
    const m = blob.match(TRAILING_RE);
    if (!m) { skipped++; continue; }
    const amountCents = parseMoneyToCents(m[2]);
    const balanceCents = parseMoneyToCents(m[3]);
    if (!amountCents) { skipped++; continue; }
    let narration = (blob.slice(0, m.index) + blob.slice(m.index + m[0].length))
      .replace(/^\d{2}\/\d{2}\/\d{2}\s*/, "")
      .replace(/\s+/g, " ")
      .trim();
    rows.push({ date: ddmmyyToIso(g.date), narration: narration || "HDFC Transaction", amountCents, balanceCents });
  }

  return { rows, summary };
}

// Walks the running balance forward from the statement's Opening Balance to
// classify each row as an expense (debit) or income (credit) — sidesteps
// the collapsed withdrawal/deposit column entirely.
function inferDebitCredit(rows, openingCents) {
  let running = openingCents;
  const out = [];
  for (const r of rows) {
    const asExpense = running - r.amountCents;
    const asIncome = running + r.amountCents;
    let type = null;
    if (Math.abs(asExpense - r.balanceCents) <= 1) type = "expense";
    else if (Math.abs(asIncome - r.balanceCents) <= 1) type = "income";
    if (type) out.push({ ...r, type });
    running = r.balanceCents;
  }
  return out;
}

// ---------- pdf.js text extraction ----------
function groupTextItemsIntoLines(items) {
  const lines = [];
  let currentY = null, currentLine = [];
  const EPS = 2;
  for (const item of items) {
    const y = item.transform[5];
    if (currentY === null || Math.abs(y - currentY) > EPS) {
      if (currentLine.length) lines.push(currentLine.join(" "));
      currentLine = [item.str];
      currentY = y;
    } else {
      currentLine.push(item.str);
    }
  }
  if (currentLine.length) lines.push(currentLine.join(" "));
  return lines;
}

let pdfjsLibPromise = null;
function loadPdfjs() {
  if (!pdfjsLibPromise) pdfjsLibPromise = import(PDFJS_LIB_URL);
  return pdfjsLibPromise;
}

async function extractPdfText(arrayBuffer) {
  const pdfjsLib = await loadPdfjs();
  pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_SRC;

  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  let fullText = "";
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    fullText += groupTextItemsIntoLines(content.items).join("\n") + "\n";
  }
  return fullText;
}

// Returns { transactions: [...], skipped: n } — same shape as parseCibcCsv,
// so the rest of the CSV-import UI flow (preview, dedup, import) works
// unchanged regardless of which bank is active.
export async function parseHdfcPdf(arrayBuffer) {
  const text = await extractPdfText(arrayBuffer);
  const { rows, summary } = parseHdfcText(text);

  if (!summary) return { transactions: [], skipped: rows.length };

  const classified = inferDebitCredit(rows, summary.opening);
  const skipped = rows.length - classified.length;

  const transactions = classified.map((r) => {
    const vendor = cleanVendorHdfc(r.narration);
    const category = r.type === "income" ? "Other" : guessCategoryHdfc(r.narration);
    return {
      date: r.date,
      vendor,
      category: CATEGORIES.includes(category) ? category : "Other",
      type: r.type,
      cents: r.amountCents,
      cardType: "debit",
      note: "",
    };
  });

  return { transactions, skipped };
}
