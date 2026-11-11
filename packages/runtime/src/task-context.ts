import { open } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import type { Artifact, Evidence } from '../../contracts/src/index';
import type { StoredCall } from '../../persistence/src/index';
import { guardPath } from '../../executor/src/path-guard';
import { hash } from '../../artifacts/src/index';

/** Historical receipts are hints. File facts are re-read under the task's current scope. */
export async function buildTaskContinuation(
  workPath: string,
  calls: StoredCall[],
  artifacts: Artifact[],
) {
  const paths = new Set(artifacts.map((a) => a.relativePath));
  const recentActions = calls.map((call) => {
    for (const key of ['path', 'source']) {
      const value = call.request.args?.[key];
      if (typeof value === 'string') paths.add(value);
    }
    const output = call.result as { files?: unknown } | undefined;
    if (Array.isArray(output?.files)) {
      for (const path of output.files) if (typeof path === 'string') paths.add(path);
    }
    return {
      id: call.id,
      name: call.request.name ?? 'legacy_action',
      state: call.state,
      revision: call.request.revision,
      args: bounded(call.request.args),
      result: bounded(call.result),
    };
  });
  const files: Array<{ path: string; status: string; size?: number; sha256?: string }> = [];
  for (const path of [...paths].slice(0, 32)) {
    try {
      if (isAbsolute(path)) continue;
      const target = await guardPath(
        path,
        { workPath, scope: { readRoots: [], writeRoots: [] } },
        false,
      );
      if (target === resolve(workPath)) continue;
      const handle = await open(target, 'r');
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > 32 * 1024 * 1024) {
          files.push({ path, status: 'unavailable' });
          continue;
        }
        const bytes = await handle.readFile();
        files.push({ path, status: 'present', size: bytes.length, sha256: hash(bytes) });
      } finally {
        await handle.close();
      }
    } catch (error) {
      files.push({
        path,
        status: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unavailable',
      });
    }
  }
  return {
    recentActions,
    files,
    historyMayBeTruncated: calls.length >= 24,
    filesMayBeTruncated: paths.size > 32,
    notice:
      'Historical receipts describe previous attempts, not current file contents. Respect current requirements and user decisions. Inspect current files before acting; do not repeat a completed side effect just because the conversation restarted. Reconciled calls are not proof of success. No pending call is automatically replayed. Only recent evidence summaries are included; full receipts remain in the project history. Use registered file inspection tools when more verification is needed.',
  };
}

/** Keep verification identities without duplicating full historical tool input/output bodies. */
export function summarizeTaskEvidence(evidence: Evidence[]): Evidence[] {
  return evidence.slice(-24).map((entry) => {
    let detail: unknown;
    try {
      const saved = JSON.parse(entry.detail);
      detail = {
        runId: saved.runId,
        name: saved.name,
        args: { path: saved.args?.path, source: saved.args?.source },
        result: {
          ok: saved.result?.ok,
          code: saved.result?.code,
          verdict: saved.result?.verdict,
        },
        verifiedInputs: saved.verifiedInputs,
        verdict: saved.verdict,
        evidenceIds: saved.evidenceIds,
        authorTaskIds: saved.authorTaskIds,
      };
    } catch {
      detail = { preview: entry.detail.slice(0, 1000), truncated: entry.detail.length > 1000 };
    }
    return {
      ...entry,
      summary: entry.summary.slice(0, 1000),
      detail: JSON.stringify(bounded(detail)),
    };
  });
}

function bounded(value: unknown): unknown {
  if (value === undefined) return undefined;
  const text = JSON.stringify(value);
  if (text.length <= 4000) return value;
  const identity: Record<string, unknown> = {};
  if (value && typeof value === 'object') {
    for (const key of [
      'ok',
      'code',
      'evidenceId',
      'requestId',
      'artifactId',
      'versionId',
      'verdict',
    ]) {
      const item = (value as Record<string, unknown>)[key];
      if (typeof item === 'boolean' || (typeof item === 'string' && item.length <= 200))
        identity[key] = item;
    }
    for (const key of ['inputVersionIds', 'verifiedInputs']) {
      const item = (value as Record<string, unknown>)[key];
      if (Array.isArray(item)) identity[key] = item.slice(0, 24);
    }
  }
  return { ...identity, truncated: true, preview: text.slice(0, 3000) };
}
