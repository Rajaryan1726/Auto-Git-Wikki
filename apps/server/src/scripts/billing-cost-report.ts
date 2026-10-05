/**
 * Actual cost per user per billing period, by plan, next to the plan price and the
 * Razorpay fee — to review pricing after real usage.
 *
 *   npm run billing:cost-report
 *
 * Cost = LLM tokens from llm_usage × model prices + an embedding estimate (newly embedded
 * chunks of the user's index jobs × tokens per chunk × embedding price). Periods are the
 * billing periods seen in webhooks plus each subscription's current one; complimentary
 * users use calendar months. Prices and rates come from env (see .env.example):
 *   BILLING_USD_INR            USD → INR rate (default 88)
 *   LLM_PRICES_USD_PER_MTOK    JSON {"<model>": {"input": n, "output": n}, "*": {...}}
 *   EMBED_PRICE_USD_PER_MTOK   default 0.02 (text-embedding-3-small)
 *   EMBED_TOKENS_PER_CHUNK     default 350
 *   RAZORPAY_FEE_PERCENT       default 2 (+ 18% GST on the fee)
 */
import { and, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import { formatPaise, PLANS, PLAN_ORDER, type PlanId } from '@autowiki/shared';
import { db, pool } from '../db/client.js';
import {
  billingEvents,
  indexJobs,
  llmUsage,
  repositories,
  subscriptions,
  users,
} from '../db/schema.js';
import { env } from '../lib/env.js';
import { calendarMonth } from '../services/billing-core.js';

const priceSchema = z.object({ input: z.number().min(0), output: z.number().min(0) });
const config = z
  .object({
    BILLING_USD_INR: z.coerce.number().positive().default(88),
    LLM_PRICES_USD_PER_MTOK: z
      .string()
      .default('{"*":{"input":0.5,"output":2}}')
      .transform((s) => z.record(z.string(), priceSchema).parse(JSON.parse(s))),
    EMBED_PRICE_USD_PER_MTOK: z.coerce.number().min(0).default(0.02),
    EMBED_TOKENS_PER_CHUNK: z.coerce.number().positive().default(350),
    RAZORPAY_FEE_PERCENT: z.coerce.number().min(0).default(2),
  })
  .parse(process.env);

type Period = { userId: string; plan: PlanId; start: Date; end: Date };

async function periods(): Promise<Period[]> {
  const out = new Map<string, Period>();
  const add = (p: Period) => out.set(`${p.userId}|${p.start.toISOString()}`, p);
  const now = new Date();

  // Paid periods: from webhooks (they carry current_start / current_end) and each
  // subscription's current period.
  const subs = await db.select().from(subscriptions);
  const events = await db
    .select({
      sub: billingEvents.razorpaySubscriptionId,
      start: billingEvents.periodStart,
      end: billingEvents.periodEnd,
    })
    .from(billingEvents)
    .where(
      sql`${billingEvents.periodStart} is not null and ${billingEvents.periodEnd} is not null`,
    );
  for (const s of subs) {
    const seen = events.filter((e) => e.sub === s.razorpaySubscriptionId);
    if (s.currentPeriodStart && s.currentPeriodEnd) {
      seen.push({
        sub: s.razorpaySubscriptionId,
        start: s.currentPeriodStart,
        end: s.currentPeriodEnd,
      });
    }
    for (const e of seen) add({ userId: s.userId, plan: s.plan, start: e.start!, end: e.end! });
  }

  // Complimentary users: calendar months since their first LLM call.
  if (env.COMP_GITHUB_LOGINS.length) {
    const comp = await db
      .select({
        id: users.id,
        first: sql<
          string | null
        >`(select min(created_at) from llm_usage where user_id = ${users.id})`,
      })
      .from(users)
      .where(inArray(sql`lower(${users.username})`, env.COMP_GITHUB_LOGINS));
    for (const u of comp) {
      if (!u.first) continue;
      for (let m = calendarMonth(new Date(u.first)); m.start < now; m = calendarMonth(m.end)) {
        add({ userId: u.id, plan: 'max', start: m.start, end: m.end });
      }
    }
  }
  return [...out.values()];
}

function llmPrice(model: string) {
  const prices = config.LLM_PRICES_USD_PER_MTOK;
  return prices[model] ?? prices['*'] ?? { input: 0, output: 0 };
}

async function periodCost(p: Period): Promise<{ usd: number; tokens: number; unpriced: string[] }> {
  const rows = await db
    .select({
      model: llmUsage.model,
      input: sql<string>`sum(${llmUsage.inputTokens})`,
      output: sql<string>`sum(${llmUsage.outputTokens})`,
    })
    .from(llmUsage)
    .where(
      and(
        eq(llmUsage.userId, p.userId),
        gte(llmUsage.createdAt, p.start),
        lt(llmUsage.createdAt, p.end),
      ),
    )
    .groupBy(llmUsage.model);
  let usd = 0;
  let tokens = 0;
  const unpriced: string[] = [];
  for (const r of rows) {
    if (!config.LLM_PRICES_USD_PER_MTOK[r.model]) unpriced.push(r.model);
    const price = llmPrice(r.model);
    usd += (Number(r.input) * price.input + Number(r.output) * price.output) / 1e6;
    tokens += Number(r.input) + Number(r.output);
  }
  const jobs = await db
    .select({ embedded: indexJobs.embeddedChunks, stats: indexJobs.stats })
    .from(indexJobs)
    .innerJoin(repositories, eq(repositories.id, indexJobs.repoId))
    .where(
      and(
        eq(repositories.userId, p.userId),
        gte(indexJobs.createdAt, p.start),
        lt(indexJobs.createdAt, p.end),
      ),
    );
  // Reused chunks (unchanged text on re-index) cost no embedding call.
  const newChunks = jobs.reduce(
    (n, j) => n + Math.max(0, j.embedded - (j.stats.reusedChunks ?? 0)),
    0,
  );
  usd += (newChunks * config.EMBED_TOKENS_PER_CHUNK * config.EMBED_PRICE_USD_PER_MTOK) / 1e6;
  return { usd, tokens, unpriced };
}

const inr = (paise: number) => formatPaise(Math.round(paise));

async function main(): Promise<void> {
  const all = await periods();
  const unpriced = new Set<string>();
  console.log(
    `USD→INR ${config.BILLING_USD_INR}; Razorpay fee ${config.RAZORPAY_FEE_PERCENT}% + 18% GST; ` +
      `embeddings ≈ ${config.EMBED_TOKENS_PER_CHUNK} tokens/chunk at $${config.EMBED_PRICE_USD_PER_MTOK}/M\n`,
  );
  const header = [
    'Plan'.padEnd(8),
    'Price'.padEnd(7),
    'Fee'.padEnd(7),
    'Periods'.padEnd(8),
    'Users'.padEnd(6),
    'Avg cost'.padEnd(9),
    'Max cost'.padEnd(9),
    'Avg tokens'.padEnd(11),
    'Margin avg'.padEnd(11),
    'Margin max',
  ];
  console.log(header.join(' '));
  for (const planId of PLAN_ORDER) {
    const plan = PLANS[planId];
    const ps = all.filter((p) => p.plan === planId);
    const costs: { paise: number; tokens: number }[] = [];
    for (const p of ps) {
      const c = await periodCost(p);
      c.unpriced.forEach((m) => unpriced.add(m));
      costs.push({ paise: c.usd * config.BILLING_USD_INR * 100, tokens: c.tokens });
    }
    const fee = plan.pricePaise * (config.RAZORPAY_FEE_PERCENT / 100) * 1.18;
    const has = costs.length > 0;
    const avg = has ? costs.reduce((a, c) => a + c.paise, 0) / costs.length : 0;
    const max = costs.reduce((a, c) => Math.max(a, c.paise), 0);
    const avgTokens = has ? Math.round(costs.reduce((a, c) => a + c.tokens, 0) / costs.length) : 0;
    console.log(
      [
        plan.name.padEnd(8),
        inr(plan.pricePaise).padEnd(7),
        inr(fee).padEnd(7),
        String(ps.length).padEnd(8),
        String(new Set(ps.map((p) => p.userId)).size).padEnd(6),
        (has ? inr(avg) : '-').padEnd(9),
        (has ? inr(max) : '-').padEnd(9),
        (has ? avgTokens.toLocaleString('en-IN') : '-').padEnd(11),
        (has ? inr(plan.pricePaise - fee - avg) : '-').padEnd(11),
        has ? inr(plan.pricePaise - fee - max) : '-',
      ].join(' '),
    );
  }
  if (unpriced.size) {
    console.log(
      `\nNo explicit price for: ${[...unpriced].join(', ')} (used the "*" price). Set LLM_PRICES_USD_PER_MTOK.`,
    );
  }
}

main()
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
