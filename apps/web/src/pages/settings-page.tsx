import { useEffect, useState, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import {
  CircleAlert,
  ExternalLink,
  Gauge,
  Monitor,
  Moon,
  Palette,
  Sun,
  Trash2,
  TriangleAlert,
  UserRound,
} from 'lucide-react';
import type { LlmFeature, UsageResponse } from '@autowiki/shared';
import { ConfirmDialog } from '../components/confirm-dialog';
import { Meter } from '../components/meter';
import { PageHeader } from '../components/page-header';
import { RefetchErrorBanner } from '../components/refetch-error';
import { useTheme, type ThemePreference } from '../app/theme-context';
import { useAuth } from '../features/auth/auth-context';
import { useDeleteAccount, useUsage } from '../features/account/api';
import { MemorySettings } from '../features/memory/memory-settings';
import { BillingSettings } from '../features/billing/billing-settings';
import { dangerButtonClass } from '../lib/ui';

function Section({
  id,
  icon: Icon,
  title,
  description,
  children,
}: {
  id: string;
  icon: typeof Palette;
  title: string;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      id={id}
      aria-labelledby={`${id}-title`}
      className="scroll-mt-6 rounded-lg border border-border bg-surface p-5 md:p-6"
    >
      <h2 id={`${id}-title`} className="flex items-center gap-2 text-lg font-semibold">
        <Icon size={20} aria-hidden className="text-accent-text" />
        {title}
      </h2>
      {description && <p className="mt-1 max-w-2xl text-sm text-muted">{description}</p>}
      <div className="mt-4">{children}</div>
    </section>
  );
}

// ---------------------------------------------------------------- appearance

const THEME_OPTIONS: { value: ThemePreference; label: string; icon: typeof Sun }[] = [
  { value: 'system', label: 'System', icon: Monitor },
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
];

function AppearanceSection() {
  const { preference, setPreference } = useTheme();
  return (
    <Section id="appearance" icon={Palette} title="Appearance">
      <fieldset>
        <legend className="mb-2 text-sm font-medium">Theme</legend>
        <div className="inline-flex flex-wrap gap-1 rounded-lg border border-border bg-raised p-1">
          {THEME_OPTIONS.map(({ value, label, icon: Icon }) => (
            <label
              key={value}
              className={`inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-md px-4 text-sm font-medium transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent-text ${
                preference === value
                  ? 'bg-accent-soft text-accent-text'
                  : 'text-muted hover:bg-soft hover:text-text'
              }`}
            >
              <input
                type="radio"
                name="theme"
                value={value}
                checked={preference === value}
                onChange={() => setPreference(value)}
                className="sr-only"
              />
              <Icon size={16} aria-hidden />
              {label}
            </label>
          ))}
        </div>
        <p className="mt-2 text-xs text-muted">
          System follows your device setting. The choice is saved in this browser.
        </p>
      </fieldset>
    </Section>
  );
}

// ---------------------------------------------------------------- account

function AccountSection() {
  const { user } = useAuth();
  if (!user) return null;
  return (
    <Section
      id="account"
      icon={UserRound}
      title="Connected GitHub account"
      description="AutoWiki reads your repositories with this account. You can revoke its access on GitHub at any time; you will then be asked to sign in again."
    >
      <div className="flex flex-wrap items-center gap-4">
        {user.avatarUrl ? (
          <img
            src={user.avatarUrl}
            alt=""
            className="h-12 w-12 rounded-full border border-border"
          />
        ) : (
          <span className="flex h-12 w-12 items-center justify-center rounded-full bg-soft font-semibold">
            {user.username.charAt(0).toUpperCase()}
          </span>
        )}
        <div className="min-w-0 flex-1">
          <p className="font-medium [overflow-wrap:anywhere]">{user.username}</p>
          <p className="text-sm text-muted">Signed in with GitHub</p>
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
          <a
            href={`https://github.com/${encodeURIComponent(user.username)}`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex min-h-11 items-center gap-1 text-accent-text hover:underline"
          >
            View profile
            <ExternalLink size={13} aria-hidden />
          </a>
          <a
            href="https://github.com/settings/applications"
            target="_blank"
            rel="noreferrer"
            className="inline-flex min-h-11 items-center gap-1 text-accent-text hover:underline"
          >
            Manage access on GitHub
            <ExternalLink size={13} aria-hidden />
          </a>
        </div>
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------- usage

const FEATURE_LABEL: Record<LlmFeature, string> = {
  chat: 'Chat answers',
  rewrite: 'Follow-up rewriting',
  wiki: 'Wiki generation',
  memory: 'Memory',
};

function UsageBody({ data }: { data: UsageResponse }) {
  const { tokens, limits } = data;
  const resets = new Date(data.resetsAt);
  return (
    <div className="space-y-6">
      <div>
        <Meter label="AI tokens today" used={tokens.used} limit={tokens.budget} unit="tokens" />
        <ul className="mt-3 grid gap-x-6 gap-y-1 text-sm text-muted sm:grid-cols-2">
          {(Object.keys(FEATURE_LABEL) as LlmFeature[]).map((f) => (
            <li key={f} className="flex justify-between gap-3">
              <span>{FEATURE_LABEL[f]}</span>
              <span className="font-mono text-xs">
                {tokens.byFeature[f].toLocaleString('en-US')}
              </span>
            </li>
          ))}
        </ul>
      </div>
      <div className="grid gap-5 sm:grid-cols-2">
        <Meter label="Indexed repositories" {...limits.indexedRepos} />
        <Meter label="Index jobs today" {...limits.indexJobsToday} />
        <Meter label="Wiki regenerations today" {...limits.wikiRegenerationsToday} />
        <Meter label="Chat messages in the last hour" {...limits.chatMessagesLastHour} />
      </div>
      <p className="text-xs text-muted">
        Daily counters reset at 00:00 UTC (
        {resets.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} your time).
        Repositories can have up to {limits.maxRepoFiles.toLocaleString('en-US')} indexable files.
      </p>
    </div>
  );
}

function UsageSection() {
  const usage = useUsage();
  return (
    <Section
      id="usage"
      icon={Gauge}
      title="Daily safety limits"
      description="Besides your plan's monthly quotas, AI work (chat, wiki generation, memory) uses tokens from a daily budget, with a few daily safety limits. When one runs out, new work pauses until the reset; everything already indexed stays available."
    >
      <RefetchErrorBanner query={usage} what="usage" />
      {usage.isPending ? (
        <div className="space-y-3" role="status" aria-label="Loading usage">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-8 animate-pulse rounded bg-soft" />
          ))}
        </div>
      ) : usage.error && !usage.data ? (
        <p role="alert" className="flex items-center gap-2 text-sm text-danger">
          <CircleAlert size={16} aria-hidden />
          Could not load usage: {usage.error.message}
        </p>
      ) : (
        <UsageBody data={usage.data!} />
      )}
    </Section>
  );
}

// ---------------------------------------------------------------- danger zone

function DangerZone() {
  const [open, setOpen] = useState(false);
  const del = useDeleteAccount();
  return (
    <section
      id="danger"
      aria-labelledby="danger-title"
      className="scroll-mt-6 rounded-lg border border-danger/40 bg-surface p-5 md:p-6"
    >
      <h2 id="danger-title" className="flex items-center gap-2 text-lg font-semibold text-danger">
        <TriangleAlert size={20} aria-hidden />
        Delete my account
      </h2>
      <p className="mt-1 max-w-2xl text-sm text-muted">
        Permanently deletes your AutoWiki account and everything in it: repository indexes and
        vectors, wikis, chats, remembered facts and usage history. Your GitHub repositories are not
        touched. To also remove AutoWiki&apos;s access, revoke it on GitHub afterwards.
      </p>
      <button type="button" onClick={() => setOpen(true)} className={`${dangerButtonClass} mt-4`}>
        <Trash2 size={16} aria-hidden />
        Delete my account
      </button>
      <ConfirmDialog
        open={open}
        title="Delete your account?"
        confirmLabel="Delete everything"
        busy={del.isPending}
        error={del.error?.message ?? null}
        onCancel={() => setOpen(false)}
        onConfirm={() => del.mutate()}
      >
        Everything AutoWiki stores about you is deleted at once and cannot be recovered. You will be
        signed out.
      </ConfirmDialog>
    </section>
  );
}

export function SettingsPage() {
  const { hash } = useLocation();
  // Links such as /settings#billing: scroll once the section is rendered.
  useEffect(() => {
    if (hash) document.getElementById(hash.slice(1))?.scrollIntoView();
  }, [hash]);
  return (
    <>
      <PageHeader
        title="Settings"
        subtitle="Appearance, account, billing, memory, usage and your data."
      />
      <div className="space-y-6">
        <AppearanceSection />
        <AccountSection />
        <BillingSettings />
        <MemorySettings />
        <UsageSection />
        <DangerZone />
      </div>
    </>
  );
}
