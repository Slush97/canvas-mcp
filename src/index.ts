#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { CanvasClient } from "./canvas.js";

const baseUrl = process.env.CANVAS_BASE_URL;
const token = process.env.CANVAS_TOKEN;

if (!baseUrl || !token) {
  console.error("canvas-mcp: CANVAS_BASE_URL and CANVAS_TOKEN must be set");
  process.exit(1);
}

const canvas = new CanvasClient({ baseUrl, token });
const server = new McpServer({ name: "canvas-mcp", version: "0.1.0" });

const json = (data: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
});

server.registerTool(
  "whoami",
  {
    description: "Return the authenticated Canvas user. Use to verify the token and base URL.",
    inputSchema: {},
  },
  async () => json(await canvas.get("/users/self"))
);

server.registerTool(
  "list_courses",
  {
    description: "List the user's courses.",
    inputSchema: {
      enrollment_state: z
        .enum(["active", "invited_or_pending", "completed"])
        .optional()
        .describe("Filter by enrollment state. Defaults to all."),
      include: z
        .array(z.enum(["term", "teachers", "total_students", "syllabus_body"]))
        .optional(),
    },
  },
  async ({ enrollment_state, include }) => {
    const courses = await canvas.paginate<any>("/courses", { enrollment_state, include });
    return json(
      courses.map((c) => ({
        id: c.id,
        name: c.name,
        course_code: c.course_code,
        term: c.term?.name,
        workflow_state: c.workflow_state,
        start_at: c.start_at,
        end_at: c.end_at,
      }))
    );
  }
);

server.registerTool(
  "list_assignments",
  {
    description: "List assignments for a single course.",
    inputSchema: {
      course_id: z.number().int().describe("Canvas course id."),
      bucket: z
        .enum(["past", "overdue", "undated", "ungraded", "unsubmitted", "upcoming", "future"])
        .optional()
        .describe("Filter by Canvas assignment bucket."),
      order_by: z.enum(["position", "name", "due_at"]).optional(),
    },
  },
  async ({ course_id, bucket, order_by }) => {
    const assignments = await canvas.paginate<any>(`/courses/${course_id}/assignments`, {
      bucket,
      order_by,
    });
    return json(
      assignments.map((a) => ({
        id: a.id,
        name: a.name,
        due_at: a.due_at,
        points_possible: a.points_possible,
        submission_types: a.submission_types,
        html_url: a.html_url,
        has_submitted_submissions: a.has_submitted_submissions,
        locked_for_user: a.locked_for_user,
      }))
    );
  }
);

server.registerTool(
  "upcoming_assignments",
  {
    description: "List assignments due within the next N days across all active courses, sorted by due date.",
    inputSchema: {
      days: z
        .number()
        .int()
        .min(1)
        .max(60)
        .default(7)
        .describe("Window length in days from now. Default 7."),
    },
  },
  async ({ days }) => {
    const courses = await canvas.paginate<any>("/courses", { enrollment_state: "active" });
    const now = Date.now();
    const cutoff = now + days * 24 * 60 * 60 * 1000;

    const perCourse = await Promise.all(
      courses.map(async (c) => {
        const items = await canvas.paginate<any>(`/courses/${c.id}/assignments`, {
          bucket: "future",
        });
        return items
          .filter((a) => {
            if (!a.due_at) return false;
            const t = Date.parse(a.due_at);
            return t >= now && t <= cutoff;
          })
          .map((a) => ({
            course_id: c.id,
            course: c.course_code ?? c.name,
            id: a.id,
            name: a.name,
            due_at: a.due_at,
            points_possible: a.points_possible,
            html_url: a.html_url,
          }));
      })
    );

    const flat = perCourse.flat().sort((a, b) => Date.parse(a.due_at) - Date.parse(b.due_at));
    return json(flat);
  }
);

server.registerTool(
  "list_announcements",
  {
    description: "List recent announcements across one or more courses.",
    inputSchema: {
      course_ids: z
        .array(z.number().int())
        .min(1)
        .describe("Course ids to fetch announcements for."),
      start_date: z.string().optional().describe("ISO date. Defaults to 14 days ago server-side."),
      end_date: z.string().optional().describe("ISO date. Defaults to now server-side."),
    },
  },
  async ({ course_ids, start_date, end_date }) => {
    const context_codes = course_ids.map((id) => `course_${id}`);
    const announcements = await canvas.paginate<any>("/announcements", {
      context_codes,
      start_date,
      end_date,
    });
    return json(
      announcements.map((a) => ({
        id: a.id,
        title: a.title,
        posted_at: a.posted_at,
        context_code: a.context_code,
        author: a.author?.display_name,
        url: a.html_url,
        message: a.message,
      }))
    );
  }
);

server.registerTool(
  "list_calendar_events",
  {
    description: "List calendar events (or assignments) within a date range.",
    inputSchema: {
      start_date: z.string().describe("ISO date inclusive."),
      end_date: z.string().describe("ISO date inclusive."),
      type: z.enum(["event", "assignment"]).default("event"),
      context_codes: z
        .array(z.string())
        .optional()
        .describe('e.g. ["course_123","user_456"]. Defaults to the user\'s own contexts.'),
    },
  },
  async ({ start_date, end_date, type, context_codes }) => {
    const events = await canvas.paginate<any>("/calendar_events", {
      start_date,
      end_date,
      type,
      context_codes,
    });
    return json(
      events.map((e) => ({
        id: e.id,
        title: e.title,
        start_at: e.start_at,
        end_at: e.end_at,
        location: e.location_name,
        context_code: e.context_code,
        url: e.html_url,
      }))
    );
  }
);

