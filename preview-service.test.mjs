import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GitHubRateLimitError,
  adaptiveAuthIconColor,
  buildPreviewItemsSnapshot,
  changedFileFromJson,
  createGitHubPreviewService,
  iconMetadata,
  iconSourceStemKey,
  iconSources,
  normalizeSimpleIconName,
  parsePrReference,
} from './preview-service.mjs';
import { prInputFromSearch, urlWithPrInput } from './url-state.mjs';

test('parses GitHub PR references', () => {
  assert.equal(parsePrReference('10426').owner, 'ente-io');
  assert.equal(parsePrReference('ente-io/ente#10426').repo, 'ente');
  assert.equal(
    parsePrReference('https://github.com/ente-io/ente/pull/10426').number,
    10426,
  );
});

test('reads and writes PR input in URL state', () => {
  assert.equal(prInputFromSearch('?pr=10426', 'fallback'), '10426');
  assert.equal(
    prInputFromSearch('?pr=https%3A%2F%2Fgithub.com%2Fente-io%2Fente%2Fpull%2F10426', 'fallback'),
    'https://github.com/ente-io/ente/pull/10426',
  );
  assert.equal(prInputFromSearch('', 'fallback'), 'fallback');
  assert.equal(
    urlWithPrInput('https://neeraj-pilot.github.io/preview-icons-pr/', '10426'),
    'https://neeraj-pilot.github.io/preview-icons-pr/?pr=10426',
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
