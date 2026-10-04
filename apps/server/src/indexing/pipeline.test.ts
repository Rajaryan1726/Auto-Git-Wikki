import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HttpError } from '../lib/http-error.js';
import { GithubRateLimitError } from '../services/github-api.js';
import { RepoAccessLostError, RepoEmptyError } from '../services/github-index.js';
import { INDEX_STEPS, describeSteps, jobProgress } from '../services/index-steps.js';
import { classifyIndexError } from './errors.js';

test('classifyIndexError fails fast on permanent problems', () => {
  const lost = classifyIndexError(new RepoAccessLostError());
  assert.equal(lost.action, 'fail');
  assert.match(lost.message, /deleted or AutoWiki lost access/);

  assert.equal(classifyIndexError(new RepoEmptyError()).action, 'fail');

  const reauth = classifyIndexError(new HttpError(401, 'GITHUB_REAUTH_REQUIRED', 'x'));
  assert.equal(reauth.action, 'fail');
  assert.match(reauth.message, /Sign in again/);
});

test('classifyIndexError waits for a rate limit reset, unless it is too far away', () => {
  const now = Date.now();
  const soon = new GithubRateLimitError('limited', new Date(now + 10 * 60_000));
  const decision = classifyIndexError(soon, now);
  assert.equal(decision.action, 'retry_at');
  assert.equal(decision.action === 'retry_at' && decision.retryAt.getTime(), now + 10 * 60_000);

  const far = new GithubRateLimitError('limited', new Date(now + 3 * 60 * 60_000));
  assert.equal(classifyIndexError(far, now).action, 'fail');
});

test('classifyIndexError retries unknown errors', () => {
  const decision = classifyIndexError(new Error('socket hang up'));
  assert.deepEqual(decision, { action: 'retry', message: 'Indexing failed: socket hang up' });
});

const job = (over: Partial<Parameters<typeof describeSteps>[0]>) => ({
  status: 'running' as const,
  currentStep: 'process_files',
  filesTotal: 10,
  filesDone: 4,
  ...over,
});

test('describeSteps marks done/current/pending and file detail', () => {
  const steps = describeSteps(job({}));
  assert.deepEqual(
    steps.map((s) => s.state),
    ['done', 'done', 'done', 'current', 'pending'],
  );
  assert.equal(steps.find((s) => s.id === 'process_files')!.detail, '4 / 10');
  assert.equal(steps.length, INDEX_STEPS.length);
});

test('describeSteps shows the failed step and all-done', () => {
  const failed = describeSteps(job({ status: 'failed', currentStep: 'list_files' }));
  assert.deepEqual(
    failed.map((s) => s.state),
    ['done', 'done', 'failed', 'pending', 'pending'],
  );
  assert.ok(describeSteps(job({ status: 'done' })).every((s) => s.state === 'done'));
  const queued = describeSteps(job({ status: 'queued', currentStep: 'queued', filesTotal: 0 }));
  assert.equal(queued[0]!.state, 'current');
});

test('jobProgress is monotonic across steps and capped below 100 until done', () => {
  const values = [
    jobProgress(job({ status: 'queued', currentStep: 'queued', filesDone: 0 })),
    jobProgress(job({ currentStep: 'resolve_commit', filesDone: 0 })),
    jobProgress(job({ currentStep: 'list_files', filesDone: 0 })),
    jobProgress(job({ filesDone: 0 })),
    jobProgress(job({ filesDone: 5 })),
    jobProgress(job({ filesDone: 10 })),
    jobProgress(job({ currentStep: 'finalize', filesDone: 10 })),
  ];
  for (let i = 1; i < values.length; i++) assert.ok(values[i]! >= values[i - 1]!, String(values));
  assert.ok(values.every((v) => v < 100));
  assert.equal(jobProgress(job({ status: 'done' })), 100);
});
