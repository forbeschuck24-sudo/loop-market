// Loop Market backend — Node + Express + Stripe
//
// Revenue levers:
//   1. Platform fee on every sale (Stripe Connect destination charge +
//      application_fee_amount). Configurable via PLATFORM_FEE_PERCENT.
//   2. Paid promoted/featured listings sellers buy for visibility
//      (POST /api/promotions/checkout). 100% platform revenue.
//   3. Premium seller tier: monthly subscription via Stripe
//      (POST /api/subscriptions/checkout). 100% platform revenue.
//   4. Tips / order bumps at checkout (optional tipCents on
//      POST /api/checkout/session). Tips go to the seller; the platform
//      fee is calculated on the item price only.
//
// All revenue is recorded by the Stripe webhook into data/revenue.json,
// broken down by stream for the app's admin/revenue view (GET /api/revenue).

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const Stripe = require('stripe');

const app = express();
// Behind Render's proxy so req.protocol/host reflect the public URL.
app.set('trust proxy', 1);
const PORT = process.env.PORT || 4242;
const PLATFORM_FEE_PERCENT = Number(process.env.PLATFORM_FEE_PERCENT || 10);
const HANDLING_FEE_CENTS = Number(process.env.HANDLING_FEE_CENTS || 30);
const PROMOTED_LISTING_PRICE_CENTS = Number(process.env.PROMOTED_LISTING_PRICE_CENTS || 499);
const PROMOTED_LISTING_DAYS = Number(process.env.PROMOTED_LISTING_DAYS || 7);
const PREMIUM_MONTHLY_CENTS = Number(process.env.PREMIUM_MONTHLY_CENTS || 999);
// Base URL for Stripe redirects: explicit CLIENT_URL wins, otherwise the
// server's own public URL (the app is served by this same server).
function baseUrl(req) {
  return (process.env.CLIENT_URL || (req.protocol + '://' + req.get('host'))).replace(/\/$/, '');
}

if (!process.env.STRIPE_SECRET_KEY) {
  console.warn('WARNING: STRIPE_SECRET_KEY is not set. Copy .env.example to .env and fill it in.');
}
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || 'sk_test_placeholder', {
  apiVersion: '2024-06-20',
});

// ---------------- JSON file stores (MVP; swap for a real DB later) ----------------
const DATA_DIR = path.join(__dirname, 'data');
const REVENUE_FILE = path.join(DATA_DIR, 'revenue.json');
const SUBS_FILE = path.join(DATA_DIR, 'subscriptions.json');
const PRICE_CACHE_FILE = path.join(DATA_DIR, 'stripe_price.json');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}
function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}
function recordEvent(evt) {
  const events = readJson(REVENUE_FILE, []);
  events.push({ id: evt.id || `evt_${Date.now()}`, created: new Date().toISOString(), ...evt });
  writeJson(REVENUE_FILE, events);
  return events[events.length - 1];
}
// subscriptions.json: { "<subscriptionId>": { sellerAccount, email, status, currentPeriodEnd } }
function getSubs() {
  return readJson(SUBS_FILE, {});
}
function saveSub(subId, data) {
  const subs = getSubs();
  subs[subId] = { ...(subs[subId] || {}), ...data };
  writeJson(SUBS_FILE, subs);
}
function findSubBySeller(sellerAccount) {
  return Object.entries(getSubs()).find(([, s]) => s.sellerAccount === sellerAccount);
}

app.use(cors());

