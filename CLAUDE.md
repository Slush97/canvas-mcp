# CLAUDE.md

Repo guide for Claude Code (and other AI agents) working in this codebase.

## What this is

A Model Context Protocol server that gives an AI client read/write access to a
Canvas LMS account. Auth is either a personal access token (CANVAS_TOKEN) or a
browser session cookie (CANVAS_COOKIE); token wins if both are set. Student-
focused. TypeScript, Node 22+, MCP SDK over stdio.

`src/index.ts` auto-loads `.env` from the repo root via `process.loadEnvFile`
(real env vars still win). `scripts/refresh-cookie.py` extracts the Canvas
session from any supported browser and writes CANVAS_COOKIE + CANVAS_BASE_URL to
`.env` — run via `npm run refresh-cookie`. It handles Chromium-family browsers
(key from the Linux keyring via secretstorage, or the macOS Keychain via
`security`; PBKDF2 is 1 iteration on Linux, 1003 on macOS) and Firefox-family
browsers (plaintext `moz_cookies`, no crypto). CANVAS_BROWSER forces one. Cookie auth: Canvas prefixes JSON
with `while(1);` (stripped in `parseCanvasJson`) and writes need the
`X-CSRF-Token` header from the `_csrf_token` cookie (see `authHeaders`).

## Layout

```
src/
  canvas.ts   API client: paginate(), get/post/put/delete, Link-header pagination.
              Exports parseNextLink so it's testable in isolation.
  util.ts     htmlToText (Canvas HTML → readable text) and date helpers.
  index.ts    MCP server bootstrap + every tool registration. Single file
              on purpose — tools are short, this is where you'll spend
              your time when adding features.

tests/        Vitest unit tests. No live Canvas required; fetch is spied on
              with vi.spyOn(globalThis, "fetch").

dist/         Build output. Gitignored, rebuilt by `tsc`.
```

## Commands

```sh
npm install
npm run build         # tsc → dist/
npm run dev           # tsx watch src/index.ts (MCP server on stdio)
npm run typecheck     # tsc --noEmit
npm test              # vitest run
npm run test:watch    # vitest in watch mode
npm run format        # prettier --write .
npm run format:check  # CI-friendly check (matches what CI runs)
```

CI (`.github/workflows/ci.yml`) runs `format:check`, `typecheck`, `build`, and
`test` on Node 22 and 24 for every push and PR to `master`.

## Conventions

- **Imports**: NodeNext ESM. Relative imports use `.js` extensions
  (`./canvas.js`), not `.ts`. This is required for the build, not optional.
- **Tools**: registered in `src/index.ts` via `server.tool(name, schema, handler)`.
  Each handler returns `{ content: [{ type: "text", text: JSON.stringify(...) }] }`.
  Read tools should return JSON; HTML-bearing fields go through `htmlToText`.
- **Write tools** mutate Canvas state. There is no undo. The README marks
  them `(write)` and the docstring should make the irreversibility explicit.
- **Pagination**: anything that can return >100 items uses
  `client.paginate<T>(...)`. Don't roll your own loop.
- **Institutional fallbacks**: some Canvas endpoints (Pages index, Files index)
  are restricted at some institutions. Catch the 403/404 and fall back to
  scanning module items. See `list_pages` and `course_files` for the pattern.
- **Errors**: let `CanvasClient` throw. Don't swallow Canvas errors — the
  message includes status, URL, and a body excerpt, which is what the user
  needs to debug.
- **Tests**: any pure helper or `CanvasClient` behavior change ships with a
  test. Live-Canvas testing is out of scope for the suite — mock fetch.

## Doing work

- Default to editing `src/index.ts` for new tools rather than splitting
  files. The single-file layout is intentional while the surface area is
  small.
- For a new tool: zod schema → handler → register → README entry → test if
  it touches `canvas.ts` or pure helpers → CHANGELOG entry under
  `[Unreleased]`.
- When you change a Canvas-facing surface, run a manual smoke (the JSON-RPC
  pipe in the README) before marking the task done. Type-checking and unit
  tests verify code correctness, not Canvas correctness.

## What's intentionally minimal

- No educator-facing tools (course creation, grading, analytics). Different
  audience, much larger surface, scope creep.
- No FERPA anonymization. Student tools only access the calling user's own
  data.
- Skills under `skills/` are workflow recipes (markdown), not a runtime
  framework. They compose existing tools; they don't add new capabilities.

If you're tempted to add any of the above, talk to the maintainer first —
those are scope decisions, not implementation details.
