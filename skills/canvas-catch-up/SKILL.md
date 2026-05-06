---
name: canvas-catch-up
description: Summarize what changed in the user's Canvas account since a moment in time — new grades, new announcements, new assignments, new messages. Use when the user says "what'd I miss," "catch me up," or "what changed since <time>."
---

# canvas-catch-up

You are reporting Canvas changes since a specific moment. Goal: a tight,
skimmable diff. Don't show anything older than `since`. Don't auto-mark
anything as read.

## Resolving `since`

The `catch_up` tool persists a last-seen marker in local state, so the
common case is zero-arg. The skill picks the right tool based on what the
user said.

If the user says...

- _"what'd I miss"_ / _"catch me up"_ with no time → **`catch_up` with no
  args.** It uses the stored marker, or 24h ago on first run. The response
  includes `first_run:true` if the marker had to be bootstrapped — note
  that in the report ("First catch-up; results since 24h ago.").
- _"since Friday"_ / _"since the weekend"_ / _"since last Sunday"_ →
  resolve to that day at **00:00 in the user's local timezone**, convert
  to ISO UTC, and pass as `catch_up(since=<iso>)`. The marker still
  advances unless the user said _"don't update my catch-up bookmark."_
- _"since I checked yesterday morning"_ → `catch_up()` is fine; don't be
  clever.
- A specific timestamp → `catch_up(since=<iso>)`.
- _"just for OM 406"_ / _"in my OM 406 class"_ → resolve the course id
  via `list_courses` and pass `catch_up(course_id=<id>)`. Per-course
  markers are tracked separately.
- _"don't reset my bookmark"_ / _"just peek"_ → pass `save=false`.

## Required Canvas tools

This skill assumes the `canvas-mcp` MCP server is connected. If `whoami`
fails, stop.

## Steps

1. **Sanity-check.** `whoami`. Bail on error.

2. **Diff.** Call `catch_up` with the args resolved above. The response
   carries `since`, `until`, `first_run`, `saved`, plus `new_announcements`,
   `new_assignments`, and `newly_graded` arrays.

3. **Cross-check the activity stream.** Call `activity_stream(only_active=false)`
   and filter to entries with `created_at >= since` (use the `since` from
   step 2's response). The stream catches things `catch_up` doesn't —
   conversation messages, submission comments from graders, discussion
   replies. Dedupe against step 2.

4. **Unread inbox.** Call `inbox(scope="unread", limit=25)`. Surface any
   conversation with `last_message_at >= since` so the user sees new
   messages without leaving Canvas.

5. **Optional: announcements you weren't enrolled in last time.** Skip
   unless the user explicitly asked about new courses or term rollover.

## Output format

```
# Catch-up since <human time, e.g. "Sat May 3, 9:00 AM">

## 📬 New messages (<count>)
- <sender> — <subject>
  <one-line preview, no signature, no quoted reply>

## 📊 New grades (<count>)
- <course code>: <assignment> — <score>/<possible>
  If grader left a comment or feedback, one-line summary.

## 📣 New announcements (<count>)
- <course code>: <title>
  <one-line gist — strip HTML, no signatures, no "click here">

## 📝 New assignments (<count>)
- <course code>: <name> (due <date>)

## 💬 Discussion activity
- <course code> — <thread title>: <N> new replies
  (only if user has posted in the thread or it's a graded discussion)
```

## Rules

- **Hide empty sections.** No "0 new messages" lines.
- **`since` is a hard floor.** Don't include items where `created_at`,
  `posted_at`, or `last_message_at` is older than `since`, even if they
  appear in `todo` or the digest.
- **Strip HTML** from announcement and message bodies before quoting. If
  the body is long, one sentence max — the user can drill in.
- **Don't auto-mark.** No `mark_conversation`, no `mark_discussion_read`.
  If the user asks "and mark them read," do that as a separate confirmed
  step, not silently.
- **No editorializing.** "Prof posted exam 2 details" is fine.
  "Important update from your professor!" is not.
- **Total at the top.** End the header line with a counts summary like
  _(3 messages, 2 grades, 1 announcement)_ so a user who's only got
  ten seconds knows the shape.

## Failure modes

- **`catch_up` errors** → fall back to filtering the
  `activity_stream` by `created_at >= since`. Note the degraded mode in
  the report ("⚠️ catch_up failed; using activity stream only — may miss
  newly-posted assignments").
- **Nothing changed** → say so in one line and stop. Don't invent
  filler. _"Nothing new since <time>. ✓"_
- **Empty inbox** → just hide the section.
- **First run** → the response will set `first_run:true`. Lead the report
  with "First catch-up since the bookmark was set up — showing the last
  24h." so the user knows it's a baseline, not a true delta.

## Example invocations

User: `/canvas-catch-up`
You: `catch_up()`. Marker advances on success.

User: `/canvas-catch-up since Friday`
You: resolve to Friday 00:00 user-local; pass as `catch_up(since=<iso>)`.

User: `/canvas-catch-up just OM 406`
You: resolve the course id, then `catch_up(course_id=<id>)`.

User: `/canvas-catch-up since 2026-04-29T08:00:00-07:00 don't reset bookmark`
You: `catch_up(since="2026-04-29T08:00:00-07:00", save=false)`.
