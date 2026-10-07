import { describe, expect, it } from 'vitest';
import { GECKO_ID, createManifest, hostPattern } from './manifest.mjs';

const base = { version: '1.2.3' };

describe('createManifest', () => {
  it('chrome: service worker background, no gecko settings', () => {
    const m = createManifest({ ...base, target: 'chrome' });
    expect(m.background).toEqual({ service_worker: 'background.js' });
    expect(m.minimum_chrome_version).toBe('116');
    expect(m.browser_specific_settings).toBeUndefined();
  });

  it('firefox: event page (no service_worker), a gecko id and a minimum version', () => {
    const m = createManifest({ ...base, target: 'firefox' });
    expect(m.background).toEqual({ scripts: ['background.js'] });
    expect(m.background.service_worker).toBeUndefined();
    expect(m.minimum_chrome_version).toBeUndefined();
    expect(m.browser_specific_settings.gecko.id).toBe(GECKO_ID);
    expect(GECKO_ID).toMatch(/^\{[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}$/);
    // data_collection_permissions を宣言しているので、それを理解する最初の版（desktop 140 / Android 142）以上が必須
    expect(m.browser_specific_settings.gecko.data_collection_permissions).toEqual({
      required: ['none'],
    });
    expect(
      Number.parseInt(m.browser_specific_settings.gecko.strict_min_version, 10),
    ).toBeGreaterThanOrEqual(140);
    expect(
      Number.parseInt(m.browser_specific_settings.gecko_android.strict_min_version, 10),
    ).toBeGreaterThanOrEqual(142);
  });

  it.each(['chrome', 'firefox'])(
    '%s: identical permissions, content script and options page',
    (target) => {
      const m = createManifest({ ...base, target });
      expect(m.manifest_version).toBe(3);
      expect(m.version).toBe('1.2.3');
      expect(m.permissions).toEqual(['storage']);
      expect(m.host_permissions).toEqual(['https://api.github.com/*']);
      expect(m.content_scripts).toEqual([
        { matches: ['https://github.com/*'], js: ['content.js'], run_at: 'document_idle' },
      ]);
      expect(m.options_ui).toEqual({ page: 'options.html', open_in_tab: true });
    },
  );

  it('only adds extra hosts / matches when explicitly asked (e2e builds), never by default', () => {
    const prod = createManifest({ ...base, target: 'firefox' });
    expect(JSON.stringify(prod)).not.toMatch(/127\.0\.0\.1|localhost/);

    const e2e = createManifest({
      ...base,
      target: 'firefox',
      apiBase: 'http://127.0.0.1:5555',
      extraMatches: ['http://127.0.0.1/*'],
    });
    expect(e2e.host_permissions).toEqual(['https://api.github.com/*', 'http://127.0.0.1/*']);
    expect(e2e.content_scripts[0].matches).toEqual(['https://github.com/*', 'http://127.0.0.1/*']);
  });

  it('never emits port-qualified patterns: Firefox accepts them silently and they never match', () => {
    expect(hostPattern('http://127.0.0.1:5555')).toBe('http://127.0.0.1/*');
    expect(hostPattern('http://localhost:8080/some/path?x=1')).toBe('http://localhost/*');
    expect(hostPattern('https://api.github.com')).toBe('https://api.github.com/*');
    const m = createManifest({ ...base, target: 'firefox', apiBase: 'http://localhost:9999' });
    for (const p of [...m.host_permissions, ...m.content_scripts[0].matches]) {
      expect(p).not.toMatch(/^[a-z]+:\/\/[^/]+:\d+\//);
    }
  });

  it('rejects hand-written extra matches that carry a port', () => {
    for (const target of ['chrome', 'firefox']) {
      expect(() =>
        createManifest({ ...base, target, extraMatches: ['http://127.0.0.1:4321/*'] }),
      ).toThrow(/must not include a port/);
    }
  });

  it('rejects unknown targets', () => {
    expect(() => createManifest({ ...base, target: 'safari' })).toThrow(/Unknown target/);
  });
});
