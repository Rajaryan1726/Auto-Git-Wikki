import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DevOnlyError, assertNotProduction, createDevSession } from './dev-session.js';

const SRC = fileURLToPath(new URL('..', import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.ts$/.test(name) && !/\.test\.ts$/.test(name) ? [path] : [];
  });
}

const rel = (p: string) => relative(SRC, p).replace(/\\/g, '/');

test('the dev session refuses to run in production, before touching the database', async () => {
  assert.throws(() => assertNotProduction('x', 'production'), DevOnlyError);
  assert.doesNotThrow(() => assertNotProduction('x', 'development'));
  // A user that does not exist would make the DB lookup throw a different error: getting
  // DevOnlyError proves the guard runs first.
  await assert.rejects(createDevSession('no-such-user', 'production'), DevOnlyError);
});

test('session tokens are only created by the OAuth callback and the dev-session module', () => {
  const minting = sourceFiles(SRC)
    // Calls only: the definition in services/session.ts is `function createSessionToken(`.
    .filter((f) => /(?<!function )\bcreateSessionToken\s*\(/.test(readFileSync(f, 'utf8')))
    .map(rel)
    .sort();
  assert.deepEqual(minting, ['routes/auth.ts', 'services/dev-session.ts']);
});

test('no HTTP code imports the dev-session module (only the dev script)', () => {
  const importers = sourceFiles(SRC)
    .filter((f) => /from ['"][./]+(services\/)?dev-session\.js['"]/.test(readFileSync(f, 'utf8')))
    .map(rel);
  assert.deepEqual(importers, ['scripts/dev-session.ts']);
  // And nothing reachable from the app imports scripts/.
  const reachable = sourceFiles(SRC).filter((f) => !rel(f).startsWith('scripts/'));
  for (const f of reachable) {
    assert.doesNotMatch(readFileSync(f, 'utf8'), /from ['"][./]+scripts\//, rel(f));
  }
});
