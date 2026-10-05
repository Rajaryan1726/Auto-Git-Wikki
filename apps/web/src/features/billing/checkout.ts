import type { SubscribeResponse, VerifyBody } from '@autowiki/shared';

/** Razorpay Standard Checkout (https://razorpay.com/docs/payments/subscriptions/integration-guide/). */
const CHECKOUT_SRC = 'https://checkout.razorpay.com/v1/checkout.js';

type RazorpayInstance = {
  open: () => void;
  on: (event: 'payment.failed', cb: (resp: { error?: { description?: string } }) => void) => void;
};
type RazorpayCtor = new (options: Record<string, unknown>) => RazorpayInstance;

declare global {
  interface Window {
    Razorpay?: RazorpayCtor;
  }
}

let loading: Promise<RazorpayCtor> | null = null;

function loadCheckout(): Promise<RazorpayCtor> {
  if (window.Razorpay) return Promise.resolve(window.Razorpay);
  loading ??= new Promise<RazorpayCtor>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = CHECKOUT_SRC;
    script.async = true;
    script.onload = () =>
      window.Razorpay ? resolve(window.Razorpay) : reject(new Error('Checkout did not load.'));
    script.onerror = () => {
      loading = null;
      reject(new Error('Could not load Razorpay Checkout. Check your connection and try again.'));
    };
    document.head.appendChild(script);
  });
  return loading;
}

export type CheckoutOutcome =
  | { kind: 'paid'; response: VerifyBody }
  | { kind: 'dismissed' }
  | { kind: 'failed'; message: string };

/**
 * Opens Checkout for a subscription the server created. Resolves with the handler
 * response (to verify on the server), a dismissal, or a failed payment.
 */
export async function openCheckout(
  sub: SubscribeResponse,
  opts: { description: string; accentColor: string },
): Promise<CheckoutOutcome> {
  const Razorpay = await loadCheckout();
  return new Promise<CheckoutOutcome>((resolve) => {
    // Checkout stays open after a failed attempt so the user can try another method; the
    // failure is reported only if they then close it.
    let lastFailure: string | null = null;
    const rzp = new Razorpay({
      key: sub.keyId,
      subscription_id: sub.subscriptionId,
      name: 'AutoWiki',
      description: opts.description,
      prefill: { name: sub.prefill.name },
      theme: { color: opts.accentColor },
      handler: (response: VerifyBody) => resolve({ kind: 'paid', response }),
      modal: {
        ondismiss: () =>
          resolve(lastFailure ? { kind: 'failed', message: lastFailure } : { kind: 'dismissed' }),
      },
    });
    rzp.on('payment.failed', (resp) => {
      lastFailure = resp.error?.description ?? 'The payment failed.';
    });
    rzp.open();
  });
}
