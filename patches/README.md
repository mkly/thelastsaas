# Dependency patches

## Casbin 5.51.1

`casbin@5.51.1.patch` fixes expression evaluation in both CommonJS and ESM builds:

- Register `in` with relational precedence (7), matching `<`, `>`, `<=`, and `>=`. The previous precedence (1) parsed logical conjunctions as operands of `in`.
- Treat a TypeError from missing ABAC attributes as a false condition, while continuing other policies; other errors still propagate.
- Convert only comma-separated tuples directly following the `in` operator. Track quoted strings and nested delimiters so preprocessing preserves policy `eval()` wrappers, unrelated parentheses, array literals, and quoted text.

Bun applies this patch through the root `patchedDependencies` entry and lockfile. Use `bun install --frozen-lockfile` for reproducible installs. The shared rule compiler registers the same operator precedence as the patched Casbin implementation.

Regression coverage is in `packages/server/test/rule-context.test.ts`: the original combined before/after/discount condition, negative authorization checks, preprocessing edge cases, both module builds, and synchronous/asynchronous enforcement. Retain that coverage when upgrading Casbin and remove the patch only once the upstream implementation passes it unchanged.
