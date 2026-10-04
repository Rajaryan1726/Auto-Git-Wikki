import { Link } from 'react-router-dom';
import { HealthStatus } from '../components/health-status';
import { PageHeader, Placeholder } from '../components/page-header';
import { MemorySettings } from '../features/memory/memory-settings';

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

export function SettingsPage() {
  return (
    <>
      <PageHeader title="Settings" subtitle="Account and app preferences." />
      <MemorySettings />
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
