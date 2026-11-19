import { chmod, mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Artifact, ProjectSnapshot } from '../../packages/contracts/src/index';
import { artifactVersionHistory } from '../../packages/artifacts/src/history';
import { blobPath, publishArtifact } from '../../packages/artifacts/src/index';
import { createExecutor } from '../../packages/executor/src/index';
import { RuntimeStore } from '../../packages/persistence/src/index';
import { createRuntime } from '../../packages/runtime/src/index';

const createdAt = '2026-11-19T00:00:00.000Z';
const commissionId = 'commission';
const fixtures: string[] = [];
afterEach(async () => {
  for (const root of fixtures.splice(0)) await rm(root, { recursive: true, force: true });
});

function snapshot(artifacts: Artifact[], events: ProjectSnapshot['events'] = []): ProjectSnapshot {
  return {
    commission: {
      id: commissionId,
      workspaceId: 'workspace',
      title: 'Comparison',
      goal: 'Compare versions',
      status: 'accepted',
      criteria: [],
      scope: {
        readRoots: [],
        writeRoots: [],
        allowProcess: false,
        allowNetwork: false,
        allowedHosts: [],
      },
      budget: { maxSteps: 10, maxMinutes: 1, maxRework: 1 },
      revision: 1,
      planningMode: 'auto',
      stepsUsed: 0,
      createdAt,
      updatedAt: createdAt,
      acceptedArtifactIds: [],
      summary: '',
    },
    workspace: {
      id: 'workspace',
      name: 'Comparison',
      sourcePath: '',
      workPath: '',
      createdAt,
    },
    agents: [],
    tasks: [],
    artifacts,
    evidence: [],
    events,
    requests: [],
    lastSequence: events.length,
  };
}

function record(versionId: string, taskId: string, relativePath: string): Artifact {
  return {
    id: `artifact-${versionId}`,
    versionId,
    commissionId,
    taskId,
    name: 'Report',
    relativePath,
    mediaType: 'text/plain',
    sha256: 'a'.repeat(64),
    size: 0,
    createdAt,
    inputVersions: [],
    validity: 'current',
  };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'astrisle-version-review-'));
  fixtures.push(root);
  const dataRoot = join(root, 'runtime');
  const workPath = join(root, 'mutable');
  async function publish(file: string, content: string | Buffer, mediaType = 'text/plain') {
    const path = join(workPath, file);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
    return publishArtifact(dataRoot, workPath, file, {
      commissionId,
      taskId: 'author',
      name: 'Report',
      mediaType,
      inputVersions: [],
    });
  }
  async function compare(artifacts: Artifact[], from: Artifact, to: Artifact) {
    const store = new RuntimeStore(dataRoot);
    const saved = snapshot(artifacts);
    if (!store.workspaces().length) store.addWorkspace(saved.workspace);
    store.save(saved);
    store.close();
    const runtime = createRuntime({
      dataRoot,
      executor: createExecutor({ projectRoot: process.cwd() }),
      getCredentials: async () => null,
    });
    try {
      return await runtime.compareArtifacts({
        commissionId,
        fromVersionId: from.versionId,
        toVersionId: to.versionId,
      });
    } finally {
      await runtime.close();
    }
  }
  return { dataRoot, workPath, publish, compare };
}

