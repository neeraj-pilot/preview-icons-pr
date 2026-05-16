import {
  GitHubRateLimitError,
  adaptiveAuthIconColor,
  createGitHubPreviewService,
  filterIconMetadata,
} from './preview-service.mjs?v=20260516-edit-comparison';
import {
  modes,
  stateFromSearch,
  urlWithState,
} from './url-state.mjs?v=20260516-edit-comparison';
import {
  svgDataUrl,
  svgFrameDocument,
  validateHexInput,
  validateSvgText,
} from './svg-renderer.mjs?v=20260516-edit-comparison';

const EXISTING_ICON_LIMIT = 48;
const SVG_CONCURRENCY = 6;
const customSource = { label: 'custom' };
const customAuthPath = 'pasted SVG';

const service = createGitHubPreviewService();
const form = document.querySelector('[data-form]');
const loadButton = document.querySelector('[data-load]');
const output = document.querySelector('[data-output]');
const prInput = document.querySelector('[data-pr-input]');
const existingInput = document.querySelector('[data-existing-input]');
const customHexInput = document.querySelector('[data-custom-hex-input]');
const modeButtons = [...document.querySelectorAll('[data-mode-button]')];
const modeControls = [...document.querySelectorAll('[data-mode-control]')];

let appState = stateFromSearch(window.location.search);
let loadRun = 0;
let existingCatalogPromise = null;
let customSvgText = '';
let customSvgTextarea = null;
let customPreviewSlot = null;

applyStateToControls(appState);
renderModeChrome();
wireEvents();
void loadActiveMode();

function wireEvents() {
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void submitActiveMode();
  });

  for (const buttonNode of modeButtons) {
    buttonNode.addEventListener('click', () => {
      const mode = buttonNode.dataset.modeButton;
      if (mode === appState.mode) return;
      appState = { ...appState, mode };
      renderModeChrome();
      syncUrl();
      void loadActiveMode();
    });
  }

  existingInput.addEventListener(
    'input',
    debounce(() => {
      if (appState.mode !== modes.existing) return;
      appState = { ...appState, existingQuery: existingInput.value.trim() };
      syncUrl();
      void loadExistingIcons();
    }, 180),
  );

  customHexInput.addEventListener('input', () => {
    if (appState.mode !== modes.custom) return;
    appState = { ...appState, customHex: customHexInput.value.trim() };
    syncUrl();
    updateCustomPreview();
  });

  window.addEventListener('popstate', () => {
    appState = stateFromSearch(window.location.search);
    applyStateToControls(appState);
    renderModeChrome();
    void loadActiveMode();
  });
}

async function submitActiveMode() {
  if (appState.mode === modes.pr) {
    appState = { ...appState, prInput: prInput.value.trim() };
    syncUrl();
    await loadPrPreview();
    return;
  }
  if (appState.mode === modes.existing) {
    appState = { ...appState, existingQuery: existingInput.value.trim() };
    syncUrl();
    await loadExistingIcons();
    return;
  }
  appState = { ...appState, customHex: customHexInput.value.trim() };
  syncUrl();
  updateCustomPreview();
}

async function loadActiveMode() {
  if (appState.mode === modes.pr) {
    await loadPrPreview();
    return;
  }
  if (appState.mode === modes.existing) {
    await loadExistingIcons();
    return;
  }
  renderCustomSvgTool();
}

function applyStateToControls(state) {
  prInput.value = state.prInput ?? '';
  existingInput.value = state.existingQuery ?? '';
  customHexInput.value = state.customHex ?? '';
}

function renderModeChrome() {
  for (const buttonNode of modeButtons) {
    const isActive = buttonNode.dataset.modeButton === appState.mode;
    buttonNode.classList.toggle('is-active', isActive);
    buttonNode.setAttribute('aria-selected', `${isActive}`);
  }
  for (const control of modeControls) {
    control.hidden = control.dataset.modeControl !== appState.mode;
  }
  loadButton.textContent =
    appState.mode === modes.pr ? 'Load' : appState.mode === modes.existing ? 'Search' : 'Preview';
}

function syncUrl() {
  window.history.replaceState(null, '', urlWithState(window.location.href, appState));
}

async function loadPrPreview() {
  const value = prInput.value.trim();
  if (!value) {
    loadRun += 1;
    loadButton.disabled = false;
    renderEmpty('Enter a GitHub PR URL or number to load icon previews.');
    return;
  }

  const runId = ++loadRun;
  loadButton.disabled = true;
  prInput.blur();
  renderLoading('Starting PR load...');

  try {
    for await (const state of service.watch(value)) {
      if (runId !== loadRun) return;
      renderPrState(state);
    }
  } finally {
    if (runId === loadRun) loadButton.disabled = false;
  }
}

