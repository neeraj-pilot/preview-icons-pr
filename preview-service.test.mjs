import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GitHubRateLimitError,
  adaptiveAuthIconColor,
  buildPreviewItemsSnapshot,
  changedFileFromJson,
  createGitHubPreviewService,
  filterIconMetadata,
  formatIconSize,
  iconMetadata,
  iconSourceStemKey,
  iconSources,
  normalizeSimpleIconName,
  oversizedIconWarning,
  parseMetadata,
  parsePrReference,
  svgByteSize,
} from './preview-service.mjs';
import { modes, prInputFromSearch, stateFromSearch, urlWithPrInput, urlWithState } from './url-state.mjs';
import { svgFrameDocument, validateHexInput, validateSvgText } from './svg-renderer.mjs';

test('parses GitHub PR references', () => {
  assert.equal(parsePrReference('10426').owner, 'ente-io');
  assert.equal(parsePrReference('ente-io/ente#10426').repo, 'ente');
  assert.equal(
    parsePrReference('https://github.com/ente-io/ente/pull/10426').number,
    10426,
  );
});

test('reads and writes PR input in URL state', () => {
  assert.equal(prInputFromSearch('?pr=10426'), '10426');
  assert.equal(
    prInputFromSearch('?pr=https%3A%2F%2Fgithub.com%2Fente-io%2Fente%2Fpull%2F10426'),
    'https://github.com/ente-io/ente/pull/10426',
  );
  assert.equal(prInputFromSearch(''), '');
  assert.equal(prInputFromSearch('?pr='), '');
  assert.equal(
    urlWithPrInput('https://neeraj-pilot.github.io/preview-icons-pr/', '10426'),
    'https://neeraj-pilot.github.io/preview-icons-pr/?pr=10426',
  );
  assert.equal(
    urlWithPrInput('https://neeraj-pilot.github.io/preview-icons-pr/?pr=10426', ''),
    'https://neeraj-pilot.github.io/preview-icons-pr/',
  );
  assert.deepEqual(stateFromSearch('?mode=existing&q=proxmox'), {
    mode: modes.existing,
    prInput: '',
    existingQuery: 'proxmox',
    customHex: '',
  });
  assert.equal(
    urlWithState('https://neeraj-pilot.github.io/preview-icons-pr/?pr=10426', {
      mode: modes.custom,
      customHex: 'ffffff',
    }),
    'https://neeraj-pilot.github.io/preview-icons-pr/?mode=custom&hex=ffffff',
  );
});

test('uses auth simple-icon filename normalization', () => {
  assert.equal(normalizeSimpleIconName('dotnet'), 'dotnet');
  assert.equal(normalizeSimpleIconName('.env'), 'dotenv');
  assert.equal(normalizeSimpleIconName('1and1'), '1and1');
});

test('builds unmatched SVG and missing registry previews', () => {
  const iconFile = changedFileFromJson({
    filename: 'mobile/apps/auth/assets/custom-icons/icons/halo.svg',
    status: 'added',
    raw_url: 'https://example.test/halo.svg',
  });
  const halo = iconMetadata({
    source: iconSources.custom,
    title: 'HaloPSA',
    slug: 'halopsa',
    hex: null,
  });
  const items = buildPreviewItemsSnapshot({
    iconFiles: [iconFile],
    metadata: new Map([
      [
        iconSources.custom.name,
        {
          source: iconSources.custom,
          headEntries: [halo],
          changedEntries: [halo],
        },
      ],
    ]),
    svgTextByPath: new Map([[iconFile.filename, '<svg viewBox="0 0 1 1"></svg>']]),
    svgErrorsByPath: new Map(),
    loadingChangedPaths: new Set(),
    expectedSvgTextByKey: new Map(),
    expectedSvgErrorsByKey: new Map([
      [iconSourceStemKey(iconSources.custom, 'halopsa'), 'HTTP 404 for test'],
    ]),
    loadingExpectedKeys: new Set(),
  });

  assert.equal(items.length, 2);
  assert.ok(
    items
      .find((item) => item.authPath.endsWith('halo.svg'))
      .warnings.includes('Changed SVG has no matching auth registry entry.'),
  );
  assert.ok(
    items
      .find((item) => item.authPath.endsWith('halopsa.svg'))
      .warnings.includes('Expected SVG is missing at assets/custom-icons/icons/halopsa.svg.'),
  );
  assert.deepEqual(
    items.map((item) => item.displayTitle),
    ['HaloPSA', 'halo'],
  );
});

