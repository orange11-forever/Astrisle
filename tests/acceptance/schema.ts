import { z } from 'zod';
import type { ProjectSnapshot } from '../../packages/contracts/src/index';

export const relativePath = z
  .string()
  .min(1)
  .max(240)
  .refine(
    (value) =>
      !/[\\:\x00-\x1f]/.test(value) &&
      value.split('/').every((part) => part && part !== '.' && part !== '..'),
    'Expected a relative path without traversal',
  );
const assertion = z
  .object({
    at: z.array(z.union([z.string(), z.number().int().nonnegative()])).max(20),
    equals: z.unknown(),
  })
  .strict();
export const checkSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), path: relativePath, equals: z.string().max(65536) }).strict(),
  z.object({ kind: z.literal('json'), path: relativePath, equals: z.unknown() }).strict(),
  z
    .object({
      kind: z.literal('node'),
      path: relativePath,
      input: z.string().max(65536).default(''),
      json: z.unknown(),
      exitCode: z.number().int().min(0).max(255).default(0),
    })
    .strict(),
  z
    .object({
      kind: z.literal('office'),
      path: relativePath,
      assertions: z.array(assertion).min(1).max(100),
      sums: z
        .array(z.object({ sheet: z.string(), range: z.string(), sum: z.number() }).strict())
        .max(100)
        .default([]),
    })
    .strict(),
]);
export const scenarioSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
    title: z.string().min(1).max(200),
    seed: z.record(relativePath, z.string().max(65536)).default({}),
    officeSeed: z
      .array(
        z
          .object({
            path: relativePath,
            format: z.enum(['docx', 'xlsx', 'pptx']),
            content: z.record(z.string(), z.unknown()),
          })
          .strict(),
      )
      .max(10)
      .default([]),
    stages: z
      .array(
        z
          .object({
            goal: z.string().min(1).max(32000),
            criteria: z.array(z.string().min(1).max(2000)).min(1).max(30),
            checks: z.array(checkSchema).min(1).max(50),
          })
          .strict(),
      )
      .min(1)
      .max(5),
  })
  .strict()
  .refine((s) => Object.keys(s.seed).length <= 100, 'Too many input files');
export type AcceptanceScenario = z.infer<typeof scenarioSchema>;
export type DeliverableCheck = z.infer<typeof checkSchema>;
export type CheckRecord = { name: string; status: 'passed' | 'failed'; detail: string };
export type AcceptanceStatus = 'passed' | 'failed' | 'blocked' | 'cancelled' | 'not_run';
export interface StageReport {
  goal: string;
  status: AcceptanceStatus;
  checks: CheckRecord[];
  snapshot?: ProjectSnapshot;
  exportHashes?: Record<string, string>;
}
export interface AcceptanceReport {
  schemaVersion: 1;
  scenarioId: string;
  title: string;
  mode: 'live' | 'scripted';
  directory: string;
  startedAt: string;
  runnerSha256?: string;
  finishedAt?: string;
  status: AcceptanceStatus;
  reason: string;
  provider: { kind: string; baseUrl: string; model: string } | null;
  inputHashes: Record<string, string>;
  stages: StageReport[];
  interventions: number;
  limits: { maxSteps: number; maxMinutes: number; maxRework: number; timeoutMs: number };
  limitations: string[];
}
