/**
 * Billing with Razorpay Subscriptions (Phase 8).
 *
 * - Plans and prices come from @autowiki/shared (PLANS); Razorpay plan ids from the
 *   billing_plans table (`npm run billing:sync-plans`). The client only sends a plan key.
 * - Webhooks are the source of truth for subscription status; the Checkout signature only
 *   marks a subscription as "confirming".
 * - Plan changes create a NEW subscription (Razorpay cannot change the plan of UPI,
 *   e-mandate or domestic-card subscriptions): upgrades start now and the old one is
 *   cancelled once the new one is active; downgrades start when the current period ends
 *   and the old one is cancelled at cycle end once the new one is authenticated.
 * - Quotas (re-indexes, chat messages) count quota_events in the current billing period.
 */
import { createHash } from 'node:crypto';
import { and, count, desc, eq, gte, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  PLANS,
  planIdSchema,
  subscriptionStatusSchema,
  type BillingResponse,
  type PlanId,
  type SubscribeResponse,
  type VerifyBody,
} from '@autowiki/shared';
import { db } from '../db/client.js';
import {
  billingEvents,
  billingPlans,
  payments,
  quotaEvents,
  subscriptions,
  users,
} from '../db/schema.js';
import { env } from '../lib/env.js';
import { HttpError } from '../lib/http-error.js';
import { moduleLogger } from '../lib/logger.js';
import {
  TERMINAL_STATUSES,
  applySubscriptionEvent,
  changeKind,
  evaluateGate,
  keyMode,
  resolveEntitlement,
  verifyCheckoutSignature,
  verifyWebhookSignature,
  type Entitlement,
  type GateKind,
  type SubscriptionRow,
} from './billing-core.js';
import * as razorpay from './razorpay.js';
import { indexedRepoIds } from './usage.js';

const log = moduleLogger('billing');

type BillingUser = { id: string; username: string };

// ---------------------------------------------------------------- plans

export function currentMode(): 'test' | 'live' {
  return keyMode(env.RAZORPAY_KEY_ID ?? '');
}

/** Razorpay plan id for this plan at its current price, in the current key mode. */
async function razorpayPlanId(plan: PlanId): Promise<string> {
  const [row] = await db
    .select({ id: billingPlans.razorpayPlanId })
    .from(billingPlans)
    .where(
      and(
        eq(billingPlans.mode, currentMode()),
        eq(billingPlans.plan, plan),
        eq(billingPlans.amountPaise, PLANS[plan].pricePaise),
      ),
    )
    .limit(1);
  if (!row) {
    throw new HttpError(
      503,
      'BILLING_NOT_CONFIGURED',
      'Plans are not set up yet (run npm run billing:sync-plans).',
    );
  }
  return row.id;
}

/** Plan key for a Razorpay plan id (any mode or price we ever synced). */
async function planForRazorpayPlan(razorpayPlan: string): Promise<PlanId | null> {
  const [row] = await db
    .select({ plan: billingPlans.plan })
    .from(billingPlans)
    .where(eq(billingPlans.razorpayPlanId, razorpayPlan))
    .limit(1);
  return row?.plan ?? null;
}

// ---------------------------------------------------------------- entitlement + quotas

async function subscriptionRows(userId: string): Promise<SubscriptionRow[]> {
  return db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.userId, userId))
    .orderBy(desc(subscriptions.createdAt));
}

export async function getEntitlement(user: BillingUser, now = new Date()): Promise<Entitlement> {
  return resolveEntitlement({
    username: user.username,
    compLogins: env.COMP_GITHUB_LOGINS,
    subscriptions: await subscriptionRows(user.id),
    now,
  });
}

/** Re-indexes and chat messages since the start of the billing period. */
export async function quotaUsed(
  userId: string,
  since: Date | null,
): Promise<{ reindexes: number; chat: number }> {
  if (!since) return { reindexes: 0, chat: 0 };
  const rows = await db
    .select({ kind: quotaEvents.kind, n: count() })
    .from(quotaEvents)
    .where(and(eq(quotaEvents.userId, userId), gte(quotaEvents.createdAt, since)))
    .groupBy(quotaEvents.kind);
  const used = { reindexes: 0, chat: 0 };
  for (const r of rows) {
    if (r.kind === 'reindex') used.reindexes = Number(r.n);
    else used.chat = Number(r.n);
  }
  return used;
}

