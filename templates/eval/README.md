# Golden set cases

Copy `.json` files into `<target-repo>/.review/eval/cases/`.

Each case:

```json
{
  "case_id": "c_001",
  "base": "main",
  "head": "fix-branch",
  "mode": "standard",
  "expected_findings": [
    { "file": "src/auth/session.ts", "line": 42, "category": "security", "must_match": "expired" }
  ],
  "clean": false,
  "notes": "regression from PR #123"
}
```

- Use `clean: true` for PRs that should produce no findings; these measure false positives.
- Matching allows a ±10 line window, exact category, and an optional case-insensitive substring in claim/evidence.
- `review eval --update-baseline` records the current recall/FP/cost baseline; later runs compare against it.
- Prefer real historical regressions and independently reviewed clean PRs over synthetic cases; a useful starting set is 30–50 cases.
