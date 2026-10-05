import { z } from 'zod';
import { retireReplacedSubscription } from '../../services/billing.js';
import { inngest } from '../client.js';

export const BILLING_REPLACE_EVENT = 'billing/subscription.replaced';
export type BillingReplaceData = {
  oldSubscriptionId: string;
  newSubscriptionId: string;
  atCycleEnd: boolean;
};
const dataSchema = z.object({
  oldSubscriptionId: z.string().min(1),
  newSubscriptionId: z.string().min(1),
  atCycleEnd: z.boolean(),
});

/**
 * A plan change went live: cancel the subscription it replaces (upgrades now, downgrades
 * at cycle end). Retried by Inngest so a Razorpay hiccup never leaves two subscriptions
 * charging. One run per old subscription at a time.
 */
export const retireReplacedSubscriptionFn = inngest.createFunction(
  {
    id: 'billing-retire-replaced-subscription',
    retries: 6,
    concurrency: { key: 'event.data.oldSubscriptionId', limit: 1 },
    triggers: [{ event: BILLING_REPLACE_EVENT }],
  },
  async ({ event, step }) => {
    const data = dataSchema.parse(event.data);
    return step.run('cancel-replaced', () => retireReplacedSubscription(data));
  },
);
