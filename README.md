# 💰 Finance Tracker

This is a tool I built for myself to actually **see where my money goes**. I bank with CIBC in Canada and kept spending without tracking it, so I made a website that:

- Imports my **CIBC bank statement** (the CSV file you can download from online banking)
- Shows my **balance, credit card usage, and spending** in one place
- Lets me **filter and search** my transactions any way I want
- Draws **charts** so I can see patterns at a glance
- Is hooked up to **Gemini (Google's AI)** so I can just ask it questions in plain English, like *"how much did I spend on food last month?"*
- Tries to **guess what's coming up** — subscriptions, rent, phone bills — before they charge me

It's completely free to run, works on your phone and your computer, and your data is private to your own Google account.

**Want to try it without setting anything up?** Open the site with `?demo=1` at the end of the link (e.g. `https://yoursite.com/?demo=1`) and it'll load with sample data so you can click around.

---

## What each part of the app does

### The top cards
Three cards at the top give you the big picture at a glance:
- **Debit card balance** (green) — the money in your chequing account. Tap the card to type in what your CIBC app currently shows — after that, it updates itself automatically every time you add a new transaction.
- **Credit card balance** (blue) — your credit limit, how much you've used, and a bar that turns amber then red as you use more of it (staying under 30% used is good for your credit score).
- **Spent this month** (red) — how much you've spent so far this month, compared with last month.

### Filters and search
Right below the cards you'll find:
- A **month dropdown** — This month, Last month, All time, or pick a specific month you've imported.
- A **search box** — type any part of a vendor name or note to find it.
- A **Date range** button — pick an exact "from" and "to" date if you want something more specific than a whole month.
- **Category chips** (Groceries, Dining, Transport, etc.) — tap one or more to only show transactions in those categories.
- **"Vendors this period"** — a collapsible list of every place you actually spent money at during the selected time, with the busiest ones showing first. Tap one to filter down to just that vendor — handy for questions like "how much have I spent at Uber this month?"

### Charts
Two charts update live based on whatever filters you've got active:
- A **donut chart** showing how your spending splits across categories.
- A **bar chart** showing your spending trend over the last 6 months.

### The transaction table
Every transaction you've imported or added shows up here — date, vendor, category, whether it was on your **debit or credit card**, and the amount (red for money out, green for money in).
- **Click any column header** to sort by it. Click a second column too and it'll sort by both together (e.g. date, then vendor name) — click **Reset sort** to go back to normal.
- Tap the **pencil icon** to edit a transaction, or the **trash icon** to delete one (you'll get a few seconds to undo).
- Large imports are automatically split into pages so the page doesn't slow down.

### Calendar & day view (on a wide screen)
On desktop, there's a panel on the right side of the screen with:
- A **calendar** — days with transactions get a small dot under them. Click any day to see exactly what you spent that day, listed right there in the same panel. This is separate from the filters above it, so browsing by day never messes with what you were already looking at.
- On your phone, get to the same calendar through the **☰ menu (top right) → Calendar & recurring charges**.

### Upcoming recurring charges
This is the part I'm most proud of — it looks at your transaction history and tries to spot **subscriptions, bills, and other charges that repeat** (like Netflix, your phone bill, or rent), then predicts when the next one is coming and roughly how much it'll be.
- Predictions are grouped into **This month** (blue) and **Next month** (orange), each showing a total for that month in the corner.
- Without any setup, it works using simple math — if a vendor has charged you at least 3 times at a fairly regular interval and similar amount, it counts it as recurring.
- If you connect a free Gemini key (see setup below), it uses AI instead for a smarter read of your data, and refreshes itself automatically about twice a day whenever you have the app open. There's also a small refresh icon if you want to force an update.

### Ask AI (the ✨ icon, top right)
Once you've added a free Gemini API key, tap the sparkle icon to open a chat where you can ask anything about your own spending in plain English — *"What's my biggest expense category?"*, *"How much did I send Kavya this year?"*, that kind of thing. It reads your real transaction data to answer, so the answers are about your actual money, not generic advice.

### The ⋮ menu (top right)
- **Import CIBC CSV** — bring in your bank statement (see below).
- **Export backup (JSON)** — download a copy of everything, just in case.
- **Clean up vendor names** — CIBC's transaction descriptions are messy (e.g. "POINT OF SALE VISA DEBIT RETAIL PURCHASE DD/DOORDASHOSMO"). This tidies up anything already imported into plain names like "DoorDash".
- **Edit balance & limit** — same as tapping the top cards.
- **Delete transactions** — wipe everything, or just a date range, with an undo option right after.

### Dark mode
Tap the sun/moon icon anytime to switch. It remembers your choice.

---

## Importing your CIBC transactions

1. In CIBC online banking, open your account → **Download / Export transactions** → choose **CSV**.
2. In the app: **⋮ menu → Import CIBC CSV** → pick the file you just downloaded.
3. It reads the dates, amounts, and whether each was a debit or credit charge, and guesses a category and a clean vendor name for you. You can always fix any row afterwards with the pencil icon.
4. If you import a file that overlaps with something already in the app (say you download "all time" every month), it automatically skips anything it's already seen — no duplicates.

---

## Setting up your own copy (free, takes about 5–10 minutes)

The site itself is just plain files (no server needed), but to actually save your data and sync it between your phone and computer, you need a free Google Firebase project. Do this once.

### 1. Create a Firebase project
1. Go to [console.firebase.google.com](https://console.firebase.google.com) and sign in with your Google account.
2. **Create a project** → name it anything (e.g. `finance-tracker`) → Google Analytics is optional, you can turn it off.

### 2. Turn on Google sign-in
1. **Build → Authentication → Get started**.
2. **Sign-in method** tab → **Google** → Enable → pick your support email → Save.

### 3. Create the database
1. **Build → Firestore Database → Create database**.
2. Pick a location close to you (e.g. `northamerica-northeast1` for Montreal) → **Production mode** → Create.
3. Open the **Rules** tab, replace everything with the contents of [`firestore.rules`](firestore.rules) from this repo, and click **Publish**. This is what makes sure only *you* can read your own data.

### 4. Connect the app to your project
1. Click the ⚙️ gear (Project settings) → **Your apps** → the web icon `</>`.
2. Register the app (any nickname) and copy the `firebaseConfig` code it shows you.
3. Open [`js/firebase.js`](js/firebase.js) in this project and paste it in, replacing the placeholder at the top.

> These config values are fine to make public — they just identify your project. Your data is actually protected by the Firestore rules from step 3, not by keeping this secret.

### 5. Allow your website's address
In **Authentication → Settings → Authorized domains**, make sure you have:
- `localhost` (already there)
- `YOUR_USERNAME.github.io` (add this once you've deployed — see below)

### 6. Lock the app down to just you
Since the code is public on GitHub, add a little extra protection so no one else can use your project:
- In [`firestore.rules`](firestore.rules) and in `ALLOWED_EMAILS` near the top of [`js/app.js`](js/app.js), list only the email address(es) allowed to sign in.
- Optionally, turn on **App Check** (Firebase console → Build → App Check → register your app → reCAPTCHA v3), which blocks any traffic that isn't coming from your real website. Paste the key it gives you into `RECAPTCHA_SITE_KEY` in `js/firebase.js`.

### 7. (Optional) Turn on "Ask AI" and the smart recurring-charge predictions
1. Go to [aistudio.google.com/apikey](https://aistudio.google.com/apikey) and make a free Gemini API key.
2. Open the app, tap the ✨ icon, and paste your key in right there when it asks — it's saved only in your browser, never in the code.
3. That's it — the ✨ chat and the AI-powered recurring charges both start working.

Your questions and your transaction data (vendor, amount, date, category — not your bank login or account numbers) get sent to Google's Gemini to generate an answer, since that's how any AI chat works.

---

## Putting it online for free (GitHub Pages)

```bash
cd "Finance tracker"
git init
git add .
git commit -m "Finance tracker"
gh repo create finance-tracker --public --source=. --push
```

Then on GitHub: **your repo → Settings → Pages → Source: Deploy from a branch → main / (root) → Save.**

Your site will be live in a minute or two at `https://YOUR_USERNAME.github.io/finance-tracker/`. Don't forget to add that same address to Firebase's authorized domains (step 5 above) so sign-in works there too.

## Running it on your own computer first

```bash
cd "Finance tracker"
python -m http.server 8080
# or: npx serve .
```

Then open `http://localhost:8080` in your browser.

---

## What it's built with

Plain HTML/CSS/JavaScript, no build tools or frameworks · Firebase Authentication + Cloud Firestore (free tier) for your data · Google Gemini for AI features · Chart.js for the charts · Material Design 3 styling (the look Google uses on Pixel phones), with light and dark themes · Hosted free on GitHub Pages.