function renderPrState(state) {
  if (state.fatalError && !state.result) {
    renderError(state.fatalError, state.rateLimitError);
    return;
  }
  if (!state.result) {
    renderLoading(state.stage);
    return;
  }
  const result = state.result;
  const warningCount = countWarnings(result.items);
  renderItemsPage({
    title: `#${result.reference.number} ${result.title}`,
    subtitle: `${result.reference.owner}/${result.reference.repo}  ${result.headSha.slice(0, 10)}`,
    copyValue: result.headSha,
    copyLabel: 'Copy head SHA',
    metrics: [
      ['Changed files', result.changedFileCount],
      ['Preview items', result.items.length],
      ['Warnings', warningCount],
    ],
    items: result.items,
    emptyText: state.isLoading ? state.stage : 'No auth SVG icon changes found in this PR.',
    isLoading: state.isLoading,
    stage: state.stage,
    globalWarnings: result.globalWarnings,
    rateLimitError: state.rateLimitError,
    gridLabel: 'Changed icon previews',
  });
}

async function loadExistingIcons() {
  const query = existingInput.value.trim();
  appState = { ...appState, existingQuery: query };
  const runId = ++loadRun;
  loadButton.disabled = true;
  renderLoading('Loading custom icon catalog from main...');

  try {
    const entries = await loadExistingCatalog();
    if (runId !== loadRun) return;

    const matches = filterIconMetadata(entries, query, { limit: EXISTING_ICON_LIMIT });
    const items = matches.map((entry) => itemFromMetadata(entry, { isLoadingSvg: true }));
    renderExistingResult({
      query,
      totalCount: entries.length,
      matchedCount: matches.length,
      items,
      isLoading: items.length > 0,
      stage: 'Loading SVG previews...',
    });

    await loadExistingSvgs({ runId, matches, items, query, totalCount: entries.length });
  } catch (error) {
    if (runId === loadRun) renderError(error, error instanceof GitHubRateLimitError ? error : null);
  } finally {
    if (runId === loadRun) loadButton.disabled = false;
  }
}

async function loadExistingCatalog() {
  existingCatalogPromise ??= service.fetchCustomIconCatalog();
  return existingCatalogPromise;
}

async function loadExistingSvgs({ runId, matches, items, query, totalCount }) {
  const queue = [...matches.keys()];
  const active = new Set();
  const startJob = (index) => {
    let task;
    task = service
      .fetchCustomIconSvg(matches[index])
      .then((svgText) => ({ index, svgText, task }))
      .catch((error) => ({ index, error, task }));
    active.add(task);
  };

  while (queue.length > 0 || active.size > 0) {
    while (queue.length > 0 && active.size < SVG_CONCURRENCY) {
      startJob(queue.shift());
    }
    const loaded = await Promise.race(active);
    active.delete(loaded.task);
    if (runId !== loadRun) return;

    const entry = matches[loaded.index];
    const warnings = loaded.error ? [`SVG content could not be fetched: ${loaded.error}`] : [];
    items[loaded.index] = itemFromMetadata(entry, {
      svgText: loaded.svgText ?? null,
      isLoadingSvg: false,
      warnings,
    });

    renderExistingResult({
      query,
      totalCount,
      matchedCount: matches.length,
      items,
      isLoading: queue.length > 0 || active.size > 0,
      stage: queue.length === 0 && active.size === 0 ? 'Loaded' : 'Loading SVG previews...',
    });
  }
}

function renderExistingResult({ query, totalCount, matchedCount, items, isLoading, stage }) {
  const subtitle = query
    ? `${matchedCount} shown for "${query}" from ${totalCount} custom icons on main`
    : `${matchedCount} shown from ${totalCount} custom icons on main`;
  renderItemsPage({
    title: 'Existing Custom Icons',
    subtitle,
    metrics: [
      ['Catalog icons', totalCount],
      ['Shown', matchedCount],
      ['Warnings', countWarnings(items)],
    ],
    items,
    emptyText: query ? 'No custom icons match this search.' : 'No custom icons found on main.',
    isLoading,
    stage,
    gridLabel: 'Existing custom icon previews',
  });
}

