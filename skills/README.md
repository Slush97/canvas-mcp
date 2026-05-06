# Skills

Workflow recipes that turn the Canvas MCP tools into single-command rituals.
Each skill is a markdown file with YAML frontmatter that an MCP client (e.g.
Claude Code) reads as instructions.

| Skill                                                           | When to use                                                                                                                        |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| [`canvas-week-plan`](canvas-week-plan/SKILL.md)                 | Sunday-night planning. Builds a prioritized weekly plan: overdue first, then this-week-by-day, then graded work and announcements. |
| [`canvas-catch-up`](canvas-catch-up/SKILL.md)                   | After time away. Reports what changed since a moment — new grades, announcements, messages, assignments.                           |
| [`canvas-submit-assignment`](canvas-submit-assignment/SKILL.md) | Turning in work. Preview-then-confirm gate around the `submit_assignment_*` write tools. Refuses on type mismatch or bad paths.    |

## Installing for Claude Code

Skills live under `~/.claude/skills/<name>/SKILL.md` (user-scoped) or
`<project>/.claude/skills/<name>/SKILL.md` (project-scoped). Symlink or copy
this repo's skills:

```sh
# user-scoped (available everywhere)
mkdir -p ~/.claude/skills
ln -s "$(pwd)/skills/canvas-week-plan"         ~/.claude/skills/canvas-week-plan
ln -s "$(pwd)/skills/canvas-catch-up"          ~/.claude/skills/canvas-catch-up
ln -s "$(pwd)/skills/canvas-submit-assignment" ~/.claude/skills/canvas-submit-assignment
```

Then in Claude Code:

```
/canvas-week-plan
/canvas-catch-up
/canvas-catch-up since Friday
/canvas-submit-assignment my repo url to BADM 350 final project
```

The skills assume the `canvas-mcp` MCP server is connected. See the top-level
[`README.md`](../README.md) for setup.

## Authoring conventions

If you're adding a new skill, match the style of the two that ship here:

- **Frontmatter**: `name` (kebab-case) and a `description` written as
  _"use this skill when …"_. The description is what the agent reads to
  decide whether the skill is relevant.
- **Body**: instructions to the agent, not user-facing docs. Use second
  person ("call X", "don't do Y").
- **Steps numbered**, with explicit tool calls and what to do with the
  results. Note which steps are optional and which are bail-outs.
- **Output format** spelled out as a markdown skeleton.
- **Rules** section for the _don'ts_: don't auto-mutate, don't fabricate,
  don't editorialize.
- **Failure modes** for at least the obvious ones (auth, single-tool
  failures, empty result).
