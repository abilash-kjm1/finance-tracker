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

import { CATEGORIES } from "./app.js?v=56";

const PDFJS_VERSION = "4.4.168";
const PDFJS_LIB_URL = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/build/pdf.min.mjs`;
const PDFJS_WORKER_SRC = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/build/pdf.worker.min.mjs`;

// Some older HDFC statements are scanned images with no text layer at all
// (nothing for pdf.js to extract). Tesseract.js (CDN-loaded, same
// no-build-step pattern as pdf.js) rasterizes each page and OCRs it as a
// fallback — much slower and less reliable than reading real text, so
// callers surface that to the user via the `usedOcr`/`summaryVerified` flags.
const TESSERACT_VERSION = "5.1.1";
const TESSERACT_LIB_URL = `https://cdn.jsdelivr.net/npm/tesseract.js@${TESSERACT_VERSION}/dist/tesseract.esm.min.js`;

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
// Newer statements use DD/MM/YY (2-digit year); older ones (e.g. 2023) use
// DD/MM/YYYY (4-digit) — support both.
const TX_START_RE = /^(\d{2}\/\d{2}\/\d{2,4})\s/;
// Lines that always mean "we've left transaction territory until the next
// date-prefixed line" — page headers/footers, account/address blocks, the
// closing disclaimer. Anchored on fixed template text (not the account
// holder's specific address), so it works regardless of whose statement it is.
const BOILERPLATE_ANCHOR_RE = /^(Page No|MR\.\s|JOINT HOLDERS|Generated On:|This is a computer generated|Date Narration)/i;
const SUMMARY_START_RE = /^STATEMENT SUMMARY/i;
const STRAY_FRAGMENT_RE = /^[A-Za-z]{1,2}$/; // leftover single/double-letter noise
// Last occurrence of "DD/MM/YY(YY)  amount  balance" in a joined transaction blob.
const TRAILING_RE = /(\d{2}\/\d{2}\/\d{2,4})\s+(-?[\d,]+\.\d{2})\s+(-?[\d,]+\.\d{2})(?!.*\d{2}\/\d{2}\/\d{2,4}\s+-?[\d,]+\.\d{2}\s+-?[\d,]+\.\d{2})/;

function parseMoneyToCents(raw) {
  const n = parseFloat(String(raw).replace(/,/g, ""));
  return Math.round(n * 100);
}

function ddmmyyToIso(ddmmyyyy) {
  const [d, m, y] = ddmmyyyy.split("/");
  const year = y.length === 2 ? `20${y}` : y;
  return `${year}-${m}-${d}`;
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

let tesseractLibPromise = null;
function loadTesseract() {
  // The ESM build only exposes a default export (an object with
  // createWorker etc. as properties), not named exports.
  if (!tesseractLibPromise) tesseractLibPromise = import(TESSERACT_LIB_URL).then((mod) => mod.default);
  return tesseractLibPromise;
}

// Thrown when a PDF needs a password we don't have (yet) — a distinct type
// so the UI can show a password field instead of a generic error.
export class PdfPasswordRequiredError extends Error {
  constructor(wrongPassword) {
    super(wrongPassword ? "Incorrect password." : "This PDF is password protected.");
    this.wrongPassword = wrongPassword;
  }
}

async function openPdf(pdfjsLib, arrayBuffer, password) {
  try {
    // pdf.js transfers (and detaches) whichever ArrayBuffer it's given, so
    // each call needs its own copy — a caller may reopen the same original
    // buffer for the OCR fallback if the text-layer pass comes up empty.
    return await pdfjsLib.getDocument({ data: arrayBuffer.slice(0), password: password || undefined }).promise;
  } catch (err) {
    if (err?.name === "PasswordException") {
      throw new PdfPasswordRequiredError(err.code === 2 /* INCORRECT_PASSWORD */ && !!password);
    }
    throw err;
  }
}

async function extractPdfText(arrayBuffer, password) {
  const pdfjsLib = await loadPdfjs();
  pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_SRC;

  const pdf = await openPdf(pdfjsLib, arrayBuffer, password);
  let fullText = "";
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    fullText += groupTextItemsIntoLines(content.items).join("\n") + "\n";
  }
  return fullText;
}