function renderCustomSvgTool() {
  loadRun += 1;
  loadButton.disabled = false;

  customSvgTextarea = el('textarea', {
    className: 'custom-svg-input',
    placeholder: '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">...</svg>',
    spellcheck: false,
  });
  customSvgTextarea.value = customSvgText;
  customSvgTextarea.addEventListener('input', () => {
    customSvgText = customSvgTextarea.value;
    updateCustomPreview();
  });

  const fileInput = el('input', {
    className: 'file-input',
    type: 'file',
    accept: '.svg,image/svg+xml',
  });
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    customSvgText = await file.text();
    customSvgTextarea.value = customSvgText;
    updateCustomPreview();
  });

  customPreviewSlot = el('div', { className: 'custom-preview-slot' });
  const workspace = el('section', { className: 'custom-workspace' }, [
    el('article', { className: 'custom-editor' }, [
      el('h2', {}, 'Custom SVG'),
      customSvgTextarea,
      el('div', { className: 'editor-actions' }, [
        el('span', { className: 'muted' }, 'Paste SVG or load a local .svg file.'),
        fileInput,
      ]),
    ]),
    customPreviewSlot,
  ]);

  output.replaceChildren(
    summarySection({
      title: 'Custom SVG Preview',
      subtitle: 'Paste an SVG and optionally provide a registry hex color.',
      metrics: [
        ['Preview items', 1],
        ['Warnings', 0],
      ],
    }),
    workspace,
  );
  updateCustomPreview();
}

function updateCustomPreview() {
  if (!customPreviewSlot) return;
  const hex = customHexInput.value.trim();
  appState = { ...appState, customHex: hex };
  const svgWarnings = validateSvgText(customSvgText);
  const hexWarnings = validateHexInput(hex);
  const warnings = [...svgWarnings, ...hexWarnings];
  const canRender = customSvgText.trim() && !svgWarnings.some((warning) => warning !== 'Paste an SVG to preview it.');
  const hexForPreview = hexWarnings.length === 0 ? normalizeHex(hex) : null;
  const item = {
    source: customSource,
    displayTitle: 'Custom SVG',
    authPath: customAuthPath,
    svgText: canRender ? customSvgText : null,
    metadata: {
      title: 'Custom SVG',
      hex: hexForPreview,
      expectedAuthPath: customAuthPath,
    },
    warnings,
    isLoadingSvg: false,
    sortKey: 'custom',
  };
  customPreviewSlot.replaceChildren(iconCard(item));
  const summary = output.querySelector('[data-custom-warning-count]');
  if (summary) summary.textContent = `${warnings.length}`;
}

function renderItemsPage({
  title,
  subtitle,
  copyValue = null,
  copyLabel = 'Copy',
  metrics,
  items,
  emptyText,
  isLoading = false,
  stage = '',
  globalWarnings = [],
  rateLimitError = null,
  gridLabel,
}) {
  const fragment = document.createDocumentFragment();
  fragment.append(
    summarySection({
      title,
      subtitle,
      copyValue,
      copyLabel,
      metrics,
      isLoading,
      stage,
    }),
  );

  if (rateLimitError) fragment.append(rateLimitBand(rateLimitError));
  if (globalWarnings.length > 0) fragment.append(warningBand(globalWarnings));

  if (items.length === 0) {
    fragment.append(
      el('section', { className: 'center-state' }, [
        el('p', { className: 'muted' }, emptyText),
      ]),
    );
  } else {
    fragment.append(
      el(
        'section',
        { className: 'icon-grid', ariaLabel: gridLabel },
        items.map((item) => iconCard(item)),
      ),
    );
  }

  output.replaceChildren(fragment);
}

function summarySection({ title, subtitle, copyValue = null, copyLabel = 'Copy', metrics, isLoading, stage }) {
  return el('section', { className: 'summary' }, [
    el('div', { className: 'summary-title' }, [
      el('h1', {}, title),
      el('div', { className: 'sha-row' }, [
        el('span', { className: 'muted selectable' }, subtitle),
        copyValue ? copyButton(copyValue, copyLabel) : null,
      ]),
      isLoading
        ? el('div', { className: 'stage-row' }, [
            el('span', { className: 'tiny-spinner', ariaHidden: 'true' }),
            el('span', { className: 'muted' }, stage),
          ])
        : null,
    ]),
    ...metrics.map(([label, value]) =>
      metric(label, value, label === 'Warnings' && title === 'Custom SVG Preview'),
    ),
  ]);
}

function metric(label, value, isCustomWarningCount = false) {
  return el('div', { className: 'metric' }, [
    el(
      'strong',
      isCustomWarningCount ? { dataCustomWarningCount: 'true' } : {},
      `${value}`,
    ),
    el('span', {}, label),
  ]);
}

