/**
 * Pure billing logic (Phase 8), unit-tested without a database or Razorpay:
 * signature checks, the subscription state machine, entitlements and quota gates.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  PLANS,
  PLAN_ORDER,
  type BillingBanner,
  type BillingErrorCode,
  type PlanId,
  type SubscriptionStatus,
} from '@autowiki/shared';

// ---------------------------------------------------------------- signatures

function hmacHex(secret: string, data: string | Buffer): string {
  return createHmac('sha256', secret).update(data).digest('hex');
}

/** Constant-time comparison of two hex signatures (false on any length mismatch). */
function sameHex(expected: string, given: string): boolean {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(given.trim().toLowerCase(), 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Checkout (subscriptions): generated_signature = hmac_sha256(razorpay_payment_id + "|" +
 * subscription_id, key_secret). The subscription id must be the one OUR server created.
 */
export function verifyCheckoutSignature(input: {
  paymentId: string;
  subscriptionId: string;
  signature: string;
  keySecret: string;
}): boolean {
  if (!input.keySecret) return false;
  const expected = hmacHex(input.keySecret, `${input.paymentId}|${input.subscriptionId}`);
  return sameHex(expected, input.signature);
}

/** Webhooks: X-Razorpay-Signature = hex HMAC-SHA256 of the RAW body with the webhook secret. */
export function verifyWebhookSignature(input: {
  rawBody: Buffer;
  signature: string | undefined;
  webhookSecret: string;
}): boolean {
  if (!input.webhookSecret || !input.signature) return false;
  return sameHex(hmacHex(input.webhookSecret, input.rawBody), input.signature);
}

// ---------------------------------------------------------------- state machine

export const TERMINAL_STATUSES: SubscriptionStatus[] = ['cancelled', 'completed', 'expired'];

/** The local subscription fields the state machine reads and writes. */
export type SubscriptionState = {
  plan: PlanId;
  status: SubscriptionStatus;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  razorpayCustomerId: string | null;
  endedAt: Date | null;
  lastEventAt: Date | null;
};

/** What one webhook says about a subscription (from payload.subscription.entity). */
export type SubscriptionEvent = {
  type: string;
  status: SubscriptionStatus | null;
  plan: PlanId | null;
  currentStart: Date | null;
  currentEnd: Date | null;
  endedAt: Date | null;
  customerId: string | null;
  createdAt: Date;
};

/** Status implied by the event name when the entity carries none. */
const STATUS_BY_EVENT: Record<string, SubscriptionStatus> = {
  'subscription.authenticated': 'authenticated',
  'subscription.activated': 'active',
  'subscription.charged': 'active',
  'subscription.resumed': 'active',
  'subscription.pending': 'pending',
  'subscription.halted': 'halted',
  'subscription.cancelled': 'cancelled',
  'subscription.completed': 'completed',
};

/**
 * Applies one webhook to the stored state. Razorpay may deliver events late, twice or out
 * of order, so:
 * - the entity status (a snapshot) is taken only from events newer than the last applied;
 * - a terminal status (cancelled / completed / expired) never moves back;
 * - billing periods only move forward; a later period start means quotas reset.
 */
export function applySubscriptionEvent(
  state: SubscriptionState,
  event: SubscriptionEvent,
): { next: SubscriptionState; periodStarted: boolean } {
  const next: SubscriptionState = { ...state };
  const isNewer = !state.lastEventAt || event.createdAt >= state.lastEventAt;
  const status = event.status ?? STATUS_BY_EVENT[event.type] ?? null;

  if (isNewer && status && !TERMINAL_STATUSES.includes(state.status)) next.status = status;
  if (isNewer && event.plan) next.plan = event.plan;
  if (isNewer) next.lastEventAt = event.createdAt;
  if (event.customerId && !next.razorpayCustomerId) next.razorpayCustomerId = event.customerId;
  if (event.endedAt) next.endedAt = event.endedAt;
  if (next.status === 'cancelled' && state.status !== 'cancelled') next.cancelAtPeriodEnd = true;

  let periodStarted = false;
  if (
    event.currentStart &&
    event.currentEnd &&
    (!state.currentPeriodEnd || event.currentEnd > state.currentPeriodEnd)
  ) {
    periodStarted =
      !state.currentPeriodStart ||
      event.currentStart.getTime() !== state.currentPeriodStart.getTime();
    next.currentPeriodStart = event.currentStart;
    next.currentPeriodEnd = event.currentEnd;
  }
  return { next, periodStarted };
}

// ---------------------------------------------------------------- entitlement

export type SubscriptionRow = SubscriptionState & {
  razorpaySubscriptionId: string;
  replacesSubscriptionId: string | null;
  startAt: Date | null;
  checkoutVerifiedAt: Date | null;
  createdAt: Date;
};

export type Entitlement = {
  plan: PlanId | null;
  source: 'subscription' | 'complimentary' | 'none';
  status: SubscriptionStatus | null;
  canUse: boolean;
  banner: BillingBanner | null;
  /** Quota window: usage counts from periodStart (null = no quota window). */
  periodStart: Date | null;
  periodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  scheduledPlan: PlanId | null;
  scheduledStart: Date | null;
  /** The Razorpay subscription that grants access (cancel / change act on it). */
  subscriptionId: string | null;
};

/** Does this subscription give access right now? */
export function grantsAccess(row: SubscriptionRow, now: Date): boolean {
  if (row.status === 'active' || row.status === 'pending') return true;
  // Cancelled (at period end, or by hand): paid time is honoured until the period ends.
  if (row.status === 'cancelled') return !!row.currentPeriodEnd && now < row.currentPeriodEnd;
  return false;
}

/** Calendar month (UTC) — the quota window of complimentary users. */
export function calendarMonth(now: Date): { start: Date; end: Date } {
  return {
    start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
    end: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)),
  };
}