// A real digitally-generated statement always has plenty of "DD/MM/YY"
// date-prefixed lines; a scanned image PDF yields little to no text at all.
function looksLikeStatementText(text) {
  return text.trim().length > 100 && /\d{2}\/\d{2}\/\d{2}/.test(text);
}

// Some PDFs (unusual/broken embedded fonts, corrupted content streams) make
// pdf.js's renderer hang indefinitely on a page instead of erroring — seen
// in practice with at least one real HDFC statement. A per-page timeout
// turns that into a clean skip instead of freezing the import forever.
const PAGE_RENDER_TIMEOUT_MS = 8000;
function renderPageToCanvas(page, viewport) {
  const canvas = document.createElement("canvas");
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  const renderTask = page.render({ canvasContext: canvas.getContext("2d"), viewport });
  const timeout = new Promise((_, reject) => {
    setTimeout(() => { renderTask.cancel(); reject(new Error("timed out")); }, PAGE_RENDER_TIMEOUT_MS);
  });
  return Promise.race([renderTask.promise, timeout]).then(() => canvas);
}

// Fallback for scanned/image-only PDFs (or ones with no usable text layer):
// rasterize each page via pdf.js and read it with Tesseract OCR. Feeds into
// the exact same line-based parser as the text-layer path, so the rest of
// the pipeline doesn't need to know which extraction method was used.
async function extractPdfTextViaOcr(arrayBuffer, onProgress, password) {
  const pdfjsLib = await loadPdfjs();
  pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_SRC;
  const pdf = await openPdf(pdfjsLib, arrayBuffer, password);

  const { createWorker } = await loadTesseract();
  const worker = await createWorker("eng");
  // PSM 6 (uniform block of text) reads statement tables noticeably more
  // faithfully than the default auto-segmentation mode, which tends to
  // scramble column order on dense tables.
  await worker.setParameters({ tessedit_pageseg_mode: "6", preserve_interword_spaces: "1" });

  let fullText = "";
  let pagesFailed = 0;
  try {
    for (let i = 1; i <= pdf.numPages; i++) {
      onProgress?.(i, pdf.numPages);
      const page = await pdf.getPage(i);
      // Higher scale meaningfully improves OCR accuracy on dense small-print
      // statement tables — verified against a real problem statement, going
      // from ~0 usable rows at 2.5x to a majority correctly reconciling at 4x.
      const viewport = page.getViewport({ scale: 4 });
      let canvas;
      try {
        canvas = await renderPageToCanvas(page, viewport);
      } catch {
        pagesFailed++;
        continue; // this page couldn't be rendered — skip it, keep going
      }
      const { data } = await worker.recognize(canvas);
      fullText += data.text + "\n";
    }
    if (pagesFailed === pdf.numPages) {
      throw new Error("This PDF's pages couldn't be read at all (a rendering problem, not just missing text) — try re-downloading the statement, or opening it in a PDF reader and re-saving/printing it to a new PDF first.");
    }
  } finally {
    await worker.terminate();
  }
  return fullText;
}

// Returns { transactions, skipped, usedOcr, summaryVerified } — the first
// two match parseCibcCsv's shape so the rest of the CSV-import UI flow
// (preview, dedup, import) works unchanged regardless of which bank is
// active. `usedOcr`/`summaryVerified` let the UI warn when the read is
// less trustworthy than a normal digital-statement import.
export async function parseHdfcPdf(arrayBuffer, onProgress, password) {
  let text = await extractPdfText(arrayBuffer, password);
  let usedOcr = false;
  if (!looksLikeStatementText(text)) {
    usedOcr = true;
    text = await extractPdfTextViaOcr(arrayBuffer, onProgress, password);
  }

  const { rows, summary } = parseHdfcText(text);
  if (!summary) return { transactions: [], skipped: rows.length, usedOcr, summaryVerified: false };

  const classified = inferDebitCredit(rows, summary.opening);
  const skipped = rows.length - classified.length;

  const debitsSum = classified.filter((r) => r.type === "expense").reduce((a, r) => a + r.amountCents, 0);
  const creditsSum = classified.filter((r) => r.type === "income").reduce((a, r) => a + r.amountCents, 0);
  const finalBalance = classified.length ? classified[classified.length - 1].balanceCents : summary.opening;
  const summaryVerified = debitsSum === summary.debits && creditsSum === summary.credits && finalBalance === summary.closing;

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

  return { transactions, skipped, usedOcr, summaryVerified };
}
