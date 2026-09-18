import { describe, expect, it } from 'bun:test';
import {
  DEFAULT_SERVER_PAGE_LOCALE,
  __testing,
  formatServerPageCopy,
  normalizeServerPageLocale,
  serverPageCopy,
} from './page-copy.js';

describe('server html page copy', () => {
  it('defaults to the pigeon Simplified Chinese locale', () => {
    expect(DEFAULT_SERVER_PAGE_LOCALE).toBe('zh-CN');
    expect(normalizeServerPageLocale(undefined)).toBe('zh-CN');
    expect(normalizeServerPageLocale('')).toBe('zh-CN');
    expect(serverPageCopy({ headers: {} })['server.oauth.message.closeTab']).toBe(
      '可以关闭此标签页，然后返回 OpenChamber。',
    );
  });

  it('honors an explicit English Accept-Language header', () => {
    expect(normalizeServerPageLocale('en-US,en;q=0.9,zh-CN;q=0.8')).toBe('en');
    expect(serverPageCopy({ headers: { 'accept-language': 'en' } })['server.oauth.message.closeTab']).toBe(
      'You can close this tab and return to OpenChamber.',
    );
  });

  it('resolves Chinese tags to zh-CN', () => {
    expect(normalizeServerPageLocale('zh-CN,zh;q=0.9')).toBe('zh-CN');
  });

  it('formats placeholders without inventing missing params', () => {
    const en = __testing.PAGE_COPY.en;
    expect(formatServerPageCopy(en, 'server.oauth.mcp.message.upstreamRejected', { status: 502 })).toContain('502');
    expect(formatServerPageCopy(en, 'server.oauth.mcp.message.upstreamRejected')).toContain('{status}');
  });
});
