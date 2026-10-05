import { isBillingErrorCode } from '@autowiki/shared';
import { ApiRequestError } from './api';

/** True for plan / quota errors, which link to the pricing page. */
export function needsPlanLink(error: unknown): boolean {
  return error instanceof ApiRequestError && isBillingErrorCode(error.code);
}
