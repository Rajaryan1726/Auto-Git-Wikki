# Phase 8 Report

## Summary

AutoWiki now sells three monthly plans (Starter ₹159, Pro ₹459, Max ₹919) through Razorpay Subscriptions:

- **Server:** pricing defined in one place; checkout and webhook signature checks; webhooks as the source of truth (idempotent, safe out of order); per-period quotas for repo slots, re-indexes and chat; cancel at period end; upgrade and downgrade.
- **Web:** pricing page, Settings → Billing, banners and a plan badge.
- **Policy drafts:** terms, privacy, refunds and contact.
- **Scripts:** plan sync and cost report.

The whole subscription lifecycle was verified live, with Razorpay-signed webhooks sent to the real API endpoint. **The real Razorpay test-mode payment has NOT been run yet: the `RAZORPAY_*` keys are not in `.env`** (the root `.env`, last modified 4 Oct, has no Razorpay lines). The steps are below.

## Files created / changed

**Shared**

- `packages/shared/src/billing.ts` (new) — `PLANS` (prices in paise, slots, quotas), `PLAN_ORDER`, `formatPaise`, subscription status / banner / billing error codes, and zod schemas for `GET /api/billing`, subscribe and verify.

**Server**

- `src/db/schema.ts` + `drizzle/0009_billing.sql` — `billing_plans`, `subscriptions`, `billing_events`, `payments`, `quota_events`.
- `src/services/billing-core.ts` (new, pure) — checkout and webhook signature verification (constant-time); the subscription state machine `applySubscriptionEvent`; `resolveEntitlement` (plans, complimentary users, pending / halted / cancelled, upgrade, scheduled downgrade); `evaluateGate` (quotas, slots, over the limit after a downgrade); `changeKind`, `keyMode`.
- `src/services/billing.ts` (new):
  - entitlement, quotas, `assertPlanAllows`, `recordQuota`, `getBillingState`;
  - `subscribe` (new / upgrade / downgrade), `verifyCheckout`, `cancelAtPeriodEnd`, `cancelAllForAccountDeletion`;
  - `handleWebhook` / `applyWebhook` (one transaction, idempotent);
  - `retireReplacedSubscription`, `syncPlans`.
- `src/services/razorpay.ts` (new) — REST client (Basic auth, 15 s timeout): plans, subscriptions, cancel. Never logs keys or bodies.
- `src/routes/billing.ts` (new) — `GET /api/billing`, `POST /api/billing/subscribe`, `/verify`, `/cancel` (rate-limited 10/min), and `POST /api/billing/webhook` (raw body).
- `src/inngest/functions/billing.ts` (new) — `billing-retire-replaced-subscription` cancels the subscription a plan change replaced (6 retries).
- `src/app.ts` — mounts the webhook before `express.json`, plus the billing router. `src/inngest/index.ts` registers the new function.
- `src/routes/index-jobs.ts`, `routes/wiki.ts`, `routes/chat.ts` — the plan gate runs before the Phase 6 limits, and a quota event is recorded only when work is actually created.
- `src/services/usage.ts` — `indexedRepoIds` exported (slots).
- `src/services/data-deletion.ts` — account deletion cancels live Razorpay subscriptions first, and counts subscriptions, payments and quota events.
- `src/lib/env.ts` — `RAZORPAY_*`, `COMP_GITHUB_LOGINS`, `BILLING_TOTAL_COUNT`.
- `src/scripts/billing-sync-plans.ts`, `billing-cost-report.ts`, `billing-simulate-webhook.ts` (new).
- Tests (new):
  - `billing-core.test.ts` (34)
  - `billing.integration.test.ts` (5, Postgres)

**Web**

- `pages/pricing-page.tsx` (new) — three plan cards, current plan marked, Subscribe / Upgrade now / Downgrade at period end, the re-index explanation line, change-plan rules, policy links. Public when signed out.
- `pages/policy-pages.tsx` (new) — `/terms`, `/privacy`, `/refund-policy`, `/contact`. These are drafts with a "Draft — to be reviewed" notice and `[placeholders]`.
- `features/billing/`:
  - `api.ts` — queries; polls every 3 s while confirming;
  - `checkout.ts` — loads Razorpay Checkout on demand;
  - `use-checkout.ts` — subscribe → Checkout → verify;
  - `billing-settings.tsx` — plan, status, renewal or end date, meters, Change plan, Cancel with a styled dialog, payment history;
  - `billing-banner.tsx` — pending, halted, ended, confirming, no plan;
  - `plan-badge.tsx` — sidebar badge.
- `components/`:
  - `public-layout.tsx` — app layout when signed in, visitor layout otherwise;
  - `site-footer.tsx` — policy links;
  - `meter.tsx` — moved out of Settings;
  - `error-with-upgrade.tsx` — error text plus a "See plans" link.
