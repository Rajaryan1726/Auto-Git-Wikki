import { HealthStatus } from '../components/health-status';
import { PageHeader, Placeholder } from '../components/page-header';

export function RepositoriesPage() {
  return (
    <>
      <PageHeader
        title="Repositories"
        subtitle="Your GitHub repositories. Index one to generate its wiki and chat with it."
      />
      <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
        <Placeholder>Repository list arrives once GitHub sign-in is wired up.</Placeholder>
        <HealthStatus />
      </div>
    </>
  );
}
