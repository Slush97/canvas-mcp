---
name: canvas-week-plan
description: Build a prioritized weekly plan from Canvas — what's due, what's missing, what was just graded, what announcements to read. Use when the user says "plan my week," "what should I focus on this week," or "Sunday check."
---

# canvas-week-plan

You are producing a single weekly plan for the user. Goal: make it obvious what
to do first on Monday, what's overdue, and what just changed. Default lookback
is 7 days, default lookahead is 7 days.

## Required Canvas tools

This skill assumes the `canvas-mcp` MCP server is connected. If `whoami` fails,
stop and tell the user to check `CANVAS_BASE_URL` / `CANVAS_TOKEN` (or `CANVAS_COOKIE`) — don't keep
calling tools.

## Steps

1. **Sanity-check the connection.** Call `whoami`. If it errors, surface the
   error verbatim and stop.

2. **Pull the digest.** Call `weekly_digest(lookback_days=7, lookahead_days=7)`.
   This is the single richest call — it returns grades, recent announcements,
   upcoming work, and the todo feed in one shot. Use this as your spine.

3. **Fill the missing-work gap.** `weekly_digest` doesn't always surface
   _missing_ (overdue and unsubmitted) assignments cleanly. For each active
   course in `list_courses(enrollment_state="active")`, call
   `assignment_status(course_id)` and pull entries with `missing: true` or
   `late: true`. Don't skip this — overdue work belongs at the top of the
   plan, not buried.

4. **Optional: tighter due-date list.** If the digest's upcoming list is
   sparse or you need finer-grained dates, call
   `upcoming_assignments(days=7)`. Skip if the digest already covered it.

5. **Optional: peer reviews.** Canvas tracks peer review obligations
   separately from regular assignments. They show up in `todo` (already in
   the digest) — scan for `type: "viewing"` or peer-review-flagged entries.

## Output format

Write a single markdown response, in this order. Skip any section that has no
content rather than padding.

```
# Week of <Mon date> – <Sun date>

## 🔴 Top priority (overdue or due in the next 48 hours)
- <due date or "OVERDUE"> — <course code>: <assignment name>
  <one-line context: rubric type, points, status>

## This week
Group by day. Inside each day, list course code first.
- **Mon** — <course>: <assignment> (<due time>)
- **Tue** — ...

## Just graded (lookback 7 days)
- <course>: <assignment> — <score>/<possible> (<percent>)
  If feedback is non-trivial, one line summarizing it.

## Grade snapshot
One-line per course with current_score. Skip courses with no score yet.

## Worth reading
- New announcements (course + title + 1-line gist)
- Unread discussion replies on threads you've posted to (if surfaced)

## Heads up
- Peer reviews due, quizzes opening, anything missing not already at the top.
```

## Rules

- **Order matters.** Overdue first, then this-week-by-day, then read-only
  context. Users skim; the first 5 lines should answer "what do I do today?"
- **No fluff.** Don't rephrase "you have 3 assignments due" if you can just
  list them. No motivational tone.
- **Use course codes, not full names**, after the first mention. `BADM 350`
  beats `Information Technology in Business and Management`.
- **Don't fabricate due dates or scores.** If a field is null, say so or
  drop the row. Canvas regularly returns `null` for `current_grade` even
  when `current_score` is set — show the score, omit the letter.
- **Don't auto-mark anything read.** This skill is read-only. Never call
  `mark_conversation`, `mark_discussion_read`, or any `submit_*` tool.
- **One pass.** Do all reads, then write the report. Don't stream partial
  output between tool calls.

## Failure modes

- **`whoami` fails** → token/URL issue. Stop. Don't try other calls.
- **A single course's `assignment_status` errors** → log it ("⚠️ couldn't
  read status for X — Canvas error") and continue with the rest. Don't
  abandon the whole report for one bad course.
- **Empty week** → say so cleanly: "Nothing due this week. Last week's
  graded work and unread announcements below." Don't invent items.

## Example invocation

User: `/canvas-week-plan`
You: [run the steps, return the report]

User: `/canvas-week-plan just BADM 350`
You: filter `assignment_status` and the upcoming list to that course only,
keep grade snapshot whole-account.
