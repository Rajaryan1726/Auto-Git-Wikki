import { Link } from 'react-router-dom';
import { PLANS } from '@autowiki/shared';
import { pillClass } from '../../lib/ui';
import { useBilling } from './api';

/** Small plan badge for the sidebar, linking to Settings → Billing (or pricing). */
export function PlanBadge() {
  const billing = useBilling();
  const e = billing.data?.entitlement;
  if (!e) return null;
  const label = e.plan
    ? `${PLANS[e.plan].name}${e.source === 'complimentary' ? ' · Complimentary' : ''}`
    : 'No plan';
  const tone =
    e.banner === 'confirming'
      ? 'border-border bg-raised text-muted'
      : !e.canUse
        ? 'border-danger/40 bg-danger-soft text-danger'
        : e.banner === 'payment_pending'
          ? 'border-warning/40 bg-warning-soft text-warning'
          : 'border-accent/30 bg-accent-soft text-accent-text';
  return (
    <Link
      to={e.canUse ? '/settings#billing' : '/pricing'}
      className="inline-flex min-h-11 items-center"
      title="Your plan"
    >
      <span className={`${pillClass} ${tone}`}>
        {label}
        {e.canUse && e.status === 'pending' ? ' · payment retrying' : ''}
        {!e.canUse && e.plan
          ? e.banner === 'confirming'
            ? ' · confirming'
            : e.status === 'halted'
              ? ' · on hold'
              : ' · inactive'
          : ''}
      </span>
    </Link>
  );
}
