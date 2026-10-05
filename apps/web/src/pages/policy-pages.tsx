import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { TriangleAlert } from 'lucide-react';
import { PLANS, PLAN_ORDER, formatPaise } from '@autowiki/shared';

/**
 * Policy pages for Razorpay live-mode KYC. DRAFTS: every [placeholder] must be filled in
 * and the text reviewed by the owner (ideally with legal advice) before going live.
 */
const LAST_UPDATED = '[Date]';

function PolicyPage({ title, children }: { title: string; children: ReactNode }) {
  return (
    <article className="max-w-3xl">
      <p
        role="note"
        className="mb-6 flex items-start gap-2 rounded-lg border border-warning/40 bg-warning-soft px-4 py-3 text-sm text-warning"
      >
        <TriangleAlert size={18} className="mt-0.5 shrink-0" aria-hidden />
        Draft — to be reviewed by the owner before going live. Text in [brackets] is a placeholder.
      </p>
      <h1 className="text-3xl font-semibold tracking-tight">{title}</h1>
      <p className="mt-1 text-sm text-muted">Last updated: {LAST_UPDATED}</p>
      <div className="mt-6 space-y-4 text-sm leading-relaxed [&_h2]:mt-8 [&_h2]:text-lg [&_h2]:font-semibold [&_li]:ml-5 [&_li]:list-disc [&_ul]:space-y-1">
        {children}
      </div>
    </article>
  );
}

const OWNER = '[Your full name]';
const EMAIL = '[Email]';

function PlanList() {
  return (
    <ul>
      {PLAN_ORDER.map((id) => {
        const p = PLANS[id];
        return (
          <li key={id}>
            {p.name}: {formatPaise(p.pricePaise)} per month — {p.repoSlots} repository slot
            {p.repoSlots === 1 ? '' : 's'}, {p.monthlyReindexes} re-indexes and{' '}
            {p.chatMessages.toLocaleString('en-IN')} chat messages per billing period.
          </li>
        );
      })}
    </ul>
  );
}

export function TermsPage() {
  return (
    <PolicyPage title="Terms of Service">
      <p>
        AutoWiki (&ldquo;the service&rdquo;) is operated by {OWNER}, [Address] (&ldquo;we&rdquo;,
        &ldquo;us&rdquo;). By signing in or subscribing you agree to these terms.
      </p>
      <h2>1. The service</h2>
      <p>
        AutoWiki connects to your GitHub account, indexes repositories you choose, and generates an
        AI-written wiki and a chat assistant that answers questions about that code. AI output can
        be incomplete or wrong; check important answers against the code.
      </p>
      <h2>2. Accounts</h2>
      <p>
        You sign in with GitHub and must be at least 18 years old (or have a guardian&apos;s
        consent). You are responsible for activity under your account and for having the right to
        let us process the repositories you index.
      </p>
      <h2>3. Plans and payment</h2>
      <PlanList />
      <p>
        Subscriptions are billed monthly in Indian rupees through Razorpay and renew automatically
        until cancelled. Quotas reset at the start of each billing period; unused quota does not
        carry over. A daily AI usage safety limit and request rate limits apply to every plan to
        keep the service stable. Prices may change with at least [30] days&apos; notice; changes
        apply from your next billing period.
      </p>
      <p>
        If a renewal payment fails, Razorpay retries it; your access continues while it retries. If
        all retries fail, new indexing and chat pause until you subscribe again; existing wikis and
        chat history stay readable. Cancellation and refunds are covered by the{' '}
        <Link to="/refund-policy" className="text-accent-text underline">
          cancellation &amp; refund policy
        </Link>
        .
      </p>
      <h2>4. Your content</h2>
      <p>
        Your code, wikis and chats remain yours. You give us permission to store and process them
        only to provide the service (including sending code excerpts to our AI providers). We do not
        use your code to train AI models.
      </p>
      <h2>5. Acceptable use</h2>
      <ul>
        <li>
          No attempts to break, overload or reverse-engineer the service or bypass its limits.
        </li>
        <li>No indexing of content you have no right to process, or of unlawful content.</li>
        <li>No reselling or automated bulk access without written permission.</li>
      </ul>
      <h2>6. Availability and changes</h2>
      <p>
        We aim for a reliable service but do not guarantee uninterrupted availability. We may change
        or discontinue features; for paid plans we will give reasonable notice of material changes.
      </p>
      <h2>7. Termination</h2>
      <p>
        You can cancel your plan or delete your account at any time in Settings. We may suspend
        accounts that break these terms.
      </p>
      <h2>8. Liability</h2>
      <p>
        To the extent permitted by law, the service is provided &ldquo;as is&rdquo; and our total
        liability is limited to the amount you paid us in the [3] months before the claim.
      </p>
      <h2>9. Governing law</h2>
      <p>
        These terms are governed by the laws of India; courts at [City, State] have exclusive
        jurisdiction.
      </p>
      <h2>10. Contact</h2>
      <p>
        Questions: {EMAIL} — see{' '}
        <Link to="/contact" className="text-accent-text underline">
          Contact
        </Link>
        .
      </p>
    </PolicyPage>
  );
}