/**
 * Throws 402 with a billing error code (the web app links it to /pricing) unless the
 * plan allows this work. `repoId` (index requests) also checks the repo slots.
 */
export async function assertPlanAllows(
  user: BillingUser,
  kind: GateKind,
  opts: { repoId?: string } = {},
): Promise<void> {
  const entitlement = await getEntitlement(user);
  const used = await quotaUsed(user.id, entitlement.periodStart);
  let slots: { indexedRepos: number; repoCounted: boolean } | undefined;
  if (opts.repoId && entitlement.canUse) {
    const indexed = await indexedRepoIds(user.id);
    slots = { indexedRepos: indexed.length, repoCounted: indexed.includes(opts.repoId) };
  }
  const error = evaluateGate({ entitlement, kind, used, slots });
  if (error) throw new HttpError(402, error.code, error.message);
}

/** Counts one re-index or asked question against the plan. */
export async function recordQuota(userId: string, kind: GateKind): Promise<void> {
  await db.insert(quotaEvents).values({ userId, kind });
}

const toIso = (d: Date | null) => (d ? d.toISOString() : null);

export async function getBillingState(user: BillingUser): Promise<BillingResponse> {
  const e = await getEntitlement(user);
  const [used, indexed, history] = await Promise.all([
    quotaUsed(user.id, e.canUse ? e.periodStart : null),
    indexedRepoIds(user.id),
    db
      .select()
      .from(payments)
      .where(eq(payments.userId, user.id))
      .orderBy(desc(payments.paidAt))
      .limit(24),
  ]);
  const plan = e.plan ? PLANS[e.plan] : null;
  const active = e.canUse && plan;
  return {
    keyId: razorpay.razorpayConfigured() ? (env.RAZORPAY_KEY_ID ?? null) : null,
    entitlement: {
      plan: e.plan,
      source: e.source,
      status: e.status,
      canUse: e.canUse,
      banner: e.banner,
      periodStart: toIso(e.periodStart),
      periodEnd: toIso(e.periodEnd),
      cancelAtPeriodEnd: e.cancelAtPeriodEnd,
      scheduledPlan: e.scheduledPlan,
      scheduledStart: toIso(e.scheduledStart),
    },
    usage: {
      repoSlots: { used: indexed.length, limit: active ? plan.repoSlots : 0 },
      reindexes: { used: used.reindexes, limit: active ? plan.monthlyReindexes : 0 },
      chatMessages: { used: used.chat, limit: active ? plan.chatMessages : 0 },
    },
    payments: history.map((p) => ({
      id: p.razorpayPaymentId,
      amountPaise: p.amountPaise,
      currency: p.currency,
      status: p.status,
      method: p.method,
      plan: p.plan,
      createdAt: p.paidAt.toISOString(),
    })),
  };
}

// ---------------------------------------------------------------- subscribe / verify / cancel

/** Plan for a new subscription or a plan change. Amount and plan id are decided here. */
export async function subscribe(user: BillingUser, plan: PlanId): Promise<SubscribeResponse> {
  const now = new Date();
  const e = await getEntitlement(user, now);
  if (e.source === 'complimentary') {
    throw new HttpError(409, 'COMPLIMENTARY_PLAN', 'You have a complimentary Max plan.');
  }
  const planId = await razorpayPlanId(plan);

  let change: SubscribeResponse['change'] = 'new';
  let startAt: Date | null = null;
  let replaces: string | null = null;
  if (e.canUse && e.plan && e.subscriptionId) {
    const kind = changeKind(e.plan, plan);
    if (kind === 'same') {
      throw new HttpError(
        409,
        'ALREADY_SUBSCRIBED',
        `You are already on the ${PLANS[plan].name} plan.`,
      );
    }
    if (e.scheduledPlan) {
      throw new HttpError(
        409,
        'CHANGE_ALREADY_SCHEDULED',
        `A change to ${PLANS[e.scheduledPlan].name} is already scheduled. Cancel your plan and subscribe again after it ends to choose another one.`,
      );
    }
    change = kind;
    replaces = e.subscriptionId;
    if (kind === 'downgrade') {
      // Razorpay needs start_at in the future; a period that ends within minutes starts now.
      startAt =
        e.periodEnd && e.periodEnd.getTime() > now.getTime() + 10 * 60_000 ? e.periodEnd : null;
    }
  } else if (e.subscriptionId && (e.status === 'halted' || e.status === 'pending')) {
    // Resubscribing after failed renewals: the old subscription is cancelled once this runs.
    replaces = e.subscriptionId;
  }

  const notes: Record<string, string> = { user_id: user.id, plan, change };
  if (replaces) notes.replaces = replaces;
  let sub: razorpay.RazorpaySubscription;
  try {
    sub = await razorpay.createSubscription({
      planId,
      totalCount: env.BILLING_TOTAL_COUNT,
      startAt: startAt ? Math.floor(startAt.getTime() / 1000) : undefined,
      notes,
    });
  } catch (err) {
    throw providerError(err, 'create the subscription');
  }
  await db.insert(subscriptions).values({
    userId: user.id,
    plan,
    razorpaySubscriptionId: sub.id,
    razorpayPlanId: planId,
    status: 'created',
    replacesSubscriptionId: replaces,
    startAt,
  });
  log.info({ userId: user.id, subscriptionId: sub.id, plan, change }, 'subscription created');
  return {
    subscriptionId: sub.id,
    keyId: env.RAZORPAY_KEY_ID!,
    plan,
    amountPaise: PLANS[plan].pricePaise,
    change,
    startsAt: toIso(startAt),
    prefill: { name: user.username },
  };
}

