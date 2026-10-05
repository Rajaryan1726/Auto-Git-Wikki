import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  billingResponseSchema,
  subscribeResponseSchema,
  type PlanId,
  type VerifyBody,
} from '@autowiki/shared';
import { apiFetch } from '../../lib/api';

export const billingKeys = { state: ['billing'] as const };

/** Plan, status, quota usage and payment history. Polls while a payment is confirming. */
export function useBilling(enabled = true) {
  return useQuery({
    queryKey: billingKeys.state,
    queryFn: async () => billingResponseSchema.parse(await apiFetch<unknown>('/api/billing')),
    enabled,
    refetchInterval: (q) => (q.state.data?.entitlement.banner === 'confirming' ? 3_000 : 60_000),
  });
}

/** Creates the Razorpay subscription on the server (plan key only; price decided there). */
export function useSubscribe() {
  return useMutation({
    mutationFn: async (plan: PlanId) =>
      subscribeResponseSchema.parse(
        await apiFetch<unknown>('/api/billing/subscribe', { method: 'POST', body: { plan } }),
      ),
  });
}

export function useVerifyCheckout() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: VerifyBody) =>
      billingResponseSchema.parse(
        await apiFetch<unknown>('/api/billing/verify', { method: 'POST', body }),
      ),
    onSuccess: (data) => queryClient.setQueryData(billingKeys.state, data),
  });
}

export function useCancelSubscription() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () =>
      billingResponseSchema.parse(
        await apiFetch<unknown>('/api/billing/cancel', { method: 'POST' }),
      ),
    onSuccess: (data) => queryClient.setQueryData(billingKeys.state, data),
  });
}
