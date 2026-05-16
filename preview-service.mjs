export const AUTH_ROOT = 'mobile/apps/auth/assets';
export const SVG_CONCURRENCY = 6;
export const ENTE_MAIN_REFERENCE = { owner: 'ente-io', repo: 'ente' };
export const AUTH_ICON_SIZE_LIMIT_BYTES = 20 * 1024;
export const AUTH_ICON_SIZE_LIMIT_LABEL = '20 KB';
export const AUTH_ICON_SIZE_EXEMPT_AUTH_PATHS = new Set([
  'assets/custom-icons/icons/bbs_nga.svg',
]);

export const iconSources = {
  custom: {
    name: 'custom',
    index: 0,
    label: 'custom',
    metadataPath: `${AUTH_ROOT}/custom-icons/_data/custom-icons.json`,
    iconPath: (stem) => `${AUTH_ROOT}/custom-icons/icons/${stem}.svg`,
  },
  simple: {
    name: 'simple',
    index: 1,
    label: 'simple',
    metadataPath: `${AUTH_ROOT}/simple-icons/_data/simple-icons.json`,
    iconPath: (stem) => `${AUTH_ROOT}/simple-icons/icons/${stem}.svg`,
  },
};

const charMap = new Map([
  ['á', 'a'],
  ['à', 'a'],
  ['â', 'a'],
  ['ä', 'a'],
  ['é', 'e'],
  ['è', 'e'],
  ['ê', 'e'],
  ['ë', 'e'],
  ['í', 'i'],
  ['ì', 'i'],
  ['î', 'i'],
  ['ï', 'i'],
  ['ó', 'o'],
  ['ò', 'o'],
  ['ô', 'o'],
  ['ö', 'o'],
  ['ú', 'u'],
  ['ù', 'u'],
  ['û', 'u'],
  ['ü', 'u'],
  ['ç', 'c'],
  ['ñ', 'n'],
  ['.', 'dot'],
  ['-', ''],
  ['&', 'and'],
  ['+', 'plus'],
  [':', ''],
  ["'", ''],
  ['/', ''],
  ['!', ''],
]);

export class HttpError extends Error {
  constructor({ status, url, body, headers }) {
    const snippet = body.length > 220 ? `${body.slice(0, 220)}...` : body;
    super(`HTTP ${status} for ${url}: ${snippet}`);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
    this.body = body;
    this.headers = headers;
  }
}

export class GitHubRateLimitError extends HttpError {
  constructor({ status, url, body, headers }) {
    super({ status, url, body, headers });
    this.name = 'GitHubRateLimitError';
    this.remaining = parseIntegerHeader(headers, 'x-ratelimit-remaining');
    const resetSeconds = parseIntegerHeader(headers, 'x-ratelimit-reset');
    this.resetAt = resetSeconds == null ? null : new Date(resetSeconds * 1000);
  }

  get remainingLabel() {
    return this.remaining == null
      ? 'unknown remaining requests'
      : `${this.remaining} remaining requests`;
  }

  get resetLabel() {
    return this.resetAt == null
      ? 'unknown reset time'
      : `resets at ${this.resetAt.toLocaleString()}`;
  }
}

function parseIntegerHeader(headers, name) {
  const value = getHeader(headers, name);
  if (value == null || value === '') return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function getHeader(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === 'function') return headers.get(name);
  const lowerName = name.toLowerCase();
  return headers[name] ?? headers[lowerName] ?? null;
}

function headersToObject(headers) {
  if (!headers) return {};
  if (typeof headers.forEach !== 'function') return { ...headers };
  const result = {};
  headers.forEach((value, key) => {
    result[key.toLowerCase()] = value;
  });
  return result;
}