function providerError(err: unknown, action: string): HttpError {
  if (err instanceof HttpError) return err;
  const detail = err instanceof razorpay.RazorpayError ? err.description : 'unavailable';
  log.error(
    { action, status: err instanceof razorpay.RazorpayError ? err.status : null, detail },
    'razorpay call failed',
  );
  return new HttpError(
    502,
    'PAYMENT_PROVIDER_ERROR',
    `Could not ${action} with Razorpay: ${detail}`,
  );
}

/**
 * Checkout success handler: verifies razorpay_signature = HMAC_SHA256(payment_id + "|" +
 * subscription_id, key_secret) for a subscription this user created. Access still waits
 * for the webhook (the source of truth).
 */
export async function verifyCheckout(
  user: BillingUser,
  body: VerifyBody,
): Promise<BillingResponse> {
  const [row] = await db
    .select({ id: subscriptions.id })
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.userId, user.id),
        eq(subscriptions.razorpaySubscriptionId, body.razorpay_subscription_id),
      ),
    )
    .limit(1);
  if (!row) throw new HttpError(404, 'SUBSCRIPTION_NOT_FOUND', 'Subscription not found.');
  const ok = verifyCheckoutSignature({
    paymentId: body.razorpay_payment_id,
    subscriptionId: body.razorpay_subscription_id,
    signature: body.razorpay_signature,
    keySecret: env.RAZORPAY_KEY_SECRET ?? '',
  });
  if (!ok) {
    log.warn(
      { userId: user.id, subscriptionId: body.razorpay_subscription_id },
      'checkout signature mismatch',
    );
    throw new HttpError(400, 'INVALID_SIGNATURE', 'The payment could not be verified.');
  }
  await db
    .update(subscriptions)
    .set({ checkoutVerifiedAt: sql`coalesce(${subscriptions.checkoutVerifiedAt}, now())` })
    .where(eq(subscriptions.id, row.id));
  log.info({ userId: user.id, subscriptionId: body.razorpay_subscription_id }, 'checkout verified');
  return getBillingState(user);
}

/** Cancels the current subscription at the end of its period; access continues until then. */
export async function cancelAtPeriodEnd(user: BillingUser): Promise<BillingResponse> {
  const e = await getEntitlement(user);
  if (e.source !== 'subscription' || !e.canUse || !e.subscriptionId) {
    throw new HttpError(409, 'NOTHING_TO_CANCEL', 'You have no active subscription to cancel.');
  }
  if (!e.cancelAtPeriodEnd) {
    try {
      await razorpay.cancelSubscription(e.subscriptionId, true);
    } catch (err) {
      throw providerError(err, 'cancel the subscription');
    }
    await db
      .update(subscriptions)
      .set({ cancelAtPeriodEnd: true })
      .where(eq(subscriptions.razorpaySubscriptionId, e.subscriptionId));
  }
  // A scheduled downgrade would start after the period: cancel it too.
  const scheduled = await db
    .select({ id: subscriptions.razorpaySubscriptionId })
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.replacesSubscriptionId, e.subscriptionId),
        eq(subscriptions.status, 'authenticated'),
      ),
    );
  for (const s of scheduled) {
    try {
      await razorpay.cancelSubscription(s.id, false);
    } catch (err) {
      throw providerError(err, 'cancel the scheduled plan change');
    }
  }
  log.info(
    { userId: user.id, subscriptionId: e.subscriptionId },
    'subscription cancelled at period end',
  );
  return getBillingState(user);
}

