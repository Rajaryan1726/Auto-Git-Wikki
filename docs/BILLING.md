# Billing (Razorpay Subscriptions)

AutoWiki sells three monthly plans through **Razorpay Subscriptions**. Plans and quotas live in
[`packages/shared/src/billing.ts`](../packages/shared/src/billing.ts); the server decides every
amount and Razorpay plan id, and the browser only sends a plan key (`starter`, `pro`, `max`).

| Plan    | Price / month | Repo slots | Monthly re-indexes | Chat messages / month |
| ------- | ------------- | ---------- | ------------------ | --------------------- |
| Starter | ₹159          | 1          | 10                 | 300                   |
| Pro     | ₹459          | 5          | 25                 | 1,000                 |
| Max     | ₹919          | 10         | 50                 | 2,000                 |

Razorpay docs used (checked **5 Oct 2026**):

- Subscriptions integration guide: https://razorpay.com/docs/payments/subscriptions/integration-guide/
- Create plan / subscription, update, cancel: https://razorpay.com/docs/api/payments/subscriptions/
- Subscription states: https://razorpay.com/docs/payments/subscriptions/states/
- Updating subscriptions (limits): https://razorpay.com/docs/payments/subscriptions/update/
- Webhooks: setup https://razorpay.com/docs/webhooks/setup-edit-payments/ · validation
  https://razorpay.com/docs/webhooks/validate-test/ · subscription events
  https://razorpay.com/docs/webhooks/subscriptions/
- Test cards / UPI: https://razorpay.com/docs/payments/payments/test-card-details/ ·
  https://razorpay.com/docs/payments/payments/test-upi-details/

## How it works

1. **Pricing → Subscribe**: `POST /api/billing/subscribe { plan }` creates a Razorpay subscription
   (plan id from `billing_plans`, `total_count` = `BILLING_TOTAL_COUNT` months, notes
   `{ user_id, plan, change, replaces? }`) and returns `subscription_id` + `key_id`.
2. **Checkout** opens with `subscription_id`. On success the handler's
   `razorpay_payment_id`, `razorpay_subscription_id` and `razorpay_signature` go to
   `POST /api/billing/verify`, which checks
   `HMAC_SHA256(razorpay_payment_id + "|" + subscription_id, RAZORPAY_KEY_SECRET)` for a
   subscription this user created. The plan shows "Confirming payment" until the webhook arrives.
3. **Webhooks are the source of truth**: `POST /api/billing/webhook`, mounted with a raw body
   parser before the JSON parser. `X-Razorpay-Signature` is checked as hex HMAC-SHA256 of the raw
   body with `RAZORPAY_WEBHOOK_SECRET`. The `x-razorpay-event-id` header is stored in
   `billing_events.event_id` (unique), so a re-delivery is acknowledged and ignored. The event row
   and the state change commit in one transaction (a failure → 500 → Razorpay retries).
   Out-of-order deliveries are handled: the status only moves forward in time, terminal statuses
   (cancelled / completed / expired) never move back, and billing periods only advance.
4. **Status rules**
   - `active` → full access. `pending` (renewal retrying) → access + "payment failed, Razorpay is
     retrying" banner.
   - `halted`, `cancelled` after the period end, `completed`, `expired` → no new indexing,
     regeneration or chat; wikis and chat history stay readable; banner to resubscribe.
   - `cancelled` before the period end → access until `current_end`.
5. **Quotas** are counted in `quota_events` (one row per Index / Re-index / Regenerate wiki, one
   per asked question) since `current_period_start`. A `subscription.charged` with a new period
   moves the window, which resets the quotas. Deleting repo data never refunds quota. Complimentary
   users count per calendar month (UTC).
6. **Cancel** (`POST /api/billing/cancel`) calls Razorpay cancel with `cancel_at_cycle_end: true`;
   access continues until the period ends.
7. **Change plan** creates a new subscription (see the limitation below):
   - **Upgrade**: starts now. When its `subscription.activated` arrives, the Inngest function
     `billing-retire-replaced-subscription` cancels the old subscription immediately.
   - **Downgrade**: the new subscription gets `start_at` = the current period end; Checkout
     authenticates the mandate now. On `subscription.authenticated` the old one is cancelled at
     cycle end. Settings shows "Switches to … on …".
   - With more indexed repos than the new plan's slots, the repos stay readable but new indexing
     answers `REPO_SLOTS_FULL` until repo data is deleted down to the limit.

