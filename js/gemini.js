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

const GEMINI_MODEL = "gemini-2.5-flash";
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

const SYSTEM_PREAMBLE = `You are a helpful personal finance assistant built into a CIBC spending
tracker for a user in Canada. You answer questions about the user's own transaction data below.

Rules:
- Amounts are in CAD cents; always show answers formatted as dollars (e.g. $42.50).
- Do the arithmetic yourself from the raw data — don't ask the user to calculate.
- Be concise: a few sentences or a short list, not an essay.
- "Debit" transactions are from their chequing account; "Credit" are from their credit card.
- If the data doesn't contain enough to answer, say so plainly instead of guessing.
- You are not a licensed financial advisor — for real investment or debt advice, say so and
  suggest they consult one. General budgeting observations from their own data are fine.`;

function formatTransactionsForPrompt(transactions) {
  // Compact CSV-ish format keeps token usage low even with years of history.
  const lines = transactions
    .slice(0, 3000)
    .map((t) => `${t.date},${t.vendor},${t.category},${t.cardType || "debit"},${t.type},${(t.cents / 100).toFixed(2)}`);
  return `date,vendor,category,card,type,amount_cad\n${lines.join("\n")}`;
}

function formatAccountsForPrompt(settings) {
  if (!settings) return "No balance/limit set yet.";
  const parts = [];
  if (settings.debitBalanceCents != null) parts.push(`Debit balance: $${(settings.debitBalanceCents / 100).toFixed(2)}`);
  if (settings.limitCents) parts.push(`Credit limit: $${(settings.limitCents / 100).toFixed(2)}`);
  if (settings.usedCents != null) parts.push(`Credit used: $${(settings.usedCents / 100).toFixed(2)}`);
  return parts.join(", ") || "No balance/limit set yet.";
}

// history: [{ role: "user"|"model", text }]. Returns the model's reply text.
export async function askGemini(question, transactions, settings, history) {
  const apiKey = getGeminiKey();
  if (!apiKey) throw new Error("No Gemini API key saved yet.");

  const systemInstruction = {
    parts: [{
      text: `${SYSTEM_PREAMBLE}\n\nAccount summary: ${formatAccountsForPrompt(settings)}\n\nTransactions:\n${formatTransactionsForPrompt(transactions)}`,
    }],
  };
  const contents = [
    ...history.map((h) => ({ role: h.role, parts: [{ text: h.text }] })),
    { role: "user", parts: [{ text: question }] },
  ];

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ systemInstruction, contents }),
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