export function createGitHubPreviewService({
  fetchImpl = globalThis.fetch,
  responseCache = new Map(),
} = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('A fetch implementation is required.');
  }

  async function getResponse(url, { headers = {} } = {}) {
    const key = url.toString();
    const cached = responseCache.get(key);
    if (cached) return cached;

    const promise = fetchImpl(url, { headers }).then(async (response) => {
      const body = await response.text();
      const responseHeaders = headersToObject(response.headers);
      if (!response.ok) {
        if (response.status === 403 || response.status === 429) {
          throw new GitHubRateLimitError({
            status: response.status,
            url: key,
            body,
            headers: responseHeaders,
          });
        }
        throw new HttpError({
          status: response.status,
          url: key,
          body,
          headers: responseHeaders,
        });
      }
      return {
        body,
        status: response.status,
        headers: responseHeaders,
      };
    });

    responseCache.set(key, promise);
    promise.catch(() => {
      if (responseCache.get(key) === promise) responseCache.delete(key);
    });
    return promise;
  }

  async function getJson(url) {
    const response = await getResponse(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    return JSON.parse(response.body);
  }

  async function getText(url) {
    const response = await getResponse(url);
    return response.body;
  }

  async function fetchChangedFiles(reference) {
    const files = [];
    let page = 1;
    while (true) {
      const url = new URL(
        `https://api.github.com/repos/${reference.owner}/${reference.repo}/pulls/${reference.number}/files`,
      );
      url.searchParams.set('per_page', '100');
      url.searchParams.set('page', `${page}`);
      const payload = await getJson(url);
      if (!Array.isArray(payload)) {
        throw new TypeError('GitHub files response was not a list.');
      }
      files.push(...payload.map(changedFileFromJson));
      if (payload.length < 100) break;
      page += 1;
    }
    return files;
  }

  async function fetchMetadataSnapshot({
    reference,
    source,
    baseSha,
    headSha,
    metadataChanged,
  }) {
    const headText = await getText(rawContentUrl(reference, headSha, source.metadataPath));
    const baseText = metadataChanged
      ? await getText(rawContentUrl(reference, baseSha, source.metadataPath))
      : null;
    const headEntries = parseMetadata(source, headText);
    const baseEntries = baseText == null ? [] : parseMetadata(source, baseText);
    return {
      source,
      headEntries,
      changedEntries: metadataChanged
        ? changedMetadataEntries(baseEntries, headEntries)
        : [],
    };
  }

  async function loadSvg(job) {
    try {
      return {
        key: job.key,
        kind: job.kind,
        svgText: await getText(job.url),
      };
    } catch (error) {
      return {
        key: job.key,
        kind: job.kind,
        errorMessage: error.toString(),
        rateLimitError: error instanceof GitHubRateLimitError ? error : null,
      };
    }
  }

  async function fetchCustomIconCatalog(ref = 'main') {
    const rawJson = await getText(rawContentUrl(ENTE_MAIN_REFERENCE, ref, iconSources.custom.metadataPath));
    return parseMetadata(iconSources.custom, rawJson);
  }

  async function fetchCustomIconSvg(entry, ref = 'main') {
    return getText(rawContentUrl(ENTE_MAIN_REFERENCE, ref, entry.source.iconPath(entry.expectedAssetStem)));
  }

  async function* watch(input) {
    yield loadingState('Fetching PR metadata...');

    let reference;
    try {
      reference = parsePrReference(input);
    } catch (error) {
      yield fatalState(error);
      return;
    }

    try {
      const prUrl = `https://api.github.com/repos/${reference.owner}/${reference.repo}/pulls/${reference.number}`;
      const pr = await getJson(prUrl);
      if (!pr || typeof pr !== 'object' || Array.isArray(pr)) {
        throw new TypeError('GitHub PR response was not an object.');
      }

      const baseSha = readJsonString(pr, ['base', 'sha']);
      const headSha = readJsonString(pr, ['head', 'sha']);
      const files = await fetchChangedFiles(reference);
      const iconFiles = files.filter(isAuthIconSvg);
      const metadataSources = new Set();
      for (const file of iconFiles) metadataSources.add(file.source.name);
      for (const file of files) {
        if (isAuthIconMetadata(file)) metadataSources.add(file.source.name);
      }

      const loadingChangedPaths = new Set(iconFiles.map((file) => file.filename));
      const loadingBeforeChangedPaths = new Set(
        iconFiles.filter(isModifiedFile).map((file) => file.filename),
      );
      let result = {
        reference,
        title: typeof pr.title === 'string' ? pr.title : 'Untitled PR',
        htmlUrl:
          typeof pr.html_url === 'string'
            ? pr.html_url
            : `https://github.com/${reference.owner}/${reference.repo}/pull/${reference.number}`,
        baseSha,
        headSha,
        changedFileCount: files.length,
        items: buildPreviewItemsSnapshot({
          iconFiles,
          metadata: new Map(),
          svgTextByPath: new Map(),
          svgErrorsByPath: new Map(),
          loadingChangedPaths,
          beforeSvgTextByPath: new Map(),
          beforeSvgErrorsByPath: new Map(),
          loadingBeforeChangedPaths,
          expectedSvgTextByKey: new Map(),
          expectedSvgErrorsByKey: new Map(),
          loadingExpectedKeys: new Set(),
        }),
        globalWarnings: [],
      };

      yield readyState(result, true, 'Found changed files. Loading icon metadata...');

      const metadataResults = await Promise.all(
        [...metadataSources].map(async (sourceName) => {
          const source = iconSources[sourceName];
          try {
            return {
              source,
              snapshot: await fetchMetadataSnapshot({
                reference,
                source,
                baseSha,
                headSha,
                metadataChanged: files.some((file) => file.filename === source.metadataPath),
              }),
            };
          } catch (error) {
            return { source, error };
          }
        }),
      );

      const metadata = new Map();
      const globalWarnings = [];
      let rateLimitError = null;
      for (const metadataResult of metadataResults) {
        if (metadataResult.snapshot) {
          metadata.set(metadataResult.source.name, metadataResult.snapshot);
        } else {
          if (metadataResult.error instanceof GitHubRateLimitError) {
            rateLimitError = metadataResult.error;
          }
          globalWarnings.push(
            `Could not load ${metadataResult.source.label} metadata: ${metadataResult.error}`,
          );
        }
      }

      const loadingExpectedKeys = new Set(registryOnlyKeys(iconFiles, metadata));
      const svgTextByPath = new Map();
      const svgErrorsByPath = new Map();
      const beforeSvgTextByPath = new Map();
      const beforeSvgErrorsByPath = new Map();
      const expectedSvgTextByKey = new Map();
      const expectedSvgErrorsByKey = new Map();

      result = {
        ...result,
        items: buildPreviewItemsSnapshot({
          iconFiles,
          metadata,
          svgTextByPath,
          svgErrorsByPath,
          loadingChangedPaths,
          beforeSvgTextByPath,
          beforeSvgErrorsByPath,
          loadingBeforeChangedPaths,
          expectedSvgTextByKey,
          expectedSvgErrorsByKey,
          loadingExpectedKeys,
        }),
        globalWarnings,
      };
      yield readyState(result, true, 'Loading SVG previews...', rateLimitError);

      const jobs = [
        ...iconFiles.map((file) => ({
          key: file.filename,
          kind: 'changed-after',
          url: rawContentUrl(reference, headSha, file.filename),
        })),
        ...iconFiles.filter(isModifiedFile).map((file) => ({
          key: file.filename,
          kind: 'changed-before',
          url: rawContentUrl(reference, baseSha, file.filename),
        })),
        ...registryOnlyEntries(iconFiles, metadata).map((entry) => ({
          key: entry.sourceStemKey,
          kind: 'expected-after',
          url: rawContentUrl(reference, headSha, entry.source.iconPath(entry.expectedAssetStem)),
        })),
      ];

      const queue = [...jobs];
      const active = new Set();
      const startJob = (job) => {
        let task;
        task = loadSvg(job).then((loaded) => ({ loaded, task }));
        active.add(task);
      };

      while (queue.length > 0 || active.size > 0) {
        while (queue.length > 0 && active.size < SVG_CONCURRENCY) {
          startJob(queue.shift());
        }
        const { loaded, task } = await Promise.race(active);
        active.delete(task);

        if (loaded.kind === 'expected-after') {
          loadingExpectedKeys.delete(loaded.key);
          if (loaded.svgText != null) expectedSvgTextByKey.set(loaded.key, loaded.svgText);
          if (loaded.errorMessage != null) {
            expectedSvgErrorsByKey.set(loaded.key, loaded.errorMessage);
          }
        } else if (loaded.kind === 'changed-before') {
          loadingBeforeChangedPaths.delete(loaded.key);
          if (loaded.svgText != null) beforeSvgTextByPath.set(loaded.key, loaded.svgText);
          if (loaded.errorMessage != null) {
            beforeSvgErrorsByPath.set(loaded.key, loaded.errorMessage);
          }
        } else {
          loadingChangedPaths.delete(loaded.key);
          if (loaded.svgText != null) svgTextByPath.set(loaded.key, loaded.svgText);
          if (loaded.errorMessage != null) svgErrorsByPath.set(loaded.key, loaded.errorMessage);
        }
        if (loaded.rateLimitError) rateLimitError = loaded.rateLimitError;

        result = {
          ...result,
          items: buildPreviewItemsSnapshot({
            iconFiles,
            metadata,
            svgTextByPath,
            svgErrorsByPath,
            loadingChangedPaths,
            beforeSvgTextByPath,
            beforeSvgErrorsByPath,
            loadingBeforeChangedPaths,
            expectedSvgTextByKey,
            expectedSvgErrorsByKey,
            loadingExpectedKeys,
          }),
          globalWarnings,
        };
        yield readyState(
          result,
          queue.length > 0 || active.size > 0,
          queue.length === 0 && active.size === 0 ? 'Loaded' : 'Loading SVG previews...',
          rateLimitError,
        );
      }

      if (jobs.length === 0) {
        yield readyState(result, false, 'Loaded', rateLimitError);
      }
    } catch (error) {
      yield fatalState(error, error instanceof GitHubRateLimitError ? error : null);
    }
  }

  return {
    fetchCustomIconCatalog,
    fetchCustomIconSvg,
    watch,
    getJson,
    getText,
    responseCache,
  };
}

