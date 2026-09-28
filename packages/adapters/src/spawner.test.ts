import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as adapters from "./index.js";
import { type AgentProcess, type ProcessSpawner, spawnHostProcess } from "./spawner.js";

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw err;
  }
};

async function readAll(stream: AsyncIterable<string | Uint8Array>): Promise<string> {
  let text = "";
  for await (const chunk of stream) {
    text += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
  }
  return text;
}

async function waitFor(file: string): Promise<number> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    try {
      const text = (await readFile(file, "utf8")).trim();
      if (text !== "") return Number(text);
    } catch {
      // Not written yet.
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${file}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function waitDead(pids: number[]): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (pids.some(alive) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe("spawnHostProcess (design.md §9.9 host spawner)", () => {
  let dir: string;
  const leftovers: number[] = [];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "orchestra-spawner-"));
  });
  afterEach(async () => {
    for (const pid of leftovers.splice(0)) if (alive(pid)) process.kill(pid, "SIGKILL");
    await rm(dir, { recursive: true, force: true });
  });

  it("is exported from the package entry with its types", () => {
    expect(adapters.spawnHostProcess).toBe(spawnHostProcess);
    const spawner: ProcessSpawner = adapters.spawnHostProcess;
    expect(typeof spawner).toBe("function");
  });

  it("runs the command in cwd with env, wiring stdin, stdout, stderr and exit", async () => {
    const child: AgentProcess = spawnHostProcess(
      "/bin/sh",
      ["-c", 'read line; echo "out:$line:$PWD:$C3_VAR"; echo "err:$line" >&2; exit 4'],
      { cwd: dir, env: { PATH: process.env.PATH, C3_VAR: "set" } },
    );
    child.stdin.end("hello\n");
    const [stdout, stderr, exit] = await Promise.all([
      readAll(child.stdout),
      readAll(child.stderr),
      child.exit,
    ]);
    const realDir = await realpath(dir);
    expect(stdout.trim()).toBe(`out:hello:${realDir}:set`);
    expect(stderr.trim()).toBe("err:hello");
    expect(exit).toEqual({ code: 4, signal: null });
  });

  it("kill() with no signal SIGKILLs the whole process group, including grandchildren", async () => {
    const selfPid = join(dir, "self.pid");
    const childPid = join(dir, "child.pid");
    const script = join(dir, "run.sh");
    await writeFile(
      script,
      [
        "#!/bin/sh",
        `echo $$ > "${selfPid}"`,
        `sh -c 'echo $$ > "$1"; exec sleep 30' sh "${childPid}" &`,
        "wait",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    const child = spawnHostProcess(script, [], { cwd: dir, env: process.env });
    child.stdout.resume();
    child.stderr.resume();
    const pids = [await waitFor(selfPid), await waitFor(childPid)];
    leftovers.push(...pids);
    expect(pids.every(alive)).toBe(true);

    child.kill();
    expect(await child.exit).toEqual({ code: null, signal: "SIGKILL" });
    await waitDead(pids);
    expect(pids.some(alive)).toBe(false);
  });

  it("kill(signal) delivers that signal to the whole process group", async () => {
    const selfPid = join(dir, "self.pid");
    const childPid = join(dir, "child.pid");
    const trapped = join(dir, "trapped");
    const script = join(dir, "run.sh");
    // The grandchild records the signal it received, proving the group got it.
    await writeFile(
      script,
      [
        "#!/bin/sh",
        `echo $$ > "${selfPid}"`,
        `sh -c 'trap "echo TERM > \\"$2\\"; exit 0" TERM; echo $$ > "$1"; while :; do sleep 0.05; done' sh "${childPid}" "${trapped}" &`,
        "wait",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    const child = spawnHostProcess(script, [], { cwd: dir, env: process.env });
    child.stdout.resume();
    child.stderr.resume();
    const pids = [await waitFor(selfPid), await waitFor(childPid)];
    leftovers.push(...pids);

    child.kill("SIGTERM");
    expect(await child.exit).toEqual({ code: null, signal: "SIGTERM" });
    await waitDead(pids);
    expect(pids.some(alive)).toBe(false);
    expect((await readFile(trapped, "utf8")).trim()).toBe("TERM");
  });

  it("rejects exit when the command cannot be started", async () => {
    const child = spawnHostProcess(join(dir, "no-such-binary"), [], {
      cwd: dir,
      env: process.env,
    });
    await expect(child.exit).rejects.toThrow(/ENOENT/);
    // A kill after a failed start must not throw.
    expect(() => child.kill()).not.toThrow();
  });
});
