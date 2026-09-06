#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import { CanvasClient, parseCanvasJson } from "./canvas.js";
import { htmlToText, daysAgoIso, daysFromNowIso, extractText } from "./util.js";
import { getLastSeen, loadState, saveState, setLastSeen } from "./state.js";
import { fileURLToPath } from "node:url";

const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024;

// Load .env from the repo root if present, so `npm start` works without the
// caller exporting these vars. An MCP client that sets env directly still wins.
try {
  process.loadEnvFile(fileURLToPath(new URL("../.env", import.meta.url)));
} catch {
  // no .env file — env is expected to come from the environment/MCP config
}

const baseUrl = process.env.CANVAS_BASE_URL;
const token = process.env.CANVAS_TOKEN;
const cookie = process.env.CANVAS_COOKIE;

if (!baseUrl || (!token && !cookie)) {
  console.error("canvas-mcp: CANVAS_BASE_URL and one of CANVAS_TOKEN / CANVAS_COOKIE must be set");
  process.exit(1);
}

const canvas = new CanvasClient({ baseUrl, token, cookie });
const server = new McpServer({ name: "canvas-mcp", version: "0.1.0" });

const json = (data: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
});

interface ChangeDiff {
  since: string;
  new_announcements: Array<{ course: string; title: string; posted_at: string; url: string }>;
  new_assignments: Array<{
    course: string;
    name: string;
    due_at: string | null;
    points_possible: number | null;
    html_url: string;
  }>;
  newly_graded: Array<{
    course: string;
    assignment: string;
    score: number;
    points_possible: number | null;
    graded_at: string | null;
    posted_at: string | null;
    html_url: string;
  }>;
}

async function computeChangedSince(since: string, only_course_id?: number): Promise<ChangeDiff> {
  const sinceMs = Date.parse(since);
  if (Number.isNaN(sinceMs)) {
    throw new Error(`invalid ISO timestamp: ${since}`);
  }
  let real: any[];
  if (only_course_id != null) {
    const c = await canvas.get<any>(`/courses/${only_course_id}`);
    real = c?.id ? [c] : [];
  } else {
    const courses = await canvas.paginate<any>("/courses", { enrollment_state: "active" });
    real = courses.filter((c) => c.id);
  }
  const courseIds = real.map((c) => c.id);
  const courseLookup = new Map<number, string>(real.map((c) => [c.id, c.course_code ?? c.name]));

  const [announcements, perCourseAssignments] = await Promise.all([
    courseIds.length
      ? canvas.paginate<any>("/announcements", {
          context_codes: courseIds.map((id) => `course_${id}`),
          start_date: since,
        })
      : Promise.resolve([]),
    Promise.all(
      courseIds.map((id) =>
        canvas.paginate<any>(`/courses/${id}/assignments`, { include: ["submission"] }),
      ),
    ),
  ]);

  const new_announcements = announcements
    .filter((a: any) => Date.parse(a.posted_at) >= sinceMs)
    .map((a: any) => {
      const cid = Number(String(a.context_code).split("_")[1]);
      return {
        course: courseLookup.get(cid) ?? a.context_code,
        title: a.title,
        posted_at: a.posted_at,
        url: a.html_url,
      };
    });

  const new_assignments: ChangeDiff["new_assignments"] = [];
  const newly_graded: ChangeDiff["newly_graded"] = [];
  for (let i = 0; i < courseIds.length; i++) {
    const course = courseLookup.get(courseIds[i]) ?? `course_${courseIds[i]}`;
    for (const a of perCourseAssignments[i]) {
      if (a.created_at && Date.parse(a.created_at) >= sinceMs) {
        new_assignments.push({
          course,
          name: a.name,
          due_at: a.due_at,
          points_possible: a.points_possible,
          html_url: a.html_url,
        });
      }
      const s = a.submission;
      const gradedAt = s?.graded_at ? Date.parse(s.graded_at) : 0;
      const postedAt = s?.posted_at ? Date.parse(s.posted_at) : 0;
      if (Math.max(gradedAt, postedAt) >= sinceMs && s?.score != null) {
        newly_graded.push({
          course,
          assignment: a.name,
          score: s.score,
          points_possible: a.points_possible,
          graded_at: s.graded_at,
          posted_at: s.posted_at,
          html_url: a.html_url,
        });
      }
    }
  }

  return { since, new_announcements, new_assignments, newly_graded };
}

server.registerTool(
  "whoami",
  {
    description: "Return the authenticated Canvas user. Use to verify the token and base URL.",
    inputSchema: {},
  },
  async () => json(await canvas.get("/users/self")),
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
      include: z.array(z.enum(["term", "teachers", "total_students", "syllabus_body"])).optional(),
    },
  },
  async ({ enrollment_state, include }) => {
    const courses = await canvas.paginate<any>("/courses", { enrollment_state, include });
    const want = new Set(include ?? []);
    return json(
      courses.map((c) => {
        const out: Record<string, unknown> = {
          id: c.id,
          name: c.name,
          course_code: c.course_code,
          term: c.term?.name,
          workflow_state: c.workflow_state,
          start_at: c.start_at,
          end_at: c.end_at,
        };
        if (want.has("teachers")) {
          out.teachers = (c.teachers ?? []).map((t: any) => ({
            id: t.id,
            name: t.display_name ?? t.name,
          }));
        }
        if (want.has("total_students")) out.total_students = c.total_students;
        if (want.has("syllabus_body")) out.syllabus = htmlToText(c.syllabus_body, 4000);
        return out;
      }),
    );
  },
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
      })),
    );
  },
);

