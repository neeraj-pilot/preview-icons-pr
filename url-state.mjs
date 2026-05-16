export const modes = {
  pr: 'pr',
  existing: 'existing',
  custom: 'custom',
};

export function stateFromSearch(search) {
  const params = new URLSearchParams(search);
  const prInput = params.get('pr')?.trim() ?? '';
  const requestedMode = params.get('mode')?.trim() ?? '';
  const mode = prInput ? modes.pr : validMode(requestedMode) ? requestedMode : modes.pr;
  return {
    mode,
    prInput,
    existingQuery: params.get('q')?.trim() ?? '',
    customHex: params.get('hex')?.trim() ?? '',
  };
}

export function urlWithState(href, state) {
  const url = new URL(href);
  url.search = '';
  const mode = validMode(state.mode) ? state.mode : modes.pr;
  if (mode === modes.pr) {
    const prInput = `${state.prInput ?? ''}`.trim();
    if (prInput) url.searchParams.set('pr', prInput);
  } else {
    url.searchParams.set('mode', mode);
    if (mode === modes.existing) {
      const query = `${state.existingQuery ?? ''}`.trim();
      if (query) url.searchParams.set('q', query);
    }
    if (mode === modes.custom) {
      const hex = `${state.customHex ?? ''}`.trim();
      if (hex) url.searchParams.set('hex', hex);
    }
  }
  return url.toString();
}

export function prInputFromSearch(search) {
  return stateFromSearch(search).prInput;
}

export function urlWithPrInput(href, prInput) {
  return urlWithState(href, { mode: modes.pr, prInput });
}

function validMode(mode) {
  return Object.values(modes).includes(mode);
}
