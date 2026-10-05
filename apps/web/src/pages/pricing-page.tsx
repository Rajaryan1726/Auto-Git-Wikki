import { Link } from 'react-router-dom';
import { Check, CircleAlert, LoaderCircle } from 'lucide-react';
import {
  PLANS,
  PLAN_ORDER,
  formatPaise,
  type BillingResponse,
  type Plan,
  type PlanId,
} from '@autowiki/shared';
import { PageHeader } from '../components/page-header';
import { useAuth } from '../features/auth/auth-context';
import { useBilling } from '../features/billing/api';
import { useCheckout } from '../features/billing/use-checkout';
import { buttonClass, pillClass } from '../lib/ui';

const REINDEX_HELP =
  'Each Index, Re-index or Regenerate wiki counts as one. Resets every billing period.';

type Action =
  | { kind: 'signin' }
  | { kind: 'current' }
  | { kind: 'subscribe' }
  | { kind: 'upgrade' }
  | { kind: 'downgrade' }
  | { kind: 'disabled'; reason: string };

function actionFor(plan: Plan, billing: BillingResponse | undefined, signedIn: boolean): Action {
  if (!signedIn) return { kind: 'signin' };
  if (!billing) return { kind: 'disabled', reason: 'Loading…' };
  const e = billing.entitlement;
  if (e.source === 'complimentary') {
    return plan.id === 'max'
      ? { kind: 'current' }
      : { kind: 'disabled', reason: 'Complimentary Max' };
  }
  if (e.canUse && plan.id === e.plan) return { kind: 'current' };
  if (!billing.keyId) return { kind: 'disabled', reason: 'Payments not available yet' };
  if (e.banner === 'confirming') return { kind: 'disabled', reason: 'Confirming payment…' };
  if (!e.canUse || !e.plan) return { kind: 'subscribe' };
  if (plan.id === e.plan) return { kind: 'current' };
  if (e.scheduledPlan) return { kind: 'disabled', reason: 'Change already scheduled' };
  return plan.pricePaise > PLANS[e.plan].pricePaise ? { kind: 'upgrade' } : { kind: 'downgrade' };
}

const ACTION_LABEL: Record<Exclude<Action['kind'], 'disabled'>, string> = {
  signin: 'Sign in to subscribe',
  current: 'Current plan',
  subscribe: 'Subscribe',
  upgrade: 'Upgrade now',
  downgrade: 'Downgrade at period end',
};

function PlanCard({
  plan,
  action,
  busy,
  anyBusy,
  scheduled,
  onChoose,
}: {
  plan: Plan;
  action: Action;
  busy: boolean;
  anyBusy: boolean;
  scheduled: boolean;
  onChoose: (id: PlanId) => void;
}) {
  const current = action.kind === 'current';
  const features = [
    `${plan.repoSlots} repository slot${plan.repoSlots === 1 ? '' : 's'} (indexed at the same time)`,
    `${plan.monthlyReindexes} re-indexes a month`,
    `${plan.chatMessages.toLocaleString('en-IN')} chat messages a month`,
    'AI wiki for every indexed repository',
  ];
  return (
    <article
      aria-labelledby={`plan-${plan.id}`}
      className={`flex flex-col rounded-lg border bg-surface p-6 ${current ? 'border-accent ring-1 ring-accent' : 'border-border'}`}
    >
      <div className="flex items-center justify-between gap-2">
        <h2 id={`plan-${plan.id}`} className="font-heading text-xl font-semibold">
          {plan.name}
        </h2>
        {current && (
          <span className={`${pillClass} border-accent/30 bg-accent-soft text-accent-text`}>
            Your plan
          </span>
        )}
        {scheduled && (
          <span className={`${pillClass} border-border bg-raised text-muted`}>Scheduled</span>
        )}
      </div>
      <p className="mt-3">
        <span className="font-heading text-4xl font-semibold">{formatPaise(plan.pricePaise)}</span>
        <span className="text-muted"> / month</span>
      </p>
      <p className="text-xs text-muted">Billed in INR every month until cancelled.</p>
      <ul className="mt-5 flex-1 space-y-2 text-sm">
        {features.map((f) => (
          <li key={f} className="flex gap-2">
            <Check size={16} className="mt-0.5 shrink-0 text-success" aria-hidden />
            {f}
          </li>
        ))}
      </ul>
      <div className="mt-6">
        {action.kind === 'signin' ? (
          <Link to="/login" className={`${buttonClass.primary} w-full`}>
            {ACTION_LABEL.signin}
          </Link>
        ) : action.kind === 'disabled' || action.kind === 'current' ? (
          <button type="button" disabled className={`${buttonClass.secondary} w-full`}>
            {action.kind === 'current' ? ACTION_LABEL.current : action.reason}
          </button>
        ) : (
          <button
            type="button"
            onClick={() => onChoose(plan.id)}
            disabled={anyBusy}
            className={`${action.kind === 'downgrade' ? buttonClass.secondary : buttonClass.primary} w-full`}
          >
            {busy && <LoaderCircle size={16} className="animate-spin" aria-hidden />}
            {ACTION_LABEL[action.kind]}
          </button>
        )}
      </div>
    </article>
  );
}

