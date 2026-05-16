# Ente Auth Icon PR Preview

Fast browser-native preview for Ente auth icons.

The app can preview GitHub PR icon changes, search existing custom icons from `ente-io/ente/main`, and render pasted SVG markup with an optional registry hex color. It shows light/dark previews, highlights registry/file mismatches, keeps card-level SVG fetch errors local, and shows GitHub rate-limit details when available.

## Local Run

```sh
python3 -m http.server 7358 --bind 0.0.0.0
```

Then open http://127.0.0.1:7358/.

Open the app with an empty URL to start from a blank input, or use deep links:

```text
https://neeraj-pilot.github.io/preview-icons-pr/?pr=10426
https://neeraj-pilot.github.io/preview-icons-pr/?pr=https%3A%2F%2Fgithub.com%2Fente-io%2Fente%2Fpull%2F10426
https://neeraj-pilot.github.io/preview-icons-pr/?mode=existing&q=proxmox
https://neeraj-pilot.github.io/preview-icons-pr/?mode=custom&hex=000000
```

## Test

```sh
npm run verify
```

## Notes

- Uses unauthenticated GitHub API calls.
- Uses native browser SVG rendering for speed and selectable text.
- For PR `ente-io/ente#10426`, rendering was checked against the Flutter prototype and matched closely enough to make this the main reviewer.
