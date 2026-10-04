import { z } from 'zod';

export const serviceStatusSchema = z.object({
  status: z.enum(['ok', 'error']),
  latencyMs: z.number().optional(),
  message: z.string().optional(),
});

export const healthResponseSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  services: z.object({
    database: serviceStatusSchema,
    qdrant: serviceStatusSchema,
  }),
  timestamp: z.string(),
});

export type ServiceStatus = z.infer<typeof serviceStatusSchema>;
export type HealthResponse = z.infer<typeof healthResponseSchema>;
