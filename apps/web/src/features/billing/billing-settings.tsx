import { useState } from 'react';
import { Link } from 'react-router-dom';
import { CircleAlert, CreditCard, LoaderCircle } from 'lucide-react';
import {
  PLANS,
  formatPaise,
  type BillingResponse,
  type SubscriptionStatus,
} from '@autowiki/shared';
import { ConfirmDialog } from '../../components/confirm-dialog';
import { Meter } from '../../components/meter';
import { RefetchErrorBanner } from '../../components/refetch-error';
import { useToast } from '../../components/toast-context';
import { buttonClass, pillClass } from '../../lib/ui';
import { useBilling, useCancelSubscription } from './api';

const STATUS_LABEL: Record<SubscriptionStatus, string> = {
  created: 'Awaiting payment',
  authenticated: 'Confirming',
  active: 'Active',
  pending: 'Payment retrying',
  halted: 'On hold',
  cancelled: 'Cancelled',
  completed: 'Completed',
  expired: 'Expired',
};

const date = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleDateString(undefined, {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
      })
    : '—';

function statusTone(data: BillingResponse): string {
  const e = data.entitlement;
  if (!e.canUse) return 'border-danger/40 bg-danger-soft text-danger';
  if (e.status === 'pending' || e.cancelAtPeriodEnd)
    return 'border-warning/40 bg-warning-soft text-warning';
  return 'border-success/40 bg-success-soft text-success';
}

