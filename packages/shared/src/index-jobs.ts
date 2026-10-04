import { z } from 'zod';

export const indexJobStatusSchema = z.enum(['queued', 'running', 'done', 'failed']);
export type IndexJobStatus = z.infer<typeof indexJobStatusSchema>;

export const indexStepStateSchema = z.enum(['done', 'current', 'failed', 'pending']);
export type IndexStepState = z.infer<typeof indexStepStateSchema>;

/** One pipeline step as reported by the server; the UI renders whatever list it gets. */
export const indexJobStepSchema = z.object({
  id: z.string(),
  label: z.string(),
  state: indexStepStateSchema,
  /** Extra progress text, e.g. "12 / 340". */
  detail: z.string().nullable(),
});
export type IndexJobStep = z.infer<typeof indexJobStepSchema>;

export const indexJobSchema = z.object({
  id: z.string(),
  repoId: z.string(),
  status: indexJobStatusSchema,
  currentStep: z.string().nullable(),
  /** Label of the step the job is on (or failed on). */
  currentStepLabel: z.string().nullable(),
  commitSha: z.string().nullable(),
  embeddingModel: z.string(),
  embeddingDims: z.number(),
  filesTotal: z.number(),
  filesDone: z.number(),
  /** Null for jobs from before embeddings existed. */
  chunksTotal: z.number().nullable(),
  embeddedChunks: z.number(),
  /** Finished with every chunk embedded and saved: the repo can be searched/chatted with. */
  searchable: z.boolean(),
  stats: z.object({
    embedCalls: z.number().optional(),
    reusedChunks: z.number().optional(),
    rateLimitHits: z.number().optional(),
    rateLimitWaitMs: z.number().optional(),
    skippedFiles: z.number().optional(),
    durationMs: z.number().optional(),
  }),
  /** 0–100. */
  progress: z.number(),
  error: z.string().nullable(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  createdAt: z.string(),
  steps: z.array(indexJobStepSchema),
});
export type IndexJob = z.infer<typeof indexJobSchema>;

export const indexJobResponseSchema = z.object({ job: indexJobSchema });
export type IndexJobResponse = z.infer<typeof indexJobResponseSchema>;

export const indexJobListResponseSchema = z.object({ jobs: z.array(indexJobSchema) });
export type IndexJobListResponse = z.infer<typeof indexJobListResponseSchema>;

export const activeIndexJobSchema = indexJobSchema.extend({
  repo: z.object({ id: z.string(), name: z.string(), fullName: z.string() }),
});
export type ActiveIndexJob = z.infer<typeof activeIndexJobSchema>;

export const activeIndexJobsResponseSchema = z.object({ jobs: z.array(activeIndexJobSchema) });
export type ActiveIndexJobsResponse = z.infer<typeof activeIndexJobsResponseSchema>;