// ---------------- Stripe webhook (needs the RAW body; before express.json) ----------------
app.post('/api/webhooks/stripe', express.raw({ type: 'application/json' }), (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  const obj = event.data.object;
  const md = obj.metadata || {};

  if (event.type === 'checkout.session.completed') {
    const buyerEmail = obj.customer_details?.email || obj.customer_email || null;
    const currency = (obj.currency || 'usd').toUpperCase();
    if (md.type === 'promotion') {
      recordEvent({
        id: obj.id,
        stream: 'promotion',
        productId: md.productId || null,
        productTitle: md.productTitle || 'Promoted listing',
        amount: obj.amount_total,
        currency,
        sellerAccount: md.sellerAccount || null,
        buyerEmail,
        days: PROMOTED_LISTING_DAYS,
      });
      console.log('Recorded promotion purchase:', obj.id);
    } else if (md.type === 'subscription') {
      if (obj.subscription) {
        saveSub(obj.subscription, {
          sellerAccount: md.sellerAccount || null,
          email: buyerEmail,
          status: 'active',
        });
        console.log('Premium subscription started:', obj.subscription);
      }
    } else {
      // Regular marketplace sale: platform keeps the fee, rest goes to seller.
      recordEvent({
        id: obj.id,
        stream: 'sale',
        product: md.productTitle || 'Digital product',
        productId: md.productId || null,
        amount: obj.amount_total,
        tip: Number(md.tip || 0),
        currency,
        fee: Number(md.platformFee || 0),
        feePercent: Number(md.feePercent || PLATFORM_FEE_PERCENT),
        handlingFee: Number(md.handlingFee || 0),
        sellerAccount: md.sellerAccount || null,
        buyerEmail,
        delivery: {
          fileUrl: md.deliveryUrl || null,
          instructions: md.deliveryInstructions || null,
        },
      });
      console.log('Recorded sale:', obj.id);
    }
  }

  if (event.type === 'customer.subscription.created' || event.type === 'customer.subscription.updated') {
    saveSub(obj.id, {
      sellerAccount: (obj.metadata || {}).sellerAccount || null,
      status: obj.status,
      currentPeriodEnd: obj.current_period_end
        ? new Date(obj.current_period_end * 1000).toISOString()
        : null,
    });
  }
  if (event.type === 'customer.subscription.deleted') {
    saveSub(obj.id, { status: 'canceled' });
  }
  if (event.type === 'invoice.payment_succeeded' && obj.subscription) {
    const sub = getSubs()[obj.subscription] || {};
    recordEvent({
      stream: 'subscription',
      amount: obj.amount_paid,
      currency: (obj.currency || 'usd').toUpperCase(),
      sellerAccount: sub.sellerAccount || (obj.metadata || {}).sellerAccount || null,
      buyerEmail: obj.customer_email || null,
      subscriptionId: obj.subscription,
      billingReason: obj.billing_reason || null,
    });
    console.log('Recorded subscription payment:', obj.id);
  }

  res.json({ received: true });
});

app.use(express.json());

// ---------------- Public config (drives the app's pricing UI) ----------------
app.get('/api/config', (req, res) => {
  res.json({
    feePercent: PLATFORM_FEE_PERCENT,
    handlingFeeCents: HANDLING_FEE_CENTS,
    promotion: { priceCents: PROMOTED_LISTING_PRICE_CENTS, days: PROMOTED_LISTING_DAYS },
    premium: { monthlyCents: PREMIUM_MONTHLY_CENTS },
    currency: 'USD',
  });
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, feePercent: PLATFORM_FEE_PERCENT });
});

