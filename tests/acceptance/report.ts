import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { redact } from '../../packages/executor/src/process';
import type { AcceptanceReport } from './schema';

export function sanitize<T>(value: T, secret: string): T {
  if (typeof value === 'string') {
    let clean: string = value;
    if (secret)
      for (const token of new Set([secret, encodeURIComponent(secret)]))
        clean = clean.replaceAll(token, '[REDACTED]');
    return redact(clean) as T;
  }
  if (Array.isArray(value)) return value.map((v) => sanitize(v, secret)) as T;
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = Object.create(null);
    for (const [key, item] of Object.entries(value)) {
      const clean = sanitize(key, secret);
      let unique = clean;
      for (let suffix = 2; Object.hasOwn(result, unique); suffix++) unique = `${clean} (${suffix})`;
      result[unique] = sanitize(item, secret);
    }
    return result as T;
  }
  return value;
}
export async function saveReport(
  report: AcceptanceReport,
  secret: string,
): Promise<AcceptanceReport> {
  const clean = sanitize(report, secret);
  const text = [
    `# ${clean.title}`,
    '',
    `Status: **${clean.status}**; mode: **${clean.mode}**`,
    '',
    clean.reason,
    '',
    `Provider: ${clean.provider?.kind ?? 'unconfigured'} / ${clean.provider?.model ?? 'unconfigured'}`,
    `Started: ${clean.startedAt}; finished: ${clean.finishedAt ?? 'pending'}`,
    `Unanswered input/approval requests: ${clean.interventions}`,
    '',
    ...clean.stages.flatMap((stage, index) => [
      `## Stage ${index + 1}: ${stage.status}`,
      '',
      stage.goal,
      '',
      ...stage.checks.map((check) => `- ${check.status}: ${check.name} — ${check.detail}`),
      '',
    ]),
    '## Limits',
    '',
    ...clean.limitations.map((limit) => `- ${limit}`),
    '',
    'Full task graphs, events, requests, input hashes and versioned evidence are in report.json.',
    '',
  ].join('\n');
  await writeFile(join(report.directory, 'report.json'), JSON.stringify(clean, null, 2), {
    mode: 0o600,
  });
  await writeFile(join(report.directory, 'report.md'), text, { mode: 0o600 });
  return clean;
}