server.registerTool(
  "list_modules",
  {
    description: "List modules in a course, optionally including their items.",
    inputSchema: {
      course_id: z.number().int(),
      include_items: z.boolean().default(false),
    },
  },
  async ({ course_id, include_items }) => {
    const modules = await canvas.paginate<any>(`/courses/${course_id}/modules`, {
      include: include_items ? ["items"] : undefined,
    });
    return json(
      modules.map((m) => ({
        id: m.id,
        name: m.name,
        position: m.position,
        state: m.state,
        items_count: m.items_count,
        unlock_at: m.unlock_at,
        items: m.items?.map((it: any) => ({
          id: it.id,
          type: it.type,
          title: it.title,
          position: it.position,
          indent: it.indent,
          html_url: it.html_url,
          url: it.url,
          completion_requirement: it.completion_requirement,
        })),
      }))
    );
  }
);

server.registerTool(
  "todo",
  {
    description: "List the user's Canvas to-do items (assignments needing attention).",
    inputSchema: {},
  },
  async () => {
    const items = await canvas.paginate<any>("/users/self/todo");
    return json(
      items.map((t) => ({
        type: t.type,
        course_id: t.course_id,
        course: t.context_name,
        assignment_id: t.assignment?.id,
        name: t.assignment?.name,
        due_at: t.assignment?.due_at,
        points_possible: t.assignment?.points_possible,
        submitted: t.assignment?.has_submitted_submissions,
        html_url: t.html_url,
      }))
    );
  }
);

server.registerTool(
  "grades_overview",
  {
    description: "Current and final grades for each of the user's courses (uses Canvas total_scores).",
    inputSchema: {
      enrollment_state: z
        .enum(["active", "invited_or_pending", "completed"])
        .default("active"),
    },
  },
  async ({ enrollment_state }) => {
    const courses = await canvas.paginate<any>("/courses", {
      enrollment_state,
      include: ["total_scores", "term"],
    });
    return json(
      courses.map((c) => {
        const e = c.enrollments?.[0];
        return {
          course_id: c.id,
          course: c.course_code ?? c.name,
          term: c.term?.name,
          current_grade: e?.computed_current_grade,
          current_score: e?.computed_current_score,
          final_grade: e?.computed_final_grade,
          final_score: e?.computed_final_score,
          unposted_current_score: e?.unposted_current_score,
          unposted_final_score: e?.unposted_final_score,
        };
      })
    );
  }
);

server.registerTool(
  "assignment_status",
  {
    description:
      "List assignments for a course with the user's submission state, score, and late/missing/excused flags.",
    inputSchema: {
      course_id: z.number().int(),
      bucket: z
        .enum(["past", "overdue", "undated", "ungraded", "unsubmitted", "upcoming", "future"])
        .optional(),
    },
  },
  async ({ course_id, bucket }) => {
    const assignments = await canvas.paginate<any>(`/courses/${course_id}/assignments`, {
      bucket,
      include: ["submission"],
    });
    return json(
      assignments.map((a) => {
        const s = a.submission;
        return {
          id: a.id,
          name: a.name,
          due_at: a.due_at,
          points_possible: a.points_possible,
          html_url: a.html_url,
          submitted_at: s?.submitted_at,
          workflow_state: s?.workflow_state,
          score: s?.score,
          grade: s?.grade,
          missing: s?.missing,
          late: s?.late,
          excused: s?.excused,
          submission_type: s?.submission_type,
          attempt: s?.attempt,
        };
      })
    );
  }
);

server.registerTool(
  "course_files",
  {
    description:
      "List files in a course. Tries the direct files API first; if the institution restricts it (403), falls back to scanning module items for File-type entries.",
    inputSchema: {
      course_id: z.number().int(),
      search_term: z
        .string()
        .min(3)
        .optional()
        .describe("Filter by filename substring (Canvas requires >=3 chars)."),
      content_types: z
        .array(z.string())
        .optional()
        .describe('MIME filter, e.g. ["application/pdf"]. Ignored in modules fallback.'),
    },
  },
  async ({ course_id, search_term, content_types }) => {
    try {
      const files = await canvas.paginate<any>(`/courses/${course_id}/files`, {
        search_term,
        content_types,
      });
      return json(
        files.map((f) => ({
          source: "files" as const,
          id: f.id,
          display_name: f.display_name,
          filename: f.filename,
          size: f.size,
          content_type: f["content-type"],
          url: f.url,
          created_at: f.created_at,
          updated_at: f.updated_at,
          locked_for_user: f.locked_for_user,
        }))
      );
    } catch (e) {
      if (!/^Canvas API 403/.test(String((e as Error).message))) throw e;
      const modules = await canvas.paginate<any>(`/courses/${course_id}/modules`, {
        include: ["items"],
      });
      const needle = search_term?.toLowerCase();
      const items = modules.flatMap((m: any) =>
        (m.items ?? [])
          .filter((it: any) => it.type === "File")
          .filter((it: any) => !needle || (it.title ?? "").toLowerCase().includes(needle))
          .map((it: any) => ({
            source: "modules" as const,
            id: it.content_id ?? null,
            display_name: it.title,
            module: m.name,
            html_url: it.html_url,
            api_url: it.url,
          }))
      );
      return json(items);
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
