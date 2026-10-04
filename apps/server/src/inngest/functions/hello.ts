import { inngest } from '../client.js';

/** Smoke-test function: send `test/hello` from the Inngest dev UI to run it. */
export const hello = inngest.createFunction(
  { id: 'hello', triggers: [{ event: 'test/hello' }] },
  async ({ event, step }) => {
    const greeting = await step.run('build-greeting', () => {
      const data = (event.data ?? {}) as { name?: unknown };
      const name = typeof data.name === 'string' ? data.name : 'world';
      return `Hello, ${name}!`;
    });
    return { greeting };
  },
);
