import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface CanvasState {
  version: 1;
  user_id?: number;
  last_seen: {
    global?: string;
    courses: Record<string, string>;
  };
}

export function getStateDir(): string {
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA;
    if (local) return join(local, "canvas-mcp");
  }
  const xdg = process.env.XDG_STATE_HOME;
  if (xdg) return join(xdg, "canvas-mcp");
  return join(homedir(), ".local", "state", "canvas-mcp");
}

export function getStatePath(): string {
  return join(getStateDir(), "state.json");
}

const empty = (): CanvasState => ({ version: 1, last_seen: { courses: {} } });

export async function loadState(): Promise<CanvasState> {
  try {
    const text = await readFile(getStatePath(), "utf8");
    const parsed = JSON.parse(text);
    if (parsed?.version !== 1 || typeof parsed?.last_seen !== "object") return empty();
    parsed.last_seen.courses ??= {};
    return parsed as CanvasState;
  } catch {
    return empty();
  }
}

export async function saveState(state: CanvasState): Promise<void> {
  await mkdir(getStateDir(), { recursive: true });
  const path = getStatePath();
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2));
  await rename(tmp, path);
}

export function getLastSeen(state: CanvasState, course_id?: number): string | undefined {
  if (course_id != null) return state.last_seen.courses[String(course_id)];
  return state.last_seen.global;
}

export function setLastSeen(state: CanvasState, course_id: number | undefined, iso: string): void {
  if (course_id != null) {
    state.last_seen.courses[String(course_id)] = iso;
  } else {
    state.last_seen.global = iso;
  }
}
