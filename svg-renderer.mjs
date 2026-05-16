export function svgDataUrl(svgText) {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgText)}`;
}

export function svgFrameDocument(svgText, variant) {
  const background = variant === 'light' ? '#ffffff' : '#121212';
  const normalizedSvg = normalizeSvgText(svgText);
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <style>
      html,
      body {
        width: 100%;
        height: 100%;
        margin: 0;
        overflow: hidden;
        background: ${background};
      }

      body {
        display: grid;
        place-items: center;
      }

      svg {
        display: block;
        width: 82px !important;
        height: 82px !important;
        max-width: 82px;
        max-height: 82px;
      }
    </style>
  </head>
  <body>${normalizedSvg}</body>
</html>`;
}

export function normalizeSvgText(svgText) {
  return `${svgText ?? ''}`
    .trim()
    .replace(/^\s*<\?xml[^>]*>\s*/i, '')
    .replace(/^\s*<!doctype[^>]*>\s*/i, '');
}

export function validateSvgText(svgText, parser = globalThis.DOMParser) {
  const value = `${svgText ?? ''}`.trim();
  if (!value) return ['Paste an SVG to preview it.'];
  if (!/<svg[\s>]/i.test(value)) return ['Input must contain an <svg> element.'];
  if (typeof parser !== 'function') return [];
  const document = new parser().parseFromString(value, 'image/svg+xml');
  if (document.querySelector('parsererror')) return ['SVG markup could not be parsed.'];
  if (!document.querySelector('svg')) return ['Input must contain an <svg> element.'];
  return [];
}

export function validateHexInput(hex) {
  const value = `${hex ?? ''}`.trim();
  if (!value) return [];
  return /^#?[0-9a-fA-F]{6}$/.test(value) ? [] : ['Hex color must be six hexadecimal characters.'];
}
