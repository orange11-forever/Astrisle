import { redact } from '../../executor/src/process';

const identifier = '[A-Za-z_][\\w.:-]*';
const openElement = new RegExp(`^<(${identifier})([\\s\\S]*?)(/?)>$`, 'u');
const closeElement = new RegExp(`^</(${identifier})\\s*>$`, 'u');
const xmlAttribute = new RegExp(`\\s+(${identifier})\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'guy');
const xmlTokens =
  /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<\/?[A-Za-z_](?:"[^"]*"|'[^']*'|[^<>"'])*>|[^<]+/gy;

const entities: Record<string, string> = {
  amp: '&',
  apos: "'",
  quot: '"',
  lt: '<',
  gt: '>',
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  hellip: '…',
};

function decodeEntities(text: string): string {
  return text.replace(/&(#(?:x[\da-f]+|\d+)|[a-z][a-z\d]+);/giu, (literal, entity: string) => {
    if (Object.hasOwn(entities, entity)) return entities[entity];
    if (!entity.startsWith('#')) return literal;
    const points = /^#x/i.test(entity)
      ? Number.parseInt(entity.slice(2), 16)
      : Number(entity.slice(1));
    return points > 0 && points <= 0x10ffff && !(points >= 0xd800 && points <= 0xdfff)
      ? String.fromCodePoint(points)
      : '\uFFFD';
  });
}

interface Element {
  name: string;
  attributes: Map<string, string>;
  children: Element[];
  text: string;
}

function xmlError(): never {
  throw new Error('Invalid RSS or Atom document');
}

function parseXml(feed: string): Element {
  const stack: Element[] = [];
  let root: Element | undefined;
  let offset = 0;
  let nodes = 0;
  for (const match of feed.matchAll(xmlTokens)) {
    const [token] = match;
    offset += token.length;
    const parent = stack.at(-1);
    if (token.startsWith('<!--') || token.startsWith('<?')) continue;
    if (token.startsWith('<![CDATA[')) {
      if (!parent) xmlError();
      parent.text += token.slice(9, -3);
      continue;
    }
    if (!token.startsWith('<')) {
      if (parent) parent.text += decodeEntities(token);
      else if (token.trim()) xmlError();
      continue;
    }
    const closing = closeElement.exec(token);
    if (closing) {
      if (stack.pop()?.name !== closing[1]) xmlError();
      continue;
    }
    const opening = openElement.exec(token);
    if (!opening || stack.length >= 32 || ++nodes > 30_000) xmlError();
    const [, name, rawAttributes, selfClosed] = opening;
    const attributes = new Map<string, string>();
    let consumed = 0;
    for (const attribute of rawAttributes.matchAll(xmlAttribute)) {
      const [, key, double, single] = attribute;
      if (attributes.has(key)) xmlError();
      attributes.set(key, decodeEntities(double ?? single));
      consumed += attribute[0].length;
    }
    if (rawAttributes.slice(consumed).trim()) xmlError();
    const element = { name, attributes, children: [], text: '' };
    if (parent) parent.children.push(element);
    else if (root) xmlError();
    else root = element;
    if (!selfClosed) stack.push(element);
  }
  if (!root || stack.length || offset !== feed.length) xmlError();
  return root;
}

export function localNewsDate(date: Date): string {
  return [date.getFullYear(), date.getMonth() + 1, date.getDate()]
    .map((part, index) => String(part).padStart(index === 0 ? 4 : 2, '0'))
    .join('-');
}

function dateOnly(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 10) === value
  );
}

export function publication(value: string): { day: string; publishedAt: string } | undefined {
  const text = value.trim();
  if (dateOnly(text)) return { day: text, publishedAt: text };
  const rfc822 =
    /^(?:[a-z]{3},\s+)?(\d{1,2})\s+([a-z]{3})\s+(\d{2}|\d{4})\s+(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?\s+(?:[+-]\d{4}|[a-z]{1,3})$/i;
  const iso =
    /^\d{4}-\d{2}-\d{2}[T ](?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})$/i;
  const rfc = rfc822.exec(text);
  if (rfc) {
    const [, day, month, year] = rfc;
    const months = [
      'Jan',
      'Feb',
      'Mar',
      'Apr',
      'May',
      'Jun',
      'Jul',
      'Aug',
      'Sep',
      'Oct',
      'Nov',
      'Dec',
    ];
    const monthIndex = months.findIndex((m) => m.toLowerCase() === month.toLowerCase());
    const fullYear = year.length === 4 ? year : (Number(year) < 50 ? '20' : '19') + year;
    if (!dateOnly(`${fullYear}-${String(monthIndex + 1).padStart(2, '0')}-${day.padStart(2, '0')}`))
      return;
  } else if (!iso.test(text) || !dateOnly(text.slice(0, 10))) return;
  const timestamp = new Date(text);
  if (!Number.isFinite(timestamp.getTime())) return;
  return { day: localNewsDate(timestamp), publishedAt: timestamp.toISOString() };
}

function localName(element: Element) {
  return element.name.split(':').at(-1);
}

function child(element: Element, name: string) {
  return element.children.find((entry) => localName(entry) === name);
}

export function newsUrl(value: string, base?: URL): URL | undefined {
  if (!value.trim() || value.length > 2048) return;
  const url = URL.parse(value.trim(), base);
  if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) return;
  url.hash = '';
  if (url.href.length <= 2048 && url.href === redact(url.href)) return url;
}

function baseUrl(element: Element, parent: URL): URL | undefined {
  const base = element.attributes.get('xml:base');
  return base ? newsUrl(base, parent) : parent;
}

function alternateLink(element: Element) {
  return element.children.find((entry) => {
    const rel = entry.attributes.get('rel');
    const type = entry.attributes.get('type')?.split(';')[0].trim().toLowerCase();
    return (
      localName(entry) === 'link' &&
      (!rel || rel === 'alternate') &&
      (!type || type === 'text/html' || type === 'application/xhtml+xml') &&
      entry.attributes.has('href')
    );
  });
}

export interface NewsLink {
  url: URL;
  feedDated: boolean;
}

export function parseNewsFeed(feed: string, url: URL, date: string) {
  const root = parseXml(feed);
  const atom = localName(root) === 'feed';
  const section = atom ? root : localName(root) === 'rss' ? child(root, 'channel') : undefined;
  if (!section) xmlError();
  const rootBase = baseUrl(root, url);
  const sectionBase = rootBase && (atom ? rootBase : baseUrl(section, rootBase));
  if (!sectionBase) xmlError();
  const publishedToday = new Map<string, NewsLink>();
  const links = new Map<string, NewsLink>();
  let oldestDatedDay: string | undefined;
  for (const entry of section.children) {
    if (localName(entry) !== (atom ? 'entry' : 'item')) continue;
    const published = child(entry, atom ? 'published' : 'pubDate') ?? child(entry, 'date');
    const day = publication(published?.text ?? '')?.day;
    if (day && (!oldestDatedDay || day < oldestDatedDay)) oldestDatedDay = day;
    if (day && day !== date) continue;
    const link = atom ? alternateLink(entry) : child(entry, 'link');
    const entryBase = baseUrl(entry, sectionBase);
    const linkBase = link && entryBase && baseUrl(link, entryBase);
    const target =
      link && linkBase && newsUrl(atom ? link.attributes.get('href')! : link.text, linkBase);
    if (target?.origin === url.origin)
      (day ? publishedToday : links).set(target.href, { url: target, feedDated: !!day });
  }
  for (const [href, link] of links) if (!publishedToday.has(href)) publishedToday.set(href, link);
  return { links: [...publishedToday.values()], oldestDatedDay };
}

const htmlAttributes = /([^\s/=<>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
const markup = /<\/?[a-z](?:"[^"]*"|'[^']*'|[^<>"'])*>/giu;

function attributes(input: string) {
  return new Map(
    [...input.matchAll(htmlAttributes)].map(([, name, double, single, unquoted]) => [
      name.toLowerCase(),
      decodeEntities(double ?? single ?? unquoted ?? ''),
    ]),
  );
}

function plainText(marked: string): string {
  return redact(decodeEntities(marked.replace(markup, ' ')))
    .replace(/[\s\p{Cc}]+/gu, ' ')
    .trim();
}

const articleType = /(?:^|[/#:])(?:Article|[\w-]*NewsArticle|BlogPosting|Report)$/;
const pageType = /(?:^|[/#:])(?:WebPage|ItemPage)$/;
type SchemaNode = Record<string, unknown>;

function schemaNode(value: unknown): SchemaNode | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as SchemaNode;
}

function schemaType(node: SchemaNode, pattern: RegExp): boolean {
  const types = Array.isArray(node['@type']) ? node['@type'] : [node['@type']];
  return types.some((type: unknown) => typeof type === 'string' && pattern.test(type));
}

function schemaNodes(value: unknown, depth = 0): SchemaNode[] {
  if (depth > 12) return [];
  if (Array.isArray(value)) return value.flatMap((node) => schemaNodes(node, depth + 1));
  const node = schemaNode(value);
  return node ? [node, ...schemaNodes(node['@graph'], depth + 1)] : [];
}

function schemaUrl(value: unknown, base: URL): URL | undefined {
  const address = schemaNode(value)?.['@id'] ?? value;
  if (typeof address !== 'string' || !address.trim() || address.length > 2048) return;
  const url = URL.parse(address.trim(), base);
  if (
    url &&
    url.origin === base.origin &&
    !url.username &&
    !url.password &&
    url.href === redact(url.href)
  )
    return url;
}

function documentUrl(url: URL | undefined): string | undefined {
  return url?.href.split('#')[0];
}

function sameHeadline(node: SchemaNode, title: string) {
  const headline = node.headline ?? node.name;
  return (
    typeof headline === 'string' &&
    plainText(headline).normalize('NFKC') === title.normalize('NFKC')
  );
}

function canonicalUrl(head: string, fetched: URL) {
  const canonical = new Set<string>();
  for (const tag of head.matchAll(/<link(?=[\s/>])((?:"[^"]*"|'[^']*'|[^<>"'])*)>/gi)) {
    const fields = attributes(tag[1]);
    if (!fields.get('rel')?.toLowerCase().split(/\s+/).includes('canonical')) continue;
    const url = newsUrl(fields.get('href') ?? '', fetched);
    if (url?.origin === fetched.origin) canonical.add(url.href);
  }
  if (canonical.size === 1) return new URL(canonical.values().next().value!);
}

function mainArticleDate(
  documents: unknown[],
  fetched: URL,
  canonical: URL | undefined,
  title: string,
) {
  const nodes = schemaNodes(documents);
  const articles = nodes.filter((node) => schemaType(node, articleType));
  const aliases = canonical && canonical.href !== fetched.href ? [fetched, canonical] : [fetched];
  const dateOf = (matches: SchemaNode[]) => {
    const value = matches.length === 1 ? matches[0].datePublished : undefined;
    return typeof value === 'string' ? value : undefined;
  };

  for (const page of aliases) {
    const location = (value: unknown) => documentUrl(schemaUrl(value, fetched));
    const onPage = (node: SchemaNode) => location(node.url ?? node['@id']) === page.href;
    const headlineMatches = (node: SchemaNode) =>
      page.pathname === fetched.pathname || sameHeadline(node, title);
    const main = nodes
      .filter((node) => schemaType(node, pageType) && onPage(node) && node.mainEntity)
      .flatMap((node) => (Array.isArray(node.mainEntity) ? node.mainEntity : [node.mainEntity]));
    if (main.length) {
      const identifiers = new Set(
        main.map((value) => schemaUrl(value, fetched)?.href).filter(Boolean),
      );
      const inline = main.flatMap((value) => {
        const node = schemaNode(value);
        return node && schemaType(node, articleType) ? [node] : [];
      });
      const selected = new Set([
        ...inline,
        ...articles.filter((node) => identifiers.has(schemaUrl(node['@id'], fetched)?.href)),
      ]);
      return dateOf(
        [...selected].filter(
          (node) => (!node.url || location(node.url) === page.href) && headlineMatches(node),
        ),
      );
    }

    const direct = articles.filter(
      (node) => location(node.url) === page.href && headlineMatches(node),
    );
    if (direct.length) return dateOf(direct);
    const associated = articles.filter(
      (node) => !node.url && location(node.mainEntityOfPage) === page.href && headlineMatches(node),
    );
    if (associated.length) return dateOf(associated);
    const identified = articles.filter((node) => {
      if (node.url || node.mainEntityOfPage || !headlineMatches(node)) return false;
      const identifier = schemaUrl(node['@id'], fetched);
      return (
        documentUrl(identifier) === page.href && (!identifier?.hash || sameHeadline(node, title))
      );
    });
    if (identified.length) return dateOf(identified);
  }

  // A standalone Article object also legitimately describes the containing page.
  if (articles.length !== 1) return;
  const [article] = articles;
  if (article.url || article['@id'] || article.mainEntityOfPage) return;
  if (
    sameHeadline(article, title) ||
    (!article.headline && !article.name && documents.includes(article))
  )
    return dateOf(articles);
}

const publicationKeys = new Set([
  'article:published_time',
  'datepublished',
  'dcterms.issued',
  'dcterms.created',
  'parsely-pub-date',
  'citation_publication_date',
]);

function endTag(html: string, name: string, from: number) {
  const close = new RegExp(`</${name}\\s*>`, 'gi');
  close.lastIndex = from;
  return close.exec(html);
}

function region(html: string, name: string) {
  const open = new RegExp(`<${name}(?=[\\s/>])[^>]*>`, 'i').exec(html);
  if (!open) return;
  const from = open.index + open[0].length;
  const close = endTag(html, name, from);
  if (close)
    return {
      text: html.slice(from, close.index),
      start: open.index,
      end: close.index + close[0].length,
    };
}

function visibleHtml(html: string, documents: unknown[]): string {
  const hidden =
    /<!--|<(script|style|template|noscript|svg|nav|footer|aside|iframe)(?=[\s/>])((?:"[^"]*"|'[^']*'|[^<>"'])*)>/gi;
  const visible: string[] = [];
  let cursor = 0;
  for (let open = hidden.exec(html); open; open = hidden.exec(html)) {
    const [, tag, rawAttributes] = open;
    visible.push(html.slice(cursor, open.index));
    const from = hidden.lastIndex;
    if (!tag) {
      const close = html.indexOf('-->', from);
      if (close === -1) return visible.join(' ');
      cursor = close + 3;
    } else if (/\/\s*$/.test(rawAttributes)) {
      cursor = from;
    } else {
      const close = endTag(html, tag, from);
      if (!close) return visible.join(' ');
      if (
        tag.toLowerCase() === 'script' &&
        attributes(rawAttributes).get('type')?.toLowerCase() === 'application/ld+json'
      ) {
        try {
          documents.push(JSON.parse(html.slice(from, close.index)));
        } catch {
          // A publisher's invalid JSON-LD does not invalidate its other metadata.
        }
      }
      cursor = close.index + close[0].length;
    }
    hidden.lastIndex = cursor;
  }
  visible.push(html.slice(cursor));
  return visible.join(' ');
}

export function originalArticle(html: string, date: string, feedDated: boolean, fetched: URL) {
  const dates: string[] = [];
  const documents: unknown[] = [];
  const clean = visibleHtml(html, documents);
  const article = region(clean, 'article');
  const body = (article ?? region(clean, 'main') ?? region(clean, 'body'))?.text;
  if (!body) return;
  const head =
    region(clean, 'head')?.text ?? clean.slice(0, clean.search(/<(?:body|main|article)(?=[\s>])/i));
  let ogTitle = '';
  for (const tag of head.matchAll(/<meta(?=[\s/>])((?:"[^"]*"|'[^']*'|[^<>"'])*)>/gi)) {
    const fields = attributes(tag[1]);
    const key = (
      fields.get('property') ??
      fields.get('itemprop') ??
      fields.get('name')
    )?.toLowerCase();
    const value = fields.get('content');
    if (!key || !value) continue;
    if (publicationKeys.has(key)) dates.push(value);
    if (key === 'og:title') ogTitle = value;
  }
  const heading = region(body, 'h1');
  const title = (
    plainText(heading?.text ?? '') || plainText(ogTitle || region(clean, 'title')?.text || '')
  ).slice(0, 300);
  const structuredDate = mainArticleDate(documents, fetched, canonicalUrl(head, fetched), title);
  if (structuredDate) dates.push(structuredDate);
  const displayedTimes: string[] = [];
  const firstParagraph = body.search(/<p(?=[\s>])/i);
  const timeTags = /<time(?=[\s>])((?:"[^"]*"|'[^']*'|[^<>"'])*)>/gi;
  for (let open = timeTags.exec(body); open; open = timeTags.exec(body)) {
    const from = timeTags.lastIndex;
    const close = endTag(body, 'time', from);
    if (!close) break;
    timeTags.lastIndex = close.index + close[0].length;
    const fields = attributes(open[1]);
    const label = plainText(body.slice(from, close.index));
    const marker = `${fields.get('property') ?? ''} ${fields.get('itemprop') ?? ''} ${fields.get('class') ?? ''}`;
    if (/modif|updat|更新|修订/i.test(marker + ' ' + label)) continue;
    const value = fields.get('datetime') ?? label;
    if (/publish|issued/i.test(marker)) dates.push(value);
    else if (article && feedDated && firstParagraph >= 0 && open.index < firstParagraph)
      displayedTimes.push(value);
  }
  if (!dates.length && displayedTimes.length === 1) dates.push(displayedTimes[0]);
  const verified = dates.flatMap((value) => publication(value) ?? []);
  const publishedAt = verified[0]?.publishedAt;
  if (!publishedAt || verified.some((value) => value.day !== date)) return;
  const content = heading ? `${body.slice(0, heading.start)} ${body.slice(heading.end)}` : body;
  const text = plainText(content).slice(0, 5000);
  if (title && text) return { title, publishedAt, text };
}