const newestFirst = (a: SubscriptionRow, b: SubscriptionRow) =>
  b.createdAt.getTime() - a.createdAt.getTime();

export function resolveEntitlement(input: {
  username: string;
  compLogins: string[];
  subscriptions: SubscriptionRow[];
  now: Date;
}): Entitlement {
  const { now } = input;
  const none: Entitlement = {
    plan: null,
    source: 'none',
    status: null,
    canUse: false,
    banner: 'no_plan',
    periodStart: null,
    periodEnd: null,
    cancelAtPeriodEnd: false,
    scheduledPlan: null,
    scheduledStart: null,
    subscriptionId: null,
  };

  if (input.compLogins.includes(input.username.toLowerCase())) {
    const month = calendarMonth(now);
    return {
      ...none,
      plan: 'max',
      source: 'complimentary',
      canUse: true,
      banner: null,
      periodStart: month.start,
      periodEnd: month.end,
    };
  }

  const subs = [...input.subscriptions].sort(newestFirst);
  const current = subs.find((s) => grantsAccess(s, now));
  if (current) {
    const scheduled = subs.find(
      (s) =>
        s.replacesSubscriptionId === current.razorpaySubscriptionId &&
        s.status === 'authenticated' &&
        !!s.startAt &&
        s.startAt > now,
    );
    return {
      plan: current.plan,
      source: 'subscription',
      status: current.status,
      canUse: true,
      banner: current.status === 'pending' ? 'payment_pending' : null,
      periodStart: current.currentPeriodStart ?? current.createdAt,
      periodEnd: current.currentPeriodEnd,
      cancelAtPeriodEnd: current.cancelAtPeriodEnd || current.status === 'cancelled',
      scheduledPlan: scheduled?.plan ?? null,
      scheduledStart: scheduled?.startAt ?? null,
      subscriptionId: current.razorpaySubscriptionId,
    };
  }

  // Paid at checkout, waiting for Razorpay's webhook to activate it.
  const confirming = subs.find(
    (s) =>
      (s.status === 'created' || s.status === 'authenticated') &&
      !!s.checkoutVerifiedAt &&
      (!s.startAt || s.startAt <= now),
  );
  if (confirming) {
    return {
      ...none,
      plan: confirming.plan,
      source: 'subscription',
      status: confirming.status,
      banner: 'confirming',
      subscriptionId: confirming.razorpaySubscriptionId,
    };
  }

  const last = subs.find((s) => s.status !== 'created' && s.status !== 'authenticated');
  if (last) {
    return {
      ...none,
      plan: last.plan,
      source: 'subscription',
      status: last.status,
      banner: last.status === 'halted' ? 'halted' : 'ended',
      periodEnd: last.currentPeriodEnd,
      subscriptionId: last.razorpaySubscriptionId,
    };
  }
  return none;
}

// ---------------------------------------------------------------- gates

export type GateKind = 'reindex' | 'chat';
export type GateError = { code: BillingErrorCode; message: string };

/** "15 Nov" in IST, for reset dates in messages. */
export function shortDate(d: Date): string {
  return d.toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    timeZone: 'Asia/Kolkata',
  });
}

