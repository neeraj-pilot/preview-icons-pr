import {
  GitHubRateLimitError,
  adaptiveAuthIconColor,
  createGitHubPreviewService,
} from './preview-service.mjs?v=20260514-no-default-pr';
import { prInputFromSearch, urlWithPrInput } from './url-state.mjs?v=20260514-no-default-pr';

const service = createGitHubPreviewService();
let loadRun = 0;

const form = document.querySelector('[data-form]');
const input = document.querySelector('[data-pr-input]');
const loadButton = document.querySelector('[data-load]');
const output = document.querySelector('[data-output]');

input.value = prInputFromSearch(window.location.search) || '';
form.addEventListener('submit', (event) => {
  event.preventDefault();
  void loadPreview({ syncUrl: true });
});
window.addEventListener('popstate', () => {
  input.value = prInputFromSearch(window.location.search) || '';
  void loadPreview();
});

void loadPreview();

async function loadPreview({ syncUrl = false } = {}) {
  const value = input.value.trim();
  if (syncUrl) {
    window.history.replaceState(null, '', urlWithPrInput(window.location.href, value));
  }
  if (!value) {
    loadRun += 1;
    loadButton.disabled = false;
    renderEmpty();
    return;
  }

  const runId = ++loadRun;
  loadButton.disabled = true;
  input.blur();
  renderLoading('Starting load...');

  try {
    for await (const state of service.watch(value)) {
      if (runId !== loadRun) return;
      renderState(state);
    }
  } finally {
    if (runId === loadRun) loadButton.disabled = false;
  }
}

function renderState(state) {
  if (state.fatalError && !state.result) {
    renderError(state.fatalError, state.rateLimitError);
    return;
  }
  if (!state.result) {
    renderLoading(state.stage);
    return;
  }
  renderResult(state);
}

function renderEmpty() {
  output.replaceChildren(
    el('section', { className: 'center-state' }, [
      el('p', { className: 'muted' }, 'Enter a GitHub PR URL or number to load icon previews.'),
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
  const message = rateLimitError
    ? formatRateLimit(rateLimitError)
    : `${error}`;
  output.replaceChildren(
    el('section', { className: 'center-state error-state' }, [
      el('div', { className: 'large-status-icon', ariaHidden: 'true' }, '!'),
      el('p', { className: 'error-text' }, message),
      button('Retry', 'retry', () => void loadPreview()),
    ]),
  );
}

function renderResult(state) {
  const result = state.result;
  const warningCount = result.items.reduce((count, item) => count + item.warnings.length, 0);
  const fragment = document.createDocumentFragment();

  fragment.append(
    el('section', { className: 'summary' }, [
      el('div', { className: 'summary-title' }, [
        el('h1', {}, `#${result.reference.number} ${result.title}`),
        el('div', { className: 'sha-row' }, [
          el(
            'span',
            { className: 'muted selectable' },
            `${result.reference.owner}/${result.reference.repo}  ${result.headSha.slice(0, 10)}`,
          ),
          copyButton(result.headSha, 'Copy head SHA'),
        ]),
        state.isLoading
          ? el('div', { className: 'stage-row' }, [
              el('span', { className: 'tiny-spinner', ariaHidden: 'true' }),
              el('span', { className: 'muted' }, state.stage),
            ])
          : null,
      ]),
      metric('Changed files', result.changedFileCount),
      metric('Preview items', result.items.length),
      metric('Warnings', warningCount),
    ]),
  );

  if (state.rateLimitError) {
    fragment.append(rateLimitBand(state.rateLimitError));
  }

  if (result.globalWarnings.length > 0) {
    fragment.append(warningBand(result.globalWarnings));
  }

  if (result.items.length === 0) {
    fragment.append(
      el('section', { className: 'center-state' }, [
        el(
          'p',
          { className: 'muted' },
          state.isLoading ? state.stage : 'No auth SVG icon changes found in this PR.',
        ),
      ]),
    );
  } else {
    fragment.append(
      el(
        'section',
        { className: 'icon-grid', ariaLabel: 'Changed icon previews' },
        result.items.map((item) => iconCard(item)),
      ),
    );
  }

  output.replaceChildren(fragment);
}

function metric(label, value) {
  return el('div', { className: 'metric' }, [
    el('strong', {}, `${value}`),
    el('span', {}, label),
  ]);
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
    button('Retry', 'retry', () => void loadPreview()),
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
    el('div', { className: 'variant-row' }, [
      variantPreview(item, 'Light', 'light'),
      variantPreview(item, 'Dark', 'dark'),
    ]),
    warningArea(item),
  ]);
}

function variantPreview(item, label, variant) {
  const tint = adaptiveAuthIconColor(item.metadata?.hex, variant);
  const isLight = variant === 'light';
  const children = [
    el('div', { className: 'variant-label' }, label),
    el('div', { className: 'variant-body' }, [variantBody(item, tint)]),
    el(
      'div',
      { className: 'variant-caption' },
      item.isLoadingSvg ? 'loading' : tint == null ? 'original colors' : tint.toUpperCase(),
    ),
  ];
  return el(
    'div',
    { className: `variant-panel ${isLight ? 'variant-light' : 'variant-dark'}` },
    children,
  );
}

function variantBody(item, tint) {
  if (item.isLoadingSvg) return el('div', { className: 'spinner small', ariaHidden: 'true' });
  if (item.svgText == null) return el('div', { className: 'broken-icon', title: 'SVG unavailable' });

  const dataUrl = svgDataUrl(item.svgText);
  if (tint == null) {
    return el('img', {
      className: 'svg-preview',
      alt: item.displayTitle,
      src: dataUrl,
    });
  }

  const mask = el('div', {
    className: 'svg-mask',
    ariaLabel: item.displayTitle,
  });
  mask.style.backgroundColor = tint;
  mask.style.maskImage = `url("${dataUrl}")`;
  mask.style.webkitMaskImage = `url("${dataUrl}")`;
  return mask;
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
    item.warnings.slice(0, 3).map((warning) =>
      el('div', { className: 'warning-item' }, [
        el('span', { className: 'warning-mark', ariaHidden: 'true' }, '!'),
        el('span', { className: 'selectable' }, warning),
        copyButton(warning, 'Copy warning'),
      ]),
    ),
  );
}

function formatRateLimit(error) {
  if (error instanceof GitHubRateLimitError) {
    return `GitHub API rate limit exceeded. ${error.remainingLabel}, ${error.resetLabel}.`;
  }
  return 'GitHub API rate limit exceeded.';
}

function svgDataUrl(svgText) {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgText)}`;
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

function el(tagName, props = {}, children = []) {
  const node = document.createElement(tagName);
  for (const [key, value] of Object.entries(props)) {
    if (value == null) continue;
    if (key === 'className') node.className = value;
    else if (key === 'ariaLabel') node.setAttribute('aria-label', value);
    else if (key === 'ariaHidden') node.setAttribute('aria-hidden', `${value}`);
    else node[key] = value;
  }

  const childList = Array.isArray(children) ? children : [children];
  for (const child of childList) {
    if (child == null) continue;
    node.append(child instanceof Node ? child : document.createTextNode(`${child}`));
  }
  return node;
}
