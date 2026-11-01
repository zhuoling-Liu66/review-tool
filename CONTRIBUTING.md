# Contributing

Thanks for taking a look at `review-tool`.

## Before you start

- This is an early-stage personal project. For larger changes, open an issue first so we can agree on the scope.
- Bug reports should include the command, the target repository shape (not the source code), the exit code, and the relevant `.review/` artifact paths.
- Never paste API keys, tokens, customer code, or other secrets into issues, pull requests, or logs.

## Development setup

```bash
npm ci
npm run typecheck
npm test
npm run build
```

The test suite uses temporary git repositories and mock model providers. It should not make real model calls.

## Pull requests

- Keep the change focused on one problem.
- Add or update tests for behavior changes.
- Run `npm run typecheck`, `npm test`, and `npm run build` before opening the PR.
- Update the README or `docs/` when behavior, commands, configuration, or limitations change.
- Do not commit `dist/`, `node_modules/`, `.review/`, `.env*`, or generated reports.

## Security

Please report sensitive vulnerabilities privately through GitHub Security Advisories. See [SECURITY.md](SECURITY.md).