/** Account deletion: cancel every live subscription immediately so nothing renews. */
export async function cancelAllForAccountDeletion(userId: string): Promise<number> {
  const rows = await db
    .select({ id: subscriptions.razorpaySubscriptionId, status: subscriptions.status })
    .from(subscriptions)
    .where(eq(subscriptions.userId, userId));
  let cancelled = 0;
  for (const r of rows) {
    if (!['authenticated', 'active', 'pending', 'halted'].includes(r.status)) continue;
    try {
      await razorpay.cancelSubscription(r.id, false);
      cancelled++;
    } catch (err) {
      throw providerError(err, 'cancel your subscription before deleting the account');
    }
  }
  return cancelled;
}

// ---------------------------------------------------------------- webhooks

const unixDate = (s: number | null | undefined) => (s ? new Date(s * 1000) : null);

const notesSchema = z
  .union([z.record(z.string(), z.unknown()), z.array(z.unknown())])
  .nullish()
  .transform((n) => (n && !Array.isArray(n) ? n : {}));

const webhookSchema = z.object({
  event: z.string(),
  created_at: z.number(),
  payload: z
    .object({
      subscription: z
        .object({
          entity: z.object({
            id: z.string(),
            plan_id: z.string(),
            status: z.string(),
            customer_id: z.string().nullish(),
            current_start: z.number().nullish(),
            current_end: z.number().nullish(),
            ended_at: z.number().nullish(),
            notes: notesSchema,
          }),
        })
        .optional(),
      payment: z
        .object({
          entity: z.object({
            id: z.string(),
            amount: z.number(),
            currency: z.string(),
            status: z.string(),
            method: z.string().nullish(),
            created_at: z.number(),
            subscription_id: z.string().nullish(),
            notes: notesSchema,
          }),
        })
        .optional(),
    })
    .default({}),
});

/** Payment statuses only move forward (a late "authorized" never overwrites "captured"). */
const PAYMENT_RANK: Record<string, number> = {
  created: 0,
  authorized: 1,
  failed: 1,
  captured: 2,
  refunded: 3,
};

export type WebhookResult =
  { outcome: 'duplicate' } | { outcome: 'recorded'; replace?: ReplaceRequest };

export type ReplaceRequest = {
  oldSubscriptionId: string;
  newSubscriptionId: string;
  atCycleEnd: boolean;
};

/**
 * Verifies, records (idempotently on the event id) and applies one webhook. The event row
 * and the state change commit together, so a failure lets Razorpay retry the delivery.
 */
export async function handleWebhook(
  input: { rawBody: Buffer; signature: string | undefined; eventId: string | undefined },
  webhookSecret = env.RAZORPAY_WEBHOOK_SECRET,
): Promise<WebhookResult> {
  if (!webhookSecret) {
    throw new HttpError(503, 'BILLING_NOT_CONFIGURED', 'Webhooks are not configured.');
  }
  if (
    !verifyWebhookSignature({ rawBody: input.rawBody, signature: input.signature, webhookSecret })
  ) {
    log.warn({ eventId: input.eventId ?? null }, 'webhook signature mismatch');
    throw new HttpError(400, 'INVALID_SIGNATURE', 'Invalid webhook signature.');
  }
  let parsed: z.infer<typeof webhookSchema>;
  try {
    parsed = webhookSchema.parse(JSON.parse(input.rawBody.toString('utf8')));
  } catch {
    throw new HttpError(400, 'INVALID_PAYLOAD', 'Unrecognised webhook payload.');
  }
  // Razorpay always sends x-razorpay-event-id; fall back to the body hash just in case.
  const eventId =
    input.eventId && /^[\w-]{1,64}$/.test(input.eventId)
      ? input.eventId
      : `sha256:${createHash('sha256').update(input.rawBody).digest('hex')}`;
  return applyWebhook(eventId, parsed);
}

