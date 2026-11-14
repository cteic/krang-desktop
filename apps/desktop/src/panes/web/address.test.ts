import { describe, expect, it } from 'vitest';

import {
  START_SHORTCUTS,
  displayAddress,
  localFileUrl,
  mayRefuseFraming,
  needsHome,
  resolveAddress,
} from './address';

function urlOf(input: string, home: string | null = null): string | null {
  const result = resolveAddress(input, home);
  return result.ok ? result.url : null;
}

function messageOf(input: string, home: string | null = null): string | null {
  const result = resolveAddress(input, home);
  return result.ok ? null : result.message;
}

describe('resolveAddress', () => {
  it('passes http and https URLs through', () => {
    expect(urlOf('http://example.com/a?b=1#c')).toBe('http://example.com/a?b=1#c');
    expect(urlOf('https://docs.rs/serde')).toBe('https://docs.rs/serde');
    expect(urlOf('  HTTPS://Example.com  ')).toBe('https://example.com/');
  });

  it('turns an absolute path into a localfile URL, keeping slashes', () => {
    expect(urlOf('/Users/x/site/index.html')).toBe('localfile://localhost/Users/x/site/index.html');
    expect(urlOf('/Users/x/my site/café #1?.html')).toBe(
      'localfile://localhost/Users/x/my%20site/caf%C3%A9%20%231%3F.html',
    );
    expect(urlOf('/Users/x/site/')).toBe('localfile://localhost/Users/x/site/');
  });

  it('turns a file URL into a localfile URL', () => {
    expect(urlOf('file:///Users/x/my%20site/index.html')).toBe(
      'localfile://localhost/Users/x/my%20site/index.html',
    );
    expect(urlOf('file://localhost/Users/x/a.html')).toBe('localfile://localhost/Users/x/a.html');
    expect(messageOf('file://server/share/a.html')).toMatch(/another machine/);
  });

  it('accepts a localfile URL as it is', () => {
    expect(urlOf('localfile://localhost/Users/x/a%20b.html')).toBe(
      'localfile://localhost/Users/x/a%20b.html',
    );
    expect(urlOf('localfile://elsewhere/Users/x')).toBeNull();
  });

  it('expands a home path with the home folder', () => {
    expect(urlOf('~/site/index.html', '/Users/x')).toBe(
      'localfile://localhost/Users/x/site/index.html',
    );
    expect(urlOf('~', '/Users/x/')).toBe('localfile://localhost/Users/x');
    expect(messageOf('~/site')).toMatch(/home folder/);
    expect(needsHome(' ~/site')).toBe(true);
    expect(needsHome('~')).toBe(true);
    expect(needsHome('~user/site')).toBe(false);
    expect(needsHome('/Users/x')).toBe(false);
  });

  it('gives local hosts http', () => {
    expect(urlOf('localhost:3000')).toBe('http://localhost:3000/');
    expect(urlOf('127.0.0.1:4747')).toBe('http://127.0.0.1:4747/');
    expect(urlOf('[::1]:8080')).toBe('http://[::1]:8080/');
    expect(urlOf('localhost')).toBe('http://localhost/');
    expect(urlOf('localhost:5173/app?x=1')).toBe('http://localhost:5173/app?x=1');
    expect(urlOf('app.localhost:3000')).toBe('http://app.localhost:3000/');
    expect(urlOf('192.168.1.20:8000')).toBe('http://192.168.1.20:8000/');
  });

  it('gives something that looks like a host https', () => {
    expect(urlOf('example.com')).toBe('https://example.com/');
    expect(urlOf('docs.rs/serde')).toBe('https://docs.rs/serde');
    expect(urlOf('example.com:8443/a')).toBe('https://example.com:8443/a');
  });

  it('reports anything else as not an address', () => {
    expect(messageOf('')).toBe('Type an address.');
    expect(messageOf('   ')).toBe('Type an address.');
    expect(messageOf('how do I centre a div')).toMatch(/not an address/);
    expect(messageOf('serde')).toMatch(/not an address/);
    expect(messageOf('~user/site')).toMatch(/not an address/);
    expect(messageOf('relative/path.html')).toMatch(/not an address/);
    expect(messageOf('http://')).toMatch(/not an address/);
  });

  it('refuses other schemes', () => {
    const refused = [
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      'data:text/html,<h1>hi</h1>',
      'blob:https://example.com/1234',
      'about:blank',
      'mailto:someone@example.com',
      'tel:12345',
      'ftp://example.com/file',
      'tauri://localhost/index.html',
    ];
    for (const input of refused) {
      expect(urlOf(input), input).toBeNull();
      expect(messageOf(input), input).toMatch(/^Cannot open "[a-z]+:" addresses/);
    }
    expect(messageOf('javascript:alert(1)')).toContain('"javascript:"');
  });
});

describe('displayAddress', () => {
  it('shows a localfile URL as its plain path', () => {
    expect(displayAddress('localfile://localhost/Users/x/my%20site/caf%C3%A9.html')).toBe(
      '/Users/x/my site/café.html',
    );
    expect(displayAddress('localfile://localhost/Users/x/a.html#top')).toBe('/Users/x/a.html#top');
  });

  it('round-trips a path through resolveAddress', () => {
    const path = '/Users/x/100% done/a b#c.html';
    expect(displayAddress(localFileUrl(path))).toBe(path);
  });

  it('leaves web URLs alone', () => {
    expect(displayAddress('http://localhost:3000/')).toBe('http://localhost:3000/');
    expect(displayAddress('')).toBe('');
  });
});

describe('mayRefuseFraming', () => {
  it('is true only for https pages that are not on this machine', () => {
    expect(mayRefuseFraming('https://example.com/')).toBe(true);
    expect(mayRefuseFraming('http://example.com/')).toBe(false);
    expect(mayRefuseFraming('https://localhost:3000/')).toBe(false);
    expect(mayRefuseFraming('https://127.0.0.1:4747/')).toBe(false);
    expect(mayRefuseFraming('https://[::1]:8443/')).toBe(false);
    expect(mayRefuseFraming('localfile://localhost/Users/x/a.html')).toBe(false);
    expect(mayRefuseFraming('')).toBe(false);
  });
});

describe('START_SHORTCUTS', () => {
  it('lists three local addresses that all resolve', () => {
    expect(START_SHORTCUTS).toEqual([
      'http://localhost:3000',
      'http://localhost:5173',
      'http://127.0.0.1:4747',
    ]);
    for (const shortcut of START_SHORTCUTS) {
      expect(urlOf(shortcut)).toBe(`${shortcut}/`);
    }
  });
});
