/** @module kernel/url.test — classification, sanitization and host predicates. */

import { describe, expect, it } from 'bun:test';
import {
  classifyUrl,
  INVALID_URL,
  isInsecureBind,
  isIpLiteral,
  isLoopbackHost,
  isPrivateNetworkHost,
  sanitizeUrl,
  URL_CATEGORIES,
} from './url.ts';

describe('classifyUrl', () => {
  it('buckets the category fixtures', () => {
    expect(classifyUrl('https://www.example.co.uk/a?b=1')).toEqual({
      domain: 'www.example.co.uk',
      registrableDomain: 'example.co.uk',
      category: 'public',
    });
    expect(classifyUrl('http://10.0.0.5:8080/')).toMatchObject({
      domain: '10.0.0.5',
      category: 'ip',
    });
    expect(classifyUrl('http://[::1]/')).toMatchObject({ domain: '::1', category: 'local' });
    expect(classifyUrl('http://127.0.0.1/')).toMatchObject({ category: 'local' });
    expect(classifyUrl('http://app.localhost/')).toMatchObject({ category: 'local' });
    expect(classifyUrl('file:///etc/hosts')).toEqual({
      domain: '',
      registrableDomain: '',
      category: 'local',
    });
    expect(classifyUrl('ftp://files.example.com/x')).toMatchObject({
      domain: 'files.example.com',
      category: 'ftp',
    });
    expect(classifyUrl('data:text/plain,hi')).toMatchObject({ domain: '', category: 'other' });
    expect(classifyUrl('about:blank')).toMatchObject({ category: 'other' });
    expect(classifyUrl('not a url')).toMatchObject({ category: 'other' });
    expect(classifyUrl('')).toMatchObject({ category: 'other' });
    expect(classifyUrl('http://[2001:db8::1]/')).toMatchObject({
      domain: '2001:db8::1',
      category: 'ip',
    });
  });

  it('keeps the display order of categories', () => {
    expect(URL_CATEGORIES).toEqual(['public', 'ip', 'local', 'ftp', 'other']);
  });

  it('never throws', () => {
    expect(() => classifyUrl('http://')).not.toThrow();
    expect(classifyUrl('http://').category).toBe('other');
  });
});

describe('host predicates', () => {
  it('isLoopbackHost', () => {
    for (const h of [
      'localhost',
      'LOCALHOST',
      'a.localhost',
      '127.0.0.1',
      '127.9.9.9',
      '::1',
      '[::1]',
    ]) {
      expect(isLoopbackHost(h)).toBe(true);
    }
    for (const h of ['0.0.0.0', '::', '10.0.0.1', 'example.com', '128.0.0.1']) {
      expect(isLoopbackHost(h)).toBe(false);
    }
  });

  it('isIpLiteral', () => {
    expect(isIpLiteral('1.2.3.4')).toBe(true);
    expect(isIpLiteral('999.1.1.1')).toBe(false);
    expect(isIpLiteral('fe80::1')).toBe(true);
    expect(isIpLiteral('example.com')).toBe(false);
  });

  it('isPrivateNetworkHost', () => {
    for (const h of [
      '10.1.2.3',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.1.1',
      'fc00::1',
      'fd12::1',
      'fe80::1',
    ]) {
      expect(isPrivateNetworkHost(h)).toBe(true);
    }
    for (const h of ['172.32.0.1', '8.8.8.8', '127.0.0.1', 'example.com', '2001:db8::1']) {
      expect(isPrivateNetworkHost(h)).toBe(false);
    }
  });

  it('isInsecureBind treats everything non-loopback as exposed', () => {
    expect(isInsecureBind('127.0.0.1')).toBe(false);
    expect(isInsecureBind('localhost')).toBe(false);
    expect(isInsecureBind('0.0.0.0')).toBe(true);
    expect(isInsecureBind('::')).toBe(true);
    expect(isInsecureBind('192.168.1.5')).toBe(true);
  });
});

describe('sanitizeUrl', () => {
  it('strips query, fragment and userinfo by default', () => {
    expect(sanitizeUrl('https://amir:pw@Example.com:8443/path/x?token=abc#frag')).toBe(
      'https://example.com:8443/path/x',
    );
  });

  it('keeps allow-listed query keys only', () => {
    expect(
      sanitizeUrl('https://example.com/s?q=cats&token=abc&page=2', {
        allowQueryKeys: ['q', 'page'],
      }),
    ).toBe('https://example.com/s?q=cats&page=2');
  });

  it('reduces opaque schemes to the scheme', () => {
    expect(sanitizeUrl('data:text/plain;base64,SGVsbG8=')).toBe('data:');
    expect(sanitizeUrl('javascript:alert(1)')).toBe('javascript:');
    expect(sanitizeUrl('about:blank')).toBe('about:blank');
    expect(sanitizeUrl('chrome://settings/')).toBe('chrome://settings/');
  });

  it('returns a placeholder for unparseable input and empty for empty', () => {
    expect(sanitizeUrl('not a url')).toBe(INVALID_URL);
    expect(sanitizeUrl('   ')).toBe('');
  });
});
