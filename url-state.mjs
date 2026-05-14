export function prInputFromSearch(search, fallback) {
  const value = new URLSearchParams(search).get('pr')?.trim();
  return value ? value : fallback;
}

export function urlWithPrInput(href, prInput) {
  const url = new URL(href);
  const value = prInput.trim();
  if (value) {
    url.searchParams.set('pr', value);
  } else {
    url.searchParams.delete('pr');
  }
  return url.toString();
}
