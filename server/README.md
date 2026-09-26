# Loop Market — Backend

Node + Express + Stripe backend for **Loop Market**, a mobile marketplace for digital products.
Every sale is a Stripe Connect *destination charge*: the buyer pays, the seller's
connected Stripe account receives the sale amount minus the platform fee, and the
platform automatically keeps its cut (`PLATFORM_FEE_PERCENT`, default 10%).

## Run locally

```bash
cd server
cp .env.example .env
# edit .env with your Stripe test keys
npm install
npm run dev
```

The API listens on `http://localhost:4242`.

**Webhook forwarding (so sales get recorded while developing):**

```bash
stripe listen --forward-to localhost:4242/api/webhooks/stripe
```

Copy the `whsec_...` secret it prints into your `.env` as `STRIPE_WEBHOOK_SECRET`,
then restart the server.

## Deploy

### Render

1. Push this repo to GitHub (see below).
2. In Render, **New → Web Service**, point it at the repo.
3. Build command: `npm install` · Start command: `npm start` · Root directory: `server`.
4. Add environment variables: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`,
   `PLATFORM_FEE_PERCENT=10`, `CLIENT_URL=https://<your-loop-market-app-url>`.
5. In the Stripe dashboard, add a webhook endpoint pointing at
   `https://<your-render-url>/api/webhooks/stripe` for the
   `checkout.session.completed` event, and put its signing secret in
   `STRIPE_WEBHOOK_SECRET`.

### Railway

1. Push this repo to GitHub.
2. In Railway, **New Project → Deploy from GitHub repo**, set the root to `server`
   (or deploy the repo and set the start command to `npm --prefix server start`).
3. Add the same four environment variables as above.
4. Add the Stripe webhook endpoint the same way as Render.

## Push to GitHub (this is the repo Chuck deploys from)

```bash
cd ~/workspace/marketplace
git init
git add server
git commit -m "Loop Market backend: Stripe Connect marketplace API"
gh repo create loop-market --public --source=. --push
# or: create the repo on github.com and then
# git remote add origin git@github.com:<you>/loop-market.git
# git push -u origin main
```

`.gitignore` already excludes `node_modules/`, `.env`, and `data/`, so no secrets
or local sales data are ever committed. Stripe keys live only in `.env`
(locally) and in the host's environment variables (Render/Railway).

## The app (front end)

The Loop Market phone app lives at `../app/index.html` — a single self-contained
file (no build step, no dependencies). It is 100% owned by Chuck (see
`../app` alongside this backend; proprietary license in `LICENSE`).

- **Run it:** open `app/index.html` in any phone or desktop browser.
- **Deploy it:** put the file on any static host (Render Static Site, Railway,
  Netlify, GitHub Pages, or even an S3 bucket). Then set this backend's
  `CLIENT_URL` to the app's public URL so Stripe redirects and webhooks line up.
- **Demo vs live:** with no backend URL in the app's Account → Settings, the app
  runs in clearly-labeled demo mode (seeded products, simulated checkout and
  sales, settings saved on-device). Paste the backend URL to go live.

## Connect the Loop Market app to this backend

1. Deploy the backend and copy its public URL, e.g. `https://loop-market.onrender.com`.
2. Open the Loop Market app → **Account** tab → **Settings**.
3. Paste the URL into **Backend URL** and save.
4. The app's Buy buttons will now create real Stripe Checkout sessions
   (`POST /api/checkout/session`), and the **Earnings** tab will read live sales
   from `GET /api/sales`. Without a backend URL, the app runs in clearly-labeled
   demo mode.

## API reference

| Method | Route                          | Purpose                                                              |
| ------ | ------------------------------ | -------------------------------------------------------------------- |
| GET    | `/api/health`                  | Health check + current fee percent                                   |
| GET    | `/api/config`                  | Public pricing config (fee %, handling fee, promo & premium pricing) |
| POST   | `/api/checkout/session`        | Create a Checkout Session (destination charge + fee + handling + tip)|
| POST   | `/api/promotions/checkout`     | Sell a featured-listing placement (100% platform revenue)            |
| POST   | `/api/subscriptions/checkout`  | Start a premium seller monthly subscription                         |
| GET    | `/api/subscriptions/status`    | Check whether a seller's premium subscription is active              |
| GET    | `/api/connect/onboarding`      | Create a Connect Express account, return its onboarding link         |
| POST   | `/api/webhooks/stripe`         | Records sales, promotions, subscriptions; stores delivery payload    |
| GET    | `/api/sales`                   | Recorded marketplace sales for the app's Earnings tab                |
| GET    | `/api/delivery/:sessionId`     | Buyer's automatic download link / delivery instructions after payment|
| GET    | `/api/revenue`                 | All revenue broken down by stream (admin view)                       |

