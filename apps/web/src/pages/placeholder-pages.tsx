import { Link, useParams } from 'react-router-dom';
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

export function RepoPage() {
  const { id } = useParams<{ id: string }>();
  return (
    <>
      <nav aria-label="Breadcrumb" className="mb-4 text-sm text-muted">
        <Link to="/" className="text-accent-text hover:underline">
          Repositories
        </Link>{' '}
        / <span className="font-mono">{id}</span>
      </nav>
      <PageHeader title="Repository" subtitle="Wiki, files and index history." />
      <Placeholder>
        Repository <span className="font-mono text-text">{id}</span> will show its wiki here.
      </Placeholder>
    </>
  );
}

export function ChatPage() {
  return (
    <>
      <PageHeader title="Chat" subtitle="Ask questions about an indexed repository." />
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
