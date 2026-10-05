/**
 * Billing against Postgres (no Razorpay calls): webhook idempotency, out-of-order
 * deliveries, payments history, quota counting and the reset at a new billing period.
 * Needs `npm run infra:up` + `npm run db:migrate`; skipped when the database is down.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { db, pingDatabase, pool } from '../db/client.js';
import { billingEvents, payments, quotaEvents, subscriptions, users } from '../db/schema.js';
import { HttpError } from '../lib/http-error.js';
import {
  assertPlanAllows,
  getBillingState,
  handleWebhook,
  quotaUsed,
  recordQuota,
} from './billing.js';

const SECRET = 'whsec_integration_test';
const GITHUB_ID = -828282;
const dbAvailable = await pingDatabase().then(
  () => true,
  () => false,
);

const subId = `sub_test_${randomUUID().slice(0, 8)}`;
const eventIds: string[] = [];
const unix = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);

function deliver(eventId: string, body: object, secret = SECRET) {
  eventIds.push(eventId);
  const rawBody = Buffer.from(JSON.stringify(body));
  const signature = createHmac('sha256', secret).update(rawBody).digest('hex');
  return handleWebhook({ rawBody, signature, eventId }, SECRET);
}

function subscriptionEvent(
  event: string,
  at: string,
  status: string,
  period?: [string, string],
  payment?: { id: string; status: string },
) {
  return {
    entity: 'event',
    event,
    created_at: unix(at),
    contains: payment ? ['subscription', 'payment'] : ['subscription'],
    payload: {
      subscription: {
        entity: {
          id: subId,
          plan_id: 'plan_not_synced',
          status,
          customer_id: 'cust_test',
          current_start: period ? unix(period[0]) : null,
          current_end: period ? unix(period[1]) : null,
          notes: { plan: 'starter' },
        },
      },
      ...(payment
        ? {
            payment: {
              entity: {
                id: payment.id,
                amount: 15900,
                currency: 'INR',
                status: payment.status,
                method: 'card',
                created_at: unix(at),
              },
            },
          }
        : {}),
    },
  };
}

describe(
  'billing webhooks and quotas (Postgres)',
  { skip: !dbAvailable && 'Postgres unavailable' },
  () => {
    let user: { id: string; username: string };

    before(async () => {
      await db.delete(users).where(eq(users.githubId, GITHUB_ID));
      const [row] = await db
        .insert(users)
        .values({ githubId: GITHUB_ID, username: 'billing-test-user' })
        .returning({ id: users.id, username: users.username });
      user = row!;
      await db.insert(subscriptions).values({
        userId: user.id,
        plan: 'starter',
        razorpaySubscriptionId: subId,
        razorpayPlanId: 'plan_not_synced',
      });
    });

    after(async () => {
      await db.delete(users).where(eq(users.id, user.id)); // cascades subscriptions/payments/quota
      if (eventIds.length)
        await db.delete(billingEvents).where(inArray(billingEvents.eventId, eventIds));
      await pool.end();
    });

    test('no access before activation; a forged webhook is rejected', async () => {
      await assert.rejects(
        assertPlanAllows(user, 'chat'),
        (e: HttpError) => e.code === 'PLAN_REQUIRED',
      );
      await assert.rejects(
        deliver(
          'evt_forged',
          subscriptionEvent('subscription.activated', '2026-10-01T10:00:00Z', 'active'),
          'wrong',
        ),
        (e: HttpError) => e.status === 400 && e.code === 'INVALID_SIGNATURE',
      );
    });

    test('activation grants access; a duplicate delivery changes nothing', async () => {
      const body = subscriptionEvent(
        'subscription.activated',
        '2026-10-01T10:00:00Z',
        'active',
        ['2026-10-01T10:00:00Z', '2099-11-01T10:00:00Z'],
        { id: 'pay_test_1', status: 'captured' },
      );
      assert.equal((await deliver('evt_act_1', body)).outcome, 'recorded');
      const [first] = await db
        .select()
        .from(subscriptions)
        .where(eq(subscriptions.razorpaySubscriptionId, subId));
      assert.equal(first!.status, 'active');
      await assertPlanAllows(user, 'chat');

      assert.equal((await deliver('evt_act_1', body)).outcome, 'duplicate');
      const [second] = await db
        .select()
        .from(subscriptions)
        .where(eq(subscriptions.razorpaySubscriptionId, subId));
      assert.deepEqual(second, first);
      const events = await db
        .select()
        .from(billingEvents)
        .where(eq(billingEvents.eventId, 'evt_act_1'));
      assert.equal(events.length, 1);
      const pays = await db.select().from(payments).where(eq(payments.userId, user.id));
      assert.equal(pays.length, 1);
      assert.equal(pays[0]!.amountPaise, 15900);
    });

    test('quota counts in the period, then resets when a new period is charged', async () => {
      for (let i = 0; i < 300; i++) await recordQuota(user.id, 'chat');
      await recordQuota(user.id, 'reindex');
      const state = await getBillingState(user);
      assert.deepEqual(state.usage.chatMessages, { used: 300, limit: 300 });
      assert.deepEqual(state.usage.reindexes, { used: 1, limit: 10 });
      await assert.rejects(
        assertPlanAllows(user, 'chat'),
        (e: HttpError) => e.status === 402 && e.code === 'QUOTA_REACHED',
      );

      // Next period starts "now": the earlier usage is outside it.
      const start = new Date(Date.now() + 1000).toISOString();
      await deliver(
        'evt_charged_2',
        subscriptionEvent(
          'subscription.charged',
          new Date().toISOString(),
          'active',
          [start, '2099-12-01T00:00:00Z'],
          {
            id: 'pay_test_2',
            status: 'captured',
          },
        ),
      );
      const [row] = await db
        .select()
        .from(subscriptions)
        .where(eq(subscriptions.razorpaySubscriptionId, subId));
      assert.equal(
        row!.currentPeriodStart!.toISOString(),
        new Date(unix(start) * 1000).toISOString(),
      );
      assert.deepEqual(await quotaUsed(user.id, row!.currentPeriodStart), {
        reindexes: 0,
        chat: 0,
      });
      // Quota events are kept (deleting repo data never refunds quota).
      assert.equal(
        (await db.select().from(quotaEvents).where(eq(quotaEvents.userId, user.id))).length,
        301,
      );
    });

    test('pending keeps access with a banner; halted blocks; a late pending does not undo halted', async () => {
      await deliver(
        'evt_pending',
        subscriptionEvent('subscription.pending', '2099-12-01T01:00:00Z', 'pending'),
      );
      let state = await getBillingState(user);
      assert.equal(state.entitlement.banner, 'payment_pending');
      assert.equal(state.entitlement.canUse, true);

      await deliver(
        'evt_halted',
        subscriptionEvent('subscription.halted', '2099-12-04T01:00:00Z', 'halted'),
      );
      await deliver(
        'evt_pending_late',
        subscriptionEvent('subscription.pending', '2099-12-02T01:00:00Z', 'pending'),
      );
      state = await getBillingState(user);
      assert.equal(state.entitlement.status, 'halted');
      assert.equal(state.entitlement.banner, 'halted');
      await assert.rejects(
        assertPlanAllows(user, 'reindex'),
        (e: HttpError) => e.code === 'SUBSCRIPTION_INACTIVE',
      );
    });

    test('a failed payment is recorded in the history', async () => {
      await deliver('evt_payfail', {
        entity: 'event',
        event: 'payment.failed',
        created_at: unix('2099-12-01T01:00:00Z'),
        contains: ['payment'],
        payload: {
          payment: {
            entity: {
              id: 'pay_test_failed',
              amount: 15900,
              currency: 'INR',
              status: 'failed',
              method: 'card',
              created_at: unix('2099-12-01T01:00:00Z'),
              subscription_id: subId,
            },
          },
        },
      });
      const state = await getBillingState(user);
      assert.ok(state.payments.some((p) => p.id === 'pay_test_failed' && p.status === 'failed'));
    });
  },
);
