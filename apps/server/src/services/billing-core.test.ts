import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import {
  applySubscriptionEvent,
  changeKind,
  evaluateGate,
  keyMode,
  resolveEntitlement,
  verifyCheckoutSignature,
  verifyWebhookSignature,
  type Entitlement,
  type SubscriptionEvent,
  type SubscriptionRow,
  type SubscriptionState,
} from './billing-core.js';

const KEY_SECRET = 'test_key_secret_123';
const WEBHOOK_SECRET = 'whsec_test_456';
const hmac = (secret: string, data: string | Buffer) =>
  createHmac('sha256', secret).update(data).digest('hex');

describe('checkout signature', () => {
  const paymentId = 'pay_29QQoUBi66xm2f';
  const subscriptionId = 'sub_00000000000001';
  const signature = hmac(KEY_SECRET, `${paymentId}|${subscriptionId}`);

  test('valid: hmac_sha256(payment_id + "|" + subscription_id, key_secret)', () => {
    assert.equal(
      verifyCheckoutSignature({ paymentId, subscriptionId, signature, keySecret: KEY_SECRET }),
      true,
    );
  });
  test('tampered payment or subscription id fails', () => {
    for (const input of [
      { paymentId: 'pay_other', subscriptionId },
      { paymentId, subscriptionId: 'sub_someone_else' },
    ]) {
      assert.equal(verifyCheckoutSignature({ ...input, signature, keySecret: KEY_SECRET }), false);
    }
    const flipped = (signature[0] === 'a' ? 'b' : 'a') + signature.slice(1);
    assert.equal(
      verifyCheckoutSignature({
        paymentId,
        subscriptionId,
        signature: flipped,
        keySecret: KEY_SECRET,
      }),
      false,
    );
  });
  test('wrong secret, empty secret and malformed signatures fail', () => {
    assert.equal(
      verifyCheckoutSignature({ paymentId, subscriptionId, signature, keySecret: 'other' }),
      false,
    );
    assert.equal(
      verifyCheckoutSignature({ paymentId, subscriptionId, signature, keySecret: '' }),
      false,
    );
    assert.equal(
      verifyCheckoutSignature({
        paymentId,
        subscriptionId,
        signature: 'abc',
        keySecret: KEY_SECRET,
      }),
      false,
    );
  });
  test('the order is payment|subscription, not subscription|payment', () => {
    const reversed = hmac(KEY_SECRET, `${subscriptionId}|${paymentId}`);
    assert.equal(
      verifyCheckoutSignature({
        paymentId,
        subscriptionId,
        signature: reversed,
        keySecret: KEY_SECRET,
      }),
      false,
    );
  });
});

describe('webhook signature', () => {
  const rawBody = Buffer.from('{"event":"subscription.activated","created_at":1700000000}');
  const signature = hmac(WEBHOOK_SECRET, rawBody);

  test('valid over the raw body', () => {
    assert.equal(
      verifyWebhookSignature({ rawBody, signature, webhookSecret: WEBHOOK_SECRET }),
      true,
    );
    assert.equal(
      verifyWebhookSignature({
        rawBody,
        signature: signature.toUpperCase(),
        webhookSecret: WEBHOOK_SECRET,
      }),
      true,
    );
  });
  test('a re-serialised (whitespace-changed) or tampered body fails', () => {
    const reserialised = Buffer.from(JSON.stringify(JSON.parse(rawBody.toString()), null, 1));
    assert.equal(
      verifyWebhookSignature({ rawBody: reserialised, signature, webhookSecret: WEBHOOK_SECRET }),
      false,
    );
    const tampered = Buffer.from(rawBody.toString().replace('activated', 'cancelled'));
    assert.equal(
      verifyWebhookSignature({ rawBody: tampered, signature, webhookSecret: WEBHOOK_SECRET }),
      false,
    );
  });
  test('wrong secret, missing header or missing secret fail', () => {
    assert.equal(verifyWebhookSignature({ rawBody, signature, webhookSecret: 'nope' }), false);
    assert.equal(
      verifyWebhookSignature({ rawBody, signature: undefined, webhookSecret: WEBHOOK_SECRET }),
      false,
    );
    assert.equal(verifyWebhookSignature({ rawBody, signature, webhookSecret: '' }), false);
  });
});