server.registerTool(
  "upcoming_assignments",
  {
    description:
      "List assignments due within the next N days across all active courses, sorted by due date.",
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
      }),
    );

    const flat = perCourse.flat().sort((a, b) => Date.parse(a.due_at) - Date.parse(b.due_at));
    return json(flat);
  },
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
        message: htmlToText(a.message, 4000),
      })),
    );
  },
);

server.registerTool(
  "list_calendar_events",
  {
    description:
      "List calendar events (or assignments) within a date range. If context_codes is omitted, defaults to all of the user's active courses (Canvas's default of 'user's own contexts' typically returns nothing for students).",
    inputSchema: {
      start_date: z.string().describe("ISO date inclusive."),
      end_date: z.string().describe("ISO date inclusive."),
      type: z.enum(["event", "assignment"]).default("assignment"),
      context_codes: z
        .array(z.string())
        .optional()
        .describe('e.g. ["course_123","user_456"]. Defaults to all active courses.'),
    },
  },
  async ({ start_date, end_date, type, context_codes }) => {
    let codes = context_codes;
    if (!codes || codes.length === 0) {
      const courses = await canvas.paginate<any>("/courses", { enrollment_state: "active" });
      codes = courses.filter((c) => c.id).map((c) => `course_${c.id}`);
      if (type === "event") codes.push("user_self");
    }
    const events = await canvas.paginate<any>("/calendar_events", {
      start_date,
      end_date,
      type,
      context_codes: codes,
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
      })),
    );
  },
);

server.registerTool(
  "list_modules",
  {
    description:
      "List modules in a course, optionally including their items. Pass module_id to fetch a single module's items (avoids huge dumps for content-heavy courses).",
    inputSchema: {
      course_id: z.number().int(),
      include_items: z.boolean().default(false),
      module_id: z
        .number()
        .int()
        .optional()
        .describe("If set, return only this module (with items if include_items)."),
    },
  },
  async ({ course_id, include_items, module_id }) => {
    const include = include_items ? ["items"] : undefined;
    if (module_id != null) {
      const m = await canvas.get<any>(
        `/courses/${course_id}/modules/${module_id}`,
        include ? { include } : undefined,
      );
      const items =
        include_items && !m.items
          ? await canvas.paginate<any>(`/courses/${course_id}/modules/${module_id}/items`)
          : m.items;
      return json([
        {
          id: m.id,
          name: m.name,
          position: m.position,
          state: m.state,
          items_count: m.items_count,
          unlock_at: m.unlock_at,
          items: items?.map((it: any) => ({
            id: it.id,
            type: it.type,
            title: it.title,
            position: it.position,
            indent: it.indent,
            html_url: it.html_url,
            url: it.url,
            completion_requirement: it.completion_requirement,
          })),
        },
      ]);
    }
    const modules = await canvas.paginate<any>(`/courses/${course_id}/modules`, { include });
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
      })),
    );
  },
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
      })),
    );
  },
);

server.registerTool(
  "grades_overview",
  {
    description:
      "Current and final grades for each of the user's courses (uses Canvas total_scores).",
    inputSchema: {
      enrollment_state: z.enum(["active", "invited_or_pending", "completed"]).default("active"),
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
      }),
    );
  },
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
      }),
    );
  },
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
        })),
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
          })),
      );
      return json(items);
    }
  },
);

server.registerTool(
  "read_file",
  {
    description:
      "Download a Canvas file by id and extract its text. PDFs go through unpdf, DOCX through mammoth, text/json/xml are decoded as UTF-8. Images, archives, and other binaries return metadata only with no text. Files larger than 50MB are not downloaded.",
    inputSchema: {
      file_id: z.number().int(),
      max_chars: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Truncate extracted text to this many characters. Defaults to 200000."),
    },
  },
  async ({ file_id, max_chars }) => {
    const limit = max_chars ?? 200_000;
    const meta = await canvas.get<any>(`/files/${file_id}`);
    const url = (meta.url ?? null) as string | null;
    const contentType = String(meta["content-type"] ?? "application/octet-stream");
    const size = Number(meta.size ?? 0);
    const name = String(meta.display_name ?? meta.filename ?? `file-${file_id}`);

    const out: {
      id: number;
      name: string;
      content_type: string;
      size: number;
      url: string | null;
      text: string | null;
      truncated: boolean;
      error?: string;
    } = {
      id: meta.id ?? file_id,
      name,
      content_type: contentType,
      size,
      url,
      text: null,
      truncated: false,
    };

    if (meta.locked_for_user || meta.locked || !url) {
      out.error = meta.lock_explanation ?? "file is locked or has no download URL";
      return json(out);
    }
    if (size > MAX_DOWNLOAD_BYTES) {
      out.error = `file too large to download (${size} bytes > ${MAX_DOWNLOAD_BYTES})`;
      return json(out);
    }

    const res = await fetch(url);
    if (!res.ok) {
      const body = await res.text();
      throw new Error(
        `File download ${res.status} ${res.statusText} for ${url}: ${body.slice(0, 500)}`,
      );
    }
    const buf = new Uint8Array(await res.arrayBuffer());
    const { text, error } = await extractText(buf, contentType);
    if (text == null) {
      out.error = error;
      return json(out);
    }
    if (text.length > limit) {
      out.text = text.slice(0, limit);
      out.truncated = true;
    } else {
      out.text = text;
    }
    return json(out);
  },
);

// ─── Deep reads ──────────────────────────────────────────────────────────────