Checkout request body:

```json
{
  "productId": "preset-pack-01",
  "title": "Moody Lightroom Presets",
  "priceCents": 1900,
  "sellerStripeAccountId": "acct_123..."
}
```

Sellers get their `sellerStripeAccountId` by opening the link returned from
`GET /api/connect/onboarding?email=seller@example.com` and completing Stripe's
onboarding. The app's **Sell** tab links sellers to this flow.

## Earning runs automatically — market while it earns

Sales, checkout, and payouts run themselves once the backend is deployed:

1. Buyer taps **Buy** → the app calls `POST /api/checkout/session` → Stripe
   Checkout collects payment.
2. Stripe sends `checkout.session.completed` to `POST /api/webhooks/stripe`,
   which records the sale automatically (see `data/sales.json`, or `GET /api/sales`).
3. Stripe Connect splits the money: the seller's connected account receives the
   sale amount minus the platform fee; your platform balance keeps the
   `PLATFORM_FEE_PERCENT`% cut. Payouts to sellers follow their Stripe Connect
   payout schedule — no manual work.

That means marketing never interrupts earning: share the app's marketing
landing page and product links freely while checkout, fee collection, and
payouts keep running in the background.

## Fully automatic money flow — zero human touch per sale

Once deployed, every sale completes end to end with no manual steps:

1. **Buyer pays.** Taps Buy → the app POSTs to `/api/checkout/session`
   (product, price, optional tip, seller's Connect account ID, and the seller's
   delivery link/instructions) → Stripe Checkout collects the card payment.
2. **Platform cut + handling fee collected automatically.** The charge is a
   Stripe Connect *destination charge*: `application_fee_amount` is set to
   `PLATFORM_FEE_PERCENT`% of the item price **plus** `HANDLING_FEE_CENTS`
   flat per order. Stripe splits it at charge time — nothing to reconcile.
3. **Seller paid automatically.** The remainder transfers to the seller's
   connected Stripe account, which pays out to their bank on their Connect
   payout schedule. No manual payouts, ever.
4. **Buyer gets the download automatically.** The webhook
   (`checkout.session.completed`) records the sale *with the delivery payload*,
   and Stripe redirects the buyer to the app's success page with the session
   ID. The success page calls `GET /api/delivery/:sessionId` and instantly
   shows the download link / delivery instructions. The seller never has to
   send anything.
5. **Receipts go out automatically.** Stripe Checkout emails the buyer a
   payment receipt. (Dashboard: Settings → Email receipts — keep customer
   emails on.)
6. **Failed payments retry automatically.** Enable **Smart Retries** in the
   Stripe dashboard (Settings → Billing → Revenue recovery) so failed
   subscription/invoice payments are retried with machine-learning-optimized
   timing instead of dying silently.
7. **Revenue is tracked automatically.** Every stream (sale cuts, handling
   fees, promotions, subscriptions, tips) lands in `data/revenue.json` via the
   webhook and shows in the app's admin revenue view (`GET /api/revenue`).

Chuck's per-sale to-do list: **nothing.** Market the app; the money flow runs itself.

## Tuning the revenue levers

Defaults are competitive for a digital-goods marketplace; adjust in `.env`
(or Render/Railway environment variables) and restart:

| Lever | Env var | Default | Notes |
| ----- | ------- | ------- | ----- |
| Platform cut | `PLATFORM_FEE_PERCENT` | `10` | 5–15% is the normal marketplace band. Lower to attract sellers early, raise once you have demand. |
| Handling fee | `HANDLING_FEE_CENTS` | `30` | Flat per order, on top of the percent cut. Covers Stripe's own fixed costs and adds up fast at volume. |
| Promoted listings | `PROMOTED_LISTING_PRICE_CENTS` / `PROMOTED_LISTING_DAYS` | `499` / `7` | Sellers pay for featured placement; 100% platform revenue. Price against the visibility value (views/clicks). |
| Premium seller tier | `PREMIUM_MONTHLY_CENTS` (or `PREMIUM_PRICE_ID`) | `999`/mo | Monthly subscription for power sellers. Consider gating perks: 0% handling fee, analytics, more listings. |
| Tips / order bumps | `tipCents` in checkout call | optional | Buyer-set at checkout; goes to the seller in full (fee calculated on item price only). Increases seller loyalty. |

The app reads live values from `GET /api/config`, so the UI always reflects
the current settings.

## Ownership

Loop Market is proprietary software, 100% owned by Chuck. See `LICENSE`
(all rights reserved) and `OWNERSHIP.md`. Before launch, review
`LEGAL_CHECKLIST.md` with an attorney and CPA — it is not legal advice.