// ---------------------------------------------------------------- state machine

const T = (iso: string) => new Date(iso);
const base: SubscriptionState = {
  plan: 'starter',
  status: 'created',
  currentPeriodStart: null,
  currentPeriodEnd: null,
  cancelAtPeriodEnd: false,
  razorpayCustomerId: null,
  endedAt: null,
  lastEventAt: null,
};
function ev(type: string, at: string, extra: Partial<SubscriptionEvent> = {}): SubscriptionEvent {
  return {
    type,
    status: null,
    plan: null,
    currentStart: null,
    currentEnd: null,
    endedAt: null,
    customerId: null,
    createdAt: T(at),
    ...extra,
  };
}

describe('subscription state machine', () => {
  test('happy path: created → authenticated → active with a period', () => {
    let s = applySubscriptionEvent(
      base,
      ev('subscription.authenticated', '2026-10-01T10:00:00Z', { customerId: 'cust_1' }),
    ).next;
    assert.equal(s.status, 'authenticated');
    assert.equal(s.razorpayCustomerId, 'cust_1');
    const r = applySubscriptionEvent(
      s,
      ev('subscription.activated', '2026-10-01T10:00:05Z', {
        status: 'active',
        currentStart: T('2026-10-01T10:00:00Z'),
        currentEnd: T('2026-11-01T10:00:00Z'),
      }),
    );
    s = r.next;
    assert.equal(s.status, 'active');
    assert.equal(r.periodStarted, true);
    assert.deepEqual(s.currentPeriodEnd, T('2026-11-01T10:00:00Z'));
  });

  test('charged with the next period starts a new period (quota reset)', () => {
    const active: SubscriptionState = {
      ...base,
      status: 'active',
      currentPeriodStart: T('2026-10-01T00:00:00Z'),
      currentPeriodEnd: T('2026-11-01T00:00:00Z'),
      lastEventAt: T('2026-10-01T00:00:00Z'),
    };
    const r = applySubscriptionEvent(
      active,
      ev('subscription.charged', '2026-11-01T00:01:00Z', {
        status: 'active',
        currentStart: T('2026-11-01T00:00:00Z'),
        currentEnd: T('2026-12-01T00:00:00Z'),
      }),
    );
    assert.equal(r.periodStarted, true);
    assert.deepEqual(r.next.currentPeriodStart, T('2026-11-01T00:00:00Z'));
    // The same period again (duplicate content under another event id) is not a reset.
    const again = applySubscriptionEvent(
      r.next,
      ev('subscription.charged', '2026-11-01T00:02:00Z', {
        status: 'active',
        currentStart: T('2026-11-01T00:00:00Z'),
        currentEnd: T('2026-12-01T00:00:00Z'),
      }),
    );
    assert.equal(again.periodStarted, false);
  });

  test('pending → halted → active (payment recovered)', () => {
    let s: SubscriptionState = {
      ...base,
      status: 'active',
      lastEventAt: T('2026-10-01T00:00:00Z'),
    };
    s = applySubscriptionEvent(
      s,
      ev('subscription.pending', '2026-11-01T01:00:00Z', { status: 'pending' }),
    ).next;
    assert.equal(s.status, 'pending');
    s = applySubscriptionEvent(
      s,
      ev('subscription.halted', '2026-11-04T01:00:00Z', { status: 'halted' }),
    ).next;
    assert.equal(s.status, 'halted');
    s = applySubscriptionEvent(
      s,
      ev('subscription.charged', '2026-11-05T01:00:00Z', { status: 'active' }),
    ).next;
    assert.equal(s.status, 'active');
  });

  test('an older event delivered late does not move the status back', () => {
    const s: SubscriptionState = {
      ...base,
      status: 'halted',
      lastEventAt: T('2026-11-04T00:00:00Z'),
    };
    const r = applySubscriptionEvent(
      s,
      ev('subscription.pending', '2026-11-02T00:00:00Z', { status: 'pending' }),
    );
    assert.equal(r.next.status, 'halted');
    assert.deepEqual(r.next.lastEventAt, T('2026-11-04T00:00:00Z'));
  });

  test('a late event still fills in a newer billing period', () => {
    const s: SubscriptionState = {
      ...base,
      status: 'active',
      currentPeriodStart: T('2026-10-01T00:00:00Z'),
      currentPeriodEnd: T('2026-11-01T00:00:00Z'),
      lastEventAt: T('2026-11-10T00:00:00Z'),
    };
    const r = applySubscriptionEvent(
      s,
      ev('subscription.charged', '2026-11-01T00:00:00Z', {
        status: 'active',
        currentStart: T('2026-11-01T00:00:00Z'),
        currentEnd: T('2026-12-01T00:00:00Z'),
      }),
    );
    assert.deepEqual(r.next.currentPeriodEnd, T('2026-12-01T00:00:00Z'));
    assert.equal(r.periodStarted, true);
  });

  test('terminal statuses never move back', () => {
    for (const status of ['cancelled', 'completed', 'expired'] as const) {
      const s: SubscriptionState = { ...base, status, lastEventAt: T('2026-10-01T00:00:00Z') };
      const r = applySubscriptionEvent(
        s,
        ev('subscription.charged', '2026-12-01T00:00:00Z', { status: 'active' }),
      );
      assert.equal(r.next.status, status);
    }
  });

  test('cancelled marks cancelAtPeriodEnd; event name is used when the entity has no status', () => {
    const s: SubscriptionState = {
      ...base,
      status: 'active',
      lastEventAt: T('2026-10-01T00:00:00Z'),
    };
    const r = applySubscriptionEvent(s, ev('subscription.cancelled', '2026-10-20T00:00:00Z'));
    assert.equal(r.next.status, 'cancelled');
    assert.equal(r.next.cancelAtPeriodEnd, true);
  });

  test('subscription.updated can change the plan', () => {
    const s: SubscriptionState = {
      ...base,
      status: 'active',
      lastEventAt: T('2026-10-01T00:00:00Z'),
    };
    const r = applySubscriptionEvent(
      s,
      ev('subscription.updated', '2026-10-05T00:00:00Z', { status: 'active', plan: 'pro' }),
    );
    assert.equal(r.next.plan, 'pro');
  });
});

