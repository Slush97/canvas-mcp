#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { CanvasClient } from "./canvas.js";
import { htmlToText, daysAgoIso, daysFromNowIso } from "./util.js";

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
      type: z.enum(["event", "assignment"]).default("assignment"),
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

// ─── Deep reads ──────────────────────────────────────────────────────────────

server.registerTool(
  "assignment_details",
  {
    description: "Full assignment info: instructions (HTML stripped to text), rubric, allowed submission types.",
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
  }
);

server.registerTool(
  "submission_feedback",
  {
    description: "Get the user's submission for an assignment, with grade, instructor comments, and rubric assessment.",
    inputSchema: {
      course_id: z.number().int(),
      assignment_id: z.number().int(),
    },
  },
  async ({ course_id, assignment_id }) => {
    const s = await canvas.get<any>(
      `/courses/${course_id}/assignments/${assignment_id}/submissions/self`,
      { include: ["submission_comments", "rubric_assessment"] }
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
      comments: (s.submission_comments ?? []).map((c: any) => ({
        author: c.author_name,
        created_at: c.created_at,
        comment: htmlToText(c.comment, 2000),
      })),
      rubric_assessment: s.rubric_assessment
        ? Object.entries(s.rubric_assessment).map(([crit_id, v]: [string, any]) => ({
            criterion_id: crit_id,
            points: v.points,
            comment: htmlToText(v.comments, 1000),
          }))
        : undefined,
    });
  }
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
  }
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
      }))
    );
  }
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
    const data = await canvas.get<any>(
      `/courses/${course_id}/quizzes/${quiz_id}/submissions`
    );
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
      }))
    );
  }
);

// ─── Communication: conversations (Canvas inbox) ─────────────────────────────

server.registerTool(
  "inbox",
  {
    description: "List Canvas conversations (the inbox). Use scope to filter.",
    inputSchema: {
      scope: z.enum(["unread", "starred", "archived", "sent"]).optional(),
      filter: z
        .array(z.string())
        .optional()
        .describe('Filter by context, e.g. ["course_46061"].'),
    },
  },
  async ({ scope, filter }) => {
    const convos = await canvas.paginate<any>("/conversations", { scope, filter });
    return json(
      convos.map((c) => ({
        id: c.id,
        subject: c.subject,
        last_message_at: c.last_message_at,
        last_message: htmlToText(c.last_message, 300),
        message_count: c.message_count,
        workflow_state: c.workflow_state,
        starred: c.starred,
        participants: (c.participants ?? []).map((p: any) => p.full_name ?? p.name),
        context_name: c.context_name,
      }))
    );
  }
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
      (c.participants ?? []).map((p: any) => [p.id, p.full_name ?? p.name])
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
  }
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
      (t) => !t.is_announcement && (!only_unread || (t.unread_count ?? 0) > 0)
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
      }))
    );
  }
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
      (view.participants ?? []).map((p: any) => [p.id, p.display_name ?? p.name])
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
  }
);

// ─── Pages ───────────────────────────────────────────────────────────────────

server.registerTool(
  "list_pages",
  {
    description: "List wiki pages in a course.",
    inputSchema: {
      course_id: z.number().int(),
      search_term: z.string().min(3).optional(),
    },
  },
  async ({ course_id, search_term }) => {
    const pages = await canvas.paginate<any>(`/courses/${course_id}/pages`, { search_term });
    return json(
      pages.map((p) => ({
        url: p.url,
        title: p.title,
        published: p.published,
        front_page: p.front_page,
        created_at: p.created_at,
        updated_at: p.updated_at,
        html_url: p.html_url,
      }))
    );
  }
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
  }
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
    const courseLookup = new Map<number, string>(
      real.map((c) => [c.id, c.course_code ?? c.name])
    );

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
          })
        )
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
        submitted: a.submission?.workflow_state === "submitted" || a.submission?.submitted_at != null,
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
  }
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
  }
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
    const sinceMs = Date.parse(since);
    if (Number.isNaN(sinceMs)) {
      return {
        content: [{ type: "text" as const, text: `invalid ISO timestamp: ${since}` }],
        isError: true,
      };
    }
    const courses = await canvas.paginate<any>("/courses", { enrollment_state: "active" });
    const real = courses.filter((c) => c.id);
    const courseIds = real.map((c) => c.id);
    const courseLookup = new Map<number, string>(
      real.map((c) => [c.id, c.course_code ?? c.name])
    );

    const [announcements, perCourseAssignments] = await Promise.all([
      courseIds.length
        ? canvas.paginate<any>("/announcements", {
            context_codes: courseIds.map((id) => `course_${id}`),
            start_date: since,
          })
        : Promise.resolve([]),
      Promise.all(
        courseIds.map((id) =>
          canvas.paginate<any>(`/courses/${id}/assignments`, { include: ["submission"] })
        )
      ),
    ]);

    const newAnnouncements = announcements
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

    const newAssignments: any[] = [];
    const newGrades: any[] = [];
    for (let i = 0; i < courseIds.length; i++) {
      const course = courseLookup.get(courseIds[i]) ?? `course_${courseIds[i]}`;
      for (const a of perCourseAssignments[i]) {
        if (a.created_at && Date.parse(a.created_at) >= sinceMs) {
          newAssignments.push({
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
          newGrades.push({
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

    return json({
      since,
      new_announcements: newAnnouncements,
      new_assignments: newAssignments,
      newly_graded: newGrades,
    });
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
