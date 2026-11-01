# Review rules (REVIEW.md template)

Describe how this repository fails, not how to restyle it.

## What “failure” looks like here

- Incorrect behavior in a real user path:
- Data loss or corruption:
- Auth/permission bypass:
- CI or release breakage:

## Evidence requirements

- Every finding must cite a file and line at HEAD.
- Explain why existing code, callers, or tests do not rule the issue out.
- No speculative findings without a concrete path.

## Noise controls

- Do not report formatting, naming, or style covered by the formatter/linter.
- Nits are limited to 3 per PR and must have a concrete impact.
- Skip generated files, lockfiles, snapshots, and `dist/**`.

## Severity

- blocker: exploitable security, data loss, auth bypass, broken main path.
- important: likely correctness/security issue in a realistic path.
- minor: real edge case or maintainability issue with concrete impact.
- nit: suggestion; not normally published.

## Review focus

- Did the change solve the stated problem?
- Did it break callers or violate system design?
- Are tests meaningful, or did they only encode the implementation?
- Do not modify tests/CI to make a red change green.