describe('artifact version review', () => {
  it('groups full paths within author lineage and uses explicit, earlier version ancestry', () => {
    const original = record('first', 'old-task', 'out/summary.txt');
    const otherTask = record('unrelated', 'other-task', 'out/summary.txt');
    const otherPath = record('other-path', 'old-task', 'backup/summary.txt');
    const otherCase = record('other-case', 'old-task', 'out/Summary.txt');
    const republished = record('second', 'old-task', 'out/summary.txt');
    const automaticRework = record('third', 'rework-task', 'out/summary.txt');
    const directedRework = {
      ...record('fourth', 'directed-task', 'new/summary.txt'),
      previousVersionId: automaticRework.versionId,
    };
    const foreign = { ...record('foreign', 'old-task', 'out/summary.txt'), commissionId: 'other' };
    const forward = {
      ...record('forward', 'forward-task', 'out/summary.txt'),
      previousVersionId: 'fourth',
    };
    const saved = snapshot(
      [
        original,
        otherTask,
        otherPath,
        otherCase,
        republished,
        automaticRework,
        forward,
        directedRework,
        foreign,
      ],
      [
        {
          id: 'event',
          commissionId,
          sequence: 1,
          type: 'rework_created',
          message: 'Linked rework-task to old-task',
          taskId: 'rework-task',
          createdAt,
        },
      ],
    );
    expect(artifactVersionHistory(saved, directedRework.versionId)).toEqual([
      original,
      republished,
      automaticRework,
      directedRework,
    ]);
    for (const artifact of [otherTask, otherPath, otherCase, forward]) {
      expect(artifactVersionHistory(saved, artifact.versionId)).toEqual([artifact]);
    }
    expect(artifactVersionHistory(saved, foreign.versionId)).toEqual([]);
  });

  it('compares any two genuine versions from immutable bytes with numbered context', async () => {
    const f = await fixture();
    const from = await f.publish('report.txt', 'head\nold\nend\n');
    const middle = await f.publish('report.txt', 'irrelevant intermediate');
    const to = await f.publish('report.txt', 'head\nnew\nmore\nend\n');
    await writeFile(join(f.workPath, 'report.txt'), 'This worktree is mutable');
    const comparison = await f.compare([{ ...from, validity: 'stale' }, middle, to], from, to);
    expect(comparison).toMatchObject({
      from: { ...from, validity: 'stale' },
      to,
      kind: 'text',
      truncated: false,
    });
    expect(comparison.hunks).toEqual([
      {
        lines: [
          { kind: 'context', text: 'head', oldLine: 1, newLine: 1 },
          { kind: 'deletion', text: 'old', oldLine: 2 },
          { kind: 'addition', text: 'new', newLine: 2 },
          { kind: 'addition', text: 'more', newLine: 3 },
          { kind: 'context', text: 'end', oldLine: 3, newLine: 4 },
        ],
      },
    ]);
  });

  it('rejects unknown, duplicate, cross-family, cross-commission, equal and reversed version IDs', async () => {
    const f = await fixture();
    const first = await f.publish('report.txt', 'first');
    const second = await f.publish('report.txt', 'second');
    await expect(f.compare([first], first, second)).rejects.toThrow();
    await expect(f.compare([first, second, second], first, second)).rejects.toThrow();
    await expect(
      f.compare([first, { ...second, taskId: 'other' }], first, second),
    ).rejects.toThrow();
    await expect(
      f.compare([first, { ...second, commissionId: 'other' }], first, second),
    ).rejects.toThrow();
    await expect(f.compare([first, second], first, first)).rejects.toThrow();
    await expect(f.compare([first, second], second, first)).rejects.toThrow();
  });

  it('reports verified unchanged, missing and corrupt historical content', async () => {
    const f = await fixture();
    const first = await f.publish('report.txt', 'original');
    const identical = await f.publish('report.txt', 'original');
    const changed = await f.publish('report.txt', 'changed');
    await expect(f.compare([first, identical], first, identical)).resolves.toMatchObject({
      kind: 'unchanged',
      truncated: false,
      hunks: [],
    });
    const path = blobPath(f.dataRoot, first.sha256);
    await chmod(path, 0o666);
    await writeFile(path, 'tampered');
    await expect(f.compare([first, changed], first, changed)).resolves.toMatchObject({
      kind: 'unavailable',
      reason: 'integrity-mismatch',
    });
    await unlink(path);
    await expect(f.compare([first, changed], first, changed)).resolves.toMatchObject({
      kind: 'unavailable',
      reason: 'missing-version',
    });
  });

  it('handles Office and non-text bytes, empty text and changes limited to line endings', async () => {
    const f = await fixture();
    const office1 = await f.publish('report.docx', 'Even valid UTF-8 is classified by known type.');
    const office2 = await f.publish('report.docx', 'Different');
    const binary1 = await f.publish('report.txt', Buffer.from([0, 1, 2]));
    const binary2 = await f.publish('report.txt', Buffer.from([255, 32, 2]));
    const empty = await f.publish('report.md', '');
    const text = await f.publish('report.md', 'note\n');
    const crlf = await f.publish('report.md', '\uFEFFnote\r\n');
    for (const [from, to] of [
      [office1, office2],
      [binary1, binary2],
    ]) {
      await expect(f.compare([from, to], from, to)).resolves.toMatchObject({
        kind: 'binary',
        hunks: [],
      });
    }
    await expect(f.compare([empty, text], empty, text)).resolves.toMatchObject({
      kind: 'text',
      hunks: [{ lines: [{ kind: 'addition', text: 'note', newLine: 1 }] }],
    });
    await expect(f.compare([text, crlf], text, crlf)).resolves.toMatchObject({
      kind: 'text',
      reason: 'text-normalization',
      hunks: [],
      truncated: false,
    });
  });

  it('bounds large comparisons and preserves useful hunks around distant changes', async () => {
    const f = await fixture();
    const lines = Array.from({ length: 6_000 }, (_, i) => `line ${i + 1}`);
    const from = await f.publish('report.txt', lines.join('\n'));
    lines[4] = 'first change';
    lines[5_900] = 'second change';
    const to = await f.publish('report.txt', lines.join('\n'));
    const result = await f.compare([from, to], from, to);
    expect(result).toMatchObject({ kind: 'text', truncated: false });
    expect(
      result.hunks.map((hunk) => hunk.lines.filter((line) => line.kind === 'addition')),
    ).toEqual([
      [{ kind: 'addition', text: 'first change', newLine: 5 }],
      [{ kind: 'addition', text: 'second change', newLine: 5_901 }],
    ]);
    const large = await f.publish('report.txt', 'a'.repeat(1_000_000));
    await expect(f.compare([to, large], to, large)).resolves.toMatchObject({
      kind: 'text',
      reason: 'input-limit',
      truncated: true,
    });
    const longLine = await f.publish('report.txt', 'a'.repeat(200_000));
    const replacedLine = await f.publish('report.txt', 'b'.repeat(200_000));
    const output = await f.compare([longLine, replacedLine], longLine, replacedLine);
    expect(output).toMatchObject({ kind: 'text', reason: 'output-limit', truncated: true });
    expect(output.hunks[0].lines).toHaveLength(2);
    expect(
      output.hunks[0].lines.map((line) => line.text.length).reduce((a, b) => a + b),
    ).toBeLessThan(65_536);
    const totallyDifferent = await f.publish('report.txt', 'different\n'.repeat(600));
    const fallback = await f.compare([to, totallyDifferent], to, totallyDifferent);
    expect(fallback).toMatchObject({ kind: 'text', reason: 'work-limit', truncated: true });
    expect(fallback.hunks.flatMap((hunk) => hunk.lines).map((line) => line.kind)).toContain(
      'addition',
    );
  });
});
