---
name: canvas-catch-up
description: Summarize what changed in the user's Canvas account since a moment in time — new grades, new announcements, new assignments, new messages. Use when the user says "what'd I miss," "catch me up," or "what changed since <time>."
---

# canvas-catch-up

You are reporting Canvas changes since a specific moment. Goal: a tight,
skimmable diff. Don't show anything older than `since`. Don't auto-mark
anything as read.

## Resolving `since`

If the user says...

- _"what'd I miss"_ / _"catch me up"_ with no time → **24 hours ago**.
- _"since Friday"_ / _"since the weekend"_ / _"since last Sunday"_ → resolve
  to that day at **00:00 in the user's local timezone**, then convert to ISO
  UTC. If timezone is unknown, use UTC and say so in the report.
- _"since I checked yesterday morning"_ → 24 hours ago is fine; don't be
  clever.
- A specific timestamp → use it.

The `what_changed_since` tool takes ISO 8601, e.g. `2026-05-04T00:00:00Z`.

## Required Canvas tools

This skill assumes the `canvas-mcp` MCP server is connected. If `whoami`
fails, stop.

## Steps

1. **Sanity-check.** `whoami`. Bail on error.

2. **Resolve the `since` timestamp** as above.

3. **Diff.** Call `what_changed_since(iso_timestamp=<since>)`. This is the
   primary call — it's designed to return new announcements, new
   assignments, and newly graded items in one shot.

4. **Cross-check the activity stream.** Call `activity_stream(only_active=false)`
   and filter to entries with `created_at >= since`. The stream catches
   things `what_changed_since` doesn't (conversation messages, submission
   comments from graders, discussion replies). Dedupe against step 3.

5. **Unread inbox.** Call `inbox(scope="unread", limit=25)`. Surface any
   conversation with `last_message_at >= since` so the user sees new
   messages without leaving Canvas.

6. **Optional: announcements you weren't enrolled in last time.** Skip
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

- **`what_changed_since` errors** → fall back to filtering the
  `activity_stream` by `created_at >= since`. Note the degraded mode in
  the report ("⚠️ what_changed_since failed; using activity stream
  only — may miss newly-posted assignments").
- **Nothing changed** → say so in one line and stop. Don't invent
  filler. _"Nothing new since <time>. ✓"_
- **Empty inbox** → just hide the section.

## Example invocations

User: `/canvas-catch-up`
You: since = now − 24h, run the steps.

User: `/canvas-catch-up since Friday`
You: resolve to Friday 00:00 user-local; if no TZ known, use UTC and say so.

User: `/canvas-catch-up since 2026-04-29T08:00:00-07:00`
You: use that exact timestamp.
