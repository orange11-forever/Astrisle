import { expect, it } from 'vitest';
import { isSearchEndpoint } from '../../packages/contracts/src/web-research';

it('accepts a configured HTTP search service including a local or mounted instance', () => {
  for (const address of ['http://127.0.0.1:8080/search', 'https://search.example/tools/search']) {
    expect(isSearchEndpoint(address)).toBe(true);
  }
});

it('requires an explicit HTTP address without credentials or preset request parameters', () => {
  for (const address of [
    'search.example',
    'file:///tmp/search',
    'https://reader@search.example/search',
    'https://search.example/search?q=x',
    'https://search.example/search#fragment',
    'https:search.example',
    'https://search.example/\nsearch',
    'https://search.example/' + 'x'.repeat(2048),
  ]) {
    expect(isSearchEndpoint(address)).toBe(false);
  }
});