export function PrivacyPage() {
  return (
    <PolicyPage title="Privacy Policy">
      <p>
        This policy explains what AutoWiki, operated by {OWNER}, collects and why. Contact: {EMAIL}.
      </p>
      <h2>What we collect</h2>
      <ul>
        <li>
          GitHub profile: user id, username and avatar; a GitHub access token, stored encrypted,
          used only to read the repositories you choose.
        </li>
        <li>
          Repository data you index: code excerpts, their embeddings (vectors), generated wikis.
        </li>
        <li>
          Chats with the assistant, and short facts the assistant remembers about you from your own
          messages (you can view, turn off and delete these in Settings).
        </li>
        <li>
          Usage records (AI tokens, quota counters) and technical logs (ids, timings, errors — never
          your code or chat text).
        </li>
        <li>
          Billing: your plan, subscription status and payment records (amount, status, Razorpay
          ids). Card, UPI and bank details are handled by Razorpay; we never see or store them.
        </li>
      </ul>
      <h2>Who processes it</h2>
      <ul>
        <li>GitHub (sign-in and repository access).</li>
        <li>OpenAI and Google (AI generation and embeddings of code excerpts and questions).</li>
        <li>Razorpay (payments).</li>
        <li>[Hosting provider] (servers and databases, region [Region]).</li>
      </ul>
      <h2>Cookies</h2>
      <p>
        One httpOnly session cookie keeps you signed in, plus a short-lived cookie during GitHub
        sign-in. No advertising or tracking cookies.
      </p>
      <h2>Retention and deletion</h2>
      <p>
        Data is kept while your account exists. &ldquo;Delete repo data&rdquo; removes a
        repository&apos;s index, wiki and chats; &ldquo;Delete my account&rdquo; cancels any active
        subscription and permanently deletes everything above. Records of payment webhooks (Razorpay
        ids and amounts, without your account) are kept for [8] years for accounting and tax law.
      </p>
      <h2>Your rights</h2>
      <p>
        You can access, correct and delete your data in the app or by writing to {EMAIL}. Grievance
        officer (Digital Personal Data Protection Act, 2023): [Name], {EMAIL}; we respond within
        [30] days.
      </p>
      <h2>Changes</h2>
      <p>We will post changes here and update the date above.</p>
    </PolicyPage>
  );
}

export function RefundPolicyPage() {
  return (
    <PolicyPage title="Cancellation & Refund Policy">
      <h2>Cancelling</h2>
      <p>
        You can cancel any time in Settings → Billing. Cancellation takes effect at the end of the
        current billing period: you keep full access until then and are not charged again. After
        that, indexing and chat pause; your wikis and chat history stay readable until you delete
        them.
      </p>
      <h2>Refunds</h2>
      <ul>
        <li>
          Payments for a billing period that has started are not refunded, including partly used
          periods.
        </li>
        <li>
          Exceptions: duplicate charges, charges after a confirmed cancellation, or a period in
          which the service was unavailable for more than [3] consecutive days because of our fault.
          Write to {EMAIL} within [7] days of the charge with the Razorpay payment id (shown in
          Settings → Billing → Payment history).
        </li>
        <li>
          Approved refunds go back to the original payment method within [5–7] business days of
          approval (bank timelines may add a few days).
        </li>
      </ul>
      <h2>Changing plan</h2>
      <ul>
        <li>
          Upgrade: starts immediately with a new monthly period on the higher plan, charged in full;
          the previous plan ends at once and its unused days are not refunded.
        </li>
        <li>Downgrade: starts when your current period ends; no charge or refund until then.</li>
      </ul>
      <h2>Failed payments</h2>
      <p>
        If a renewal fails, Razorpay retries it automatically and your access continues meanwhile.
        If every retry fails, the subscription is put on hold: no further charges are attempted and
        new indexing and chat pause until you subscribe again.
      </p>
      <h2>Contact</h2>
      <p>
        {OWNER}, {EMAIL}, [Phone]. See{' '}
        <Link to="/contact" className="text-accent-text underline">
          Contact
        </Link>
        .
      </p>
    </PolicyPage>
  );
}

export function ContactPage() {
  return (
    <PolicyPage title="Contact us">
      <p>For support, billing questions, refunds or privacy requests:</p>
      <ul>
        <li>Name / business: {OWNER} [Business name, if any]</li>
        <li>Email: {EMAIL}</li>
        <li>Phone: [Phone]</li>
        <li>Address: [Address, City, State, PIN code], India</li>
      </ul>
      <p>
        We reply within [2] business days. Please include your GitHub username, and the Razorpay
        payment id for payment questions.
      </p>
    </PolicyPage>
  );
}
