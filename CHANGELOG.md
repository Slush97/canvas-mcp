# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- `read_file(file_id, max_chars?=200_000)` — download a Canvas file by id and
  extract its text. PDFs go through `unpdf`, DOCX through `mammoth`, and
  text/json/xml are decoded as UTF-8. Images, archives, and other binaries
  return metadata only with no text. Files larger than 50MB are not
  downloaded. Locked files return an `error` describing the lock.
- `extractText(data, contentType)` helper exported from `src/util.ts` so the
  content-type dispatch is unit-testable in isolation.
- New runtime dependencies: `unpdf` (PDF text extraction) and `mammoth`
  (DOCX text extraction). Loaded via dynamic `import()` so they only count
  against startup when `read_file` is actually called.
- `catch_up(course_id?, since?, save?=true)` — wraps `what_changed_since`
  with a stored last-seen marker so the common case is zero-arg. First
  call defaults to 24h ago and sets `first_run:true`. Pass `course_id` to
  scope to one course (per-course markers are tracked separately). Pass
  `since` to override the stored marker for one call. Pass `save:false` to
  peek without advancing.
- `src/state.ts`: a small persistent-state module with XDG-compliant
  defaults (`${XDG_STATE_HOME:-~/.local/state}/canvas-mcp/state.json` on
  Linux/Mac, `%LOCALAPPDATA%\canvas-mcp\state.json` on Windows). Atomic
  writes via tmpfile + rename. Forward-incompatible state is treated as
  empty rather than crashing.

### Changed
- `what_changed_since` now delegates to a shared `computeChangedSince`
  helper, which `catch_up` also uses. No change to its public signature.
- `CanvasClient` now caches single-shot `get` results in-memory for 60s,
  keyed by full URL with query. `paginate` is not cached. Any write
  (`post`/`put`/`delete`) clears the cache. Helps the burst pattern that
  composites like `weekly_digest` produce. Set `CANVAS_NO_CACHE=1` to
  disable.
- `CanvasClient` now retries a request once on `429` or on `403` whose
  body matches `/rate.?limit/i`, after a 2-second pause. If the retry
  also fails, the original Canvas error is surfaced.
- Dependencies bumped to current majors: `zod` 4, `vitest` 5, `typescript` 7,
  `@types/node` 26. TypeScript 7 no longer auto-includes `@types/*`, so
  `tsconfig.json` now sets `types: ["node"]` explicitly.

## [0.2.0] — 2026-05-06

### Added
- MIT `LICENSE`.
- `CHANGELOG.md` (this file).
- Vitest unit tests for `htmlToText`, the `daysAgoIso` / `daysFromNowIso`
  helpers, and the `CanvasClient` (URL building, query encoding, error
  wrapping, Link-header pagination). 28 tests, no live Canvas required.
- `parseNextLink` is now exported from `src/canvas.ts` so its
  Link-header parsing can be exercised in isolation.
- GitHub Actions CI: typecheck + build + test on Node 22 and 24, plus
  `prettier --check`. Action runtimes opted into Node 24 via
  `FORCE_JAVASCRIPT_ACTIONS_TO_NODE24=true`.
- `engines.node: ">=22"` in `package.json`. `@types/node` bumped to `^24`.
- Prettier config (`.prettierrc.json`, `.prettierignore`) and
  `format` / `format:check` npm scripts. Existing source reformatted.
- `CLAUDE.md` repo guide for AI agents.
- Dependabot config (weekly npm grouped by dev/prod, monthly Actions).
- Three skills under `skills/`:
  - **`canvas-week-plan`** — prioritized weekly plan from `weekly_digest`
    + per-course `assignment_status`.
  - **`canvas-catch-up`** — diff since a moment, built around
    `what_changed_since` with an `activity_stream` cross-check.
  - **`canvas-submit-assignment`** — preview-then-confirm gate around the
    `submit_assignment_*` write tools, with submission-type validation
    and post-submit verification via `submission_history`.

## [0.1.0] — 2026-05-05

Initial public version. 38 tools, student-focused, all returning JSON. Write
tools are tagged `(write)` in the README; there is no undo for them.

### Added
- **Identity & courses**: `whoami`, `list_courses`, `course_syllabus`,
  `course_dashboard`.
- **Assignments & grades**: `list_assignments`, `upcoming_assignments`,
  `assignment_details`, `assignment_status`, `submission_feedback`,
  `submission_history`, `grades_overview`.
- **Quizzes**: `list_quizzes`, `quiz_submissions`.
- **Calendar & to-do**: `list_calendar_events`, `todo`, `activity_stream`,
  `weekly_digest`, `what_changed_since`.
- **Announcements & discussions**: `list_announcements`, `list_discussions`,
  `read_discussion`, `reply_discussion` *(write)*,
  `mark_discussion_read` *(write)*.
- **Conversations**: `inbox`, `read_conversation`,
  `send_message` *(write)*, `mark_conversation` *(write)*.
- **People & groups**: `course_roster`, `search_recipients`, `course_groups`.
- **Modules, files, pages**: `list_modules`, `course_files`, `list_pages`,
  `read_page`.
- **Submissions**: `submit_assignment_text` *(write)*,
  `submit_assignment_url` *(write)*, `submit_assignment_file` *(write)*
  (3-step Canvas upload), `add_submission_comment` *(write)*.

### Notes
- Transparent fallbacks for institutions that restrict the bulk Pages and
  Files endpoints — `list_pages` and `course_files` scan module items when
  the index returns 404/403.
- `list_calendar_events` defaults `context_codes` to all active courses and
  `type` to `assignment`, since Canvas's own defaults return nothing useful
  at many institutions.

[Unreleased]: https://github.com/Slush97/canvas-mcp/compare/v0.2.0...HEAD

[0.2.0]: https://github.com/Slush97/canvas-mcp/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Slush97/canvas-mcp/releases/tag/v0.1.0