function PlanSummary({ data }: { data: BillingResponse }) {
  const e = data.entitlement;
  const plan = e.plan ? PLANS[e.plan] : null;
  const status =
    e.source === 'complimentary'
      ? 'Complimentary'
      : e.banner === 'confirming'
        ? 'Confirming payment'
        : e.status === 'cancelled' && e.canUse
          ? 'Cancelled — active until period end'
          : e.status
            ? STATUS_LABEL[e.status]
            : 'No plan';
  return (
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0">
        <p className="flex flex-wrap items-center gap-2 font-heading text-xl font-semibold">
          {plan ? plan.name : 'No plan'}
          <span className={`${pillClass} ${statusTone(data)}`}>{status}</span>
        </p>
        <p className="mt-1 text-sm text-muted">
          {e.source === 'complimentary'
            ? 'Max plan at no cost. Quotas reset on the 1st of each month.'
            : plan && e.canUse
              ? `${formatPaise(plan.pricePaise)} / month · ${
                  e.cancelAtPeriodEnd ? `ends ${date(e.periodEnd)}` : `renews ${date(e.periodEnd)}`
                }`
              : e.banner === 'confirming'
                ? 'Waiting for Razorpay to confirm your payment…'
                : e.banner === 'halted'
                  ? 'The renewal payment failed after several retries. Resubscribe to index and chat again.'
                  : e.banner === 'ended'
                    ? `Ended${e.periodEnd ? ` on ${date(e.periodEnd)}` : ''}. Subscribe again to index and chat.`
                    : 'Subscribe to index repositories and chat.'}
        </p>
        {e.scheduledPlan && (
          <p className="mt-1 text-sm text-muted">
            Switches to {PLANS[e.scheduledPlan].name} on {date(e.scheduledStart)}.
          </p>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        {e.source !== 'complimentary' && e.banner !== 'confirming' && (
          <Link to="/pricing" className={e.canUse ? buttonClass.secondary : buttonClass.primary}>
            {e.canUse ? 'Change plan' : e.plan ? 'Resubscribe' : 'See plans'}
          </Link>
        )}
        {e.source === 'subscription' && e.canUse && !e.cancelAtPeriodEnd && (
          <CancelButton periodEnd={e.periodEnd} />
        )}
      </div>
    </div>
  );
}

function CancelButton({ periodEnd }: { periodEnd: string | null }) {
  const [open, setOpen] = useState(false);
  const cancel = useCancelSubscription();
  const toast = useToast();
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={`${buttonClass.secondary} text-danger`}
      >
        Cancel plan
      </button>
      <ConfirmDialog
        open={open}
        title="Cancel your plan?"
        confirmLabel="Cancel plan"
        busy={cancel.isPending}
        error={cancel.error?.message ?? null}
        onCancel={() => setOpen(false)}
        onConfirm={() =>
          void cancel.mutateAsync().then(() => {
            setOpen(false);
            toast.success(`Cancelled. You keep your plan until ${date(periodEnd)}.`);
          })
        }
      >
        Your plan stays active until the end of the current billing period ({date(periodEnd)}) and
        will not renew. After that, indexing and chat pause; your wikis and chat history stay
        readable. Payments already made are not refunded (see the{' '}
        <Link to="/refund-policy" className="text-accent-text underline">
          refund policy
        </Link>
        ).
      </ConfirmDialog>
    </>
  );
}

function PaymentHistory({ data }: { data: BillingResponse }) {
  if (data.payments.length === 0) {
    return <p className="text-sm text-muted">No payments yet.</p>;
  }
  return (
    <div className="overflow-x-auto rounded-md border border-border">
      <table className="w-full text-left text-sm">
        <thead className="bg-raised text-xs text-muted">
          <tr>
            <th scope="col" className="px-3 py-2 font-medium">
              Date
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Plan
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Amount
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Status
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Payment id
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {data.payments.map((p) => (
            <tr key={p.id}>
              <td className="px-3 py-2 whitespace-nowrap">{date(p.createdAt)}</td>
              <td className="px-3 py-2">{p.plan ? PLANS[p.plan].name : '—'}</td>
              <td className="px-3 py-2 font-mono text-xs">
                {p.currency === 'INR'
                  ? formatPaise(p.amountPaise)
                  : `${p.amountPaise / 100} ${p.currency}`}
              </td>
              <td className={`px-3 py-2 ${p.status === 'failed' ? 'text-danger' : ''}`}>
                {p.status === 'captured'
                  ? 'Paid'
                  : p.status.charAt(0).toUpperCase() + p.status.slice(1)}
                {p.method ? <span className="text-muted"> · {p.method}</span> : null}
              </td>
              <td className="px-3 py-2 font-mono text-xs text-muted">{p.id}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function BillingBody({ data }: { data: BillingResponse }) {
  const { usage, entitlement: e } = data;
  return (
    <div className="space-y-6">
      <PlanSummary data={data} />
      {e.canUse && (
        <div>
          <div className="grid gap-5 sm:grid-cols-3">
            <Meter label="Repo slots" {...usage.repoSlots} />
            <Meter label="Re-indexes this period" {...usage.reindexes} />
            <Meter label="Chat messages this period" {...usage.chatMessages} />
          </div>
          <p className="mt-3 text-xs text-muted">
            Each Index, Re-index or Regenerate wiki counts as one re-index. Quotas reset{' '}
            {e.periodEnd ? `on ${date(e.periodEnd)}` : 'every billing period'}.
            {usage.repoSlots.used > usage.repoSlots.limit &&
              ` You have more indexed repositories than slots: they stay readable, but new indexing is blocked until you delete repo data down to ${usage.repoSlots.limit}.`}
          </p>
        </div>
      )}
      <div>
        <h3 className="mb-2 text-sm font-semibold">Payment history</h3>
        <PaymentHistory data={data} />
      </div>
    </div>
  );
}

/** Settings → Billing: plan, status, renewal, quota meters, change / cancel, payments. */
export function BillingSettings() {
  const billing = useBilling();
  return (
    <section
      id="billing"
      aria-labelledby="billing-title"
      className="scroll-mt-6 rounded-lg border border-border bg-surface p-5 md:p-6"
    >
      <h2 id="billing-title" className="flex items-center gap-2 text-lg font-semibold">
        <CreditCard size={20} aria-hidden className="text-accent-text" />
        Billing
      </h2>
      <div className="mt-4">
        <RefetchErrorBanner query={billing} what="billing" />
        {billing.isPending ? (
          <div className="flex items-center gap-2 text-sm text-muted" role="status">
            <LoaderCircle size={16} className="animate-spin" aria-hidden />
            Loading billing…
          </div>
        ) : billing.error && !billing.data ? (
          <p role="alert" className="flex items-center gap-2 text-sm text-danger">
            <CircleAlert size={16} aria-hidden />
            Could not load billing: {billing.error.message}
          </p>
        ) : (
          <BillingBody data={billing.data!} />
        )}
      </div>
    </section>
  );
}
