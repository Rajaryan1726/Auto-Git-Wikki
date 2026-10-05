/**
 * Creates the AutoWiki plans in Razorpay (in the mode of RAZORPAY_KEY_ID: test or live)
 * if they are missing, and stores their ids in billing_plans. Safe to re-run: it never
 * creates a duplicate (stored id → Razorpay plan tagged with our notes → create).
 *
 *   npm run billing:sync-plans
 *
 * Prices live in packages/shared/src/billing.ts. Razorpay plans cannot be edited, so a
 * price change creates a new plan; existing subscriptions keep their old plan.
 */
import { formatPaise, PLANS } from '@autowiki/shared';
import { pool } from '../db/client.js';
import { currentMode, syncPlans } from '../services/billing.js';
import { razorpayConfigured } from '../services/razorpay.js';

async function main(): Promise<void> {
  if (!razorpayConfigured()) {
    console.error('Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in .env first.');
    process.exitCode = 1;
    return;
  }
  console.log(`Razorpay ${currentMode()} mode`);
  for (const r of await syncPlans()) {
    const p = PLANS[r.plan];
    console.log(
      `  ${p.name.padEnd(8)} ${formatPaise(p.pricePaise).padStart(5)}/month  ${r.razorpayPlanId}  (${r.action})`,
    );
  }
}

main()
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : 'sync failed');
    process.exitCode = 1;
  })
  .finally(() => pool.end());
