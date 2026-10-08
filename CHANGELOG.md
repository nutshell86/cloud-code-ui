# Changelog

This repository is a **public snapshot**, published as a single commit. The detailed development
changelog — several hundred entries, each written against the internal repository's commits,
branches, pull requests and measurement runs — is not part of it: without that history its
references lead nowhere.

What replaces it:

- **[README.md](README.md)** documents the current state feature by feature, including the
  measured CLI behaviour each one depends on and the env-var seams the tests use.
- **`test/`** pins the behaviour. Where a decision is not obvious from the code, the test name and
  the comment above it say what was measured and why it came out this way.
- The panel's own **Changelog card** (System view) reads `git log` of the checkout it runs in, so
  it fills up again from the first commit you make here.

Snapshot taken 2026-10-08, against Claude Code CLI 2.1.288.
