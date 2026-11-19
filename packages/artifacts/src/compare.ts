import type {
  Artifact,
  ArtifactComparison,
  ArtifactComparisonInput,
  ArtifactDiffHunk,
  ArtifactDiffLine,
  ProjectSnapshot,
} from '../../contracts/src/index';
import { readVersionBytes } from './index';
import { artifactVersionHistory } from './history';

const MAX_BLOB_BYTES = 256 * 1_024;
const MAX_LINES = 8_000;
const MAX_EDIT_DISTANCE = 256;
const MAX_DIFF_WORK = 1_000_000;
const CONTEXT_LINES = 3;
const MAX_OUTPUT_LINES = 400;
const MAX_OUTPUT_BYTES = 64 * 1_024;
const MAX_LINE_CHARACTERS = 4_096;

function isDeclaredBinary(artifact: Artifact): boolean {
  return (
    /\.(?:doc[xmb]?|xls[xmb]?|ppt[xmb]?|od[fgpst]|pdf|png|jpe?g|gif|webp|bmp|ico|zip|tar|gz|7z|rar|wasm|exe|dll)$/i.test(
      artifact.relativePath,
    ) ||
    /^(?:(?:audio|video)\/|image\/(?!svg\+xml)|application\/(?:pdf|zip|msword|vnd\.(?:openxmlformats-officedocument|ms-|oasis\.opendocument)))/i.test(
      artifact.mediaType,
    )
  );
}

function isDeclaredText(artifact: Artifact): boolean {
  return (
    /^(?:text\/|application\/(?:json|javascript|xml|yaml|x-yaml)|image\/svg\+xml)/i.test(
      artifact.mediaType,
    ) || /\.(?:md|txt|json|ya?ml|ts|tsx|js|py|css|html|csv|svg|xml)$/i.test(artifact.relativePath)
  );
}

function decodeText(artifact: Artifact, bytes: Buffer): string | undefined {
  if (isDeclaredBinary(artifact) || bytes.subarray(0, 5).toString() === '%PDF-') return;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    // Tabs and all common newline styles are allowed. Other control bytes indicate a binary payload.
    if (!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(text)) return text;
  } catch {
    // Invalid UTF-8 is shown through file metadata.
  }
}