test('adapts neutral colors like the Flutter app', () => {
  assert.equal(adaptiveAuthIconColor('000000', 'dark'), '#FFFFFF');
  assert.equal(adaptiveAuthIconColor('FFFFFF', 'light'), '#1C1C1E');
  assert.equal(adaptiveAuthIconColor('EC1C24', 'dark'), '#EC1C24');
});

test('searches custom metadata by title, slug, and alt names', () => {
  const entries = parseMetadata(
    iconSources.custom,
    JSON.stringify({
      icons: [
        { title: 'Proxmox', altNames: ['PVE'] },
        { title: 'Nintendo Account', slug: 'nintendo' },
      ],
    }),
  );

  assert.equal(filterIconMetadata(entries, 'pve')[0].title, 'Proxmox');
  assert.equal(filterIconMetadata(entries, 'nintendo')[0].expectedAuthPath, 'assets/custom-icons/icons/nintendo.svg');
});

test('loads custom icon catalog and SVGs from main', async () => {
  const service = createGitHubPreviewService({
    fetchImpl: async (url) => {
      const value = url.toString();
      if (value.endsWith('/custom-icons/_data/custom-icons.json')) {
        return jsonResponse({ icons: [{ title: 'Proxmox' }] });
      }
      if (value.endsWith('/custom-icons/icons/proxmox.svg')) {
        return textResponse('<svg viewBox="0 0 1 1"></svg>');
      }
      return textResponse('not found', { status: 404 });
    },
  });

  const [entry] = await service.fetchCustomIconCatalog();
  assert.equal(entry.title, 'Proxmox');
  assert.match(await service.fetchCustomIconSvg(entry), /<svg/);
});

