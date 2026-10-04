import { Inngest } from 'inngest';
import { env } from '../lib/env.js';

export const inngest = new Inngest({
  id: 'autowiki',
  // Talk to the local `inngest-cli dev` server unless we are in production.
  isDev: env.NODE_ENV !== 'production',
  eventKey: env.INNGEST_EVENT_KEY,
  signingKey: env.INNGEST_SIGNING_KEY,
});