function splitLines(text: string): string[] {
  const lines = text.split(/\r\n|\n|\r/, MAX_LINES + 2);
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

function context(text: string, oldLine: number, newLine: number): ArtifactDiffLine {
  return { kind: 'context', text, oldLine, newLine };
}

function deletion(text: string, oldLine: number): ArtifactDiffLine {
  return { kind: 'deletion', text, oldLine };
}

function addition(text: string, newLine: number): ArtifactDiffLine {
  return { kind: 'addition', text, newLine };
}

function fromInsertion(diagonal: number, edits: number, frontier: Int32Array): boolean {
  const center = MAX_EDIT_DISTANCE + 1;
  return (
    diagonal === -edits ||
    (diagonal !== edits && frontier[center + diagonal - 1] < frontier[center + diagonal + 1])
  );
}

function backtrack(
  trace: Int32Array[],
  before: string[],
  after: string[],
  prefix: number,
): ArtifactDiffLine[] {
  const lines: ArtifactDiffLine[] = [];
  let x = before.length;
  let y = after.length;
  for (let edits = trace.length - 1; edits >= 0; edits--) {
    const diagonal = x - y;
    const inserted = fromInsertion(diagonal, edits, trace[edits]);
    const previousDiagonal = diagonal + (inserted ? 1 : -1);
    const previousX = trace[edits][MAX_EDIT_DISTANCE + 1 + previousDiagonal];
    const previousY = previousX - previousDiagonal;
    while (x > previousX && y > previousY) {
      lines.push(context(before[x - 1], prefix + x, prefix + y));
      x--;
      y--;
    }
    if (edits === 0) break;
    if (inserted) {
      lines.push(addition(after[y - 1], prefix + y));
      y--;
    } else {
      lines.push(deletion(before[x - 1], prefix + x));
      x--;
    }
  }
  return lines.reverse();
}

/** Myers shortest edit script, with a cap on both the frontier and the number of comparisons. */
function findChanges(
  before: string[],
  after: string[],
  prefix: number,
): ArtifactDiffLine[] | undefined {
  if (!before.length) return after.map((text, index) => addition(text, prefix + index + 1));
  if (!after.length) return before.map((text, index) => deletion(text, prefix + index + 1));
  const center = MAX_EDIT_DISTANCE + 1;
  const frontier = new Int32Array(2 * center + 1);
  const trace: Int32Array[] = [];
  if (Math.abs(before.length - after.length) > MAX_EDIT_DISTANCE) return;
  const lineIds = new Map<string, number>();
  function lineId(text: string): number {
    const existing = lineIds.get(text);
    if (existing !== undefined) return existing;
    const next = lineIds.size;
    lineIds.set(text, next);
    return next;
  }
  const oldIds = before.map(lineId);
  const newIds = after.map(lineId);
  let work = 0;
  for (let edits = 0; edits <= MAX_EDIT_DISTANCE; edits++) {
    trace.push(frontier.slice());
    for (let diagonal = -edits; diagonal <= edits; diagonal += 2) {
      if (++work > MAX_DIFF_WORK) return;
      let x = fromInsertion(diagonal, edits, frontier)
        ? frontier[center + diagonal + 1]
        : frontier[center + diagonal - 1] + 1;
      let y = x - diagonal;
      while (x < before.length && y < after.length && oldIds[x] === newIds[y]) {
        if (++work > MAX_DIFF_WORK) return;
        x++;
        y++;
      }
      frontier[center + diagonal] = x;
      if (x >= before.length && y >= after.length) return backtrack(trace, before, after, prefix);
    }
  }
}

function renderHunks(lines: ArtifactDiffLine[]): { hunks: ArtifactDiffHunk[]; clipped: boolean } {
  const ranges: Array<{ start: number; end: number }> = [];
  for (let index = 0; index < lines.length; index++) {
    if (lines[index].kind === 'context') continue;
    const start = Math.max(0, index - CONTEXT_LINES);
    const end = Math.min(lines.length, index + CONTEXT_LINES + 1);
    const previous = ranges.at(-1);
    if (previous && start <= previous.end) previous.end = end;
    else ranges.push({ start, end });
  }
  const hunks: ArtifactDiffHunk[] = [];
  let remainingLines = MAX_OUTPUT_LINES;
  let remainingBytes = MAX_OUTPUT_BYTES;
  let clipped = false;
  for (const { start, end } of ranges) {
    const hunk: ArtifactDiffHunk = { lines: [] };
    hunks.push(hunk);
    for (let index = start; index < end; index++) {
      let line = lines[index];
      if (line.text.length > MAX_LINE_CHARACTERS) {
        const excerpt = line.text.slice(0, MAX_LINE_CHARACTERS).replace(/[\uD800-\uDBFF]$/, '');
        line = { ...line, text: `${excerpt}…` };
        clipped = true;
      }
      const size = Buffer.byteLength(JSON.stringify(line)) + 1;
      if (remainingLines === 0 || size > remainingBytes) {
        if (!hunk.lines.length) hunks.pop();
        return { hunks, clipped: true };
      }
      hunk.lines.push(line);
      remainingLines--;
      remainingBytes -= size;
    }
  }
  return { hunks, clipped };
}

function compareText(
  beforeText: string,
  afterText: string,
): Pick<ArtifactComparison, 'hunks' | 'truncated' | 'reason'> {
  const before = splitLines(beforeText);
  const after = splitLines(afterText);
  if (before.length > MAX_LINES || after.length > MAX_LINES)
    return { hunks: [], truncated: true, reason: 'line-limit' };
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix])
    prefix++;
  if (prefix === before.length && prefix === after.length)
    return { hunks: [], truncated: false, reason: 'text-normalization' };
  let suffix = 0;
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - suffix - 1] === after[after.length - suffix - 1]
  )
    suffix++;
  const beforeMiddle = before.slice(prefix, before.length - suffix);
  const afterMiddle = after.slice(prefix, after.length - suffix);
  const leadStart = Math.max(0, prefix - CONTEXT_LINES);
  const leading = before
    .slice(leadStart, prefix)
    .map((text, index) => context(text, leadStart + index + 1, leadStart + index + 1));
  const changes = findChanges(beforeMiddle, afterMiddle, prefix);
  if (!changes) {
    // Show both sides of the unaligned changed region, with a work-limit warning.
    const excerpt = 40;
    const removed = beforeMiddle
      .slice(0, excerpt)
      .map((text, index) => deletion(text, prefix + index + 1));
    const added = afterMiddle
      .slice(0, excerpt)
      .map((text, index) => addition(text, prefix + index + 1));
    const { hunks } = renderHunks([...leading, ...removed, ...added]);
    return { hunks, truncated: true, reason: 'work-limit' };
  }
  const trailing = before
    .slice(before.length - suffix, before.length - suffix + Math.min(suffix, CONTEXT_LINES))
    .map((text, index) =>
      context(text, before.length - suffix + index + 1, after.length - suffix + index + 1),
    );
  const { hunks, clipped } = renderHunks([...leading, ...changes, ...trailing]);
  return { hunks, truncated: clipped, ...(clipped && { reason: 'output-limit' }) };
}