server.registerTool(
  "assignment_details",
  {
    description:
      "Full assignment info: instructions (HTML stripped to text), rubric, allowed submission types.",
    inputSchema: {
      course_id: z.number().int(),
      assignment_id: z.number().int(),
    },
  },
  async ({ course_id, assignment_id }) => {
    const a = await canvas.get<any>(`/courses/${course_id}/assignments/${assignment_id}`, {
      include: ["rubric", "submission"],
    });
    return json({
      id: a.id,
      name: a.name,
      due_at: a.due_at,
      lock_at: a.lock_at,
      unlock_at: a.unlock_at,
      points_possible: a.points_possible,
      submission_types: a.submission_types,
      allowed_extensions: a.allowed_extensions,
      allowed_attempts: a.allowed_attempts,
      html_url: a.html_url,
      locked_for_user: a.locked_for_user,
      lock_explanation: a.lock_explanation,
      description: htmlToText(a.description, 6000),
      rubric: a.rubric?.map((r: any) => ({
        id: r.id,
        description: r.description,
        long_description: htmlToText(r.long_description, 500),
        points: r.points,
        criterion_use_range: r.criterion_use_range,
      })),
      has_submitted: a.submission?.workflow_state === "submitted" || a.has_submitted_submissions,
    });
  },
);

server.registerTool(
  "submission_feedback",
  {
    description:
      "Get the user's submission for an assignment, with grade, instructor comments, and rubric assessment.",
    inputSchema: {
      course_id: z.number().int(),
      assignment_id: z.number().int(),
    },
  },
  async ({ course_id, assignment_id }) => {
    const s = await canvas.get<any>(
      `/courses/${course_id}/assignments/${assignment_id}/submissions/self`,
      { include: ["submission_comments", "rubric_assessment"] },
    );
    return json({
      assignment_id: s.assignment_id,
      score: s.score,
      grade: s.grade,
      attempt: s.attempt,
      submitted_at: s.submitted_at,
      graded_at: s.graded_at,
      posted_at: s.posted_at,
      late: s.late,
      missing: s.missing,
      excused: s.excused,
      workflow_state: s.workflow_state,
      submission_type: s.submission_type,
      preview_url: s.preview_url,
      html_url: s.html_url,
      attachments: (s.attachments ?? []).map((a: any) => ({
        id: a.id,
        display_name: a.display_name,
        filename: a.filename,
        size: a.size,
        content_type: a["content-type"],
        url: a.url,
      })),
      comments: (s.submission_comments ?? []).map((c: any) => ({
        author: c.author_name,
        created_at: c.created_at,
        comment: htmlToText(c.comment, 2000),
        attachments: (c.attachments ?? []).map((a: any) => ({
          filename: a.filename,
          display_name: a.display_name,
          url: a.url,
        })),
      })),
      rubric_assessment: s.rubric_assessment
        ? Object.entries(s.rubric_assessment).map(([crit_id, v]: [string, any]) => ({
            criterion_id: crit_id,
            points: v.points,
            comment: htmlToText(v.comments, 1000),
          }))
        : undefined,
    });
  },
);

server.registerTool(
  "course_syllabus",
  {
    description: "Course syllabus (HTML body stripped to text).",
    inputSchema: { course_id: z.number().int() },
  },
  async ({ course_id }) => {
    const c = await canvas.get<any>(`/courses/${course_id}`, {
      include: ["syllabus_body", "term"],
    });
    return json({
      course_id: c.id,
      name: c.name,
      term: c.term?.name,
      syllabus: htmlToText(c.syllabus_body, 12000),
      html_url: `${baseUrl}/courses/${c.id}/assignments/syllabus`,
    });
  },
);

server.registerTool(
  "list_quizzes",
  {
    description: "List quizzes in a course (separate from regular assignments in Canvas).",
    inputSchema: { course_id: z.number().int() },
  },
  async ({ course_id }) => {
    const quizzes = await canvas.paginate<any>(`/courses/${course_id}/quizzes`);
    return json(
      quizzes.map((q) => ({
        id: q.id,
        title: q.title,
        quiz_type: q.quiz_type,
        due_at: q.due_at,
        lock_at: q.lock_at,
        unlock_at: q.unlock_at,
        time_limit: q.time_limit,
        allowed_attempts: q.allowed_attempts,
        points_possible: q.points_possible,
        question_count: q.question_count,
        published: q.published,
        locked_for_user: q.locked_for_user,
        html_url: q.html_url,
      })),
    );
  },
);

server.registerTool(
  "quiz_submissions",
  {
    description: "User's submissions for a quiz (attempts, scores, kept_score).",
    inputSchema: {
      course_id: z.number().int(),
      quiz_id: z.number().int(),
    },
  },
  async ({ course_id, quiz_id }) => {
    const data = await canvas.get<any>(`/courses/${course_id}/quizzes/${quiz_id}/submissions`);
    const subs = data.quiz_submissions ?? [];
    return json(
      subs.map((s: any) => ({
        id: s.id,
        attempt: s.attempt,
        started_at: s.started_at,
        finished_at: s.finished_at,
        end_at: s.end_at,
        time_spent: s.time_spent,
        score: s.score,
        kept_score: s.kept_score,
        workflow_state: s.workflow_state,
        html_url: s.html_url,
      })),
    );
  },
);

// ─── Communication: conversations (Canvas inbox) ─────────────────────────────