- `lib/billing-errors.ts`.
- Updated:
  - `app/router.tsx` — public routes;
  - `components/app-layout.tsx` — banner, footer, and a one-time redirect to /pricing for users without a plan;
  - `components/sidebar.tsx` — badge;
  - `pages/settings-page.tsx` — Billing section, `#hash` scrolling, "Daily safety limits" wording;
  - `pages/repo-page.tsx`, `features/wiki/wiki-panel.tsx`, `pages/chat-page.tsx`, `features/chat/message-view.tsx` — quota errors link to /pricing.

**Docs / config**

- `docs/BILLING.md` (new): flow, the Razorpay limitation, setup, tunnel, webhook, test cards / UPI, simulator, going live, pricing review.
- `CLAUDE.md`: billing tables and a "Billing (Phase 8)" section.
- `README.md`: plan note in "Run it", new scripts and env vars.
- `.env.example` and `package.json` scripts.

## How to run / test

```bash
npm install && npm run db:migrate                 # applies 0009_billing
npm test && npm run typecheck && npm run lint && npm run build
# after adding RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET / RAZORPAY_WEBHOOK_SECRET to .env:
npm run billing:sync-plans                        # run twice: the second run prints "(kept)"
cloudflared tunnel --url http://localhost:4000    # then add the webhook (steps below)
npm run dev                                       # + npm run inngest:dev
npm run billing:simulate -- <sub_id> subscription.pending   # dev only: pending / halted / renewal
npm run billing:cost-report
```

## Acceptance criteria

- **Test mode end to end (Starter test payment → webhook via tunnel activates it → quotas apply → meters update)** — **NOT TESTED with Razorpay** (no keys in `.env`; the tunnel and dashboard webhook are steps for you).
  - Everything after the payment was verified live against the running API, with webhooks signed exactly as Razorpay signs them, sent to `POST /api/billing/webhook`:
    - a subscription in "created + checkout verified" showed **Confirming payment**;
    - `subscription.activated` made Starter active, and Settings showed "₹159 / month · renews Nov 4, 2026" plus the payment;
    - one real chat question moved the chat meter 0 → 1/300.
  - The Checkout signature formula is unit-tested.
- **Hitting each quota shows a clear message with an upgrade link** — **PASS** (live, 402):

  | Quota                                 | Message                                                                                                                                                                                                                                        |
  | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | Chat (300/300)                        | "You have used all 300 chat messages of your Starter plan this billing period. It resets on 4 Nov. Upgrade to Pro for 1,000 a month." + **See plans**, shown in the chat UI                                                                    |
  | Re-indexes (10/10)                    | "You have used all 10 re-indexes of your Starter plan this billing period. It resets on 4 Nov. Upgrade to Pro for 25 a month."                                                                                                                 |
  | Repo slots (4 indexed, Starter has 1) | "Your Starter plan has 1 repository slot but 4 repositories are indexed. Delete repo data until 1 is left to index again, or upgrade to Pro for 5 slots. Your wikis and chat history stay readable." Shown on the repo page with **See plans** |
  | No plan                               | "Choose a plan to index repositories, regenerate wikis and chat." + See plans, a banner, and the first visit redirects to /pricing                                                                                                             |

  A new `subscription.charged` period reset the counters live (chat 300 → 0, re-indexes 10 → 0).

- **Duplicate webhook delivery changes nothing** — **PASS**:
  - Live: the same `x-razorpay-event-id` sent twice returned `{"duplicate":false}`, then `{"duplicate":true}`; there was one `billing_events` row and an identical subscription row.
  - The integration test asserts the row is deep-equal and the payment is not duplicated.
  - A forged signature → 400 `INVALID_SIGNATURE`.
- **A failed test payment leads to the pending banner; halted blocks new work but keeps data readable** — **PASS (simulated webhooks)**.
  - `payment.failed` + `subscription.pending` → the banner "Your renewal payment failed. Razorpay is retrying it automatically; everything keeps working meanwhile…", the badge "Starter · payment retrying", and work still allowed (a wiki regeneration started, 202).
  - `subscription.halted` → ask and index 402 `SUBSCRIPTION_INACTIVE` ("…on hold… Your wikis and chat history stay readable."); `GET` wiki and messages 200; Settings shows "On hold", a Resubscribe button, and the failed payment in the history.
  - A late `pending` after `halted` did not undo halted.
  - A real failing test card has not been tried (needs the keys).
- **Cancel keeps access until period end. Upgrade applies immediately** — **PASS for the state handling, NOT TESTED against Razorpay**:
  - Cancel: after `subscription.cancelled` with the period ending 4 Nov, Settings shows "Cancelled — active until period end · ends Nov 4", and chat still answered (200). The Cancel button itself calls Razorpay (`cancel_at_cycle_end: true`), which needs the keys.
  - Upgrade: a Max subscription replacing Starter, once activated, immediately gave Max (slots 4/10, 0/50, 0/2,000). The Inngest event `billing/subscription.replaced` fired to cancel the Starter subscription (that call to Razorpay needs the keys).