function renderEmpty(message) {
  output.replaceChildren(
    el('section', { className: 'center-state' }, [
      el('p', { className: 'muted' }, message),
    ]),
  );
}

function renderLoading(label) {
  output.replaceChildren(
    el('section', { className: 'center-state' }, [
      el('div', { className: 'spinner', ariaHidden: 'true' }),
      el('p', { className: 'muted' }, label),
    ]),
  );
}

function renderError(error, rateLimitError) {
  const message = rateLimitError ? formatRateLimit(rateLimitError) : `${error}`;
  output.replaceChildren(
    el('section', { className: 'center-state error-state' }, [
      el('div', { className: 'large-status-icon', ariaHidden: 'true' }, '!'),
      el('p', { className: 'error-text' }, message),
      button('Retry', 'retry', () => void loadActiveMode()),
    ]),
  );
}

function warningBand(warnings) {
  return el('section', { className: 'warning-band' }, [
    el('div', { className: 'band-title' }, 'PR-level warnings'),
    ...warnings.map((warning) =>
      el('div', { className: 'copy-line' }, [
        el('span', { className: 'selectable' }, warning),
        copyButton(warning, 'Copy warning'),
      ]),
    ),
  ]);
}

function rateLimitBand(error) {
  return el('section', { className: 'rate-band' }, [
    el('strong', {}, 'GitHub API rate limit exceeded'),
    el('span', { className: 'selectable' }, formatRateLimit(error)),
    button('Retry', 'retry', () => void loadActiveMode()),
  ]);
}

function iconCard(item) {
  const expectedPath = item.metadata?.expectedAuthPath ?? item.authPath;
  return el('article', { className: 'icon-card' }, [
    el('header', { className: 'card-heading' }, [
      el('h2', { title: item.displayTitle }, item.displayTitle),
      el('span', { className: 'badge' }, item.source.label),
    ]),
    el('div', { className: 'path-row' }, [
      el('code', { title: item.authPath }, item.authPath),
      copyButton(item.authPath, 'Copy path'),
    ]),
    expectedPath !== item.authPath
      ? el('div', { className: 'expected-row' }, [
          el('span', { title: expectedPath }, `Registry expects ${expectedPath}`),
          copyButton(expectedPath, 'Copy expected path'),
        ])
      : null,
    previewArea(item),
    warningArea(item),
  ]);
}

function previewArea(item) {
  if (item.changeStatus === 'modified') {
    return el('div', { className: 'comparison-grid' }, [
      variantPreview(item, 'Before Light', 'light', {
        svgText: item.beforeSvgText,
        isLoading: item.isLoadingBeforeSvg,
      }),
      variantPreview(item, 'Before Dark', 'dark', {
        svgText: item.beforeSvgText,
        isLoading: item.isLoadingBeforeSvg,
      }),
      variantPreview(item, 'After Light', 'light', {
        svgText: item.afterSvgText,
        isLoading: item.isLoadingAfterSvg,
      }),
      variantPreview(item, 'After Dark', 'dark', {
        svgText: item.afterSvgText,
        isLoading: item.isLoadingAfterSvg,
      }),
    ]);
  }

  return el('div', { className: 'variant-row' }, [
    variantPreview(item, 'Light', 'light'),
    variantPreview(item, 'Dark', 'dark'),
  ]);
}

function variantPreview(
  item,
  label,
  variant,
  { svgText = item.svgText, isLoading = item.isLoadingSvg } = {},
) {
  const tint = adaptiveAuthIconColor(item.metadata?.hex, variant);
  const isLight = variant === 'light';
  const children = [
    el('div', { className: 'variant-label' }, label),
    el('div', { className: 'variant-body' }, [
      variantBody({ item, svgText, isLoading, tint, variant, label }),
    ]),
    el(
      'div',
      { className: 'variant-caption' },
      isLoading
        ? 'loading'
        : svgText == null
          ? 'unavailable'
          : tint == null
            ? 'original colors'
            : tint.toUpperCase(),
    ),
  ];
  return el(
    'div',
    { className: `variant-panel ${isLight ? 'variant-light' : 'variant-dark'}` },
    children,
  );
}

