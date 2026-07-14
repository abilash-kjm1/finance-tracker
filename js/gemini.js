// ============================================================
// Gemini Q&A — ask natural-language questions about your spending.
//
// The API key is entered directly in the app UI (Ask AI → setup) and
// kept only in this browser's localStorage — it is never written to
// source code or committed to git. This matters because Gemini API
// keys created as "service-account-bound" keys can't be restricted to
// specific websites the way the Firebase config key can, so it must
// not be shipped in the public repo.
// ============================================================

// "-latest" alias avoids hard-pinning to a model version that Google
// later retires for new API keys.
const GEMINI_MODEL = "gemini-flash-latest";
const STORAGE_KEY = "ft-gemini-key";

export function getGeminiKey() {
  try { return localStorage.getItem(STORAGE_KEY) || ""; } catch { return ""; }
}
export function setGeminiKey(key) {
  try { localStorage.setItem(STORAGE_KEY, key.trim()); } catch {}
}
export function clearGeminiKey() {
  try { localStorage.removeItem(STORAGE_KEY); } catch {}
}
export function hasGeminiKey() {
  return getGeminiKey().length > 0;
}

function systemPreamble(bank) {
  return `You are a helpful personal finance assistant built into a spending
tracker. You are currently answering about the user's ${bank.label} account (${bank.country}). You answer questions about the user's own transaction data below.

Rules:
- Amounts are in ${bank.currency} cents; always show answers formatted as currency (e.g. ${bank.symbol}42.50).
- Do the arithmetic yourself from the raw data — don't ask the user to calculate.
- Be concise: a few sentences or a short list, not an essay.
- Formatting: use **bold** only for key labels/numbers, and "* " bullet points for
  breakdowns. Don't use headings, tables, or nested/indented sub-bullets — keep every
  bullet at the same single level so it renders cleanly in a simple chat bubble.
- When listing individual transactions, always write the date in full as
  "Month D, YYYY" (e.g. "July 3, 2026") and always tag each amount with "(Income)"
  or "(Expense)" right after it — these get auto-highlighted in the UI, so the
  exact wording "(Income)"/"(Expense)" matters.
- "Debit" transactions are from their main account; "Credit" are from a credit card/facility.
- If the data doesn't contain enough to answer, say so plainly instead of guessing.
- You are not a licensed financial advisor — for real investment or debt advice, say so and
  suggest they consult one. General budgeting observations from their own data are fine.`;
}

function formatTransactionsForPrompt(transactions) {
  // Compact CSV-ish format keeps token usage low even with years of history.
  const lines = transactions
    .slice(0, 3000)
    .map((t) => `${t.date},${t.vendor},${t.category},${t.cardType || "debit"},${t.type},${(t.cents / 100).toFixed(2)}`);
  return `date,vendor,category,card,type,amount\n${lines.join("\n")}`;
}

function formatAccountsForPrompt(settings) {
  if (!settings) return "No balance/limit set yet.";
  const parts = [];
  if (settings.debitBalanceCents != null) parts.push(`Debit balance: $${(settings.debitBalanceCents / 100).toFixed(2)}`);
  if (settings.limitCents) parts.push(`Credit limit: $${(settings.limitCents / 100).toFixed(2)}`);
  if (settings.usedCents != null) parts.push(`Credit used: $${(settings.usedCents / 100).toFixed(2)}`);
  return parts.join(", ") || "No balance/limit set yet.";
}

async function callGemini(systemText, contents) {
  const apiKey = getGeminiKey();
  if (!apiKey) throw new Error("No Gemini API key saved yet.");

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ systemInstruction: { parts: [{ text: systemText }] }, contents }),
    }
  );

  if (!res.ok) {
    const body = await res.json().catch(() => null);
    const msg = body?.error?.message || `Request failed (${res.status})`;
    throw new Error(msg);
  }

  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || "";
  if (!text) throw new Error("No response from Gemini — it may have blocked the request.");
  return text;
}

// bank: { label, country, currency, symbol } — identifies which of the
// user's (fully separate) banks this question/prediction is about.
// history: [{ role: "user"|"model", text }]. Returns the model's reply text.
export async function askGemini(question, transactions, settings, history, bank) {
  const systemText = `${systemPreamble(bank)}\n\nAccount summary: ${formatAccountsForPrompt(settings)}\n\nTransactions:\n${formatTransactionsForPrompt(transactions)}`;
  const contents = [
    ...history.map((h) => ({ role: h.role, parts: [{ text: h.text }] })),
    { role: "user", parts: [{ text: question }] },
  ];
  return callGemini(systemText, contents);
}

// Tailored recurring-charge forecast, following the user's own prompt
// template: 90-day trailing window, explicitly drop anything that looks
// cancelled (no charge in over one full interval), catch weekly/biweekly/
// monthly cadences, and format as a bulleted "(Expense)" list so it
// renders through the same date/tag highlighting as the chat panel.
export async function askGeminiRecurringPrediction(transactions, bank) {
  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);
  const ninetyDaysAgo = new Date(today.getTime() - 90 * 86400000).toISOString().slice(0, 10);
  const nextMonth = new Date(today.getFullYear(), today.getMonth() + 2, 0).toISOString().slice(0, 10);

  const recent = transactions.filter((t) => t.type === "expense" && t.date >= ninetyDaysAgo);
  const systemText = `You are analyzing a ${bank.label} (${bank.country}) transaction history to predict upcoming recurring charges. Amounts are in ${bank.currency}.

Today's date is ${todayStr}. Predict recurring expenses through ${nextMonth} (the remainder of this month and next month).

Transactions from the last 90 days (${ninetyDaysAgo} to ${todayStr}), CSV format date,vendor,category,card,amount:
${["date,vendor,category,card,amount", ...recent.map((t) => `${t.date},${t.vendor},${t.category},${t.cardType || "debit"},${(t.cents / 100).toFixed(2)}`)].join("\n")}

Follow these strict rules:
1. Only consider active recurring charges that have appeared within this 90-day window.
2. Explicitly ignore anything that looks cancelled or stopped — if a vendor's normal interval
   (e.g. every ~30 days) has clearly been missed (no matching charge in over one full interval
   past the last one seen), do not predict a future charge for it.
3. Identify weekly, bi-weekly, and monthly patterns.
4. Format the output as a simple bulleted list ("* " prefix), using the "Month D, YYYY" date
   format for each predicted date, and tag each amount with "(Expense)" immediately after it —
   e.g. "* July 28, 2026 — Rogers Wireless — ${bank.symbol}89.91 (Expense)".
5. Output only the bulleted list — no preamble, no summary paragraph, no closing remarks.
   If nothing qualifies, output exactly: "No active recurring charges detected."`;

  return callGemini(systemText, [{ role: "user", parts: [{ text: "Predict my upcoming recurring charges." }] }]);
}
