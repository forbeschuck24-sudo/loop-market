# Legal Checklist — Loop Market

> **Disclaimer: this is not legal advice.** This checklist is general information
> only. Before launching, consult a licensed attorney and a CPA/tax professional
> in your state. Laws vary by jurisdiction and change over time.

## Before you take real payments

- [ ] **Form a business entity.** Most marketplace founders form an LLC (or
      equivalent) to separate personal and business liability. File in your
      state, get an EIN from the IRS, and open a business bank account.
- [ ] **Complete Stripe business verification / KYC.** Stripe will ask for
      business details, tax ID, beneficial owners, and a bank account before
      payouts are enabled. Sellers onboarded through Stripe Connect Express
      complete their own identity verification.
- [ ] **Decide your tax setup.**
  - US marketplaces may need to handle **1099-K** reporting thresholds for
    sellers (thresholds have changed in recent years — confirm the current
    federal and state thresholds with your CPA).
  - For **digital goods**, consider enabling **Stripe Tax** so sales tax / VAT
    is calculated and collected automatically at checkout.
  - Talk to your CPA about income tax on your platform fees and whether you
    need to collect/remit sales tax where you have nexus.
- [ ] **Publish your policies in the app** (the Loop Market app ships with
      starter screens — have an attorney review them before launch):
  - Terms of Service
  - Privacy Policy
  - Seller Agreement (10% platform fee, payout timing via Stripe Connect,
    refunds, prohibited items)
- [ ] **Refund & dispute policy.** Decide: who funds refunds (seller, platform,
      or split)? How are chargebacks handled? Stripe Connect destination
      charges have specific refund behavior — understand it before your first
      dispute.
- [ ] **Prohibited items list.** Define what cannot be sold (e.g. pirated
      content, malware, weapons, adult content, anything illegal). Enforce it.
- [ ] **Privacy compliance basics.** You handle buyer emails and seller payout
      details. Minimize data collection, secure your `.env` secrets, use HTTPS
      everywhere, and understand obligations under laws that may apply to you
      (e.g. state privacy laws, GDPR if you serve EU buyers).
- [ ] **Seller Agreement acceptance.** Make sellers accept the Seller Agreement
      (with the 10% fee clearly disclosed) before they can list or receive
      payouts.
- [ ] **Business insurance.** Consider general liability / E&O coverage once
      real money flows.

## Ongoing

- [ ] Reconcile payouts and fees monthly; keep clean books from day one.
- [ ] Monitor disputes and fraud signals in the Stripe dashboard.
- [ ] Review policies annually or whenever you change fees, categories, or regions.