// ---------------------------------------------------------------- entitlement

const NOW = T('2026-10-15T12:00:00Z');
function row(partial: Partial<SubscriptionRow>): SubscriptionRow {
  return {
    ...base,
    razorpaySubscriptionId: 'sub_A',
    replacesSubscriptionId: null,
    startAt: null,
    checkoutVerifiedAt: null,
    createdAt: T('2026-10-01T00:00:00Z'),
    ...partial,
  };
}
const period = {
  currentPeriodStart: T('2026-10-01T00:00:00Z'),
  currentPeriodEnd: T('2026-11-01T00:00:00Z'),
};
const ent = (subs: SubscriptionRow[], username = 'someone', comp: string[] = []) =>
  resolveEntitlement({ username, compLogins: comp, subscriptions: subs, now: NOW });

describe('entitlement', () => {
  test('no subscription → no plan', () => {
    const e = ent([]);
    assert.equal(e.canUse, false);
    assert.equal(e.banner, 'no_plan');
    assert.equal(e.plan, null);
  });

  test('complimentary login gets Max for free (case-insensitive), with a calendar-month window', () => {
    const e = ent([], 'RajAryan1726', ['rajaryan1726']);
    assert.equal(e.plan, 'max');
    assert.equal(e.source, 'complimentary');
    assert.equal(e.canUse, true);
    assert.deepEqual(e.periodStart, T('2026-10-01T00:00:00Z'));
    assert.deepEqual(e.periodEnd, T('2026-11-01T00:00:00Z'));
  });

  test('active → full access, quota window = billing period', () => {
    const e = ent([row({ status: 'active', plan: 'pro', ...period })]);
    assert.equal(e.canUse, true);
    assert.equal(e.plan, 'pro');
    assert.equal(e.banner, null);
    assert.deepEqual(e.periodStart, period.currentPeriodStart);
  });

  test('pending → access with the payment-failed banner', () => {
    const e = ent([row({ status: 'pending', ...period })]);
    assert.equal(e.canUse, true);
    assert.equal(e.banner, 'payment_pending');
  });

  test('halted → no new work, halted banner', () => {
    const e = ent([row({ status: 'halted', ...period })]);
    assert.equal(e.canUse, false);
    assert.equal(e.banner, 'halted');
  });

  test('cancelled keeps access until period end, then ends', () => {
    const cancelled = row({ status: 'cancelled', cancelAtPeriodEnd: true, ...period });
    assert.equal(ent([cancelled]).canUse, true);
    assert.equal(ent([cancelled]).cancelAtPeriodEnd, true);
    const later = resolveEntitlement({
      username: 'x',
      compLogins: [],
      subscriptions: [cancelled],
      now: T('2026-11-02T00:00:00Z'),
    });
    assert.equal(later.canUse, false);
    assert.equal(later.banner, 'ended');
  });

  test('completed / expired → ended', () => {
    for (const status of ['completed', 'expired'] as const) {
      assert.equal(ent([row({ status })]).banner, 'ended');
    }
  });

  test('checkout verified but no webhook yet → confirming, no access', () => {
    const e = ent([row({ status: 'created', checkoutVerifiedAt: NOW })]);
    assert.equal(e.canUse, false);
    assert.equal(e.banner, 'confirming');
  });

  test('abandoned checkout (created, not verified) → still no plan', () => {
    assert.equal(ent([row({ status: 'created' })]).banner, 'no_plan');
  });

  test('upgrade: the newer active subscription wins', () => {
    const old = row({ status: 'active', plan: 'starter', ...period });
    const upgraded = row({
      razorpaySubscriptionId: 'sub_B',
      status: 'active',
      plan: 'max',
      replacesSubscriptionId: 'sub_A',
      createdAt: T('2026-10-10T00:00:00Z'),
      currentPeriodStart: T('2026-10-10T00:00:00Z'),
      currentPeriodEnd: T('2026-11-10T00:00:00Z'),
    });
    const e = ent([old, upgraded]);
    assert.equal(e.plan, 'max');
    assert.equal(e.subscriptionId, 'sub_B');
  });

  test('downgrade: current plan until period end, the lower plan is shown as scheduled', () => {
    const current = row({ status: 'active', plan: 'max', cancelAtPeriodEnd: true, ...period });
    const next = row({
      razorpaySubscriptionId: 'sub_B',
      status: 'authenticated',
      plan: 'starter',
      replacesSubscriptionId: 'sub_A',
      startAt: period.currentPeriodEnd,
      checkoutVerifiedAt: NOW,
      createdAt: T('2026-10-12T00:00:00Z'),
    });
    const e = ent([current, next]);
    assert.equal(e.plan, 'max');
    assert.equal(e.scheduledPlan, 'starter');
    assert.equal(e.cancelAtPeriodEnd, true);
  });
});

