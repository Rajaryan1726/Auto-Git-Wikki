import { z } from 'zod';

export const wikiStateSchema = z.enum(['none', 'generating', 'done', 'failed']);
export type WikiState = z.infer<typeof wikiStateSchema>;

/** Wiki of a repo's last successful index. */
export const wikiStatusSchema = z.object({
  /**
   * none: no wiki for this index yet (e.g. indexed before wikis existed);
   * generating: a run is in progress (pages, if any, are from the previous run);
   * done / failed: state of the newest run for this index.
   */
  state: wikiStateSchema,
  indexJobId: z.string().nullable(),
  commitSha: z.string().nullable(),
  pagesTotal: z.number().nullable(),
  pagesDone: z.number(),
  error: z.string().nullable(),
  /** When the pages shown were generated. */
  generatedAt: z.string().nullable(),
  /** The repo was pushed to after this index started: the wiki may be out of date. */
  stale: z.boolean(),
});
export type WikiStatus = z.infer<typeof wikiStatusSchema>;

export const wikiPageSummarySchema = z.object({
  slug: z.string(),
  title: z.string(),
  parentSlug: z.string().nullable(),
  position: z.number(),
});
export type WikiPageSummary = z.infer<typeof wikiPageSummarySchema>;

export const wikiResponseSchema = z.object({
  wiki: wikiStatusSchema,
  /** Page tree (flat, ordered: parents by position, children right after their parent). */
  pages: z.array(wikiPageSummarySchema),
});
export type WikiResponse = z.infer<typeof wikiResponseSchema>;

export const wikiSourceSchema = z.object({
  path: z.string(),
  startLine: z.number(),
  endLine: z.number(),
});
export type WikiSource = z.infer<typeof wikiSourceSchema>;

export const wikiPageSchema = wikiPageSummarySchema.extend({
  contentMd: z.string(),
  sources: z.array(wikiSourceSchema),
  commitSha: z.string(),
  model: z.string().nullable(),
  generatedAt: z.string(),
});
export type WikiPage = z.infer<typeof wikiPageSchema>;

export const wikiPageResponseSchema = z.object({ page: wikiPageSchema });
export type WikiPageResponse = z.infer<typeof wikiPageResponseSchema>;

export const wikiSlugSchema = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
