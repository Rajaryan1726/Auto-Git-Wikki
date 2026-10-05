import { useEffect } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useBilling } from '../features/billing/api';
import { BillingBanner } from '../features/billing/billing-banner';
import { Sidebar } from './sidebar';
import { SiteFooter } from './site-footer';

const PRICING_SHOWN_KEY = 'autowiki.pricingShown';

/** Signed-in users without a plan see the pricing page once per browser session. */
function useShowPricingOnce() {
  const billing = useBilling();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const noPlan = billing.data?.entitlement.banner === 'no_plan';
  useEffect(() => {
    if (!noPlan || pathname !== '/') return;
    try {
      if (sessionStorage.getItem(PRICING_SHOWN_KEY)) return;
      sessionStorage.setItem(PRICING_SHOWN_KEY, '1');
    } catch {
      return; // storage blocked: just show the banner
    }
    navigate('/pricing', { replace: true });
  }, [noPlan, pathname, navigate]);
}

export function AppLayout() {
  useShowPricingOnce();
  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      <Sidebar />
      <main className="flex min-w-0 flex-1 flex-col px-4 py-6 md:px-10 md:py-10">
        <BillingBanner />
        <div className="flex-1">
          <Outlet />
        </div>
        <SiteFooter />
      </main>
    </div>
  );
}