**Razorpay limitation that shaped this:** the update-subscription API cannot change the plan of
subscriptions paid with **UPI, e-mandate or domestic cards** ("For Subscriptions created using
domestic cards, you can update only the offer"), which is almost every Indian customer. So plan
changes are a new subscription plus cancelling the old one, which works for every payment method.
Consequence: an upgrade charges the full new price and starts a new period; the unused days of
the old plan are not refunded (stated on the pricing page and in the refund policy).

Other layers stay in place: the daily LLM token budget, the global `LIMIT_*` safety limits and
the rate limits (Phase 6). Plan checks run first and return **402** with codes `PLAN_REQUIRED`,
`SUBSCRIPTION_INACTIVE`, `QUOTA_REACHED`, `REPO_SLOTS_FULL`; the web app shows them with a
"See plans" link.

`COMP_GITHUB_LOGINS` (comma-separated GitHub logins) get the Max plan for free, shown as
"Complimentary".

## One-time setup (test mode)

1. **API keys**: Razorpay Dashboard (Test mode toggle on) → Account & Settings → API Keys →
   Generate test key. Put them in the repo-root `.env`:
   ```
   RAZORPAY_KEY_ID=rzp_test_...
   RAZORPAY_KEY_SECRET=...
   ```
2. **Subscriptions** must be enabled on the account (Dashboard → Subscriptions; in test mode it
   is normally available at once).
3. **Plans**: `npm run db:migrate`, then
   ```bash
   npm run billing:sync-plans
   ```
   It creates `AutoWiki Starter / Pro / Max` (monthly, INR, notes `autowiki_plan`) if missing and
   stores their ids in `billing_plans`. Re-running never creates duplicates: it reuses the stored
   id, else a Razorpay plan with the same notes and amount. Razorpay plans cannot be edited, so a
   price change in `billing.ts` creates a new plan on the next run; existing subscribers keep
   theirs.
4. **Expose the API** (webhooks need a public HTTPS URL; Razorpay rejects `localhost`). Either:
   - Cloudflare quick tunnel (free, no account): install `cloudflared`
     (https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/), then
     ```bash
     cloudflared tunnel --url http://localhost:4000
     ```
     It prints `https://<random>.trycloudflare.com` (a new URL on every start).
   - or ngrok (free account): `ngrok http 4000` → `https://<id>.ngrok-free.app`.
5. **Webhook**: Dashboard (Test mode) → Account & Settings → Webhooks (under Website and app
   settings) → Add New Webhook:
   - URL: `https://<tunnel-host>/api/billing/webhook`
   - Secret: a long random string (for example `openssl rand -hex 32`); put the same value in
     `.env` as `RAZORPAY_WEBHOOK_SECRET`
   - Alert email: yours
   - Active events: `subscription.authenticated`, `subscription.activated`,
     `subscription.charged`, `subscription.pending`, `subscription.halted`,
     `subscription.cancelled`, `subscription.completed`, `subscription.updated`,
     `payment.failed` (optionally `subscription.paused`, `subscription.resumed`)
   - In test mode the dashboard asks for an OTP: use `754081`.
6. Restart `npm run dev` (and keep `npm run inngest:dev` running: it cancels replaced
   subscriptions on plan changes).

Razorpay expects a 2xx within 5 s; failed deliveries are retried with back-off for 24 h, after
which the webhook is disabled. Our handler records and answers in a few milliseconds. When the
tunnel URL changes, edit the webhook URL in the dashboard.

## Testing payments

- Cards that support recurring payments in test mode: **4718 6091 0820 4366** (Visa, domestic),
  5104 0155 5555 5558 (Mastercard). Any future expiry, any CVV. OTP: any 4–10 digits succeeds; fewer than 4
  digits fails the payment.
- Declined cards: 4100 2800 0006 0003 (Visa), 5305 6200 0003 0003 (Mastercard).
- UPI: `success@razorpay` succeeds, `failure@razorpay` fails.
- Test-mode card tokens are valid for 3 days, so test renewals soon after subscribing.
- Renewals happen on Razorpay's schedule (a month later), so to see **pending / halted /
  renewal** quickly, replay signed webhooks locally for a subscription you created through the
  app (dev only, refuses `NODE_ENV=production`):
  ```bash
  npm run billing:simulate -- sub_XXXX subscription.pending
  npm run billing:simulate -- sub_XXXX payment.failed
  npm run billing:simulate -- sub_XXXX subscription.halted
  npm run billing:simulate -- sub_XXXX subscription.charged --new-period
  npm run billing:simulate -- sub_XXXX subscription.charged --event-id evt_dup1   # run twice: 2nd is a duplicate
  ```
  Simulated events change only your local database, not Razorpay; the real subscription stays
  as Razorpay has it.
- To test **cancel**: Settings → Billing → Cancel plan. Razorpay keeps the subscription `active`
  until the cycle ends, then sends `subscription.cancelled`.

What to check after a test subscription:

```bash
npm run billing:cost-report
```

and Settings → Billing (plan, renewal date, meters, payment history).

## Going live

1. Complete KYC / activation in the Razorpay Dashboard. Fill in and review the policy pages
   (`/terms`, `/privacy`, `/refund-policy`, `/contact`; all are drafts with `[placeholders]`) and
   publish the site so Razorpay can see them.
2. Switch the Dashboard to **Live mode** → Account & Settings → API Keys → generate live keys;
   set `RAZORPAY_KEY_ID=rzp_live_...` and `RAZORPAY_KEY_SECRET` in the production environment.
3. Run `npm run billing:sync-plans` against production with the live keys. Plans are stored per
   mode (`billing_plans.mode` = `live`), so test plans are never used for live payments.
4. Add the webhook again in **Live mode** (webhooks are per mode) with the production URL
   `https://<your-domain>/api/billing/webhook`, the same events, and a **new** secret; set it as
   `RAZORPAY_WEBHOOK_SECRET`.
5. Set `COMP_GITHUB_LOGINS` as needed, and run one real ₹159 subscription end to end (then
   cancel and refund it from the Dashboard if you like).

## Pricing review

`npm run billing:cost-report` shows, per plan, the average and maximum actual cost per user per
billing period (LLM tokens from `llm_usage` × model prices + an embedding estimate) next to the
price and the Razorpay fee. Configure `BILLING_USD_INR`, `LLM_PRICES_USD_PER_MTOK`,
`EMBED_PRICE_USD_PER_MTOK`, `EMBED_TOKENS_PER_CHUNK` and `RAZORPAY_FEE_PERCENT` in `.env` (check
current model prices first).
