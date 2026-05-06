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
    return json(modules);
  }
);

server.registerTool(
  "todo",
  {
    description: "List the user's Canvas to-do items (assignments needing attention).",
    inputSchema: {},
  },
  async () => json(await canvas.paginate("/users/self/todo"))
);

const transport = new StdioServerTransport();
await server.connect(transport);
