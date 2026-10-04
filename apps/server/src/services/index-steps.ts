import type { IndexJobStatus, IndexJobStep } from '@autowiki/shared';

/**
 * The ordered indexing pipeline shown in the UI. The server is the source of truth so
 * later phases can insert steps (3B: embedding & saving, 5: generating wiki) without
 * touching the frontend. `weight` is the share of overall progress each step covers.
 */
export const INDEX_STEPS = [
  { id: 'queued', label: 'Queued', weight: 0 },
  { id: 'resolve_commit', label: 'Resolving latest commit', weight: 3 },
  { id: 'list_files', label: 'Listing & filtering files', weight: 4 },
  { id: 'process_files', label: 'Processing files', weight: 90 },
  { id: 'finalize', label: 'Finishing', weight: 3 },
] as const;

export type IndexStepId = (typeof INDEX_STEPS)[number]['id'];

export type StepJobFields = {
  status: IndexJobStatus;
  currentStep: string | null;
  filesTotal: number;
  filesDone: number;
};

function stepIndex(job: StepJobFields): number {
  const i = INDEX_STEPS.findIndex((s) => s.id === job.currentStep);
  return i === -1 ? 0 : i;
}

function filesFraction(job: StepJobFields): number {
  return job.filesTotal > 0 ? Math.min(1, job.filesDone / job.filesTotal) : 0;
}

export function stepLabel(id: string | null): string | null {
  return INDEX_STEPS.find((s) => s.id === id)?.label ?? null;
}

/** Overall progress 0–100, weighted by step; file processing advances smoothly. */
export function jobProgress(job: StepJobFields): number {
  if (job.status === 'done') return 100;
  const total = INDEX_STEPS.reduce((n, s) => n + s.weight, 0);
  const current = stepIndex(job);
  let done = 0;
  INDEX_STEPS.forEach((s, i) => {
    if (i < current) done += s.weight;
  });
  const step = INDEX_STEPS[current]!;
  if (step.id === 'process_files') done += step.weight * filesFraction(job);
  return Math.min(99, Math.round((done / total) * 100));
}

/** The step list with a state per step, as returned by the API. */
export function describeSteps(job: StepJobFields): IndexJobStep[] {
  const current = stepIndex(job);
  return INDEX_STEPS.map((s, i) => {
    let state: IndexJobStep['state'];
    if (job.status === 'done') state = 'done';
    else if (i < current) state = 'done';
    else if (i > current) state = 'pending';
    else state = job.status === 'failed' ? 'failed' : 'current';

    const detail =
      s.id === 'process_files' && job.filesTotal > 0 && state !== 'pending'
        ? `${job.filesDone} / ${job.filesTotal}`
        : null;
    return { id: s.id, label: s.label, state, detail };
  });
}
