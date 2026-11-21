/** A commission names the search service separately from the hosts it can read. */
export function isSearchEndpoint(value: string): boolean {
  if (
    value.length > 2048 ||
    !/^https?:\/\//i.test(value) ||
    /[\s\\?#]/u.test(value) ||
    Array.from(value).some((character) => character.charCodeAt(0) < 32)
  )
    return false;
  try {
    const url = new URL(value);
    return Boolean(url.hostname) && !url.username && !url.password;
  } catch {
    return false;
  }
}

export function isSourceHostname(value: string): boolean {
  const hostname = value.toLowerCase();
  return URL.parse(`http://${hostname}`)?.hostname === hostname;
}

export function isSearchServiceUrl(url: URL, endpoint: URL): boolean {
  return (
    url.origin === endpoint.origin &&
    url.pathname.replace(/\/+$/, '') === endpoint.pathname.replace(/\/+$/, '')
  );
}