- **A user without a plan cannot index or chat; a COMP user can** — **PASS**:
  - Without a plan: index → 402 `PLAN_REQUIRED`.
  - With `COMP_GITHUB_LOGINS=Rajaryan1726`: Max · Complimentary (badge + Settings), chat answered (200) and the meter showed 1/2,000.
- **Secrets never appear in logs** — **PASS**:
  - After the whole simulation, the API and Inngest logs contained 0 occurrences of the webhook secret, of `x-razorpay-signature`, and of `Basic ` auth headers.
  - The logger never logs headers or bodies; billing logs carry ids, statuses and event types only.
  - Re-check after the real run: `grep -c "<your key secret>" "$TEMP/autowiki-dev.log"`.
- **Typecheck, lint and tests pass** — **PASS**: 0 type errors, 0 lint problems, **200/200 tests** (+39), build OK.
- **Commit at checkpoints** — `3ade746` (server), `7444373` (web + docs), then this report.

## Razorpay docs used (checked 5 Oct 2026)

- Integration guide (Checkout `subscription_id`, handler fields, signature `hmac_sha256(razorpay_payment_id + "|" + subscription_id, secret)`): https://razorpay.com/docs/payments/subscriptions/integration-guide/
- Create subscription: https://razorpay.com/docs/api/payments/subscriptions/create-subscription/
- Create plan: https://razorpay.com/docs/api/payments/subscriptions/create-plan/
- Update: https://razorpay.com/docs/api/payments/subscriptions/update-subscription/ and https://razorpay.com/docs/payments/subscriptions/update/
- Cancel: https://razorpay.com/docs/api/payments/subscriptions/cancel-subscription/
- States: https://razorpay.com/docs/payments/subscriptions/states/
- Webhooks: https://razorpay.com/docs/webhooks/setup-edit-payments/, https://razorpay.com/docs/webhooks/validate-test/, https://razorpay.com/docs/webhooks/subscriptions/
- Test data: https://razorpay.com/docs/payments/payments/test-card-details/, https://razorpay.com/docs/payments/payments/test-upi-details/

## Steps you must do by hand

1. **Keys:** Razorpay Dashboard → switch on **Test mode** → Account & Settings → API Keys → Generate key. Add `RAZORPAY_KEY_ID=rzp_test_…` and `RAZORPAY_KEY_SECRET=…` to the repo-root `.env`. Make sure Subscriptions is enabled for the account.
2. **Free plan for yourself (optional):** add `COMP_GITHUB_LOGINS=Rajaryan1726`. Leave it out while you test paying with your own account, since a complimentary user can't subscribe.
3. **Plans:** run `npm run billing:sync-plans`, then run it again; the second run should say `(kept)` for all three.
4. **Tunnel:** install cloudflared, then run `cloudflared tunnel --url http://localhost:4000`. Copy the `https://….trycloudflare.com` URL. Or use `ngrok http 4000`.
5. **Webhook:** Dashboard (Test mode) → Account & Settings → Webhooks → Add New Webhook.
   - URL: `https://<tunnel>/api/billing/webhook`
   - Secret: a long random string, for example `openssl rand -hex 32`. Put the same value in `.env` as `RAZORPAY_WEBHOOK_SECRET`.
   - Events: `subscription.authenticated`, `activated`, `charged`, `pending`, `halted`, `cancelled`, `completed`, `updated`, and `payment.failed`.
   - The test-mode OTP is `754081`.
