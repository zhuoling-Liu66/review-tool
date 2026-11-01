# Security Policy

## Supported versions

This project is at v0.1.x. Security fixes are applied to the latest release only.

## Reporting a vulnerability

Please do not open a public issue for a vulnerability that could expose secrets, allow arbitrary code execution, or bypass the review gate.

Use GitHub's private vulnerability reporting:

<https://github.com/zhuoling-Liu66/review-tool/security/advisories/new>

Include:

- the affected command and configuration;
- a minimal reproduction;
- the expected and actual behavior;
- the impact you believe it has.

Reports are handled on a best-effort basis. Please allow time for a fix before public disclosure.

## Secrets

- Model API keys are read from environment variables only.
- Do not put real keys in `.review/config.yml`, test fixtures, issues, pull requests, or reports.
- `.review/`, `.env`, and `.env.*` are ignored by git, but you should still review `git status` before committing.
