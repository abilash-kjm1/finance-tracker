# 💰 Finance Tracker

A personal spending tracker for CIBC (or any Canadian bank), built with **Material Design 3** (the Google Pixel look). Works on phone and desktop, syncs across all your devices, and costs **$0 to run**.

- **Top cards:** available balance, credit limit with utilization bar, this-month spending vs last month
- **Charts:** spending by category (doughnut) + 6-month trend (bar)
- **Transactions:** sortable table (stacked cards on mobile), month/date-range/category/search filters
- **CIBC CSV import** with automatic category guessing (Tim Hortons → Dining, Presto → Transport, …)
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

---

## Run locally

Any static server works. Easiest:

```bash
cd "Finance tracker"
python -m http.server 8080
# or: npx serve .
```

Open http://localhost:8080 and sign in with Google.

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
