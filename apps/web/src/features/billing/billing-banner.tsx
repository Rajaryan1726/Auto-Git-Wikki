import { Link, useLocation } from 'react-router-dom';
import { CircleAlert, CreditCard, LoaderCircle, TriangleAlert } from 'lucide-react';
import type { BillingBanner as Banner } from '@autowiki/shared';
import { useBilling } from './api';

const COPY: Record<Banner, { tone: 'warning' | 'danger' | 'info'; text: string; cta?: string }> = {
  payment_pending: {
    tone: 'warning',
    text: 'Your renewal payment failed. Razorpay is retrying it automatically; everything keeps working meanwhile. Check the card or UPI mandate you subscribed with.',
    cta: 'Billing settings',
  },
  halted: {
    tone: 'danger',
    text: 'Your subscription is on hold because the renewal payment failed after several retries. Indexing and chat are paused; your wikis and chat history stay readable.',
    cta: 'Resubscribe',
  },
  ended: {
    tone: 'danger',
    text: 'Your subscription has ended. Indexing and chat are paused; your wikis and chat history stay readable.',
    cta: 'Choose a plan',
  },
  confirming: {
    tone: 'info',
    text: 'Payment received. Waiting for Razorpay to confirm it; this usually takes a few seconds.',
  },
  no_plan: {
    tone: 'info',
    text: 'Choose a plan to index repositories, generate wikis and chat with your code.',
    cta: 'See plans',
  },
};

const TONE = {
  warning: 'border-warning/40 bg-warning-soft text-warning',
  danger: 'border-danger/40 bg-danger-soft text-danger',
  info: 'border-border bg-raised text-text',
} as const;

/** App-wide billing notice (payment retrying, on hold, ended, confirming, no plan). */
export function BillingBanner() {
  const billing = useBilling();
  const { pathname } = useLocation();
  const banner = billing.data?.entitlement.banner;
  if (!banner) return null;
  // The pricing page and Settings already explain the state.
  if (banner === 'no_plan' && pathname === '/pricing') return null;
  const copy = COPY[banner];
  const Icon =
    banner === 'confirming'
      ? LoaderCircle
      : copy.tone === 'danger'
        ? TriangleAlert
        : copy.tone === 'warning'
          ? CircleAlert
          : CreditCard;
  const to = banner === 'payment_pending' ? '/settings#billing' : '/pricing';
  return (
    <div
      role={copy.tone === 'info' ? 'status' : 'alert'}
      className={`mb-6 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border px-4 py-3 text-sm ${TONE[copy.tone]}`}
    >
      <Icon
        size={18}
        aria-hidden
        className={`shrink-0 ${banner === 'confirming' ? 'animate-spin' : ''}`}
      />
      <p className="min-w-0 flex-1">{copy.text}</p>
      {copy.cta && pathname !== to.split('#')[0] && (
        <Link
          to={to}
          className="inline-flex min-h-11 items-center font-semibold underline underline-offset-2"
        >
          {copy.cta}
        </Link>
      )}
    </div>
  );
}
