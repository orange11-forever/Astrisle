import type { Artifact, Evidence, Scope } from '../../contracts/src/index';
import {
  isSearchEndpoint,
  isSearchServiceUrl,
  isSourceHostname,
} from '../../contracts/src/web-research';
import { redact } from '../../executor/src/process';

export const maxArtifactWebSources = 8;
type WebSource = NonNullable<Artifact['webSources']>[number];
type WebRead = WebSource & { inputVersionIds: string[] };

export function canSearchWeb(scope: Scope): boolean {
  return (
    scope.allowNetwork &&
    scope.allowedHosts.some(isSourceHostname) &&
    typeof scope.searchEndpoint === 'string' &&
    isSearchEndpoint(scope.searchEndpoint)
  );
}

function webRead(evidence: Evidence, scope: Scope): WebRead | undefined {
  if (!scope.allowNetwork || evidence.kind !== 'tool' || evidence.status !== 'passed') return;
  try {
    const receipt = JSON.parse(evidence.detail);
    const metadata = receipt.result?.metadata;
    if (
      receipt.name !== 'web_read' ||
      receipt.result?.ok !== true ||
      typeof receipt.result.output !== 'string' ||
      !receipt.result.output.trim() ||
      typeof metadata?.url !== 'string' ||
      metadata.url.length > 2048 ||
      !Number.isInteger(metadata.status) ||
      metadata.status < 200 ||
      metadata.status >= 300
    )
      return;
    const url = new URL(metadata.url);
    const endpoint =
      scope.searchEndpoint && isSearchEndpoint(scope.searchEndpoint)
        ? new URL(scope.searchEndpoint)
        : undefined;
    const requested = typeof receipt.args?.url === 'string' ? URL.parse(receipt.args.url) : null;
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      redact(url.href) !== url.href ||
      !scope.allowedHosts.some((host) => host.toLowerCase() === url.hostname.toLowerCase()) ||
      (endpoint &&
        (isSearchServiceUrl(url, endpoint) ||
          (requested && isSearchServiceUrl(requested, endpoint))))
    )
      return;
    return {
      url: url.href,
      evidenceId: evidence.id,
      inputVersionIds: Array.isArray(receipt.inputVersionIds) ? receipt.inputVersionIds : [],
    };
  } catch {
    // Older records may contain text instead of a structured receipt.
    return;
  }
}

export function artifactWebSources(
  ids: string[],
  taskId: string,
  evidence: Evidence[],
  scope: Scope,
  inherited: WebSource[] = [],
): WebSource[] {
  if (ids.length > maxArtifactWebSources)
    throw new Error(`Submit at most ${maxArtifactWebSources} source evidence IDs per artifact`);
  const sources = new Map<string, WebSource>();
  for (const id of new Set(ids)) {
    const entry = evidence.find((e) => e.id === id && e.taskId === taskId);
    const read = entry && webRead(entry, scope);
    if (!read)
      throw new Error(
        'Every sourceEvidenceIds entry must be a successful web_read of an original source by this task',
      );
    sources.set(read.url, { url: read.url, evidenceId: read.evidenceId });
  }
  for (const source of inherited) if (!sources.has(source.url)) sources.set(source.url, source);
  if (sources.size > maxArtifactWebSources)
    throw new Error(
      `An artifact can cite at most ${maxArtifactWebSources} distinct original sources`,
    );
  return [...sources.values()];
}

export function hasReviewedWebSources(
  artifacts: Artifact[],
  ids: string[],
  taskId: string,
  evidence: Evidence[],
  scope: Scope,
): boolean {
  const selected = new Set(ids);
  const reads = evidence.flatMap((entry) => {
    if (entry.taskId !== taskId || !selected.has(entry.id)) return [];
    const receipt = webRead(entry, scope);
    return receipt ? [receipt] : [];
  });
  return artifacts.every((artifact) =>
    (artifact.webSources ?? []).every((source) =>
      reads.some(
        (read) => read.url === source.url && read.inputVersionIds.includes(artifact.versionId),
      ),
    ),
  );
}
