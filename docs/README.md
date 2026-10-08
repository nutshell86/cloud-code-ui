# docs

The panel's planning notes (`ideas.md`) and the raw CLI measurement protocols
(`messung-*.md`) are **not part of this public snapshot** — they are working documents of the
internal repository this code was extracted from and carry context that is of no use outside it.

Code comments that point at `docs/ideas.md` or `docs/messung-*.md` refer to those documents. The
reasoning they carry is, wherever it matters for reading the code, repeated at the place it applies:
the comment above the function, or the test that pins the behaviour.

What *is* public, and the better entry point anyway:

- **[../README.md](../README.md)** — what the panel does, every feature, the env-var seams, the
  measured CLI facts the implementation relies on.
- **`test/`** — ~100 test files. Nearly every non-obvious decision is pinned by a test whose name
  says why it exists.
