import { Link } from 'react-router-dom';

const POLICY_LINKS = [
  { to: '/pricing', label: 'Pricing' },
  { to: '/terms', label: 'Terms' },
  { to: '/privacy', label: 'Privacy' },
  { to: '/refund-policy', label: 'Cancellation & refunds' },
  { to: '/contact', label: 'Contact' },
] as const;

/** Footer with the pricing and policy pages (also required for Razorpay KYC). */
export function SiteFooter() {
  return (
    <footer className="mt-12 border-t border-border pt-4 text-sm text-muted">
      <nav aria-label="Legal">
        <ul className="flex flex-wrap gap-x-5">
          {POLICY_LINKS.map((l) => (
            <li key={l.to}>
              <Link
                to={l.to}
                className="inline-flex min-h-11 items-center hover:text-text hover:underline"
              >
                {l.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <p className="mt-1">© {new Date().getFullYear()} AutoWiki</p>
    </footer>
  );
}
