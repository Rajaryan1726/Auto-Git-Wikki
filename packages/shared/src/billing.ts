import { z } from 'zod';

/**
 * Billing plans (Phase 8): the single source of truth for prices and quotas. Prices are
 * integer paise (₹1 = 100 paise). The server decides amounts and Razorpay plan ids from
 * this table; the client only ever sends a plan key.
 */
export const planIdSchema = z.enum(['starter', 'pro', 'max']);
export type PlanId = z.infer<typeof planIdSchema>;

export type Plan = {
  id: PlanId;
  name: string;
  /** Monthly price in paise. */
  pricePaise: number;
  /** Repositories indexed at the same time. */
  repoSlots: number;
  /** Index, Re-index or Regenerate wiki per billing period. */
  monthlyReindexes: number;
  /** Asked questions per billing period. */
  chatMessages: number;
};

export const PLANS: Record<PlanId, Plan> = {
  starter: {
    id: 'starter',
    name: 'Starter',
    pricePaise: 15_900,
    repoSlots: 1,
    monthlyReindexes: 10,
    chatMessages: 300,
  },
  pro: {
    id: 'pro',
    name: 'Pro',
    pricePaise: 45_900,
    repoSlots: 5,
    monthlyReindexes: 25,
    chatMessages: 1_000,
  },
  max: {
    id: 'max',
    name: 'Max',
    pricePaise: 91_900,
    repoSlots: 10,
    monthlyReindexes: 50,
    chatMessages: 2_000,
  },
};

export const PLAN_ORDER: PlanId[] = ['starter', 'pro', 'max'];

/** "₹159" (whole rupees) or "₹159.50". */
export function formatPaise(paise: number): string {
  const rupees = paise / 100;
  return `₹${rupees.toLocaleString('en-IN', {
    minimumFractionDigits: Number.isInteger(rupees) ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;
}

/** Razorpay subscription states (https://razorpay.com/docs/payments/subscriptions/states/). */
export const subscriptionStatusSchema = z.enum([
  'created',
  'authenticated',
  'active',
  'pending',
  'halted',
  'cancelled',
  'completed',
  'expired',
]);
export type SubscriptionStatus = z.infer<typeof subscriptionStatusSchema>;

/**
 * Error codes of the billing gates. The web app shows a link to /pricing with each of them.
 */
export const BILLING_ERROR_CODES = [
  'PLAN_REQUIRED',
  'SUBSCRIPTION_INACTIVE',
  'QUOTA_REACHED',
  'REPO_SLOTS_FULL',
] as const;
export type BillingErrorCode = (typeof BILLING_ERROR_CODES)[number];
export function isBillingErrorCode(code: string): code is BillingErrorCode {
  return (BILLING_ERROR_CODES as readonly string[]).includes(code);
}

/**
 * Banner shown in the app:
 * - payment_pending: a renewal failed, Razorpay is retrying (access continues);
 * - halted: retries exhausted (no new work; data stays readable);
 * - ended: cancelled / completed / expired (no new work; data stays readable);
 * - confirming: checkout finished, waiting for Razorpay's webhook;
 * - no_plan: never subscribed.
 */
export const billingBannerSchema = z.enum([
  'payment_pending',
  'halted',
  'ended',
  'confirming',
  'no_plan',
]);
export type BillingBanner = z.infer<typeof billingBannerSchema>;

const counterSchema = z.object({ used: z.number(), limit: z.number() });

export const paymentSchema = z.object({
  id: z.string(),
  amountPaise: z.number(),
  currency: z.string(),
  status: z.string(),
  method: z.string().nullable(),
  plan: planIdSchema.nullable(),
  createdAt: z.string(),
});
export type Payment = z.infer<typeof paymentSchema>;

export const billingResponseSchema = z.object({
  /** Razorpay key id (public) for Checkout; null when billing is not configured. */
  keyId: z.string().nullable(),
  entitlement: z.object({
    plan: planIdSchema.nullable(),
    source: z.enum(['subscription', 'complimentary', 'none']),
    status: subscriptionStatusSchema.nullable(),
    /** New indexing, regeneration and chat are allowed. */
    canUse: z.boolean(),
    banner: billingBannerSchema.nullable(),
    periodStart: z.string().nullable(),
    periodEnd: z.string().nullable(),
    cancelAtPeriodEnd: z.boolean(),
    /** A lower plan that starts when the current period ends. */
    scheduledPlan: planIdSchema.nullable(),
    scheduledStart: z.string().nullable(),
  }),
  usage: z.object({
    repoSlots: counterSchema,
    reindexes: counterSchema,
    chatMessages: counterSchema,
  }),
  payments: z.array(paymentSchema),
});
export type BillingResponse = z.infer<typeof billingResponseSchema>;

export const subscribeBodySchema = z.object({ plan: planIdSchema });
export type SubscribeBody = z.infer<typeof subscribeBodySchema>;

export const subscribeResponseSchema = z.object({
  subscriptionId: z.string(),
  keyId: z.string(),
  plan: planIdSchema,
  amountPaise: z.number(),
  /** new: first plan; upgrade: starts now; downgrade: starts when the current period ends. */
  change: z.enum(['new', 'upgrade', 'downgrade']),
  startsAt: z.string().nullable(),
  prefill: z.object({ name: z.string() }),
});
export type SubscribeResponse = z.infer<typeof subscribeResponseSchema>;

/** The Checkout handler's response, exactly as Razorpay names the fields. */
export const verifyBodySchema = z.object({
  razorpay_payment_id: z.string().min(1).max(64),
  razorpay_subscription_id: z.string().min(1).max(64),
  razorpay_signature: z.string().regex(/^[0-9a-f]{64}$/i),
});
export type VerifyBody = z.infer<typeof verifyBodySchema>;
