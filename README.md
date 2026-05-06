# canvas-mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server that gives Claude (or any MCP client) read/write access to a Canvas LMS account using a personal access token. No admin involvement, no OAuth — Canvas lets students generate a token from user settings.

Built for students. Drop it into your Claude Code config and ask things like:

- *"What's due this week?"*
- *"Summarize the feedback on my last submission in OM 406."*
- *"What changed in my courses since yesterday?"*
- *"Send my professor a question about Exam 2."*

## Quick start

1. **Generate a Canvas access token.**
   In Canvas: Account → Settings → **Approved Integrations** → **+ New Access Token**. Copy it; it's only shown once. Treat it like a password.

2. **Build.**

   ```sh
   git clone <repo> canvas-mcp && cd canvas-mcp
   npm install
   npm run build
   ```

3. **Configure auth.**

   ```sh
   cp .env.example .env
   # edit .env:
   #   CANVAS_BASE_URL=https://yourschool.instructure.com
   #   CANVAS_TOKEN=<paste token>
   ```

4. **Smoke test.**

   ```sh
   set -a && . .env && set +a
   printf '%s\n' \
     '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}' \
     '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
     '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"whoami","arguments":{}}}' \
     | node dist/index.js
   ```

   You should see your Canvas user object. If not, the token or base URL is wrong.

5. **Wire into Claude Code.**
   The bash wrapper keeps the token in `.env` only — it isn't duplicated into `~/.claude.json`.

   ```sh
   claude mcp add canvas -s user -- \
     bash -c 'set -a && . /absolute/path/to/canvas-mcp/.env && set +a && exec node /absolute/path/to/canvas-mcp/dist/index.js'
   ```

   Verify with `claude mcp list`.

## Tools

38 tools, all return JSON. Tools marked *(write)* mutate Canvas state — there's no undo.

### Identity and courses
- `whoami` — sanity-check the token.
- `list_courses(enrollment_state?, include?)` — courses you're enrolled in. `include` may surface `term`, `teachers`, `total_students`, `syllabus_body`.
- `course_syllabus(course_id)` — syllabus body, HTML stripped to text.
- `course_dashboard(course_id)` — single-call summary: meta, current grade, syllabus excerpt, recent announcements, upcoming work, modules.

### Assignments and grades
- `list_assignments(course_id, bucket?, order_by?)` — full list for a course.
- `upcoming_assignments(days=7)` — across all active courses, sorted by due date.
- `assignment_details(course_id, assignment_id)` — instructions, rubric, allowed submission types.
- `assignment_status(course_id)` — assignments with submission state, score, late/missing/excused flags.
- `submission_feedback(course_id, assignment_id)` — latest submission with grade, attachments, comments, rubric assessment.
- `submission_history(course_id, assignment_id)` — every attempt the user has made.
- `grades_overview` — current/final scores per course.

### Quizzes
- `list_quizzes(course_id)` — Canvas tracks quizzes separately from assignments.
- `quiz_submissions(course_id, quiz_id)` — your attempts and scores.

