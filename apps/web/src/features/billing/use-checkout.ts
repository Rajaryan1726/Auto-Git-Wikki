import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { PLANS, formatPaise, type PlanId } from '@autowiki/shared';
import { useToast } from '../../components/toast-context';
import { billingKeys, useSubscribe, useVerifyCheckout } from './api';
import { openCheckout } from './checkout';

/** Brand accent (Theme A) for the Checkout modal. */
const ACCENT = '#722F37';

/**
 * Subscribe / change plan: the server creates the subscription (amount and plan id are
 * decided there), Checkout collects the payment, the server verifies the signature, and
 * the webhook activates the plan (the billing query polls while it is confirming).
 */
export function useCheckout() {
  const subscribe = useSubscribe();
  const verify = useVerifyCheckout();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [busyPlan, setBusyPlan] = useState<PlanId | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function start(plan: PlanId) {
    setBusyPlan(plan);
    setError(null);
    try {
      const sub = await subscribe.mutateAsync(plan);
      const p = PLANS[plan];
      const outcome = await openCheckout(sub, {
        description:
          sub.change === 'downgrade' && sub.startsAt
            ? `${p.name} plan from ${new Date(sub.startsAt).toLocaleDateString()} (${formatPaise(p.pricePaise)}/month)`
            : `${p.name} plan, ${formatPaise(p.pricePaise)}/month`,
        accentColor: ACCENT,
      });
      if (outcome.kind === 'dismissed') return;
      if (outcome.kind === 'failed') {
        setError(`Payment failed: ${outcome.message} No money was taken; you can try again.`);
        return;
      }
      await verify.mutateAsync(outcome.response);
      toast.success(
        sub.change === 'downgrade'
          ? `Done. You switch to ${p.name} when the current period ends.`
          : `Payment received. Activating your ${p.name} plan…`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setBusyPlan(null);
      void queryClient.invalidateQueries({ queryKey: billingKeys.state });
    }
  }

  return { start, busyPlan, error, clearError: () => setError(null) };
}
