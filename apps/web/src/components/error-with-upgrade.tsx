import { Link } from 'react-router-dom';
import { needsPlanLink } from '../lib/billing-errors';

/** "See plans" link shown after a plan or quota error. */
export function PlansLink() {
  return (
    <Link to="/pricing" className="font-semibold whitespace-nowrap underline underline-offset-2">
      See plans
    </Link>
  );
}

/** An error message, plus a link to /pricing when the error is a plan or quota limit. */
export function ErrorWithUpgrade({ error }: { error: Error }) {
  return (
    <span>
      {error.message}
      {needsPlanLink(error) && (
        <>
          {' '}
          <PlansLink />
        </>
      )}
    </span>
  );
}