export async function compareArtifactVersions(
  dataRoot: string,
  snapshot: ProjectSnapshot,
  input: ArtifactComparisonInput,
): Promise<ArtifactComparison> {
  if (snapshot.commission.id !== input.commissionId)
    throw new Error('Artifact versions must belong to the selected commission');
  const family = artifactVersionHistory(snapshot, input.fromVersionId);
  const fromIndex = family.findIndex((version) => version.versionId === input.fromVersionId);
  const toIndex = family.findIndex((version) => version.versionId === input.toVersionId);
  if (fromIndex < 0 || toIndex < 0)
    throw new Error('Both versions must belong to the same artifact history');
  if (fromIndex >= toIndex)
    throw new Error('Select an earlier version and a later version to compare');
  const from = family[fromIndex];
  const to = family[toIndex];
  const result = { from, to, hunks: [], truncated: false };
  const [before, after] = await Promise.all([
    readVersionBytes(dataRoot, from, MAX_BLOB_BYTES),
    readVersionBytes(dataRoot, to, MAX_BLOB_BYTES),
  ]);
  for (const blob of [before, after]) {
    if (typeof blob === 'string' && blob !== 'input-limit')
      return { ...result, kind: 'unavailable', reason: blob };
  }
  if (Buffer.isBuffer(before) && Buffer.isBuffer(after) && from.sha256 === to.sha256)
    return { ...result, kind: 'unchanged' };
  const beforeText = Buffer.isBuffer(before) ? decodeText(from, before) : undefined;
  const afterText = Buffer.isBuffer(after) ? decodeText(to, after) : undefined;
  if (before === 'input-limit' || after === 'input-limit') {
    const binary =
      isDeclaredBinary(from) ||
      isDeclaredBinary(to) ||
      (Buffer.isBuffer(before) && beforeText === undefined) ||
      (Buffer.isBuffer(after) && afterText === undefined);
    const text =
      (before === 'input-limit' ? isDeclaredText(from) : beforeText !== undefined) &&
      (after === 'input-limit' ? isDeclaredText(to) : afterText !== undefined);
    return {
      ...result,
      kind: binary ? 'binary' : text ? 'text' : 'unavailable',
      truncated: true,
      reason: 'input-limit',
    };
  }
  if (beforeText === undefined || afterText === undefined) return { ...result, kind: 'binary' };
  return { from, to, kind: 'text', ...compareText(beforeText, afterText) };
}
