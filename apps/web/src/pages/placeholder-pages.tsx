import { Link } from 'react-router-dom';
import { PageHeader } from '../components/page-header';

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