export async function applyWebhook(
  eventId: string,
  body: z.infer<typeof webhookSchema>,
): Promise<WebhookResult> {
  const sub = body.payload.subscription?.entity;
  const pay = body.payload.payment?.entity;
  const eventAt = unixDate(body.created_at)!;
  const subStatus = sub ? subscriptionStatusSchema.safeParse(sub.status) : null;

  const result = await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(billingEvents)
      .values({
        eventId,
        type: body.event,
        razorpaySubscriptionId: sub?.id ?? pay?.subscription_id ?? null,
        razorpayPaymentId: pay?.id ?? null,
        amountPaise: pay?.amount ?? null,
        status: sub?.status ?? pay?.status ?? null,
        periodStart: unixDate(sub?.current_start),
        periodEnd: unixDate(sub?.current_end),
        eventCreatedAt: eventAt,
      })
      .onConflictDoNothing({ target: billingEvents.eventId })
      .returning({ id: billingEvents.id });
    if (inserted.length === 0) return { outcome: 'duplicate' as const };

    let userId: string | null = null;
    let replace: ReplaceRequest | undefined;
    let plan: PlanId | null = null;
    if (sub) {
      plan =
        (await planForRazorpayPlan(sub.plan_id)) ??
        planIdSchema.safeParse(sub.notes.plan).data ??
        null;
      let [row] = await tx
        .select()
        .from(subscriptions)
        .where(eq(subscriptions.razorpaySubscriptionId, sub.id))
        .for('update');
      if (!row) {
        // Created outside this app instance (or the insert was lost): adopt it via notes.
        const noteUser = z.uuid().safeParse(sub.notes.user_id);
        const [owner] = noteUser.success
          ? await tx.select({ id: users.id }).from(users).where(eq(users.id, noteUser.data))
          : [];
        if (owner && plan) {
          [row] = await tx
            .insert(subscriptions)
            .values({
              userId: owner.id,
              plan,
              razorpaySubscriptionId: sub.id,
              razorpayPlanId: sub.plan_id,
              replacesSubscriptionId:
                typeof sub.notes.replaces === 'string' ? sub.notes.replaces : null,
            })
            .returning();
        }
      }
      if (row) {
        userId = row.userId;
        const before = row.status;
        const { next, periodStarted } = applySubscriptionEvent(row, {
          type: body.event,
          status: subStatus?.success ? subStatus.data : null,
          plan,
          currentStart: unixDate(sub.current_start),
          currentEnd: unixDate(sub.current_end),
          endedAt: unixDate(sub.ended_at),
          customerId: sub.customer_id ?? null,
          createdAt: eventAt,
        });
        await tx
          .update(subscriptions)
          .set({ ...next, razorpayPlanId: sub.plan_id })
          .where(eq(subscriptions.id, row.id));
        // Plan change: retire the replaced subscription once this one is live.
        if (row.replacesSubscriptionId && next.status !== before) {
          const downgrade = !!row.startAt;
          if (
            (downgrade && (next.status === 'authenticated' || next.status === 'active')) ||
            (!downgrade && next.status === 'active')
          ) {
            replace = {
              oldSubscriptionId: row.replacesSubscriptionId,
              newSubscriptionId: row.razorpaySubscriptionId,
              atCycleEnd: downgrade && next.status === 'authenticated',
            };
          }
        }
        log.info(
          {
            eventId,
            event: body.event,
            subscriptionId: sub.id,
            status: next.status,
            from: before,
            periodStarted,
          },
          'subscription webhook applied',
        );
      } else {
        log.warn(
          { eventId, event: body.event, subscriptionId: sub.id },
          'webhook for unknown subscription',
        );
      }
    }

    if (pay) {
      const subId = sub?.id ?? pay.subscription_id ?? null;
      if (!userId && subId) {
        const [owner] = await tx
          .select({ userId: subscriptions.userId, plan: subscriptions.plan })
          .from(subscriptions)
          .where(eq(subscriptions.razorpaySubscriptionId, subId));
        userId = owner?.userId ?? null;
        plan = plan ?? owner?.plan ?? null;
      }
      if (userId) {
        const [existing] = await tx
          .select({ status: payments.status })
          .from(payments)
          .where(eq(payments.razorpayPaymentId, pay.id))
          .for('update');
        const rank = (s: string) => PAYMENT_RANK[s] ?? 1;
        if (!existing) {
          await tx.insert(payments).values({
            userId,
            razorpayPaymentId: pay.id,
            razorpaySubscriptionId: subId,
            plan,
            amountPaise: pay.amount,
            currency: pay.currency,
            status: pay.status,
            method: pay.method ?? null,
            paidAt: unixDate(pay.created_at)!,
          });
        } else if (rank(pay.status) >= rank(existing.status)) {
          await tx
            .update(payments)
            .set({ status: pay.status, method: pay.method ?? null })
            .where(eq(payments.razorpayPaymentId, pay.id));
        }
        log.info(
          { eventId, event: body.event, paymentId: pay.id, status: pay.status },
          'payment webhook applied',
        );
      }
    }
    return { outcome: 'recorded' as const, replace };
  });
  if (result.outcome === 'duplicate')
    log.info({ eventId, event: body.event }, 'duplicate webhook ignored');
  return result;
}

