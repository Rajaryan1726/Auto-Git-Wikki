/**
 * Razorpay REST API (https://razorpay.com/docs/api/), HTTP Basic auth with the key id and
 * secret. Only the calls billing needs. Never logs keys, request bodies or responses.
 */
import { z } from 'zod';
import { env } from '../lib/env.js';
import { HttpError } from '../lib/http-error.js';

const API = 'https://api.razorpay.com/v1';

export function razorpayConfigured(): boolean {
  return !!(env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET);
}

function credentials(): { keyId: string; keySecret: string } {
  if (!env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET) {
    throw new HttpError(503, 'BILLING_NOT_CONFIGURED', 'Payments are not configured yet.');
  }
  return { keyId: env.RAZORPAY_KEY_ID, keySecret: env.RAZORPAY_KEY_SECRET };
}

/** Razorpay's error JSON: { error: { code, description } }. */
const errorSchema = z.object({
  error: z.object({ code: z.string().optional(), description: z.string().optional() }),
});

export class RazorpayError extends Error {
  constructor(
    readonly status: number,
    readonly description: string,
  ) {
    super(`Razorpay ${status}: ${description}`);
    this.name = 'RazorpayError';
  }
}

async function call<T>(
  method: 'GET' | 'POST' | 'PATCH',
  path: string,
  schema: z.ZodType<T>,
  body?: unknown,
): Promise<T> {
  const { keyId, keySecret } = credentials();
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const parsed = errorSchema.safeParse(data);
    throw new RazorpayError(res.status, parsed.data?.error.description ?? 'request failed');
  }
  return schema.parse(data);
}

// ---------------------------------------------------------------- plans

export const razorpayPlanSchema = z.object({
  id: z.string(),
  period: z.string(),
  interval: z.number(),
  item: z.object({ name: z.string(), amount: z.number(), currency: z.string() }),
  notes: z.union([z.record(z.string(), z.unknown()), z.array(z.unknown())]).optional(),
});
export type RazorpayPlan = z.infer<typeof razorpayPlanSchema>;

export function createPlan(input: {
  name: string;
  description: string;
  amountPaise: number;
  notes: Record<string, string>;
}): Promise<RazorpayPlan> {
  return call('POST', '/plans', razorpayPlanSchema, {
    period: 'monthly',
    interval: 1,
    item: {
      name: input.name,
      description: input.description,
      amount: input.amountPaise,
      currency: 'INR',
    },
    notes: input.notes,
  });
}

export function fetchPlan(id: string): Promise<RazorpayPlan> {
  return call('GET', `/plans/${encodeURIComponent(id)}`, razorpayPlanSchema);
}

/** All plans of the account (paged, 100 per call). */
export async function listPlans(): Promise<RazorpayPlan[]> {
  const page = z.object({ items: z.array(razorpayPlanSchema) });
  const all: RazorpayPlan[] = [];
  for (let skip = 0; ; skip += 100) {
    const { items } = await call('GET', `/plans?count=100&skip=${skip}`, page);
    all.push(...items);
    if (items.length < 100) return all;
  }
}

// ---------------------------------------------------------------- subscriptions

export const razorpaySubscriptionSchema = z.object({
  id: z.string(),
  plan_id: z.string(),
  status: z.string(),
  customer_id: z.string().nullish(),
  current_start: z.number().nullish(),
  current_end: z.number().nullish(),
  start_at: z.number().nullish(),
  ended_at: z.number().nullish(),
  short_url: z.string().nullish(),
});
export type RazorpaySubscription = z.infer<typeof razorpaySubscriptionSchema>;

export function createSubscription(input: {
  planId: string;
  totalCount: number;
  /** Unix seconds; omitted = starts right after the authentication payment. */
  startAt?: number;
  notes: Record<string, string>;
}): Promise<RazorpaySubscription> {
  return call('POST', '/subscriptions', razorpaySubscriptionSchema, {
    plan_id: input.planId,
    total_count: input.totalCount,
    quantity: 1,
    customer_notify: true,
    ...(input.startAt ? { start_at: input.startAt } : {}),
    notes: input.notes,
  });
}

export function fetchSubscription(id: string): Promise<RazorpaySubscription> {
  return call('GET', `/subscriptions/${encodeURIComponent(id)}`, razorpaySubscriptionSchema);
}

/** atCycleEnd: cancel when the current billing cycle ends (access continues until then). */
export function cancelSubscription(id: string, atCycleEnd: boolean): Promise<RazorpaySubscription> {
  return call(
    'POST',
    `/subscriptions/${encodeURIComponent(id)}/cancel`,
    razorpaySubscriptionSchema,
    { cancel_at_cycle_end: atCycleEnd },
  );
}