// ---------------- Marketplace checkout (destination charge + platform fee) ----------------
// Body: { productId, title, priceCents, tipCents?, sellerStripeAccountId }
// Fee is calculated on the item price only; an optional tip goes to the seller.
app.post('/api/checkout/session', async (req, res) => {
  try {
    const { productId, title, priceCents, tipCents = 0, sellerStripeAccountId, deliveryUrl, deliveryInstructions } = req.body || {};
    if (!title || !priceCents || !sellerStripeAccountId) {
      return res.status(400).json({ error: 'title, priceCents and sellerStripeAccountId are required' });
    }
    const price = Number(priceCents);
    const tip = Math.max(0, Number(tipCents) || 0);
    const percentCut = Math.round((price * PLATFORM_FEE_PERCENT) / 100);
    const fee = percentCut + HANDLING_FEE_CENTS; // percent cut + flat handling fee, both automatic

    const lineItems = [
      {
        price_data: {
          currency: 'usd',
          product_data: { name: title },
          unit_amount: price,
        },
        quantity: 1,
      },
    ];
    if (tip > 0) {
      lineItems.push({
        price_data: {
          currency: 'usd',
          product_data: { name: 'Tip for the creator' },
          unit_amount: tip,
        },
        quantity: 1,
      });
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: lineItems,
      payment_intent_data: {
        application_fee_amount: fee,
        transfer_data: { destination: sellerStripeAccountId },
      },
      metadata: {
        productId: productId || '',
        productTitle: title,
        platformFee: String(fee),
        feePercent: String(PLATFORM_FEE_PERCENT),
        handlingFee: String(HANDLING_FEE_CENTS),
        tip: String(tip),
        sellerAccount: sellerStripeAccountId,
        deliveryUrl: (deliveryUrl || '').slice(0, 500),
        deliveryInstructions: (deliveryInstructions || '').slice(0, 500),
      },
      success_url: `${baseUrl(req)}/?purchase=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl(req)}/?purchase=cancelled`,
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('Checkout session error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------------- Promoted / featured listings ----------------
// Sellers pay the platform a flat fee for N days of featured placement.
// This is 100% platform revenue (no Connect destination charge).
app.post('/api/promotions/checkout', async (req, res) => {
  try {
    const { productId, productTitle, sellerStripeAccountId, email } = req.body || {};
    if (!productId || !productTitle || !sellerStripeAccountId) {
      return res.status(400).json({ error: 'productId, productTitle and sellerStripeAccountId are required' });
    }
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      customer_email: email || undefined,
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: {
              name: `Featured listing — ${productTitle} (${PROMOTED_LISTING_DAYS} days)`,
            },
            unit_amount: PROMOTED_LISTING_PRICE_CENTS,
          },
          quantity: 1,
        },
      ],
      metadata: {
        type: 'promotion',
        productId,
        productTitle,
        sellerAccount: sellerStripeAccountId,
      },
      success_url: `${baseUrl(req)}/?promotion=success`,
      cancel_url: `${baseUrl(req)}/?promotion=cancelled`,
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error('Promotion checkout error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------------- Premium seller tier (monthly subscription) ----------------
async function getPremiumPriceId() {
  if (process.env.PREMIUM_PRICE_ID) return process.env.PREMIUM_PRICE_ID;
  const cached = readJson(PRICE_CACHE_FILE, null);
  if (cached && cached.priceId) return cached.priceId;
  const price = await stripe.prices.create({
    unit_amount: PREMIUM_MONTHLY_CENTS,
    currency: 'usd',
    recurring: { interval: 'month' },
    product_data: { name: 'Loop Market Premium Seller' },
  });
  writeJson(PRICE_CACHE_FILE, { priceId: price.id });
  return price.id;
}

app.post('/api/subscriptions/checkout', async (req, res) => {
  try {
    const { sellerStripeAccountId, email } = req.body || {};
    if (!sellerStripeAccountId) {
      return res.status(400).json({ error: 'sellerStripeAccountId is required' });
    }
    const priceId = await getPremiumPriceId();
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer_email: email || undefined,
      line_items: [{ price: priceId, quantity: 1 }],
      subscription_data: {
        metadata: { type: 'subscription', sellerAccount: sellerStripeAccountId },
      },
      metadata: { type: 'subscription', sellerAccount: sellerStripeAccountId },
      success_url: `${baseUrl(req)}/?premium=success`,
      cancel_url: `${baseUrl(req)}/?premium=cancelled`,
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error('Subscription checkout error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/subscriptions/status', (req, res) => {
  const sellerAccount = req.query.sellerAccount;
  if (!sellerAccount) return res.status(400).json({ error: 'sellerAccount query param required' });
  const found = findSubBySeller(sellerAccount);
  if (!found) return res.json({ active: false });
  const [, sub] = found;
  res.json({ active: sub.status === 'active' || sub.status === 'trialing', ...sub });
});

// ---------------- Seller onboarding (Stripe Connect Express) ----------------
app.get('/api/connect/onboarding', async (req, res) => {
  try {
    const account = await stripe.accounts.create({
      type: 'express',
      email: req.query.email || undefined,
    });
    const link = await stripe.accountLinks.create({
      account: account.id,
      refresh_url: `${baseUrl(req)}/?onboarding=refresh`,
      return_url: `${baseUrl(req)}/?onboarding=done&account=${account.id}`,
      type: 'account_onboarding',
    });
    res.json({ accountId: account.id, url: link.url });
  } catch (err) {
    console.error('Connect onboarding error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------------- Sales + revenue ----------------
// GET /api/sales — marketplace sales (powers the app's Earnings tab).
app.get('/api/sales', (req, res) => {
  const sales = readJson(REVENUE_FILE, []).filter((e) => e.stream === 'sale').reverse();
  res.json({ sales });
});

// GET /api/delivery/:sessionId — the buyer's automatic digital delivery.
// After a successful payment the app's success page calls this with the
// Checkout Session ID and instantly shows the download link / instructions.
// No human involvement: the webhook stored the delivery payload at sale time.
app.get('/api/delivery/:sessionId', (req, res) => {
  const events = readJson(REVENUE_FILE, []);
  const sale = events.find((e) => e.stream === 'sale' && e.id === req.params.sessionId);
  if (!sale) return res.status(404).json({ error: 'Sale not found or payment not completed yet' });
  res.json({
    paid: true,
    product: sale.product,
    amount: sale.amount,
    currency: sale.currency,
    buyerEmail: sale.buyerEmail,
    created: sale.created,
    delivery: sale.delivery || { fileUrl: null, instructions: null },
  });
});

// GET /api/revenue — every revenue stream, broken down (powers the admin view).
app.get('/api/revenue', (req, res) => {
  const events = readJson(REVENUE_FILE, []);
  const byStream = {
    sale: { count: 0, gross: 0, platformCut: 0, sellerVolume: 0 },
    promotion: { count: 0, gross: 0 },
    subscription: { count: 0, gross: 0 },
    tip: { count: 0, gross: 0 },
  };
  for (const e of events) {
    if (e.stream === 'sale') {
      byStream.sale.count += 1;
      byStream.sale.gross += e.amount || 0;
      byStream.sale.platformCut += e.fee || 0;
      byStream.sale.sellerVolume += (e.amount || 0) - (e.fee || 0);
      if (e.tip > 0) {
        byStream.tip.count += 1;
        byStream.tip.gross += e.tip;
      }
    } else if (byStream[e.stream]) {
      byStream[e.stream].count += 1;
      byStream[e.stream].gross += e.amount || 0;
    }
  }
  const platformRevenue =
    byStream.sale.platformCut + byStream.promotion.gross + byStream.subscription.gross;
  res.json({ events: [...events].reverse(), byStream, totals: { platformRevenue } });
});

// ---------------- Serve the Loop Market app itself ----------------
// One deploy, one URL: the app lives in public/ and the API under /api/*.
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => {
  console.log(
    `Loop Market server on :${PORT} | fee ${PLATFORM_FEE_PERCENT}% + $${(HANDLING_FEE_CENTS / 100).toFixed(2)} handling | ` +
      `promo $${(PROMOTED_LISTING_PRICE_CENTS / 100).toFixed(2)}/${PROMOTED_LISTING_DAYS}d | ` +
      `premium $${(PREMIUM_MONTHLY_CENTS / 100).toFixed(2)}/mo`
  );
});
