import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type CanvasState,
  getLastSeen,
  getStateDir,
  getStatePath,
  loadState,
  saveState,
  setLastSeen,
} from "../src/state.js";

describe("getStateDir", () => {
  const original = { ...process.env };
  afterEach(() => {
    process.env = { ...original };
  });

  it("respects XDG_STATE_HOME on Linux/Mac", () => {
    if (process.platform === "win32") return;
    process.env.XDG_STATE_HOME = "/tmp/xdg";
    expect(getStateDir()).toBe("/tmp/xdg/canvas-mcp");
  });

  it("falls back to ~/.local/state on Linux/Mac when XDG unset", () => {
    if (process.platform === "win32") return;
    delete process.env.XDG_STATE_HOME;
    expect(getStateDir()).toMatch(/\.local\/state\/canvas-mcp$/);
  });
});

describe("loadState / saveState round-trip", () => {
  let dir: string;
  const original = { ...process.env };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "canvas-mcp-state-"));
    process.env.XDG_STATE_HOME = dir;
    delete process.env.LOCALAPPDATA;
  });

  afterEach(async () => {
    process.env = { ...original };
    await rm(dir, { recursive: true, force: true });
  });

  it("returns a fresh state when no file exists", async () => {
    const state = await loadState();
    expect(state.version).toBe(1);
    expect(state.last_seen.global).toBeUndefined();
    expect(state.last_seen.courses).toEqual({});
  });

  it("returns a fresh state when the file is malformed JSON", async () => {
    const { writeFile, mkdir } = await import("node:fs/promises");
    await mkdir(getStateDir(), { recursive: true });
    await writeFile(getStatePath(), "not json");
    const state = await loadState();
    expect(state.version).toBe(1);
    expect(state.last_seen.courses).toEqual({});
  });

  it("returns a fresh state when version doesn't match", async () => {
    const { writeFile, mkdir } = await import("node:fs/promises");
    await mkdir(getStateDir(), { recursive: true });
    await writeFile(getStatePath(), JSON.stringify({ version: 99, last_seen: { courses: {} } }));
    const state = await loadState();
    expect(state.version).toBe(1);
    expect(state.last_seen.global).toBeUndefined();
  });

  it("round-trips a saved state", async () => {
    const state: CanvasState = {
      version: 1,
      user_id: 42,
      last_seen: { global: "2026-05-05T00:00:00Z", courses: { "98765": "2026-05-04T00:00:00Z" } },
    };
    await saveState(state);
    const reloaded = await loadState();
    expect(reloaded).toEqual(state);
  });
});

describe("getLastSeen / setLastSeen", () => {
  const fresh = (): CanvasState => ({ version: 1, last_seen: { courses: {} } });

  it("global getter returns undefined when unset", () => {
    expect(getLastSeen(fresh())).toBeUndefined();
  });

  it("global setter then getter round-trip", () => {
    const s = fresh();
    setLastSeen(s, undefined, "2026-05-05T00:00:00Z");
    expect(getLastSeen(s)).toBe("2026-05-05T00:00:00Z");
  });

  it("per-course setter does not change global", () => {
    const s = fresh();
    setLastSeen(s, undefined, "2026-05-01T00:00:00Z");
    setLastSeen(s, 123, "2026-05-05T00:00:00Z");
    expect(getLastSeen(s)).toBe("2026-05-01T00:00:00Z");
    expect(getLastSeen(s, 123)).toBe("2026-05-05T00:00:00Z");
    expect(getLastSeen(s, 999)).toBeUndefined();
  });
});