/** /pricing — public; signed-in users subscribe or change plan here. */
export function PricingPage() {
  const { user } = useAuth();
  const billing = useBilling(!!user);
  const checkout = useCheckout();
  const e = billing.data?.entitlement;
  const changing = !!(e?.canUse && e.plan && e.source === 'subscription');

  return (
    <>
      <PageHeader
        title="Plans"
        subtitle="Pay monthly with UPI, cards or netbanking through Razorpay. Cancel any time."
      />
      {checkout.error && (
        <p
          role="alert"
          className="mb-6 flex items-start gap-2 rounded-lg bg-danger-soft px-4 py-3 text-sm text-danger"
        >
          <CircleAlert size={18} className="mt-0.5 shrink-0" aria-hidden />
          {checkout.error}
        </p>
      )}
      {billing.error && !billing.data && (
        <p role="alert" className="mb-6 text-sm text-danger">
          Could not load your plan: {billing.error.message}
        </p>
      )}
      <div className="grid gap-5 md:grid-cols-3">
        {PLAN_ORDER.map((id) => (
          <PlanCard
            key={id}
            plan={PLANS[id]}
            action={actionFor(PLANS[id], billing.data, !!user)}
            busy={checkout.busyPlan === id}
            anyBusy={checkout.busyPlan !== null}
            scheduled={e?.scheduledPlan === id}
            onChoose={(plan) => void checkout.start(plan)}
          />
        ))}
      </div>
      <div className="mt-8 max-w-3xl space-y-2 text-sm text-muted">
        <p>
          <strong className="text-text">Monthly re-indexes:</strong> {REINDEX_HELP}
        </p>
        <p>
          <strong className="text-text">Repository slots</strong> are repositories indexed at the
          same time. Free a slot with Delete repo data on the repository page.
        </p>
        {changing && (
          <p>
            <strong className="text-text">Changing plan:</strong> an upgrade starts a new monthly
            period on the new plan right away (you pay the new price now and the current plan ends;
            its unused days are not refunded). A downgrade starts when your current period ends,
            with no charge until then. If you then have more indexed repositories than slots, they
            stay readable but new indexing waits until you delete repo data.
          </p>
        )}
        <p>
          A daily AI safety budget also applies to every plan. See the{' '}
          <Link to="/terms" className="text-accent-text underline">
            terms
          </Link>{' '}
          and the{' '}
          <Link to="/refund-policy" className="text-accent-text underline">
            cancellation &amp; refund policy
          </Link>
          .
        </p>
      </div>
    </>
  );
}
