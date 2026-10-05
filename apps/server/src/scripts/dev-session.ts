/**
 * LOCAL DEVELOPMENT ONLY. Prints a session cookie for an existing user, so the UI can be
 * tested without GitHub OAuth (e.g. in an automated browser). Refuses to run when
 * NODE_ENV=production; not reachable over HTTP.
 *
 *   npm run dev:session -- <github-username|userId> [--out <file>]
 *
 * With --out the token is written to that file instead of the terminal. Set it in the
 * browser for http://localhost:5173 as the `aw_session` cookie (path /).
 */
import { writeFileSync } from 'node:fs';
import { pool } from '../db/client.js';
import { createDevSession } from '../services/dev-session.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf('--out');
  const out = outIdx >= 0 ? args[outIdx + 1] : undefined;
  const who = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--out');
  if (!who) {
    console.error('Usage: npm run dev:session -- <github-username|userId> [--out <file>]');
    process.exit(1);
  }
  const { token, username } = await createDevSession(who);
  if (out) {
    writeFileSync(out, token, { mode: 0o600 });
    console.log(`Session token for ${username} written to ${out} (valid 7 days).`);
  } else {
    console.log(`aw_session=${token}`);
  }
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
