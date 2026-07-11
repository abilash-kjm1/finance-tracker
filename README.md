# 💰 Finance Tracker

A personal spending tracker for CIBC (or any Canadian bank), built with **Material Design 3** (the Google Pixel look). Works on phone and desktop, syncs across all your devices, and costs **$0 to run**.

- **Top cards:** available balance, credit limit with utilization bar, this-month spending vs last month
- **Charts:** spending by category (doughnut) + 6-month trend (bar)
- **Transactions:** sortable table (stacked cards on mobile), month/date-range/category/search filters
- **CIBC CSV import** with automatic category guessing (Tim Hortons → Dining, Presto → Transport, …) and duplicate detection for monthly re-imports
- **Ask AI**: natural-language questions about your spending, answered by Gemini using your real transaction data
- **Google sign-in + cloud sync** via Firebase (free tier), with offline support
- Light & dark themes, ripple effects, animated numbers

Try the UI instantly with demo data: open the site with `?demo=1` in the URL.

---

## Setup (once, ~5 minutes, all free)

### 1. Create a Firebase project
1. Go to [console.firebase.google.com](https://console.firebase.google.com) and sign in with your Google account.
2. **Create a project** → name it anything (e.g. `finance-tracker`) → Google Analytics optional (off is fine).

### 2. Enable Google sign-in
1. In the left sidebar: **Build → Authentication → Get started**.
2. **Sign-in method** tab → **Google** → Enable → pick your support email → Save.

### 3. Create the database
1. **Build → Firestore Database → Create database**.
2. Choose a location (e.g. `northamerica-northeast1` — Montreal) → **Production mode** → Create.
3. Open the **Rules** tab, replace everything with the contents of [`firestore.rules`](firestore.rules), and click **Publish**. This makes your data readable only by your own Google account.

### 4. Connect the app
1. Click the ⚙️ gear (Project settings) → **Your apps** → the web icon **`</>`**.
2. Register the app (any nickname, no hosting needed) and copy the `firebaseConfig` object it shows.
3. Open [`js/firebase.js`](js/firebase.js) and replace the placeholder `firebaseConfig` at the top with yours.

> The config values are safe to commit publicly — they identify your project but the Firestore rules are what protect your data.

### 5. Authorize your site's domain
In **Authentication → Settings → Authorized domains**, make sure these are listed:
- `localhost` (already there by default)
- `YOUR_USERNAME.github.io` (add this after deploying — step below)

### 6. Lock the app to your account(s)
This app is public on GitHub, so anything with your `firebaseConfig` could theoretically try to use it. Two things already stop that from mattering:
- **Firestore rules** ([`firestore.rules`](firestore.rules)) only allow read/write for emails you list — edit the array there and in `ALLOWED_EMAILS` at the top of [`js/app.js`](js/app.js) to add/remove people.
- **App Check** (optional but recommended) blocks any request that isn't coming from your real deployed site, even before it reaches your Firestore rules:
  1. **Build → App Check** in the Firebase console → **Apps** → register your web app.
  2. Choose **reCAPTCHA v3** as the provider → it'll give you a **site key**.
  3. Paste that key into `RECAPTCHA_SITE_KEY` in [`js/firebase.js`](js/firebase.js).
  4. Back in App Check, under **APIs**, set **Firestore** to **Enforce** (do this *after* pasting the key and confirming sign-in still works, otherwise you'll lock yourself out too).

---

## Run locally

Any static server works. Easiest:

```bash
cd "Finance tracker"
python -m http.server 8080
# or: npx serve .
```

Open http://localhost:8080 and sign in with Google.

### 7. (Optional) Enable "Ask AI"
1. Go to [aistudio.google.com/apikey](https://aistudio.google.com/apikey) and create a free Gemini API key (same or different Google account, doesn't matter).
2. Open [`js/gemini.js`](js/gemini.js) and paste the key over the placeholder `GEMINI_API_KEY`.
3. **Restrict the key to your own domains** — this key ships in your public source code, unlike Firebase's. In AI Studio, open the key's settings → **Website restrictions** → add `localhost` and `YOUR_USERNAME.github.io`. Without this, anyone who copies your public repo could burn through your free quota.
4. Tap the ✨ icon in the top bar and ask things like *"How much did I spend on dining last month?"* or *"What's my biggest expense category?"*

Your questions and transaction data (vendor, amount, date, category) are sent to Google's Gemini API to generate an answer — that's inherent to using a cloud AI model. Nothing about your bank account or login is included.

---

## Deploy free on GitHub Pages

```bash
git init
git add .
git commit -m "Finance tracker"
gh repo create finance-tracker --public --source=. --push
```

Then on GitHub: **repo → Settings → Pages → Source: Deploy from a branch → main / (root) → Save.**

Your site goes live at `https://YOUR_USERNAME.github.io/finance-tracker/` in a minute or two. Add `YOUR_USERNAME.github.io` to Firebase's authorized domains (step 5 above), and you can open it from any phone or laptop, sign in, and see all your data.

---

## Importing your CIBC transactions

1. In CIBC online banking, open the account → **Download / Export transactions** → choose **CSV**.
2. In the app: **⋮ menu → Import CIBC CSV** → pick the file.
3. It detects dates, amounts, debits vs credits, and auto-guesses categories from vendor names. Edit any row afterwards with the ✏️ button.

Both CIBC CSV shapes are supported (with or without header row):

```
MM/DD/YYYY, Description, Debit, Credit [, Card number]
YYYY-MM-DD, Description, Debit, Credit
```

## Setting your balance & credit limit

Tap the **balance** or **credit limit** card (or ⋮ → Edit balance & limit) and type what your CIBC app shows. From then on, the balance auto-adjusts as you log transactions dated after that day. The utilization bar turns amber above 30% and red above 70% — keeping utilization under 30% is good for your credit score.

## Tech

Plain HTML/CSS/JS (no build step) · Firebase Auth + Cloud Firestore (free Spark plan) · Chart.js · Material Design 3 tokens, light/dark · GitHub Pages hosting.