server.registerTool(
  "inbox",
  {
    description: "List Canvas conversations (the inbox). Use scope to filter.",
    inputSchema: {
      scope: z.enum(["unread", "starred", "archived", "sent"]).optional(),
      filter: z.array(z.string()).optional().describe('Filter by context, e.g. ["course_46061"].'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(200)
        .default(25)
        .describe("Max conversations to return (most recent first). Default 25."),
    },
  },
  async ({ scope, filter, limit }) => {
    const convos = await canvas.paginate<any>("/conversations", { scope, filter });
    const trimmed = convos.slice(0, limit);
    return json({
      total: convos.length,
      returned: trimmed.length,
      conversations: trimmed.map((c) => {
        const participants = (c.participants ?? []).map((p: any) => p.full_name ?? p.name);
        return {
          id: c.id,
          subject: c.subject,
          last_message_at: c.last_message_at,
          last_message: htmlToText(c.last_message, 300),
          message_count: c.message_count,
          workflow_state: c.workflow_state,
          starred: c.starred,
          participants:
            participants.length > 6
              ? [...participants.slice(0, 5), `…and ${participants.length - 5} others`]
              : participants,
          participant_count: participants.length,
          context_name: c.context_name,
        };
      }),
    });
  },
);

server.registerTool(
  "read_conversation",
  {
    description: "Read the full message thread of a conversation.",
    inputSchema: { conversation_id: z.number().int() },
  },
  async ({ conversation_id }) => {
    const c = await canvas.get<any>(`/conversations/${conversation_id}`);
    const nameById = new Map<number, string>(
      (c.participants ?? []).map((p: any) => [p.id, p.full_name ?? p.name]),
    );
    return json({
      id: c.id,
      subject: c.subject,
      context_name: c.context_name,
      participants: [...nameById.entries()].map(([id, name]) => ({ id, name })),
      messages: (c.messages ?? []).map((m: any) => ({
        id: m.id,
        author: nameById.get(m.author_id) ?? `user_${m.author_id}`,
        created_at: m.created_at,
        body: htmlToText(m.body, 4000),
        attachments: (m.attachments ?? []).map((a: any) => ({
          filename: a.filename,
          url: a.url,
        })),
      })),
    });
  },
);

// ─── Discussions (announcements are also discussion_topics) ──────────────────

server.registerTool(
  "list_discussions",
  {
    description: "List discussion topics (non-announcement) in a course.",
    inputSchema: {
      course_id: z.number().int(),
      only_unread: z.boolean().default(false),
    },
  },
  async ({ course_id, only_unread }) => {
    const topics = await canvas.paginate<any>(`/courses/${course_id}/discussion_topics`, {
      only_announcements: false,
    });
    const filtered = topics.filter(
      (t) => !t.is_announcement && (!only_unread || (t.unread_count ?? 0) > 0),
    );
    return json(
      filtered.map((t) => ({
        id: t.id,
        title: t.title,
        posted_at: t.posted_at,
        last_reply_at: t.last_reply_at,
        discussion_type: t.discussion_type,
        unread_count: t.unread_count,
        pinned: t.pinned,
        locked: t.locked,
        published: t.published,
        author: t.author?.display_name,
        html_url: t.html_url,
        message_preview: htmlToText(t.message, 400),
      })),
    );
  },
);

server.registerTool(
  "read_discussion",
  {
    description: "Read a discussion topic and its full reply thread (flattened with parent_id).",
    inputSchema: {
      course_id: z.number().int(),
      topic_id: z.number().int(),
    },
  },
  async ({ course_id, topic_id }) => {
    const [topic, view] = await Promise.all([
      canvas.get<any>(`/courses/${course_id}/discussion_topics/${topic_id}`),
      canvas.get<any>(`/courses/${course_id}/discussion_topics/${topic_id}/view`),
    ]);
    const nameById = new Map<number, string>(
      (view.participants ?? []).map((p: any) => [p.id, p.display_name ?? p.name]),
    );
    const flat: any[] = [];
    const walk = (entries: any[], parentId: number | null) => {
      for (const e of entries ?? []) {
        flat.push({
          id: e.id,
          parent_id: parentId,
          user_id: e.user_id,
          author: nameById.get(e.user_id) ?? `user_${e.user_id}`,
          created_at: e.created_at,
          updated_at: e.updated_at,
          message: htmlToText(e.message, 2000),
          rating_count: e.rating_count,
        });
        if (e.replies) walk(e.replies, e.id);
      }
    };
    walk(view.view ?? [], null);
    return json({
      id: topic.id,
      title: topic.title,
      author: topic.author?.display_name,
      posted_at: topic.posted_at,
      message: htmlToText(topic.message, 6000),
      html_url: topic.html_url,
      entry_count: flat.length,
      entries: flat,
    });
  },
);

// ─── Pages ───────────────────────────────────────────────────────────────────

server.registerTool(
  "list_pages",
  {
    description:
      "List wiki pages in a course. If the institution disables the pages index (404), falls back to scanning module items for Page-type entries.",
    inputSchema: {
      course_id: z.number().int(),
      search_term: z.string().min(3).optional(),
    },
  },
  async ({ course_id, search_term }) => {
    try {
      const pages = await canvas.paginate<any>(`/courses/${course_id}/pages`, { search_term });
      return json(
        pages.map((p) => ({
          source: "pages" as const,
          url: p.url,
          title: p.title,
          published: p.published,
          front_page: p.front_page,
          created_at: p.created_at,
          updated_at: p.updated_at,
          html_url: p.html_url,
        })),
      );
    } catch (e) {
      if (!/^Canvas API 40[34]/.test(String((e as Error).message))) throw e;
      const modules = await canvas.paginate<any>(`/courses/${course_id}/modules`, {
        include: ["items"],
      });
      const needle = search_term?.toLowerCase();
      const items = modules.flatMap((m: any) =>
        (m.items ?? [])
          .filter((it: any) => it.type === "Page")
          .filter((it: any) => !needle || (it.title ?? "").toLowerCase().includes(needle))
          .map((it: any) => ({
            source: "modules" as const,
            url: typeof it.url === "string" ? (it.url.split("/pages/").pop() ?? null) : null,
            title: it.title,
            module: m.name,
            html_url: it.html_url,
          })),
      );
      return json(items);
    }
  },
);

server.registerTool(
  "read_page",
  {
    description: "Read a course wiki page (body stripped to text).",
    inputSchema: {
      course_id: z.number().int(),
      page_url: z.string().describe("Page slug, from list_pages.url."),
    },
  },
  async ({ course_id, page_url }) => {
    const p = await canvas.get<any>(`/courses/${course_id}/pages/${page_url}`);
    return json({
      url: p.url,
      title: p.title,
      updated_at: p.updated_at,
      html_url: p.html_url,
      body: htmlToText(p.body, 12000),
    });
  },
);

// ─── Composites ──────────────────────────────────────────────────────────────

server.registerTool(
  "weekly_digest",
  {
    description:
      "One-shot weekly summary: active courses with grades, announcements (last 7d), assignments due (next 7d), todo items.",
    inputSchema: {
      lookback_days: z.number().int().min(1).max(30).default(7),
      lookahead_days: z.number().int().min(1).max(30).default(7),
    },
  },
  async ({ lookback_days, lookahead_days }) => {
    const courses = await canvas.paginate<any>("/courses", {
      enrollment_state: "active",
      include: ["total_scores"],
    });
    const real = courses.filter((c) => c.id);
    const courseIds = real.map((c) => c.id);
    const courseLookup = new Map<number, string>(real.map((c) => [c.id, c.course_code ?? c.name]));

    const now = Date.now();
    const ahead = now + lookahead_days * 86400000;

    const [announcements, perCourseAssignments, todoItems] = await Promise.all([
      courseIds.length
        ? canvas.paginate<any>("/announcements", {
            context_codes: courseIds.map((id) => `course_${id}`),
            start_date: daysAgoIso(lookback_days),
          })
        : Promise.resolve([]),
      Promise.all(
        courseIds.map((id) =>
          canvas.paginate<any>(`/courses/${id}/assignments`, {
            bucket: "future",
            include: ["submission"],
          }),
        ),
      ),
      canvas.paginate<any>("/users/self/todo"),
    ]);

    const upcoming = perCourseAssignments
      .flat()
      .filter((a) => a.due_at && Date.parse(a.due_at) >= now && Date.parse(a.due_at) <= ahead)
      .map((a) => ({
        course: courseLookup.get(a.course_id) ?? `course_${a.course_id}`,
        name: a.name,
        due_at: a.due_at,
        points_possible: a.points_possible,
        submitted:
          a.submission?.workflow_state === "submitted" || a.submission?.submitted_at != null,
        html_url: a.html_url,
      }))
      .sort((a, b) => Date.parse(a.due_at) - Date.parse(b.due_at));

    return json({
      window: {
        lookback_days,
        lookahead_days,
        now: new Date(now).toISOString(),
      },
      grades: real.map((c) => {
        const e = c.enrollments?.[0];
        return {
          course: c.course_code ?? c.name,
          current_score: e?.computed_current_score,
          final_score: e?.computed_final_score,
        };
      }),
      announcements: announcements
        .sort((a: any, b: any) => Date.parse(b.posted_at) - Date.parse(a.posted_at))
        .map((a: any) => {
          const cid = Number(String(a.context_code).split("_")[1]);
          return {
            course: courseLookup.get(cid) ?? a.context_code,
            title: a.title,
            posted_at: a.posted_at,
            author: a.author?.display_name,
            url: a.html_url,
          };
        }),
      upcoming_assignments: upcoming,
      todo: todoItems.map((t: any) => ({
        type: t.type,
        course: t.context_name,
        name: t.assignment?.name,
        due_at: t.assignment?.due_at,
        points_possible: t.assignment?.points_possible,
      })),
    });
  },
);

server.registerTool(
  "course_dashboard",
  {
    description:
      "One-shot per-course summary: meta, current grade, syllabus excerpt, recent announcements, upcoming assignments, modules.",
    inputSchema: { course_id: z.number().int() },
  },
  async ({ course_id }) => {
    const [course, announcements, assignments, modules] = await Promise.all([
      canvas.get<any>(`/courses/${course_id}`, {
        include: ["syllabus_body", "total_scores", "term"],
      }),
      canvas.paginate<any>("/announcements", {
        context_codes: [`course_${course_id}`],
        start_date: daysAgoIso(21),
      }),
      canvas.paginate<any>(`/courses/${course_id}/assignments`, {
        bucket: "future",
        include: ["submission"],
      }),
      canvas.paginate<any>(`/courses/${course_id}/modules`),
    ]);

    const enrollment = course.enrollments?.[0];
    const now = Date.now();

    return json({
      course: {
        id: course.id,
        name: course.name,
        code: course.course_code,
        term: course.term?.name,
        start_at: course.start_at,
        end_at: course.end_at,
      },
      grade: {
        current_score: enrollment?.computed_current_score,
        current_grade: enrollment?.computed_current_grade,
        final_score: enrollment?.computed_final_score,
        final_grade: enrollment?.computed_final_grade,
      },
      syllabus_excerpt: htmlToText(course.syllabus_body, 1500),
      recent_announcements: announcements
        .sort((a: any, b: any) => Date.parse(b.posted_at) - Date.parse(a.posted_at))
        .slice(0, 5)
        .map((a: any) => ({
          title: a.title,
          posted_at: a.posted_at,
          author: a.author?.display_name,
          url: a.html_url,
        })),
      upcoming_assignments: assignments
        .filter((a) => a.due_at && Date.parse(a.due_at) >= now)
        .sort((a, b) => Date.parse(a.due_at) - Date.parse(b.due_at))
        .slice(0, 10)
        .map((a) => ({
          name: a.name,
          due_at: a.due_at,
          points_possible: a.points_possible,
          submitted:
            a.submission?.workflow_state === "submitted" || a.submission?.submitted_at != null,
          html_url: a.html_url,
        })),
      modules: modules.map((m) => ({
        id: m.id,
        name: m.name,
        position: m.position,
        state: m.state,
        items_count: m.items_count,
      })),
    });
  },
);

server.registerTool(
  "what_changed_since",
  {
    description:
      "What's new across the user's active courses since a timestamp: new announcements, new assignments, newly graded submissions.",
    inputSchema: {
      since: z.string().describe("ISO timestamp."),
    },
  },
  async ({ since }) => {
    if (Number.isNaN(Date.parse(since))) {
      return {
        content: [{ type: "text" as const, text: `invalid ISO timestamp: ${since}` }],
        isError: true,
      };
    }
    return json(await computeChangedSince(since));
  },
);

server.registerTool(
  "catch_up",
  {
    description:
      "What's new since you last checked. Reads a stored last-seen marker from local state, calls what_changed_since with that timestamp, then advances the marker. On the first call (no stored marker yet) defaults to 24 hours ago and sets first_run=true. Pass course_id to scope to one course (per-course markers are tracked separately). Pass since to override the stored marker. Pass save:false to peek without advancing.",
    inputSchema: {
      course_id: z
        .number()
        .int()
        .optional()
        .describe(
          "Restrict to a single course. The per-course last-seen marker is tracked separately from the global one.",
        ),
      since: z
        .string()
        .optional()
        .describe("Override the stored marker with this ISO timestamp for this call."),
      save: z
        .boolean()
        .optional()
        .describe("Update the stored marker after reading. Defaults to true."),
    },
  },
  async ({ course_id, since: sinceArg, save }) => {
    const shouldSave = save !== false;
    const state = await loadState();
    const stored = getLastSeen(state, course_id);
    let first_run = false;
    let since: string;
    if (sinceArg) {
      since = sinceArg;
    } else if (stored) {
      since = stored;
    } else {
      since = daysAgoIso(1);
      first_run = true;
    }
    if (Number.isNaN(Date.parse(since))) {
      return {
        content: [{ type: "text" as const, text: `invalid ISO timestamp: ${since}` }],
        isError: true,
      };
    }
    const until = new Date().toISOString();
    const diff = await computeChangedSince(since, course_id);
    if (shouldSave) {
      setLastSeen(state, course_id, until);
      await saveState(state);
    }
    return json({
      first_run,
      since,
      until,
      saved: shouldSave,
      course_id: course_id ?? null,
      new_announcements: diff.new_announcements,
      new_assignments: diff.new_assignments,
      newly_graded: diff.newly_graded,
    });
  },
);

// ─── People, groups, activity ────────────────────────────────────────────────

server.registerTool(
  "course_roster",
  {
    description:
      "List users enrolled in a course (id, name, role). Use the resulting ids with send_message recipients.",
    inputSchema: {
      course_id: z.number().int(),
      enrollment_type: z
        .enum(["teacher", "student", "ta", "observer", "designer"])
        .optional()
        .describe("Filter by role."),
      search_term: z
        .string()
        .min(2)
        .optional()
        .describe("Filter by name substring (Canvas requires >=2 chars)."),
    },
  },
  async ({ course_id, enrollment_type, search_term }) => {
    const users = await canvas.paginate<any>(`/courses/${course_id}/users`, {
      enrollment_type,
      search_term,
      include: ["enrollments"],
    });
    return json(
      users.map((u) => ({
        id: u.id,
        name: u.name,
        sortable_name: u.sortable_name,
        email: u.email,
        roles: (u.enrollments ?? []).map((e: any) => e.type),
      })),
    );
  },
);

server.registerTool(
  "search_recipients",
  {
    description:
      "Search Canvas for message recipients across all the user's contexts. Returns users and groups with ids usable in send_message.",
    inputSchema: {
      search: z.string().min(1).describe("Name fragment to search for."),
      context: z
        .string()
        .optional()
        .describe('Limit to a context, e.g. "course_46061" or "course_46061_students".'),
      type: z
        .enum(["user", "context"])
        .optional()
        .describe('"user" for people, "context" for courses/groups.'),
    },
  },
  async ({ search, context, type }) => {
    const results = await canvas.get<any[]>("/search/recipients", { search, context, type });
    return json(
      (results ?? []).map((r: any) => ({
        id: r.id,
        name: r.name,
        type: r.type ?? (typeof r.id === "string" ? "context" : "user"),
        common_courses: r.common_courses,
        user_count: r.user_count,
      })),
    );
  },
);

server.registerTool(
  "course_groups",
  {
    description: "List groups within a course. Useful for group-project students.",
    inputSchema: { course_id: z.number().int() },
  },
  async ({ course_id }) => {
    const groups = await canvas.paginate<any>(`/courses/${course_id}/groups`);
    return json(
      groups.map((g) => ({
        id: g.id,
        name: g.name,
        description: htmlToText(g.description, 500),
        members_count: g.members_count,
        max_membership: g.max_membership,
        group_category_id: g.group_category_id,
        is_public: g.is_public,
        join_level: g.join_level,
      })),
    );
  },
);

server.registerTool(
  "activity_stream",
  {
    description:
      "The user's Canvas activity stream — the same notifications shown in the global header (announcements, conversations, submissions, grading, etc.).",
    inputSchema: {
      only_active: z
        .boolean()
        .default(false)
        .describe("If true, drop items the user has already read."),
    },
  },
  async ({ only_active }) => {
    const items = await canvas.get<any[]>("/users/self/activity_stream");
    const filtered = only_active ? (items ?? []).filter((i: any) => !i.read_state) : (items ?? []);
    return json(
      filtered.map((i: any) => ({
        id: i.id,
        type: i.type,
        title: i.title,
        message: htmlToText(i.message, 800),
        course_id: i.course_id,
        context_type: i.context_type,
        read_state: i.read_state,
        created_at: i.created_at,
        updated_at: i.updated_at,
        url: i.html_url,
      })),
    );
  },
);

server.registerTool(
  "submission_history",
  {
    description:
      "All attempts the user has made on an assignment (submission_feedback returns only the latest).",
    inputSchema: {
      course_id: z.number().int(),
      assignment_id: z.number().int(),
    },
  },
  async ({ course_id, assignment_id }) => {
    const s = await canvas.get<any>(
      `/courses/${course_id}/assignments/${assignment_id}/submissions/self`,
      { include: ["submission_history"] },
    );
    const attempts = s.submission_history ?? [];
    return json(
      attempts.map((a: any) => ({
        attempt: a.attempt,
        submitted_at: a.submitted_at,
        graded_at: a.graded_at,
        score: a.score,
        grade: a.grade,
        late: a.late,
        missing: a.missing,
        excused: a.excused,
        workflow_state: a.workflow_state,
        submission_type: a.submission_type,
        body: a.body ? htmlToText(a.body, 2000) : undefined,
        url: a.url,
        preview_url: a.preview_url,
        attachments: (a.attachments ?? []).map((f: any) => ({
          id: f.id,
          filename: f.filename,
          display_name: f.display_name,
          size: f.size,
          url: f.url,
        })),
      })),
    );
  },
);

// ─── Writes ──────────────────────────────────────────────────────────────────

server.registerTool(
  "send_message",
  {
    description:
      "Send a Canvas conversation. Recipients are user ids as strings. Set group_conversation=false to fan out as separate threads (e.g., emailing several students individually).",
    inputSchema: {
      recipients: z
        .array(z.string())
        .min(1)
        .describe('User ids as strings, e.g. ["1234"]. "self" also works.'),
      body: z.string().min(1),
      subject: z.string().optional(),
      context_code: z.string().optional().describe('e.g. "course_46061" to attach to a course.'),
      group_conversation: z.boolean().default(true),
    },
  },
  async ({ recipients, body, subject, context_code, group_conversation }) => {
    const data = await canvas.post<any>("/conversations", {
      recipients,
      body,
      subject,
      context_code,
      group_conversation,
    });
    const list = Array.isArray(data) ? data : [data];
    return json({
      created: list.length,
      conversations: list.map((c: any) => ({
        id: c.id,
        subject: c.subject,
        last_message_at: c.last_message_at,
      })),
    });
  },
);

server.registerTool(
  "mark_conversation",
  {
    description:
      "Update a conversation: set state (read/unread/archived) and/or starred. At least one must be provided.",
    inputSchema: {
      conversation_id: z.number().int(),
      state: z
        .enum(["read", "unread", "archived"])
        .optional()
        .describe("Workflow state. Omit to leave unchanged."),
      starred: z.boolean().optional().describe("Star/unstar. Omit to leave unchanged."),
    },
  },
  async ({ conversation_id, state, starred }) => {
    if (state === undefined && starred === undefined) {
      return {
        content: [{ type: "text" as const, text: "must set state or starred" }],
        isError: true,
      };
    }
    const conversation: Record<string, unknown> = {};
    if (state !== undefined) conversation.workflow_state = state;
    if (starred !== undefined) conversation.starred = starred;
    const data = await canvas.put<any>(`/conversations/${conversation_id}`, { conversation });
    return json({
      id: data.id,
      workflow_state: data.workflow_state,
      starred: data.starred,
    });
  },
);

server.registerTool(
  "mark_discussion_read",
  {
    description:
      "Mark a discussion topic or announcement as read for the user (announcements are discussion topics in Canvas).",
    inputSchema: {
      course_id: z.number().int(),
      topic_id: z.number().int(),
    },
  },
  async ({ course_id, topic_id }) => {
    await canvas.put(`/courses/${course_id}/discussion_topics/${topic_id}/read`);
    return json({ ok: true, topic_id });
  },
);

server.registerTool(
  "reply_discussion",
  {
    description:
      "Post a reply to a discussion topic. If parent_entry_id is set, the reply is nested under that entry.",
    inputSchema: {
      course_id: z.number().int(),
      topic_id: z.number().int(),
      message: z.string().min(1),
      parent_entry_id: z.number().int().optional(),
    },
  },
  async ({ course_id, topic_id, message, parent_entry_id }) => {
    const path = parent_entry_id
      ? `/courses/${course_id}/discussion_topics/${topic_id}/entries/${parent_entry_id}/replies`
      : `/courses/${course_id}/discussion_topics/${topic_id}/entries`;
    const e = await canvas.post<any>(path, { message });
    return json({
      id: e.id,
      parent_id: e.parent_id ?? parent_entry_id ?? null,
      created_at: e.created_at,
      user_id: e.user_id,
      message: htmlToText(e.message, 500),
    });
  },
);

server.registerTool(
  "submit_assignment_text",
  {
    description:
      "Submit an assignment as online_text_entry. Verify the assignment accepts this submission_type via assignment_details first.",
    inputSchema: {
      course_id: z.number().int(),
      assignment_id: z.number().int(),
      body: z.string().min(1).describe("Text/HTML body to submit."),
    },
  },
  async ({ course_id, assignment_id, body }) => {
    const s = await canvas.post<any>(
      `/courses/${course_id}/assignments/${assignment_id}/submissions`,
      { submission: { submission_type: "online_text_entry", body } },
    );
    return json({
      id: s.id,
      attempt: s.attempt,
      submitted_at: s.submitted_at,
      workflow_state: s.workflow_state,
      preview_url: s.preview_url,
    });
  },
);

server.registerTool(
  "submit_assignment_url",
  {
    description:
      "Submit an assignment as online_url. Verify the assignment accepts this submission_type via assignment_details first.",
    inputSchema: {
      course_id: z.number().int(),
      assignment_id: z.number().int(),
      url: z.string().url(),
    },
  },
  async ({ course_id, assignment_id, url }) => {
    const s = await canvas.post<any>(
      `/courses/${course_id}/assignments/${assignment_id}/submissions`,
      { submission: { submission_type: "online_url", url } },
    );
    return json({
      id: s.id,
      attempt: s.attempt,
      submitted_at: s.submitted_at,
      workflow_state: s.workflow_state,
      url: s.url,
      preview_url: s.preview_url,
    });
  },
);

server.registerTool(
  "add_submission_comment",
  {
    description:
      "Add a comment to the user's own submission for an assignment (e.g., reply to grader feedback). Does not create a new submission.",
    inputSchema: {
      course_id: z.number().int(),
      assignment_id: z.number().int(),
      text: z.string().min(1),
    },
  },
  async ({ course_id, assignment_id, text }) => {
    const s = await canvas.put<any>(
      `/courses/${course_id}/assignments/${assignment_id}/submissions/self`,
      { comment: { text_comment: text } },
    );
    const comments = s.submission_comments ?? [];
    const last = comments[comments.length - 1];
    return json({
      assignment_id: s.assignment_id,
      comment_count: comments.length,
      last_comment: last
        ? {
            author: last.author_name,
            created_at: last.created_at,
            comment: htmlToText(last.comment, 1000),
          }
        : undefined,
    });
  },
);

server.registerTool(
  "submit_assignment_file",
  {
    description:
      "Submit an assignment as online_upload by uploading one or more local files. Three-step Canvas flow (init → upload → submit). Verify the assignment accepts online_upload via assignment_details first.",
    inputSchema: {
      course_id: z.number().int(),
      assignment_id: z.number().int(),
      file_paths: z
        .array(z.string().min(1))
        .min(1)
        .max(10)
        .describe("Absolute paths to files to upload."),
      content_types: z
        .array(z.string())
        .optional()
        .describe("Optional MIME types, parallel to file_paths."),
    },
  },
  async ({ course_id, assignment_id, file_paths, content_types }) => {
    const fileIds: number[] = [];
    for (let i = 0; i < file_paths.length; i++) {
      const path = file_paths[i];
      const ct = content_types?.[i];
      const size = (await stat(path)).size;
      const name = basename(path);

      const init = await canvas.post<any>(
        `/courses/${course_id}/assignments/${assignment_id}/submissions/self/files`,
        { name, size, content_type: ct },
      );
      if (!init.upload_url || !init.upload_params) {
        throw new Error(
          `Canvas upload init returned no upload_url for ${name}: ${JSON.stringify(init).slice(0, 300)}`,
        );
      }

      const form = new FormData();
      for (const [k, v] of Object.entries(init.upload_params)) {
        form.append(k, String(v));
      }
      const buf = await readFile(path);
      form.append("file", new Blob([new Uint8Array(buf)]), name);

      const up = await fetch(init.upload_url, {
        method: "POST",
        body: form,
        redirect: "manual",
      });

      let fileId: number | undefined;
      if (up.status >= 300 && up.status < 400) {
        const location = up.headers.get("location") ?? up.headers.get("Location");
        if (!location) throw new Error(`Upload redirect with no Location for ${name}`);
        const confirm = await fetch(location, {
          method: "POST",
          headers: { ...canvas.authHeaders("POST"), "Content-Length": "0" },
        });
        if (!confirm.ok) {
          const t = await confirm.text();
          throw new Error(`File confirm failed for ${name}: ${confirm.status} ${t.slice(0, 300)}`);
        }
        const fileData = parseCanvasJson(await confirm.text()) as { id?: unknown };
        fileId = fileData.id as number | undefined;
      } else if (up.ok) {
        const fileData = await up.json();
        fileId = fileData.id;
      } else {
        const t = await up.text();
        throw new Error(`Upload failed for ${name}: ${up.status} ${t.slice(0, 300)}`);
      }
      if (typeof fileId !== "number") {
        throw new Error(`Upload for ${name} did not return a file id`);
      }
      fileIds.push(fileId);
    }

    const s = await canvas.post<any>(
      `/courses/${course_id}/assignments/${assignment_id}/submissions`,
      { submission: { submission_type: "online_upload", file_ids: fileIds } },
    );
    return json({
      id: s.id,
      attempt: s.attempt,
      submitted_at: s.submitted_at,
      workflow_state: s.workflow_state,
      file_ids: fileIds,
      preview_url: s.preview_url,
    });
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
