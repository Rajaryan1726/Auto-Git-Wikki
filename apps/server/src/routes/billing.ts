import express, { Router } from 'express';
import { subscribeBodySchema, verifyBodySchema, type BillingResponse } from '@autowiki/shared';
import { inngest } from '../inngest/client.js';
import { BILLING_REPLACE_EVENT, type BillingReplaceData } from '../inngest/functions/billing.js';
import { moduleLogger } from '../lib/logger.js';
import { rateLimit } from '../lib/rate-limit.js';
import { currentUser, requireAuth } from '../middleware/require-auth.js';
import {
  cancelAtPeriodEnd,
  getBillingState,
  handleWebhook,
  subscribe,
  verifyCheckout,
} from '../services/billing.js';

const log = moduleLogger('billing');

/** /api/billing — plan state, subscribe, verify checkout, cancel (signed-in users). */
export const billingRouter = Router();
billingRouter.use(requireAuth);

const billingRateLimit = rateLimit({ name: 'billing', limit: 10 });

billingRouter.get('/', async (req, res) => {
  const body: BillingResponse = await getBillingState(currentUser(req));
  res.json(body);
});

billingRouter.post('/subscribe', billingRateLimit, async (req, res) => {
  const { plan } = subscribeBodySchema.parse(req.body);
  res.status(201).json(await subscribe(currentUser(req), plan));
});

billingRouter.post('/verify', billingRateLimit, async (req, res) => {
  const body = verifyBodySchema.parse(req.body);
  res.json(await verifyCheckout(currentUser(req), body));
});

billingRouter.post('/cancel', billingRateLimit, async (req, res) => {
  res.json(await cancelAtPeriodEnd(currentUser(req)));
});

/**
 * POST /api/billing/webhook — Razorpay webhooks. Mounted with a RAW body parser before
 * the JSON parser: the signature is an HMAC of the exact bytes received. Records the event
 * and answers 200 quickly; cancelling a replaced subscription runs in Inngest.
 */
export const billingWebhookRouter = Router();
billingWebhookRouter.post('/', express.raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
  const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  const result = await handleWebhook({
    rawBody,
    signature: req.header('x-razorpay-signature'),
    eventId: req.header('x-razorpay-event-id'),
  });
  if (result.outcome === 'recorded' && result.replace) {
    const data: BillingReplaceData = result.replace;
    await inngest
      .send({ name: BILLING_REPLACE_EVENT, data })
      .catch((err: unknown) =>
        log.error(
          { err: err instanceof Error ? err.message : err, ...result.replace },
          'could not enqueue replaced-subscription cancel',
        ),
      );
  }
  res.status(200).json({ ok: true, duplicate: result.outcome === 'duplicate' });
});
