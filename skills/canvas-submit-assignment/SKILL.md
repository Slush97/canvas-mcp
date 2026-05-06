---
name: canvas-submit-assignment
description: Safely submit an assignment to Canvas — text, URL, or file upload. Use when the user says "submit X to assignment Y," "turn in," or "upload to Canvas." This skill REQUIRES explicit user confirmation before calling any write tool.
---

# canvas-submit-assignment

You are submitting an assignment on the user's behalf. Canvas submissions
**cannot be undone** — a submitted attempt is recorded permanently, even if
the user resubmits later. This skill is built around a confirmation gate:
read everything first, show the user a preview, then submit only after they
say yes.

## The hard rule

**Never call `submit_assignment_text`, `submit_assignment_url`, or
`submit_assignment_file` on the same turn the user requests submission.**
Always: resolve → preview → confirm → submit → verify. If the user is in a
hurry and asks you to skip the preview, refuse — the preview takes one extra
turn and is the only safety this skill has.

## Steps

1. **Sanity-check.** `whoami`. Bail on error.

2. **Resolve the target assignment.**
   - If the user gave a course code (e.g. "BADM 350"): call
     `list_courses(enrollment_state="active")`, find the matching `id`.
   - If the user gave an assignment name: call
     `list_assignments(course_id, bucket="unsubmitted")` first, then fall
     back to the full list. If multiple match, list them and ask which.
   - If the user gave numeric ids, use them directly.

3. **Read the assignment.** Call `assignment_details(course_id, assignment_id)`.
   Capture: `name`, `due_at`, `lock_at`, `points_possible`, `submission_types`,
   any rubric, and any existing `submission` info.

4. **Pick the submission flavor by intersecting user intent with
   `submission_types`:**
   - User pasted text or wrote a draft → needs `online_text_entry`.
   - User gave a URL (Google Doc link, GitHub repo, etc.) → needs `online_url`.
   - User gave a file path / mentioned a file → needs `online_upload`.

   **If the assignment doesn't accept the user's flavor, stop and tell them.**
   Don't silently substitute. Example: assignment is `online_upload` only and
   user pasted text → respond "this assignment only accepts file uploads;
   save your text as a `.pdf`/`.docx` first and tell me the path."

5. **Pre-flight checks.**
   - **Past due?** If `due_at` is in the past, surface that. If `lock_at` is
     in the past, the submission will likely be rejected — warn before
     attempting.
   - **Already submitted?** If `assignment_details` shows existing submission
     info, call `submission_history(course_id, assignment_id)` and tell the
     user the previous attempt count + submitted_at. Confirm they want a
     resubmission (Canvas will record it as a new attempt).
   - **Files exist?** For `online_upload`, the paths must be absolute and
     readable. If the user gave a relative path or a path that doesn't
     exist, ask before calling the tool — `submit_assignment_file` will
     fail loudly otherwise.

6. **Show the preview.** Print a confirmation block in this exact shape:

   ```
   ## Preview — about to submit
   - Course: <code> (id <course_id>)
   - Assignment: <name> (id <assignment_id>)
   - Due: <due_at, or "no due date"> · Points: <points_possible>
   - Type: online_text_entry | online_url | online_upload
   - Status: first attempt | resubmission (attempt <N+1>)
   - <Late warning if past due>

   <Content preview:>
   - For text: first 20 lines, fenced. Note total length.
   - For url: the URL on its own line.
   - For files: each path with its size in bytes.

   Reply "submit" to send it, or tell me what to change.
   ```

   **Stop here.** Do not call the write tool yet.

7. **On the user's confirmation only**, call the matching write tool:
   - `submit_assignment_text(course_id, assignment_id, body)`
   - `submit_assignment_url(course_id, assignment_id, url)`
   - `submit_assignment_file(course_id, assignment_id, file_paths, content_types?)`

   Treat anything other than an unambiguous "submit" / "yes, submit" /
   "go" as not-confirmed. If the user replies with edits, loop back to
   step 6 with the new content.

8. **Verify.** After the write returns, call
   `submission_history(course_id, assignment_id)` and report:
   - `attempt` number
   - `submitted_at` (UTC, also note relative time)
   - `preview_url` (text) or `url` (url) or list of attached filenames (file)
   - `workflow_state` (should be `submitted`)

   If the write succeeded but verify shows nothing matching, flag it
   loudly — that's a sync issue worth surfacing.

9. **Optional grader comment.** If the user said something like "tell the
   grader I had to use the late policy," do _not_ fold that into the
   submission body. Use `add_submission_comment(course_id, assignment_id,
text)` as a separate step, after the submission verifies. Don't do this
   without an explicit user request.

## Rules

- **One tool call per write.** Don't loop "submit and verify and comment"
  into a single batch. Each write is its own decision.
- **No silent retries.** If a submit fails (e.g. Canvas 422 because
  submission window closed), surface the full error and stop. Don't try a
  different submission_type as a fallback.
- **Don't strip user content.** If the body is markdown, submit markdown.
  Canvas accepts HTML and plain text in `online_text_entry`; let the
  grader see what the user wrote.
- **Don't auto-fill URLs.** If the user said "submit my repo" without a
  URL, ask for the URL — don't infer one.
- **Never submit a file you generated.** If you wrote the content, the
  user explicitly accepts it via the preview gate. No "I'll just write a
  reflection and submit it" flow.
- **One assignment at a time.** No bulk submission across multiple
  assignments in one skill invocation.

## Failure modes

- **Ambiguous assignment match** → list candidates with id + name + due_at,
  ask which.
- **Submission type mismatch** → refuse, name the accepted types.
- **Locked / past `lock_at`** → warn, ask whether to attempt anyway. If
  the API rejects it, surface the rejection verbatim.
- **File path issues** → catch before calling the tool by mentioning the
  paths in the preview ("⚠️ /path/to/x.pdf — file not found"). Don't call
  `submit_assignment_file` with bad paths.
- **`submission_history` empty after submit** → write succeeded but
  Canvas hasn't synced — note this and tell the user to refresh Canvas in
  the browser before assuming failure.

## Example

User: `/canvas-submit-assignment my essay to Reflection 3 in OM 406, here it is: <pastes 2000 words>`

You (turn 1):

- run steps 1–6
- show preview block, stop

User: `submit`

You (turn 2):

- run steps 7–8
- show verification block with attempt number and submitted_at
