import { describe, it, expect } from 'vitest';
import {
  validateProvider,
  isTrustedSender,
  canOpenExternally,
} from '../../apps/desktop/src/security';

describe('desktop privilege boundaries', () => {
  it('accepts configured HTTPS vendors and localhost models only', () => {
    expect(
      validateProvider({
        kind: 'anthropic',
        baseUrl: 'https://api.anthropic.com',
        model: 'my-model',
        apiKey: 'secret',
      }).baseUrl,
    ).toBe('https://api.anthropic.com');
    expect(
      validateProvider({
        kind: 'openai-compatible',
        baseUrl: 'http://127.0.0.1:11434/v1/',
        model: 'local',
      }).baseUrl,
    ).toBe('http://127.0.0.1:11434/v1');
    expect(() =>
      validateProvider({ kind: 'gemini', baseUrl: 'http://remote.example/v1', model: 'model' }),
    ).toThrow();
    expect(() =>
      validateProvider({
        kind: 'gemini',
        baseUrl: 'https://user:password@example.com',
        model: 'model',
      }),
    ).toThrow();
    expect(() =>
      validateProvider({ kind: 'unknown', baseUrl: 'https://example.com', model: 'model' }),
    ).toThrow();
  });
  it('never accepts remote or child frames as privileged desktop senders', () => {
    const expected = 'file:///E:/Astrisle/dist/client/index.html';
    expect(isTrustedSender(expected, expected, true)).toBe(true);
    expect(isTrustedSender('https://evil.example', expected, true)).toBe(false);
    expect(isTrustedSender(expected, expected, false)).toBe(false);
    expect(isTrustedSender('file:///E:/Astrisle/dist/client/other.html', expected, true)).toBe(
      false,
    );
  });
  it('does not launch generated executables, scripts, HTML or macro documents', () => {
    for (const path of ['a.exe', 'a.cmd', 'a.ps1', 'a.html', 'a.xlsm', 'a.docm', 'a.lnk', 'a.url'])
      expect(canOpenExternally(path)).toBe(false);
    for (const path of ['report.docx', 'data.xlsx', 'deck.pptx', 'view.pdf', 'image.png'])
      expect(canOpenExternally(path)).toBe(true);
  });
});