export function loadingState(stage) {
  return {
    result: null,
    isLoading: true,
    stage,
    fatalError: null,
    rateLimitError: null,
  };
}

export function readyState(result, isLoading, stage, rateLimitError = null) {
  return {
    result,
    isLoading,
    stage,
    fatalError: null,
    rateLimitError,
  };
}

export function fatalState(error, rateLimitError = null) {
  return {
    result: null,
    isLoading: false,
    stage: 'Failed',
    fatalError: error,
    rateLimitError,
  };
}

export function parsePrReference(input) {
  const value = input.trim();
  if (/^\d+$/.test(value)) {
    return { owner: 'ente-io', repo: 'ente', number: Number.parseInt(value, 10) };
  }

  const shorthand = /^([^/\s]+)\/([^#\s]+)#(\d+)$/.exec(value);
  if (shorthand) {
    return {
      owner: shorthand[1],
      repo: shorthand[2],
      number: Number.parseInt(shorthand[3], 10),
    };
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError(`Unsupported PR reference: ${input}`);
  }
  if (url.hostname !== 'github.com') {
    throw new TypeError(`Unsupported PR reference: ${input}`);
  }
  const segments = url.pathname.split('/').filter(Boolean);
  const pullIndex = segments.indexOf('pull');
  if (segments.length < 4 || pullIndex < 2 || pullIndex + 1 >= segments.length) {
    throw new TypeError(`Unsupported GitHub PR URL: ${input}`);
  }
  return {
    owner: segments[0],
    repo: segments[1],
    number: Number.parseInt(segments[pullIndex + 1], 10),
  };
}

export function changedFileFromJson(json) {
  const filename = `${json.filename ?? ''}`;
  const source = sourceForFilename(filename);
  return {
    filename,
    status: `${json.status ?? ''}`,
    rawUrl: `${json.raw_url ?? ''}`,
    source,
    stem: fileStem(filename),
    authPath: authPath(filename),
  };
}

export function sourceForFilename(filename) {
  if (filename.startsWith(`${AUTH_ROOT}/custom-icons/`)) return iconSources.custom;
  if (filename.startsWith(`${AUTH_ROOT}/simple-icons/`)) return iconSources.simple;
  return null;
}

export function isAuthIconSvg(file) {
  return (
    file.source != null &&
    file.filename.startsWith(`${AUTH_ROOT}/`) &&
    file.filename.endsWith('.svg') &&
    file.filename.includes('/icons/')
  );
}

export function isAuthIconMetadata(file) {
  return file.source != null && file.source.metadataPath === file.filename;
}

export function isModifiedFile(file) {
  return file.status === 'modified';
}

export function svgByteSize(svgText) {
  if (svgText == null) return null;
  return new TextEncoder().encode(`${svgText}`).length;
}

export function formatIconSize(bytes) {
  if (bytes == null) return null;
  if (bytes < 1024) return `${bytes} B`;
  const kib = Math.ceil((bytes / 1024) * 10) / 10;
  return Number.isInteger(kib) ? `${kib} KB` : `${kib.toFixed(1)} KB`;
}

export function oversizedIconWarning({ authPath, bytes, label = 'SVG', force = false }) {
  if (bytes == null || bytes <= AUTH_ICON_SIZE_LIMIT_BYTES) return null;
  if (!force && !isCustomAuthIconSizeLinted(authPath)) return null;
  return `${label} size is ${formatIconSize(bytes)}, above auth linter limit of ${AUTH_ICON_SIZE_LIMIT_LABEL}.`;
}

export function isCustomAuthIconSizeLinted(authPath) {
  return (
    `${authPath ?? ''}`.startsWith('assets/custom-icons/icons/') &&
    `${authPath ?? ''}`.endsWith('.svg') &&
    !AUTH_ICON_SIZE_EXEMPT_AUTH_PATHS.has(authPath)
  );
}

export function fileStem(filename) {
  const name = filename.split('/').at(-1) ?? filename;
  return name.endsWith('.svg') ? name.slice(0, -4) : name;
}

export function authPath(filename) {
  return filename.replace(`${AUTH_ROOT}/`, 'assets/');
}

export function rawContentUrl(reference, sha, path) {
  return `https://raw.githubusercontent.com/${reference.owner}/${reference.repo}/${sha}/${path}`;
}

export function parseMetadata(source, rawJson) {
  const decoded = JSON.parse(rawJson);
  const records =
    source.name === 'simple'
      ? Array.isArray(decoded)
        ? decoded
        : []
      : decoded && typeof decoded === 'object' && Array.isArray(decoded.icons)
        ? decoded.icons
        : [];

  return records
    .filter((record) => record && typeof record === 'object')
    .map((record) =>
      iconMetadata({
        source,
        title: `${record.title ?? ''}`,
        slug: record.slug == null ? null : `${record.slug}`,
        hex: record.hex == null ? null : `${record.hex}`,
        altNames: Array.isArray(record.altNames) ? record.altNames.map((name) => `${name}`) : [],
      }),
    )
    .filter((entry) => entry.title.length > 0);
}

export function iconMetadata({ source, title, slug, hex, altNames = [] }) {
  const titleKey = title.replaceAll(' ', '').toLowerCase();
  const expectedAssetStem =
    source.name === 'custom' ? (slug ?? titleKey) : normalizeSimpleIconName(titleKey);
  const expectedPath = source.iconPath(expectedAssetStem);
  const expectedAuthPath = authPath(expectedPath);
  const sourceStemKey = iconSourceStemKey(source, expectedAssetStem);
  return {
    source,
    title,
    slug,
    hex,
    altNames,
    titleKey,
    expectedAssetStem,
    expectedAuthPath,
    sourceStemKey,
    fingerprint: `${title}|${slug ?? ''}|${hex ?? ''}|${altNames.join('|')}`,
  };
}

export function filterIconMetadata(entries, query, { limit = 60 } = {}) {
  const normalizedQuery = normalizeSearchText(query);
  const sortedEntries = [...entries].sort((left, right) => ordinalCompare(left.title, right.title));
  const matches = normalizedQuery
    ? sortedEntries.filter((entry) => iconSearchText(entry).includes(normalizedQuery))
    : sortedEntries;
  return matches.slice(0, limit);
}

export function iconSearchText(entry) {
  return normalizeSearchText([entry.title, entry.slug, ...entry.altNames].filter(Boolean).join(' '));
}

export function normalizeSearchText(input) {
  return `${input ?? ''}`
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function changedMetadataEntries(baseEntries, headEntries) {
  const baseByTitle = new Map(baseEntries.map((entry) => [entry.titleKey, entry.fingerprint]));
  return headEntries.filter((entry) => baseByTitle.get(entry.titleKey) !== entry.fingerprint);
}

export function buildPreviewItemsSnapshot({
  iconFiles,
  metadata,
  svgTextByPath,
  svgErrorsByPath,
  loadingChangedPaths,
  beforeSvgTextByPath = new Map(),
  beforeSvgErrorsByPath = new Map(),
  loadingBeforeChangedPaths = new Set(),
  expectedSvgTextByKey,
  expectedSvgErrorsByKey,
  loadingExpectedKeys,
}) {
  const metadataBySourceAndStem = new Map();
  const changedMetadataByKey = new Map();

  for (const snapshot of metadata.values()) {
    for (const entry of snapshot.headEntries) {
      metadataBySourceAndStem.set(entry.sourceStemKey, entry);
    }
    for (const entry of snapshot.changedEntries) {
      changedMetadataByKey.set(entry.sourceStemKey, entry);
    }
  }

  const usedSvgKeys = new Set();
  const items = [];
  for (const file of iconFiles) {
    const key = iconSourceStemKey(file.source, file.stem);
    const entry = metadataBySourceAndStem.get(key);
    const warnings = [];
    if (metadata.has(file.source.name) && entry == null) {
      warnings.push('Changed SVG has no matching auth registry entry.');
    }
    const svgError = svgErrorsByPath.get(file.filename);
    const beforeSvgError = beforeSvgErrorsByPath.get(file.filename);
    const isModified = isModifiedFile(file);
    const beforeSvgText = beforeSvgTextByPath.get(file.filename) ?? null;
    const afterSvgText = svgTextByPath.get(file.filename) ?? null;
    const beforeSvgSizeBytes = svgByteSize(beforeSvgText);
    const afterSvgSizeBytes = svgByteSize(afterSvgText);
    if (beforeSvgError != null) {
      warnings.push(`Before SVG content could not be fetched: ${beforeSvgError}`);
    }
    if (svgError != null) {
      const label = isModified ? 'After SVG content' : 'SVG content';
      warnings.push(`${label} could not be fetched: ${svgError}`);
    }
    const sizeWarning = oversizedIconWarning({
      authPath: file.authPath,
      bytes: afterSvgSizeBytes,
      label: isModified ? 'After SVG' : 'SVG',
    });
    if (sizeWarning != null) warnings.push(sizeWarning);
    usedSvgKeys.add(key);
    items.push({
      source: file.source,
      displayTitle: entry?.title ?? file.stem,
      authPath: file.authPath,
      svgText: afterSvgText,
      svgSizeBytes: afterSvgSizeBytes,
      beforeSvgText,
      beforeSvgSizeBytes,
      afterSvgText,
      afterSvgSizeBytes,
      metadata: entry ?? null,
      warnings,
      isLoadingSvg: loadingChangedPaths.has(file.filename),
      isLoadingBeforeSvg: loadingBeforeChangedPaths.has(file.filename),
      isLoadingAfterSvg: loadingChangedPaths.has(file.filename),
      changeStatus: file.status,
      sortKey: `${file.source.index}:${entry?.title ?? file.stem}:0`,
    });
  }

  for (const entry of changedMetadataByKey.values()) {
    if (usedSvgKeys.has(entry.sourceStemKey)) continue;
    const warnings = ['Registry entry changed, but expected SVG was not changed in the PR.'];
    const expectedError = expectedSvgErrorsByKey.get(entry.sourceStemKey);
    if (expectedError != null) {
      if (expectedError.startsWith('HTTP 404 ')) {
        warnings.push(`Expected SVG is missing at ${entry.expectedAuthPath}.`);
      } else {
        warnings.push(`Expected SVG probe failed: ${expectedError}`);
      }
    }
    const svgText = expectedSvgTextByKey.get(entry.sourceStemKey) ?? null;
    const svgSizeBytes = svgByteSize(svgText);
    const sizeWarning = oversizedIconWarning({
      authPath: entry.expectedAuthPath,
      bytes: svgSizeBytes,
      label: 'SVG',
    });
    if (sizeWarning != null) warnings.push(sizeWarning);
    items.push({
      source: entry.source,
      displayTitle: entry.title,
      authPath: entry.expectedAuthPath,
      svgText,
      svgSizeBytes,
      metadata: entry,
      warnings,
      isLoadingSvg: loadingExpectedKeys.has(entry.sourceStemKey),
      isLoadingBeforeSvg: false,
      isLoadingAfterSvg: loadingExpectedKeys.has(entry.sourceStemKey),
      changeStatus: 'metadata',
      sortKey: `${entry.source.index}:${entry.title}:1`,
    });
  }

  items.sort((a, b) => ordinalCompare(a.sortKey, b.sortKey));
  return items;
}

export function ordinalCompare(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export function registryOnlyKeys(iconFiles, metadata) {
  return registryOnlyEntries(iconFiles, metadata).map((entry) => entry.sourceStemKey);
}

export function registryOnlyEntries(iconFiles, metadata) {
  const usedSvgKeys = new Set(
    iconFiles.map((file) => iconSourceStemKey(file.source, file.stem)),
  );
  const entries = [];
  for (const snapshot of metadata.values()) {
    for (const entry of snapshot.changedEntries) {
      if (!usedSvgKeys.has(entry.sourceStemKey)) entries.push(entry);
    }
  }
  return entries;
}

export function iconSourceStemKey(source, stem) {
  return `${source.name}:${stem}`;
}

export function normalizeSimpleIconName(input) {
  let result = '';
  for (const char of input) {
    result += charMap.get(char) ?? char;
  }
  return result.trim();
}

export function readJsonString(json, path) {
  let cursor = json;
  for (const segment of path) {
    if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)) {
      throw new TypeError(`Missing JSON field ${path.join('.')}`);
    }
    cursor = cursor[segment];
  }
  if (typeof cursor !== 'string' || cursor.length === 0) {
    throw new TypeError(`Missing JSON field ${path.join('.')}`);
  }
  return cursor;
}

export function adaptiveAuthIconColor(hexColor, variant) {
  if (hexColor == null || `${hexColor}`.trim() === '') return null;
  const sanitized = `${hexColor}`.replace(/^#/, '').trim();
  if (!/^[0-9a-fA-F]{6}$/.test(sanitized)) return null;
  const color = {
    r: Number.parseInt(sanitized.slice(0, 2), 16),
    g: Number.parseInt(sanitized.slice(2, 4), 16),
    b: Number.parseInt(sanitized.slice(4, 6), 16),
  };
  const luminance = relativeLuminance(color);
  const isTooLightForLightTheme = variant === 'light' && luminance > 0.7;
  const isTooDarkForDarkTheme = variant === 'dark' && luminance < 0.05;
  if (isCloseToNeutralGrey(color) && (isTooLightForLightTheme || isTooDarkForDarkTheme)) {
    return variant === 'light' ? '#1C1C1E' : '#FFFFFF';
  }
  return `#${sanitized.toUpperCase()}`;
}

export function isCloseToNeutralGrey(color, tolerance = 3) {
  return (
    Math.abs(color.r - color.g) <= tolerance &&
    Math.abs(color.g - color.b) <= tolerance &&
    Math.abs(color.b - color.r) <= tolerance
  );
}

function relativeLuminance({ r, g, b }) {
  const channel = (value) => {
    const normalized = value / 255;
    return normalized <= 0.03928
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}
