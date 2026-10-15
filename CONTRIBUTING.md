# Contributing to Clipstead

Thanks for helping. Clipstead handles people's clipboards, so changes are judged first on security and privacy,
then on simplicity.

## Getting started

Set up the Worker and the Mac app as described in [docs/development.md](docs/development.md). Before opening a pull
request, run:

```sh
cd worker && npm run typecheck && npm run lint && npm test
cd apps/macos && swift test            # on macOS
```

CI runs the same checks on every pull request.

## Guidelines

- **Isolation first.** Every query on account data must be scoped to the authenticated user. Adding a resource or
  endpoint means adding a cross-user test to `worker/test/isolation.test.ts`.
- **No sensitive logging.** Never log request bodies, headers, tokens, pairing codes, passwords or clipboard
  content, in the Worker or in the app.
- **No new runtime dependencies** without a strong reason. The Worker and the web app have none today.
- **Migrations are append-only.** Add a new numbered file; never edit one that is already on `main`.
- **Say what you tested.** Describe what you ran in the pull request, and note anything you could not test (for
  example, no Mac available).
- Keep changes small and focused, and match the surrounding style. Biome and `swift build` must pass without warnings.

## Reporting security issues

Please do **not** open a public issue. See [SECURITY.md](SECURITY.md).

## License

By contributing, you agree that your contributions are licensed under the MIT License.