function nextPlan(plan: PlanId): (typeof PLANS)[PlanId] | null {
  const next = PLAN_ORDER[PLAN_ORDER.indexOf(plan) + 1];
  return next ? PLANS[next] : null;
}

const KEEP_DATA = 'Your wikis and chat history stay readable.';

/**
 * Can the user start this kind of work? Pure: the caller supplies the entitlement, the
 * quota usage in the current window and the repo-slot situation.
 */
export function evaluateGate(input: {
  entitlement: Entitlement;
  kind: GateKind;
  used: { reindexes: number; chat: number };
  /** Only for kind 'reindex' from an index request (not wiki regeneration). */
  slots?: { indexedRepos: number; repoCounted: boolean };
}): GateError | null {
  const e = input.entitlement;
  if (!e.canUse || !e.plan) {
    if (e.banner === 'confirming') {
      return {
        code: 'SUBSCRIPTION_INACTIVE',
        message:
          'Your payment went through and we are waiting for Razorpay to confirm it. This usually takes a few seconds; refresh the page in a moment.',
      };
    }
    if (e.banner === 'halted') {
      return {
        code: 'SUBSCRIPTION_INACTIVE',
        message: `Your subscription is on hold because the renewal payment failed. Resubscribe to index and chat again. ${KEEP_DATA}`,
      };
    }
    if (e.banner === 'ended') {
      return {
        code: 'SUBSCRIPTION_INACTIVE',
        message: `Your subscription has ended. Choose a plan to index and chat again. ${KEEP_DATA}`,
      };
    }
    return {
      code: 'PLAN_REQUIRED',
      message: 'Choose a plan to index repositories, regenerate wikis and chat.',
    };
  }

  const plan = PLANS[e.plan];
  const upgrade = nextPlan(e.plan);
  const resets = e.periodEnd ? ` It resets on ${shortDate(e.periodEnd)}.` : '';

  if (input.slots) {
    const { indexedRepos, repoCounted } = input.slots;
    const slots = `${plan.repoSlots} repository slot${plan.repoSlots === 1 ? '' : 's'}`;
    if (indexedRepos > plan.repoSlots) {
      return {
        code: 'REPO_SLOTS_FULL',
        message:
          `Your ${plan.name} plan has ${slots} but ${indexedRepos} repositories are indexed. ` +
          `Delete repo data until ${plan.repoSlots} ${plan.repoSlots === 1 ? 'is' : 'are'} left to index again` +
          (upgrade ? `, or upgrade to ${upgrade.name} for ${upgrade.repoSlots} slots.` : '.') +
          ` ${KEEP_DATA}`,
      };
    }
    if (!repoCounted && indexedRepos >= plan.repoSlots) {
      return {
        code: 'REPO_SLOTS_FULL',
        message:
          `Your ${plan.name} plan has ${slots} and ${plan.repoSlots === 1 ? 'it is' : 'all are'} in use. ` +
          'Delete the data of a repository you no longer need (repository page → Delete repo data)' +
          (upgrade ? `, or upgrade to ${upgrade.name} for ${upgrade.repoSlots} slots.` : '.'),
      };
    }
  }

  if (input.kind === 'reindex' && input.used.reindexes >= plan.monthlyReindexes) {
    return {
      code: 'QUOTA_REACHED',
      message:
        `You have used all ${plan.monthlyReindexes} re-indexes of your ${plan.name} plan this billing period.${resets}` +
        (upgrade ? ` Upgrade to ${upgrade.name} for ${upgrade.monthlyReindexes} a month.` : ''),
    };
  }
  if (input.kind === 'chat' && input.used.chat >= plan.chatMessages) {
    return {
      code: 'QUOTA_REACHED',
      message:
        `You have used all ${plan.chatMessages.toLocaleString('en-IN')} chat messages of your ${plan.name} plan this billing period.${resets}` +
        (upgrade
          ? ` Upgrade to ${upgrade.name} for ${upgrade.chatMessages.toLocaleString('en-IN')} a month.`
          : ''),
    };
  }
  return null;
}

/** How a plan change is carried out: upgrades start now, downgrades at period end. */
export function changeKind(from: PlanId, to: PlanId): 'upgrade' | 'downgrade' | 'same' {
  const diff = PLANS[to].pricePaise - PLANS[from].pricePaise;
  return diff > 0 ? 'upgrade' : diff < 0 ? 'downgrade' : 'same';
}

/** 'test' / 'live' from the key id prefix (rzp_test_… / rzp_live_…). */
export function keyMode(keyId: string): 'test' | 'live' {
  return keyId.startsWith('rzp_live_') ? 'live' : 'test';
}