### Calendar and to-do
- `list_calendar_events(start_date, end_date, type=assignment, context_codes?)` — calendar entries. If `context_codes` is omitted, defaults to all active courses (Canvas's own default of "user contexts" returns nothing for students). `type` defaults to `assignment` because some institutions don't populate the event channel.
- `todo` — Canvas's own "needs attention" feed.
- `activity_stream(only_active=false)` — global notifications: announcements, conversations, submissions, grading.
- `weekly_digest(lookback_days=7, lookahead_days=7)` — grades + recent announcements + upcoming + todo in one call.
- `what_changed_since(iso_timestamp)` — new announcements, new assignments, newly graded since a moment.

### Announcements and discussions
- `list_announcements(course_ids[])` — recent announcements across one or more courses (HTML stripped).
- `list_discussions(course_id, only_unread=false)` — non-announcement discussion topics.
- `read_discussion(course_id, topic_id)` — full thread, flattened entries with `parent_id`.
- `reply_discussion(course_id, topic_id, message, parent_entry_id?)` — *(write)*.
- `mark_discussion_read(course_id, topic_id)` — *(write)*.

### Conversations (Canvas inbox)
- `inbox(scope?, filter?, limit=25)` — list conversations; participant lists are truncated to first 5 + count.
- `read_conversation(conversation_id)` — full message thread with author names resolved.
- `send_message(recipients[], body, subject?, context_code?, group_conversation?)` — *(write)*.
- `mark_conversation(conversation_id, state?, starred?)` — *(write)*. `state` ∈ {read, unread, archived}.

### People and groups
- `course_roster(course_id, enrollment_type?, search_term?)` — list users in a course; gives the ids you need for `send_message`.
- `search_recipients(search, context?, type?)` — Canvas's recipient search (users and contexts).
- `course_groups(course_id)` — groups within a course.

### Modules, files, pages
- `list_modules(course_id, include_items=false, module_id?)` — modules with optional item listing. `module_id` returns just one module (avoids huge dumps).
- `course_files(course_id, search_term?, content_types?)` — direct files API; falls back to scanning module items for File-type entries if the institution restricts the bulk endpoint.
- `list_pages(course_id, search_term?)` — wiki pages; falls back to scanning module items for Page-type entries on 404.
- `read_page(course_id, page_url)` — page body, HTML stripped.

### Submissions
- `submit_assignment_text(course_id, assignment_id, body)` — *(write)*. `online_text_entry`.
- `submit_assignment_url(course_id, assignment_id, url)` — *(write)*. `online_url`.
- `submit_assignment_file(course_id, assignment_id, file_paths[], content_types?)` — *(write)*. `online_upload`. Reads files from local disk and runs Canvas's three-step upload (init → form post → submit).
- `add_submission_comment(course_id, assignment_id, text)` — *(write)*. Reply to grader feedback without creating a new submission.

## Institutional quirks

Canvas's surface area varies between schools. Quirks observed at one institution (CSUSM) that you may also see elsewhere:

- **Pages index disabled.** `GET /api/v1/courses/:id/pages` returns `404 "That page has been disabled for this course"`. `list_pages` transparently falls back to scanning module items for Page-type entries. Individual pages are still readable via `read_page` if you know the slug.
- **Files API restricted.** `GET /api/v1/courses/:id/files` returns 403 for students. `course_files` transparently falls back to scanning module items for File-type entries — usually surfaces ~all the same files via a different path.
- **Calendar `type=event` empty.** Instructors don't post events; entries live under `type=assignment` (which surfaces quizzes too). The default reflects this.
- **Letter grades not exposed.** Numeric scores only; `current_grade` and `final_grade` come back null even when `current_score` is set.

The tools fail loudly with the underlying Canvas error message — no silent degradations except the `course_files` fallback.

## Security

- The token grants the server your full Canvas permissions as a student. Treat it like a password.
- Revoke from Canvas → Account → Settings → Approved Integrations when you're done.
- Write tools act as you. There's no undo: a sent message is sent; a submitted assignment is submitted.
- `.env` is gitignored. Don't commit it.

## Development

```sh
npm run build      # tsc to dist/
npm run dev        # tsx watch mode
npm run typecheck  # tsc --noEmit
```

The protocol is JSON-RPC over stdio. To exercise a tool manually, pipe an `initialize`, then `notifications/initialized`, then `tools/call` frame into `node dist/index.js`.

Source layout:

```
src/
  canvas.ts   # API client: paginate(), get/post/put/delete, Link-header pagination
  util.ts     # htmlToText, date helpers
  index.ts    # MCP server bootstrap + tool registrations
```

## Acknowledgements

Built against the [Canvas REST API](https://canvas.instructure.com/doc/api/) and [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/typescript-sdk).