test('validates custom SVG and hex inputs', () => {
  assert.deepEqual(validateSvgText('', undefined), ['Paste an SVG to preview it.']);
  assert.deepEqual(validateSvgText('not svg', undefined), ['Input must contain an <svg> element.']);
  assert.deepEqual(validateSvgText('<svg viewBox="0 0 1 1"></svg>', undefined), []);
  assert.deepEqual(validateHexInput('fff'), ['Hex color must be six hexadecimal characters.']);
  assert.deepEqual(validateHexInput('#ffffff'), []);
  assert.match(svgFrameDocument('<svg></svg>', 'dark'), /#121212/);
});

test('formats SVG byte sizes and mirrors auth icon size lint exemptions', () => {
  assert.equal(svgByteSize('<svg>€</svg>'), 14);
  assert.equal(formatIconSize(640), '640 B');
  assert.equal(formatIconSize(1536), '1.5 KB');
  assert.equal(
    oversizedIconWarning({
      authPath: 'assets/custom-icons/icons/large.svg',
      bytes: 20481,
      label: 'SVG',
    }),
    'SVG size is 20.1 KB, above auth linter limit of 20 KB.',
  );
  assert.equal(
    oversizedIconWarning({
      authPath: 'assets/custom-icons/icons/bbs_nga.svg',
      bytes: 20481,
      label: 'SVG',
    }),
    null,
  );
  assert.equal(
    oversizedIconWarning({
      authPath: 'assets/simple-icons/icons/large.svg',
      bytes: 20481,
      label: 'SVG',
    }),
    null,
  );
});

test('service emits file-stage state before metadata and SVG finish', async () => {
  const metadataGate = deferred();
  const service = createGitHubPreviewService({
    fetchImpl: async (url) => {
      const value = url.toString();
      if (value.endsWith('/pulls/10426')) return jsonResponse(prJson());
      if (value.includes('/pulls/10426/files')) {
        return jsonResponse([
          {
            filename: 'mobile/apps/auth/assets/custom-icons/icons/cove.svg',
            status: 'added',
            raw_url: 'https://example.test/cove.svg',
          },
        ]);
      }
      if (value.endsWith('/custom-icons/_data/custom-icons.json')) {
        return metadataGate.promise;
      }
      if (value.endsWith('/custom-icons/icons/cove.svg')) {
        return textResponse('<svg viewBox="0 0 1 1"></svg>');
      }
      return textResponse('not found', { status: 404 });
    },
  });

  const iterator = service.watch('10426')[Symbol.asyncIterator]();

  let next = await iterator.next();
  assert.equal(next.value.stage, 'Fetching PR metadata...');

  next = await iterator.next();
  assert.equal(next.value.result.changedFileCount, 1);
  assert.equal(next.value.result.items[0].authPath, 'assets/custom-icons/icons/cove.svg');
  assert.equal(next.value.result.items[0].svgText, null);
  assert.equal(next.value.result.items[0].isLoadingSvg, true);

  metadataGate.resolve(
    jsonResponse({
      icons: [{ title: 'Cove Backup', slug: 'cove' }],
    }),
  );

  next = await iterator.next();
  assert.equal(next.value.result.items[0].displayTitle, 'Cove Backup');

  next = await iterator.next();
  assert.match(next.value.result.items[0].svgText, /<svg/);

  await iterator.return?.();
});

test('service loads before and after SVGs for modified icons', async () => {
  const service = createGitHubPreviewService({
    fetchImpl: async (url) => {
      const value = url.toString();
      if (value.endsWith('/pulls/10426')) return jsonResponse(prJson());
      if (value.includes('/pulls/10426/files')) {
        return jsonResponse([
          {
            filename: 'mobile/apps/auth/assets/custom-icons/icons/cove.svg',
            status: 'modified',
            raw_url: 'https://example.test/cove.svg',
          },
        ]);
      }
      if (value.endsWith('/custom-icons/_data/custom-icons.json')) {
        return jsonResponse({ icons: [{ title: 'Cove Backup', slug: 'cove' }] });
      }
      if (value.includes('/aaaaaaaaaa') && value.endsWith('/custom-icons/icons/cove.svg')) {
        return textResponse('<svg id="before"></svg>');
      }
      if (value.includes('/bbbbbbbbbb') && value.endsWith('/custom-icons/icons/cove.svg')) {
        return textResponse('<svg id="after"></svg>');
      }
      return textResponse('not found', { status: 404 });
    },
  });

  const finalResult = await finalWatchResult(service.watch('10426'));
  const [item] = finalResult.items;
  assert.equal(item.changeStatus, 'modified');
  assert.equal(item.beforeSvgText, '<svg id="before"></svg>');
  assert.equal(item.afterSvgText, '<svg id="after"></svg>');
  assert.equal(item.svgText, '<svg id="after"></svg>');
  assert.equal(item.beforeSvgSizeBytes, 23);
  assert.equal(item.afterSvgSizeBytes, 22);
  assert.equal(item.isLoadingBeforeSvg, false);
  assert.equal(item.isLoadingAfterSvg, false);
});

test('service keeps added icons as after-only previews', async () => {
  const service = createGitHubPreviewService({
    fetchImpl: async (url) => {
      const value = url.toString();
      if (value.endsWith('/pulls/10426')) return jsonResponse(prJson());
      if (value.includes('/pulls/10426/files')) {
        return jsonResponse([
          {
            filename: 'mobile/apps/auth/assets/custom-icons/icons/cove.svg',
            status: 'added',
            raw_url: 'https://example.test/cove.svg',
          },
        ]);
      }
      if (value.endsWith('/custom-icons/_data/custom-icons.json')) {
        return jsonResponse({ icons: [{ title: 'Cove Backup', slug: 'cove' }] });
      }
      if (value.includes('/bbbbbbbbbb') && value.endsWith('/custom-icons/icons/cove.svg')) {
        return textResponse('<svg id="after"></svg>');
      }
      return textResponse('not found', { status: 404 });
    },
  });

  const finalResult = await finalWatchResult(service.watch('10426'));
  const [item] = finalResult.items;
  assert.equal(item.changeStatus, 'added');
  assert.equal(item.beforeSvgText, null);
  assert.equal(item.afterSvgText, '<svg id="after"></svg>');
  assert.equal(item.svgSizeBytes, 22);
  assert.equal(item.isLoadingBeforeSvg, false);
});

test('service warns when changed custom icon exceeds auth lint size limit', async () => {
  const oversizedSvg = `<svg>${'x'.repeat(20470)}</svg>`;
  const service = createGitHubPreviewService({
    fetchImpl: async (url) => {
      const value = url.toString();
      if (value.endsWith('/pulls/10426')) return jsonResponse(prJson());
      if (value.includes('/pulls/10426/files')) {
        return jsonResponse([
          {
            filename: 'mobile/apps/auth/assets/custom-icons/icons/cove.svg',
            status: 'added',
            raw_url: 'https://example.test/cove.svg',
          },
        ]);
      }
      if (value.endsWith('/custom-icons/_data/custom-icons.json')) {
        return jsonResponse({ icons: [{ title: 'Cove Backup', slug: 'cove' }] });
      }
      if (value.includes('/bbbbbbbbbb') && value.endsWith('/custom-icons/icons/cove.svg')) {
        return textResponse(oversizedSvg);
      }
      return textResponse('not found', { status: 404 });
    },
  });

  const finalResult = await finalWatchResult(service.watch('10426'));
  const [item] = finalResult.items;
  assert.equal(item.svgSizeBytes, 20481);
  assert.ok(item.warnings.includes('SVG size is 20.1 KB, above auth linter limit of 20 KB.'));
});

test('service warns when modified icon before SVG cannot be fetched', async () => {
  const service = createGitHubPreviewService({
    fetchImpl: async (url) => {
      const value = url.toString();
      if (value.endsWith('/pulls/10426')) return jsonResponse(prJson());
      if (value.includes('/pulls/10426/files')) {
        return jsonResponse([
          {
            filename: 'mobile/apps/auth/assets/custom-icons/icons/cove.svg',
            status: 'modified',
            raw_url: 'https://example.test/cove.svg',
          },
        ]);
      }
      if (value.endsWith('/custom-icons/_data/custom-icons.json')) {
        return jsonResponse({ icons: [{ title: 'Cove Backup', slug: 'cove' }] });
      }
      if (value.includes('/aaaaaaaaaa') && value.endsWith('/custom-icons/icons/cove.svg')) {
        return textResponse('not found', { status: 404 });
      }
      if (value.includes('/bbbbbbbbbb') && value.endsWith('/custom-icons/icons/cove.svg')) {
        return textResponse('<svg id="after"></svg>');
      }
      return textResponse('not found', { status: 404 });
    },
  });

  const finalResult = await finalWatchResult(service.watch('10426'));
  const [item] = finalResult.items;
  assert.equal(item.beforeSvgText, null);
  assert.equal(item.afterSvgText, '<svg id="after"></svg>');
  assert.ok(
    item.warnings.some((warning) =>
      warning.startsWith('Before SVG content could not be fetched:'),
    ),
  );
});

test('rate limit responses are typed and include reset metadata', async () => {
  const resetSeconds = Date.UTC(2026, 4, 14, 12, 0, 0) / 1000;
  const service = createGitHubPreviewService({
    fetchImpl: async () =>
      jsonResponse(
        { message: 'rate limit' },
        {
          status: 403,
          headers: {
            'x-ratelimit-remaining': '0',
            'x-ratelimit-reset': `${resetSeconds}`,
          },
        },
      ),
  });

  const iterator = service.watch('10426')[Symbol.asyncIterator]();
  await iterator.next();
  const failed = await iterator.next();

  assert.equal(failed.value.fatalError instanceof GitHubRateLimitError, true);
  assert.equal(failed.value.rateLimitError.remaining, 0);
  assert.equal(failed.value.rateLimitError.resetAt.toISOString(), '2026-05-14T12:00:00.000Z');
});

test('caches fetched URLs for the session', async () => {
  let requestCount = 0;
  const service = createGitHubPreviewService({
    fetchImpl: async () => {
      requestCount += 1;
      return textResponse('<svg></svg>');
    },
  });

  assert.equal(await service.getText('https://example.test/icon.svg'), '<svg></svg>');
  assert.equal(await service.getText('https://example.test/icon.svg'), '<svg></svg>');
  assert.equal(requestCount, 1);
});

function prJson() {
  return {
    title: 'Icon test',
    html_url: 'https://github.com/ente-io/ente/pull/10426',
    base: { sha: 'aaaaaaaaaa000000000000000000000000000000' },
    head: { sha: 'bbbbbbbbbb000000000000000000000000000000' },
  };
}

function jsonResponse(body, options = {}) {
  return new Response(JSON.stringify(body), {
    status: options.status ?? 200,
    headers: options.headers ?? { 'content-type': 'application/json' },
  });
}

function textResponse(body, options = {}) {
  return new Response(body, {
    status: options.status ?? 200,
    headers: options.headers ?? { 'content-type': 'text/plain' },
  });
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}

async function finalWatchResult(watchIterable) {
  for await (const state of watchIterable) {
    if (state.result && !state.isLoading) return state.result;
  }
  throw new Error('Preview service did not emit a final result.');
}
