import { lookup as dnsLookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import type { ToolContext, ToolResult } from '../../contracts/src/index';
import {
  isSearchEndpoint,
  isSearchServiceUrl,
  isSourceHostname,
} from '../../contracts/src/web-research';
import { ToolError } from './path-guard';
import { redact } from './process';

export const MAX_WEB_QUERY = 256;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_READ_OUTPUT = 64 * 1024;
const MAX_SEARCH_RESULTS = 8;
const MAX_SOURCE_URL = 2048;
const WEB_TIMEOUT = 15_000;

export type HostLookup = (
  hostname: string,
  options: { all: true; verbatim: true },
) => Promise<ReadonlyArray<{ address: string; family?: number }>>;

const RESTRICTED_IPS = new BlockList();
RESTRICTED_IPS.addSubnet('0.0.0.0', 8, 'ipv4');
RESTRICTED_IPS.addSubnet('10.0.0.0', 8, 'ipv4');
RESTRICTED_IPS.addSubnet('100.64.0.0', 10, 'ipv4');
RESTRICTED_IPS.addSubnet('127.0.0.0', 8, 'ipv4');
RESTRICTED_IPS.addSubnet('169.254.0.0', 16, 'ipv4');
RESTRICTED_IPS.addSubnet('172.16.0.0', 12, 'ipv4');
RESTRICTED_IPS.addSubnet('192.0.0.0', 24, 'ipv4');
RESTRICTED_IPS.addSubnet('192.168.0.0', 16, 'ipv4');
RESTRICTED_IPS.addSubnet('198.18.0.0', 15, 'ipv4');
RESTRICTED_IPS.addSubnet('224.0.0.0', 4, 'ipv4');
RESTRICTED_IPS.addSubnet('240.0.0.0', 4, 'ipv4');
RESTRICTED_IPS.addAddress('::', 'ipv6');
RESTRICTED_IPS.addAddress('::1', 'ipv6');
RESTRICTED_IPS.addSubnet('fe80::', 10, 'ipv6');
RESTRICTED_IPS.addSubnet('fc00::', 7, 'ipv6');
RESTRICTED_IPS.addSubnet('ff00::', 8, 'ipv6');

function bareHost(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

export function isRestrictedIpAddress(rawAddress: string): boolean {
  const bare = bareHost(rawAddress.trim());
  const address = bare.includes('%') ? bare.slice(0, bare.indexOf('%')) : bare;
  const family = isIP(address);
  if (family === 4) return RESTRICTED_IPS.check(address, 'ipv4');
  if (family !== 6) return false;
  if (RESTRICTED_IPS.check(address, 'ipv6')) return true;
  const canonical = URL.parse(`http://[${address}]`)?.hostname;
  const mapped = canonical?.match(/^\[::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})\]$/i);
  if (!mapped) return false;
  const hi = Number.parseInt(mapped[1], 16);
  const lo = Number.parseInt(mapped[2], 16);
  const ipv4 = `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
  return RESTRICTED_IPS.check(ipv4, 'ipv4');
}

async function assertPublicHostResolution(
  url: URL,
  signal: AbortSignal,
  lookup: HostLookup = dnsLookup,
): Promise<void> {
  const host = bareHost(url.hostname).toLowerCase();
  if (host === 'localhost' || isIP(host) !== 0) return;
  let addresses: ReadonlyArray<{ address: string; family?: number }>;
  try {
    addresses = await lookup(host, { all: true, verbatim: true });
  } catch (error) {
    if (signal.aborted) throw new ToolError('ABORTED', 'Operation cancelled');
    if (error instanceof ToolError) throw error;
    throw new ToolError('NETWORK_FAILED', 'Could not resolve URL host');
  }
  if (signal.aborted) throw new ToolError('ABORTED', 'Operation cancelled');
  if (!addresses.length) throw new ToolError('NETWORK_FAILED', 'Could not resolve URL host');
  if (addresses.some((entry) => isRestrictedIpAddress(entry.address))) {
    throw new ToolError(
      'SCOPE_DENIED',
      'URL host resolves to a restricted private or local address',
    );
  }
}

function sourceAllowed(url: URL, hosts: ReadonlySet<string>): boolean {
  return (
    ['https:', 'http:'].includes(url.protocol) &&
    !url.username &&
    !url.password &&
    hosts.has(url.hostname.toLowerCase())
  );
}

function authorizedSources(context: ToolContext): Set<string> {
  if (!context.scope.allowNetwork)
    throw new ToolError('SCOPE_DENIED', 'Network permission is required');
  return new Set(context.scope.allowedHosts.map((host) => host.toLowerCase()));
}

function configuredSearchService(context: ToolContext): URL | undefined {
  const endpoint = context.scope.searchEndpoint;
  if (typeof endpoint === 'string' && isSearchEndpoint(endpoint)) return new URL(endpoint);
}

async function readResponse(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new ToolError('SIZE_LIMIT', 'Web response exceeds 1 MiB');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function webRead(
  url: string,
  context: ToolContext,
  options: {
    accept?: string;
    allowedOrigin?: string;
    fullOutput?: boolean;
    lookup?: HostLookup;
  } = {},
): Promise<ToolResult> {
  const hosts = authorizedSources(context);
  const searchService = configuredSearchService(context);
  const signal = AbortSignal.any([AbortSignal.timeout(WEB_TIMEOUT), context.signal]);
  let current = new URL(url);
  for (let count = 0; count <= 5; count++) {
    if (
      !sourceAllowed(current, hosts) ||
      (options.allowedOrigin &&
        (current.origin !== options.allowedOrigin ||
          current.href.length > MAX_SOURCE_URL ||
          current.href !== redact(current.href)))
    )
      throw new ToolError('SCOPE_DENIED', 'URL host or protocol is not authorized');
    if (context.pinnedWebReadUrls && !context.pinnedWebReadUrls.has(current.href))
      throw new ToolError('SCOPE_DENIED', 'Only pinned source URLs are authorized for this task');
    if (searchService && isSearchServiceUrl(current, searchService))
      throw new ToolError('SCOPE_DENIED', 'Use web_search for the configured search endpoint');
    await assertPublicHostResolution(current, signal, options.lookup);
    const response = await fetch(current, {
      signal,
      redirect: 'manual',
      headers: { accept: options.accept ?? 'text/plain,text/html,application/json' },
    });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      const location = response.headers.get('location');
      if (!location) throw new ToolError('NETWORK_FAILED', 'Redirect has no destination');
      current = new URL(location, current);
      if (options.allowedOrigin) current.hash = '';
      continue;
    }
    const output = redact(await readResponse(response));
    const metadata: Record<string, unknown> = { status: response.status };
    if (redact(current.href) === current.href) metadata.url = current.href;
    return {
      ok: response.ok,
      output:
        !options.fullOutput && output.length > MAX_READ_OUTPUT
          ? `${output.slice(0, MAX_READ_OUTPUT)}\n[output truncated]`
          : output,
      metadata,
    };
  }
  throw new ToolError('NETWORK_FAILED', 'Redirect limit exceeded');
}

function boundedField(value: unknown, length: number): string {
  return typeof value === 'string'
    ? redact(value).replace(/\s+/gu, ' ').trim().slice(0, length)
    : '';
}

function sourceResults(body: string, hosts: ReadonlySet<string>, endpoint: URL) {
  let parsed: { results?: unknown } | undefined;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new ToolError('NETWORK_FAILED', 'Search service returned invalid JSON');
  }
  if (!Array.isArray(parsed?.results))
    throw new ToolError('NETWORK_FAILED', 'Search service JSON has no results array');
  const results: { url: string; title: string; snippet: string }[] = [];
  const seen = new Set<string>();
  for (const entry of parsed.results as { url?: unknown; title?: unknown; content?: unknown }[]) {
    if (typeof entry?.url !== 'string' || entry.url.length > MAX_SOURCE_URL) continue;
    const url = URL.parse(entry.url);
    if (!url || !sourceAllowed(url, hosts)) continue;
    if (isSearchServiceUrl(url, endpoint)) continue;
    url.hash = '';
    const href = url.href;
    if (href.length > MAX_SOURCE_URL || seen.has(href) || redact(href) !== href) continue;
    seen.add(href);
    results.push({
      url: href,
      title: boundedField(entry.title, 200),
      snippet: boundedField(entry.content, 500),
    });
    if (results.length === MAX_SEARCH_RESULTS) break;
  }
  return results;
}

function siteScopedQuery(query: string, hosts: ReadonlySet<string>): string {
  const sites = [...hosts]
    .filter((host) => /^(?:[a-z0-9-]+\.)+[a-z][a-z0-9-]*$/i.test(host))
    .map((host) => `site:${host}`);
  if (!sites.length || sites.length !== hosts.size) return query;
  const group = sites.join(' OR ');
  if (group.length > 1024) return query;
  return `${sites.length === 1 ? group : `(${group})`} ${query}`;
}

export async function webSearch(
  rawQuery: string,
  context: ToolContext,
  options: { lookup?: HostLookup } = {},
): Promise<ToolResult> {
  const hosts = authorizedSources(context);
  const url = configuredSearchService(context);
  if (!url)
    throw new ToolError(
      'SCOPE_DENIED',
      'Configure a valid SearXNG search endpoint in the commission',
    );
  if (![...hosts].some(isSourceHostname))
    throw new ToolError('SCOPE_DENIED', 'An authorized source hostname is required');

  const query = rawQuery.trim();
  if (!query || rawQuery.length > MAX_WEB_QUERY)
    throw new ToolError(
      'INVALID_ARGUMENT',
      `Search query must contain 1 to ${MAX_WEB_QUERY} characters`,
    );
  url.searchParams.set('q', siteScopedQuery(query, hosts));
  url.searchParams.set('format', 'json');

  const timeout = AbortSignal.timeout(WEB_TIMEOUT);
  const signal = AbortSignal.any([timeout, context.signal]);
  try {
    await assertPublicHostResolution(url, signal, options.lookup);
    const response = await fetch(url, {
      signal,
      redirect: 'manual',
      headers: { accept: 'application/json' },
    });
    const json = /^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '');
    if (!response.ok || !json) {
      await response.body?.cancel();
      if (response.status >= 300 && response.status < 400)
        throw new ToolError('NETWORK_FAILED', 'Search service redirected; configure its final URL');
      if (response.status === 403)
        throw new ToolError(
          'NETWORK_FAILED',
          'Search service returned HTTP 403; check that JSON is enabled and the service permits access',
        );
      if (!response.ok)
        throw new ToolError('NETWORK_FAILED', `Search service returned HTTP ${response.status}`);
      throw new ToolError('NETWORK_FAILED', 'Search service must return JSON');
    }
    const results = sourceResults(await readResponse(response), hosts, url);
    return { ok: true, output: JSON.stringify(results), metadata: { resultCount: results.length } };
  } catch (error) {
    if (context.signal.aborted) throw new ToolError('ABORTED', 'Search cancelled');
    if (timeout.aborted) throw new ToolError('NETWORK_FAILED', 'Search service timed out');
    if (error instanceof ToolError) throw error;
    throw new ToolError('NETWORK_FAILED', 'Could not reach or read the search service');
  }
}
