import { Link, useSearchParams } from 'react-router-dom';
import { useRepo } from '../features/repos/api';
import { HealthStatus } from '../components/health-status';
import { PageHeader, Placeholder } from '../components/page-header';

export function OverviewPage() {
  return (
    <>
      <PageHeader title="Overview" subtitle="A summary of your indexed repositories." />
      <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
        <Placeholder>Overview stats will appear here.</Placeholder>
        <HealthStatus />
      </div>
    </>
  );
}

export function ChatPage() {
  const [params] = useSearchParams();
  const repo = useRepo(params.get('repo') ?? undefined);
  return (
    <>
      <PageHeader title="Chat" subtitle="Ask questions about an indexed repository." />
      {repo.data && (
        <p className="mb-4 inline-flex rounded-full border border-border bg-raised px-3 py-1 font-mono text-sm">
          {repo.data.fullName}
        </p>
      )}
      <Placeholder>Chat threads will appear here.</Placeholder>
    </>
  );
}

export function SettingsPage() {
  return (
    <>
      <PageHeader title="Settings" subtitle="Account and app preferences." />
      <Placeholder>Settings will appear here.</Placeholder>
    </>
  );
}

export function NotFoundPage() {
  return (
    <>
      <PageHeader title="Page not found" />
      <Link to="/" className="text-accent-text hover:underline">
        Back to repositories
      </Link>
    </>
  );
}
