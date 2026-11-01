# Project conventions (CLAUDE.md template)

Keep this file short. Point to detailed docs instead of duplicating them.

## Stack

- Runtime:
- Language:
- Test runner:
- Package manager:

## Commands

- Format:
- Lint:
- Typecheck:
- Test:

## Conventions

- Prefer small, reversible changes.
- Do not modify tests to make a failing change pass.
- High-risk paths: auth, billing, CI workflows, migrations, release scripts.
- Every behavior change needs a test or a documented reason it cannot be tested.

## Non-goals

- No new dependency without a stated reason.
- No unrelated refactors in a bug-fix change.
