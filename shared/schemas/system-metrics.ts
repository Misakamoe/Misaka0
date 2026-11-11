import { z } from 'zod';

const bytes = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const value = z.number().nonnegative();
const limitState = z.enum(['limited', 'unlimited', 'unavailable']);
const groupScope = z.enum(['current', 'ancestor', 'unavailable']);

export const systemMetricsSchema = z.strictObject({
  sampledAt: z.iso.datetime(),
  intervalSeconds: value.nullable(),
  process: z.strictObject({
    cpuPercent: value.nullable(),
    rssBytes: bytes,
    heapUsedBytes: bytes,
    heapTotalBytes: bytes,
    heapLimitBytes: bytes,
    externalBytes: bytes,
    arrayBuffersBytes: bytes,
    uptimeSeconds: value,
  }),
  system: z.strictObject({
    logicalCpus: z.number().int().positive().nullable(),
    availableCpus: z.number().int().positive().nullable(),
    cpuPercent: value.max(100).nullable(),
    loadAverage: z.tuple([value, value, value]).nullable(),
    memoryTotalBytes: bytes,
    memoryAvailableBytes: bytes.nullable(),
    memoryFreeBytes: bytes,
    uptimeSeconds: value,
  }),
  cgroup: z.strictObject({
    version: z.enum(['v2', 'v1', 'unavailable']),
    state: z.enum(['available', 'partial', 'unavailable']),
    cpuPercent: value.nullable(),
    cpuIntervalSeconds: value.nullable(),
    cpuQuotaCores: value.nullable(),
    cpuLimit: limitState,
    cpuScope: groupScope,
    memoryCurrentBytes: bytes.nullable(),
    memoryPeakBytes: bytes.nullable(),
    memoryLimitBytes: bytes.nullable(),
    memoryLimit: limitState,
    memoryScope: groupScope,
    swapCurrentBytes: bytes.nullable(),
    swapLimitBytes: bytes.nullable(),
    swapLimit: limitState,
    pidsCurrent: bytes.nullable(),
    pidsLimit: bytes.nullable(),
    pidsLimitState: limitState,
    pidsScope: groupScope,
  }),
});
export type SystemMetricsSnapshot = z.infer<typeof systemMetricsSchema>;