/**
 * Cancels the subscription a plan change replaced (run from Inngest, with retries).
 * Downgrades: at cycle end (the user keeps the paid period). Upgrades / resubscribes: now.
 */
export async function retireReplacedSubscription(req: ReplaceRequest): Promise<string> {
  const remote = await razorpay.fetchSubscription(req.oldSubscriptionId);
  if ((TERMINAL_STATUSES as string[]).includes(remote.status)) return `already ${remote.status}`;
  const atCycleEnd = req.atCycleEnd && remote.status === 'active';
  await razorpay.cancelSubscription(req.oldSubscriptionId, atCycleEnd);
  if (atCycleEnd) {
    await db
      .update(subscriptions)
      .set({ cancelAtPeriodEnd: true })
      .where(eq(subscriptions.razorpaySubscriptionId, req.oldSubscriptionId));
  }
  log.info({ ...req, atCycleEnd }, 'replaced subscription cancelled');
  return atCycleEnd ? 'cancelled at cycle end' : 'cancelled now';
}

// ---------------------------------------------------------------- plan sync

/**
 * Creates the three plans in Razorpay if missing (current key mode) and stores their ids.
 * Idempotent: reuses the stored id, or a Razorpay plan tagged with our notes
 * (autowiki_plan + amount), before creating anything.
 */
export async function syncPlans(): Promise<
  { plan: PlanId; razorpayPlanId: string; action: 'kept' | 'adopted' | 'created' }[]
> {
  const mode = currentMode();
  const results: {
    plan: PlanId;
    razorpayPlanId: string;
    action: 'kept' | 'adopted' | 'created';
  }[] = [];
  let remote: razorpay.RazorpayPlan[] | null = null;
  for (const plan of Object.values(PLANS)) {
    const [stored] = await db
      .select()
      .from(billingPlans)
      .where(
        and(
          eq(billingPlans.mode, mode),
          eq(billingPlans.plan, plan.id),
          eq(billingPlans.amountPaise, plan.pricePaise),
        ),
      );
    if (stored) {
      const p = await razorpay.fetchPlan(stored.razorpayPlanId).catch(() => null);
      if (p && p.item.amount === plan.pricePaise) {
        results.push({ plan: plan.id, razorpayPlanId: p.id, action: 'kept' });
        continue;
      }
      await db.delete(billingPlans).where(eq(billingPlans.id, stored.id));
    }
    remote ??= await razorpay.listPlans();
    const match = remote.find((p) => {
      const notes = p.notes && !Array.isArray(p.notes) ? p.notes : {};
      return (
        notes.autowiki_plan === plan.id &&
        p.item.amount === plan.pricePaise &&
        p.item.currency === 'INR' &&
        p.period === 'monthly' &&
        p.interval === 1
      );
    });
    const created = match
      ? null
      : await razorpay.createPlan({
          name: `AutoWiki ${plan.name}`,
          description: `${plan.repoSlots} repo slot(s), ${plan.monthlyReindexes} re-indexes and ${plan.chatMessages} chat messages per month`,
          amountPaise: plan.pricePaise,
          notes: { autowiki_plan: plan.id, amount_paise: String(plan.pricePaise) },
        });
    const id = (match ?? created)!.id;
    await db
      .insert(billingPlans)
      .values({ mode, plan: plan.id, amountPaise: plan.pricePaise, razorpayPlanId: id })
      .onConflictDoNothing();
    results.push({ plan: plan.id, razorpayPlanId: id, action: match ? 'adopted' : 'created' });
  }
  return results;
}