6. **Restart** `npm run dev` (I'm currently running it with a `COMP_GITHUB_LOGINS=Rajaryan1726` override) and keep `npm run inngest:dev` running.
7. **Subscribe:** open `/pricing` and choose Subscribe on Starter. Pay with card **4718 6091 0820 4366** (any future expiry and CVV, OTP 4–10 digits) or UPI `success@razorpay`. Within seconds, Settings → Billing should show Starter active.
8. **Then:** try Cancel plan, Upgrade, and a declined card (4100 2800 0006 0003 or `failure@razorpay`). For renewals and pending/halted states, use `npm run billing:simulate -- <sub_id> subscription.pending` (or `halted`, or `charged --new-period`).
9. **Policies:** before live mode, fill in every `[placeholder]` in the policy pages (name, email, phone, address, city, numbers in brackets) and review the text. They are drafts, not legal advice.
10. **Going live:** generate live keys, run `billing:sync-plans` with them (plans are stored per mode), add a Live-mode webhook with a new secret, and set the production env (see `docs/BILLING.md`).

## Decisions & deviations

- **Razorpay limitation that changed the design:** the update-subscription API "cannot be updated when payment mode is UPI" or e-mandate, and for domestic cards "you can update only the offer". That covers almost every Indian customer. So **a plan change creates a new subscription**:
  - **Upgrade:** applies immediately. The user pays the new plan's full price now and gets a new period. The old subscription is cancelled at once when the new one activates, and its unused days are not refunded. This is stated on the pricing page and in the refund policy.
  - **Downgrade:** the new subscription has `start_at` = the current period end. The mandate is authenticated now, the old subscription is cancelled at cycle end, and Settings shows "Switches to … on …".
  - Proration with `PATCH` (`schedule_change_at`) works only for some international cards, so I didn't build two paths.
- **Checkout verify only marks "Confirming payment"**; access starts with the webhook (the UI polls every 3 s), as required.
- **Webhook ordering:** Razorpay says the order "may not be followed", so the status moves only for events newer than the last applied (`last_event_at`), terminal states never move back, and periods only move forward.
- **Webhook processing is synchronous but small:** one transaction, a few ms, well within Razorpay's 5 s. The only slow call (cancelling a replaced subscription at Razorpay) runs in Inngest with retries.
- **Quotas use a separate ledger** (`quota_events`), so deleting repo data or chats never refunds quota. Re-index and chat count only when work is created: not when the request returns a job that's already running, and not for a chat retry of the same unanswered question.
- **Billing errors are 402** (`PLAN_REQUIRED`, `SUBSCRIPTION_INACTIVE`, `QUOTA_REACHED`, `REPO_SLOTS_FULL`), separate from the Phase 6 429s, so the UI can link them to /pricing. The plan check runs before the safety limits.
- **Repo slots after a downgrade:** while over the limit, every index request (including re-indexing an existing repo) is blocked; wiki regeneration and chat still work. That's how I read "block new indexing until they delete repo data down to the limit".
- **No plan:** a banner everywhere, plus a once-per-browser-session redirect from `/` to `/pricing`.
- **Complimentary users** count quotas per calendar month (UTC), since they have no billing period.
- **Account deletion** cancels live Razorpay subscriptions immediately and refuses (502) if Razorpay can't cancel. `billing_events` (Razorpay ids and amounts, no user id) are kept for accounting; the privacy draft says so.
- **`total_count` = 60 months** (`BILLING_TOTAL_COUNT`), because Razorpay needs a finite count.
- **Policy pages are public**, both signed in and out; pricing is public too, as Razorpay KYC needs.
- **`billing:simulate`** (dev only, refuses production) was added because renewals, pending and halted can't be triggered on demand in test mode. The live checks above used an equivalent scratch script; the committed script itself has not been run yet (it needs `RAZORPAY_WEBHOOK_SECRET`).
- **Cost report:** model prices are not hard-coded. `LLM_PRICES_USD_PER_MTOK` defaults to a placeholder `*` price, and the report lists models without an explicit price. Embedding cost is estimated as new chunks × tokens per chunk.

## Known issues / TODO

- **The real Razorpay test-mode run is pending your keys** (steps 1–8 above). This covers sync-plans against the API, Checkout, verify, the real webhooks, Cancel, Upgrade/Downgrade calls and a declined card.
- **`payment.failed` without a subscription link:** these webhooks are mapped through `payment.subscription_id` when present. If Razorpay omits it, the event is still recorded in `billing_events` but not shown in the history. The pending banner still comes from `subscription.pending`.
- **Unconfirmed `cancel_at_cycle_end` edge cases:** Razorpay refuses it in the final billing cycle and while another operation is in progress. The user sees the Razorpay message (502 `PAYMENT_PROVIDER_ERROR`).
- **Abandoned checkouts** leave `created` subscription rows. They are harmless but not cleaned up.
- **In-flight replacement job:** from the simulated upgrade, an Inngest run is retrying the cancellation of `sub_SIMstarter01`. That subscription doesn't exist at Razorpay, so the run will end failed. The simulated rows were deleted from your account.
- **Upgrade refunds:** the unused part of the old plan isn't refunded; a prorated credit would need the update API, which doesn't work for UPI.
- **The cost report has no data yet:** there are no paid periods. Comp-user months appear once `COMP_GITHUB_LOGINS` is set in `.env`.

## Env vars added

`RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`, `COMP_GITHUB_LOGINS` (empty), `BILLING_TOTAL_COUNT` (60). Cost report only: `BILLING_USD_INR` (88), `LLM_PRICES_USD_PER_MTOK` (`{"*":{"input":0.5,"output":2}}`), `EMBED_PRICE_USD_PER_MTOK` (0.02), `EMBED_TOKENS_PER_CHUNK` (350), `RAZORPAY_FEE_PERCENT` (2).
