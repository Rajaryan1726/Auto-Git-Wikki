/**
 * LOCAL DEVELOPMENT ONLY. Sends a Razorpay-style webhook, signed with
 * RAZORPAY_WEBHOOK_SECRET, to the local API — to see pending / halted / charged / cancelled
 * states without waiting for a real renewal. Refuses NODE_ENV=production.
 *
 *   npm run billing:simulate -- <sub_id> <event> [--status <s>] [--new-period] [--event-id <id>]
 *
 * <event>: subscription.activated | subscription.charged | subscription.pending |
 *          subscription.halted | subscription.cancelled | subscription.completed | payment.failed
 * The subscription must exist locally (created through the app). --new-period starts a new
 * 30-day period now (quota reset); --event-id repeats an id to test duplicate delivery.
 */
import { createHmac, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db, pool } from '../db/client.js';
import { subscriptions } from '../db/schema.js';
import { env } from '../lib/env.js';

const DEFAULT_STATUS: Record<string, string> = {
  'subscription.authenticated': 'authenticated',
  'subscription.activated': 'active',
  'subscription.charged': 'active',
  'subscription.pending': 'pending',
  'subscription.halted': 'halted',
  'subscription.cancelled': 'cancelled',
  'subscription.completed': 'completed',
};

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  if (env.NODE_ENV === 'production') {
    console.error('billing:simulate is a local development tool and refuses NODE_ENV=production.');
    process.exitCode = 1;
    return;
  }
  if (!env.RAZORPAY_WEBHOOK_SECRET) {
    console.error('Set RAZORPAY_WEBHOOK_SECRET in .env first.');
    process.exitCode = 1;
    return;
  }
  const [subId, event] = process.argv.slice(2);
  if (!subId || !event) {
    console.error(
      'Usage: npm run billing:simulate -- <sub_id> <event> [--status s] [--new-period]',
    );
    process.exitCode = 1;
    return;
  }
  const [sub] = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.razorpaySubscriptionId, subId));
  if (!sub) throw new Error(`No local subscription ${subId}`);

  const now = Math.floor(Date.now() / 1000);
  const unix = (d: Date | null) => (d ? Math.floor(d.getTime() / 1000) : null);
  const newPeriod = process.argv.includes('--new-period');
  const subscription = {
    id: sub.razorpaySubscriptionId,
    entity: 'subscription',
    plan_id: sub.razorpayPlanId,
    status: flag('--status') ?? DEFAULT_STATUS[event] ?? sub.status,
    customer_id: sub.razorpayCustomerId,
    current_start: newPeriod ? now : unix(sub.currentPeriodStart),
    current_end: newPeriod ? now + 30 * 86_400 : unix(sub.currentPeriodEnd),
    notes: { user_id: sub.userId, plan: sub.plan },
  };
  const payment = {
    id: `pay_sim_${randomUUID().slice(0, 8)}`,
    entity: 'payment',
    amount: 0,
    currency: 'INR',
    status: event === 'payment.failed' ? 'failed' : 'captured',
    method: 'card',
    created_at: now,
    subscription_id: sub.razorpaySubscriptionId,
  };
  const withPayment = event === 'payment.failed' || event === 'subscription.charged';
  const body = {
    entity: 'event',
    account_id: 'acc_simulated',
    event,
    contains:
      event === 'payment.failed'
        ? ['payment']
        : ['subscription', ...(withPayment ? ['payment'] : [])],
    created_at: now,
    payload: {
      ...(event === 'payment.failed' ? {} : { subscription: { entity: subscription } }),
      ...(withPayment ? { payment: { entity: payment } } : {}),
    },
  };
  const raw = JSON.stringify(body);
  const eventId = flag('--event-id') ?? `evt_sim_${randomUUID().slice(0, 12).replace(/-/g, '')}`;
  const res = await fetch(`${env.SERVER_URL}/api/billing/webhook`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Razorpay-Signature': createHmac('sha256', env.RAZORPAY_WEBHOOK_SECRET)
        .update(raw)
        .digest('hex'),
      'X-Razorpay-Event-Id': eventId,
    },
    body: raw,
  });
  console.log(`${event} (${eventId}) → ${res.status} ${await res.text()}`);
}

main()
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