// ---------------------------------------------------------------- gates

const activeStarter: Entitlement = ent([row({ status: 'active', plan: 'starter', ...period })]);
const activeMax: Entitlement = ent([row({ status: 'active', plan: 'max', ...period })]);

describe('quota and slot gates', () => {
  test('no plan → PLAN_REQUIRED; halted / ended → SUBSCRIPTION_INACTIVE', () => {
    assert.equal(
      evaluateGate({ entitlement: ent([]), kind: 'chat', used: { reindexes: 0, chat: 0 } })?.code,
      'PLAN_REQUIRED',
    );
    const halted = ent([row({ status: 'halted' })]);
    const g = evaluateGate({
      entitlement: halted,
      kind: 'reindex',
      used: { reindexes: 0, chat: 0 },
    });
    assert.equal(g?.code, 'SUBSCRIPTION_INACTIVE');
    assert.match(g!.message, /stay readable/);
  });

  test('complimentary users pass', () => {
    const comp = ent([], 'me', ['me']);
    assert.equal(
      evaluateGate({ entitlement: comp, kind: 'chat', used: { reindexes: 0, chat: 1999 } }),
      null,
    );
    assert.equal(
      evaluateGate({ entitlement: comp, kind: 'chat', used: { reindexes: 0, chat: 2000 } })?.code,
      'QUOTA_REACHED',
    );
  });

  test('re-index quota: 10 on Starter, with an upgrade suggestion and reset date', () => {
    assert.equal(
      evaluateGate({
        entitlement: activeStarter,
        kind: 'reindex',
        used: { reindexes: 9, chat: 0 },
      }),
      null,
    );
    const g = evaluateGate({
      entitlement: activeStarter,
      kind: 'reindex',
      used: { reindexes: 10, chat: 0 },
    });
    assert.equal(g?.code, 'QUOTA_REACHED');
    assert.match(g!.message, /all 10 re-indexes of your Starter plan/);
    assert.match(g!.message, /resets on 1 Nov/);
    assert.match(g!.message, /Upgrade to Pro for 25/);
  });

  test('chat quota: Max has no upgrade suggestion', () => {
    const g = evaluateGate({
      entitlement: activeMax,
      kind: 'chat',
      used: { reindexes: 0, chat: 2000 },
    });
    assert.equal(g?.code, 'QUOTA_REACHED');
    assert.doesNotMatch(g!.message, /Upgrade/);
    assert.equal(
      evaluateGate({ entitlement: activeStarter, kind: 'chat', used: { reindexes: 0, chat: 299 } }),
      null,
    );
  });

  test('repo slots: re-indexing a counted repo is fine, a new repo needs a free slot', () => {
    const used = { reindexes: 0, chat: 0 };
    assert.equal(
      evaluateGate({
        entitlement: activeStarter,
        kind: 'reindex',
        used,
        slots: { indexedRepos: 1, repoCounted: true },
      }),
      null,
    );
    const g = evaluateGate({
      entitlement: activeStarter,
      kind: 'reindex',
      used,
      slots: { indexedRepos: 1, repoCounted: false },
    });
    assert.equal(g?.code, 'REPO_SLOTS_FULL');
    assert.match(g!.message, /upgrade to Pro for 5 slots/);
  });

  test('after a downgrade over the slot limit: all indexing blocked until data is deleted', () => {
    const used = { reindexes: 0, chat: 0 };
    const g = evaluateGate({
      entitlement: activeStarter,
      kind: 'reindex',
      used,
      slots: { indexedRepos: 3, repoCounted: true },
    });
    assert.equal(g?.code, 'REPO_SLOTS_FULL');
    assert.match(g!.message, /1 repository slot but 3 repositories are indexed/);
    assert.match(g!.message, /stay readable/);
    // Chat still works on the plan (only new indexing is blocked).
    assert.equal(evaluateGate({ entitlement: activeStarter, kind: 'chat', used }), null);
  });
});

describe('helpers', () => {
  test('changeKind by price', () => {
    assert.equal(changeKind('starter', 'max'), 'upgrade');
    assert.equal(changeKind('max', 'pro'), 'downgrade');
    assert.equal(changeKind('pro', 'pro'), 'same');
  });
  test('keyMode from the key id prefix', () => {
    assert.equal(keyMode('rzp_test_abc'), 'test');
    assert.equal(keyMode('rzp_live_abc'), 'live');
  });
});
