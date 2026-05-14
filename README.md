# Ente Auth Icon PR Preview

Fast browser-native preview for Ente auth icon pull requests.

The app accepts a GitHub PR URL or PR number, loads changed auth icon metadata progressively, and shows light/dark previews for changed SVGs. It also highlights registry/file mismatches, keeps card-level SVG fetch errors local, and shows GitHub rate-limit details when available.

## Local Run

```sh
python3 -m http.server 7358 --bind 0.0.0.0
```

Then open http://127.0.0.1:7358/.

## Test

```sh
npm run verify
```

## Notes

- Uses unauthenticated GitHub API calls.
- Uses native browser SVG rendering for speed and selectable text.
- For PR `ente-io/ente#10426`, rendering was checked against the Flutter prototype and matched closely enough to make this the default reviewer.