function variantBody({ item, svgText, isLoading, tint, variant, label }) {
  if (isLoading) return el('div', { className: 'spinner small', ariaHidden: 'true' });
  if (svgText == null) return el('div', { className: 'broken-icon', title: 'SVG unavailable' });

  const dataUrl = svgDataUrl(svgText);
  if (tint == null) return svgFrame(svgText, `${item.displayTitle} ${label}`, variant);

  const mask = el('div', {
    className: 'svg-mask',
    ariaLabel: `${item.displayTitle} ${label}`,
  });
  mask.style.backgroundColor = tint;
  mask.style.maskImage = `url("${dataUrl}")`;
  mask.style.webkitMaskImage = `url("${dataUrl}")`;
  return mask;
}

function svgFrame(svgText, title, variant) {
  const frame = document.createElement('iframe');
  frame.className = 'svg-frame';
  frame.title = title;
  frame.setAttribute('sandbox', '');
  frame.setAttribute('scrolling', 'no');
  frame.setAttribute('referrerpolicy', 'no-referrer');
  frame.srcdoc = svgFrameDocument(svgText, variant);
  return frame;
}

function warningArea(item) {
  if (item.warnings.length === 0) {
    const message = item.metadata
      ? `Registry entry: ${item.metadata.title}`
      : item.isLoadingSvg
        ? 'Loading preview...'
        : 'No registry metadata loaded.';
    return el('div', { className: 'card-foot muted' }, message);
  }
  return el(
    'div',
    { className: 'card-foot warning-list' },
    item.warnings.slice(0, 4).map((warning) =>
      el('div', { className: 'warning-item' }, [
        el('span', { className: 'warning-mark', ariaHidden: 'true' }, '!'),
        el('span', { className: 'selectable' }, warning),
        copyButton(warning, 'Copy warning'),
      ]),
    ),
  );
}

function itemFromMetadata(entry, { svgText = null, isLoadingSvg = false, warnings = [] } = {}) {
  return {
    source: entry.source,
    displayTitle: entry.title,
    authPath: entry.expectedAuthPath,
    svgText,
    metadata: entry,
    warnings,
    isLoadingSvg,
    sortKey: entry.title,
  };
}

function countWarnings(items) {
  return items.reduce((count, item) => count + item.warnings.length, 0);
}

function formatRateLimit(error) {
  if (error instanceof GitHubRateLimitError) {
    return `GitHub API rate limit exceeded. ${error.remainingLabel}, ${error.resetLabel}.`;
  }
  return 'GitHub API rate limit exceeded.';
}

function normalizeHex(hex) {
  const value = `${hex ?? ''}`.replace(/^#/, '').trim();
  return /^[0-9a-fA-F]{6}$/.test(value) ? value.toUpperCase() : null;
}

function copyButton(value, label) {
  return button(label, 'copy-icon', async () => {
    await copyText(value);
  });
}

function button(label, className, onClick) {
  const node = el('button', { className, type: 'button', title: label, ariaLabel: label }, [
    className === 'copy-icon' ? 'Copy' : label,
  ]);
  node.addEventListener('click', onClick);
  return node;
}

async function copyText(value) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    flashCopyStatus('Copied');
    return;
  }
  const textarea = document.createElement('textarea');
  textarea.value = value;
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  document.body.append(textarea);
  textarea.select();
  document.execCommand('copy');
  textarea.remove();
  flashCopyStatus('Copied');
}

function flashCopyStatus(message) {
  const status = document.querySelector('[data-copy-status]');
  status.textContent = message;
  window.clearTimeout(flashCopyStatus.timeout);
  flashCopyStatus.timeout = window.setTimeout(() => {
    status.textContent = '';
  }, 1200);
}

function debounce(fn, delayMs) {
  let timeout = null;
  return (...args) => {
    window.clearTimeout(timeout);
    timeout = window.setTimeout(() => fn(...args), delayMs);
  };
}

function el(tagName, props = {}, children = []) {
  const node = document.createElement(tagName);
  for (const [key, value] of Object.entries(props)) {
    if (value == null) continue;
    if (key === 'className') node.className = value;
    else if (key === 'ariaLabel') node.setAttribute('aria-label', value);
    else if (key === 'ariaHidden') node.setAttribute('aria-hidden', `${value}`);
    else if (key.startsWith('data') && key.length > 4) {
      const dataName = key
        .slice(4)
        .replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)
        .replace(/^-/, '');
      node.setAttribute(`data-${dataName}`, value);
    } else node[key] = value;
  }

  const childList = Array.isArray(children) ? children : [children];
  for (const child of childList) {
    if (child == null) continue;
    node.append(child instanceof Node ? child : document.createTextNode(`${child}`));
  }
  return node;
}
