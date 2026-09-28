import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentProcess } from "@orchestra/adapters";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ContainerManager,
  DockerError,
  containerName,
  dockerExecutionContainers,
  runDocker,
  type DockerRunner,
} from "../src/containers/index.js";

/**
 * design.md §9.9 against the real Docker daemon and the locally built
 * `orchestra/agent` image. Skips only when `docker info` fails. Every
 * container, network and file created here is removed in `afterAll`.
 */

const IMAGE = process.env.ORCHESTRA_TEST_AGENT_IMAGE ?? "orchestra/agent:0.0.1";
const SECRET = `orchestra-secret-${randomUUID()}`;

const info = spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], {
  encoding: "utf8",
  timeout: 30_000,
});
const dockerOk = info.status === 0;
if (!dockerOk) {
  const reason = (info.error?.message ?? info.stderr ?? "").trim() || `exit ${info.status}`;
  console.warn(
    [
      "",
      "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!",
      "!! SKIPPING containers-docker.test.ts: `docker info` failed.",
      `!! reason: ${reason}`,
      "!! The real-Docker tests for agent containers (§9.9) did NOT run.",
      "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!",
      "",
    ].join("\n"),
  );
}

function docker(...args: string[]): string {
  return execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function dockerStatus(...args: string[]): number | null {
  return spawnSync("docker", args, { stdio: "ignore" }).status;
}

interface Inspect {
  Config: {
    Env: string[];
    Labels: Record<string, string>;
    User: string;
    Image: string;
    Cmd: string[];
    Entrypoint: string[];
  };
  HostConfig: { NanoCpus: number; Memory: number };
  Mounts: Array<{ Type: string; Source: string; Destination: string; RW: boolean }>;
  NetworkSettings: { Networks: Record<string, unknown> };
  State: { Running: boolean };
}

const inspect = (name: string): Inspect =>
  (JSON.parse(docker("container", "inspect", name)) as Inspect[])[0]!;

/** Collects a process's stdout, stderr and exit. */
async function collect(proc: AgentProcess) {
  let out = "";
  let err = "";
  proc.stdout.on("data", (c: Buffer) => (out += c.toString()));
  proc.stderr.on("data", (c: Buffer) => (err += c.toString()));
  const exit = await proc.exit;
  await new Promise((r) => setImmediate(r));
  return { out, err, exit };
}

/** Live (non-zombie) processes in the container whose command matches. */
function liveProcesses(container: string, pattern: RegExp): string[] {
  return docker("exec", container, "ps", "-eo", "stat=,args=")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("Z") && pattern.test(l));
}

async function waitFor(check: () => boolean, ms = 15_000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error("condition not reached");
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe.skipIf(!dockerOk)("agent containers against real Docker (§9.9)", () => {
  const network = `orchestra-agents-test-${randomUUID().slice(0, 8)}`;
  const taskId = randomUUID();
  const executionId = randomUUID();
  const specExecutionId = randomUUID();
  /** Random per run, so a concurrent run on this daemon never shares an owner. */
  const owner = randomUUID().replaceAll("-", "");
  const created = new Set<string>();
  let tmp: string;
  let root: string;
  let worktree: string;
  let bare: string;
  let manager: ContainerManager;
  const hostEnv = { ...process.env, DATABASE_URL: "postgres://orchestra:leak@db/orchestra" };

  const ensure = async (id: string, role: "spec" | "implementation" = "implementation") => {
    created.add(containerName(id));
    return manager.ensure({
      executionId: id,
      taskId,
      repositoryName: "sample_repo",
      role,
      env: { GITHUB_TOKEN: SECRET },
      worktreePath: worktree,
    });
  };

  beforeAll(async () => {
    tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "orchestra-containers-docker-")));
    root = path.join(tmp, "ws");
    worktree = path.join(root, "work", executionId);
    bare = path.join(root, "repos", "sample_repo.git");
    await fs.mkdir(worktree, { recursive: true });
    await fs.mkdir(bare, { recursive: true });
    await fs.writeFile(path.join(bare, "HEAD"), "ref: refs/heads/main\n");
    manager = new ContainerManager({
      workspaceRoot: root,
      image: IMAGE,
      cpus: 1,
      memory: "512m",
      owner,
      network,
      hostEnv,
    });
  });

  afterAll(async () => {
    for (const name of created) dockerStatus("rm", "-f", "-v", name);
    dockerStatus("network", "rm", network);
    if (tmp) await fs.rm(tmp, { recursive: true, force: true });
  });

  it("creates the container with labels, uid:gid, limits, network, exactly three same-path mounts and only the passed env", async () => {
    const handle = await ensure(executionId);
    expect(handle.created).toBe(true);

    const c = inspect(handle.name);
    expect(c.State.Running).toBe(true);
    expect(c.Config.Labels).toMatchObject({
      "orchestra.execution": executionId,
      "orchestra.task": taskId,
      "orchestra.owner": owner,
    });
    expect(c.Config.User).toBe(`${process.getuid!()}:${process.getgid!()}`);
    // §9.9 Lifecycle: idles on `sleep infinity`, forced via --entrypoint so a
    // per-repository image's own ENTRYPOINT or CMD never wins (F2).
    expect(c.Config.Entrypoint).toEqual(["sleep"]);
    expect(c.Config.Cmd).toEqual(["infinity"]);
    expect(c.HostConfig.NanoCpus).toBe(1e9);
    expect(c.HostConfig.Memory).toBe(512 * 1024 * 1024);
    expect(Object.keys(c.NetworkSettings.Networks)).toEqual([network]);

    const home = path.join(root, "agent-home", taskId);
    expect(
      c.Mounts.map((m) => ({ type: m.Type, source: m.Source, target: m.Destination, rw: m.RW })).sort((a, b) =>
        a.target.localeCompare(b.target),
      ),
    ).toEqual(
      [
        { type: "bind", source: home, target: home, rw: true },
        { type: "bind", source: bare, target: bare, rw: true },
        { type: "bind", source: worktree, target: worktree, rw: true },
      ].sort((a, b) => a.target.localeCompare(b.target)),
    );

    const toMap = (list: string[]) =>
      Object.fromEntries(list.map((e) => [e.slice(0, e.indexOf("=")), e.slice(e.indexOf("=") + 1)]));
    const imageEnv = toMap(
      JSON.parse(docker("image", "inspect", "--format", "{{json .Config.Env}}", IMAGE)) as string[],
    );
    const env = toMap(c.Config.Env);
    expect(env.HOME).toBe(home);
    expect(env.GITHUB_TOKEN).toBe(SECRET);
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.PATH).toBe(imageEnv.PATH);
    // Nothing beyond the passed variable, HOME and the image's own env.
    expect(Object.keys(env).sort()).toEqual(
      [...new Set(["HOME", "GITHUB_TOKEN", ...Object.keys(imageEnv)])].sort(),
    );
  });

  it("writes a file in the worktree from the container, owned by the worker's user", async () => {
    const result = await manager.runShell({
      container: containerName(executionId),
      cwd: worktree,
      command: 'echo "hello from $(pwd)" > from-container.txt && echo done',
      timeoutMs: 30_000,
    });
    expect(result).toMatchObject({ exitCode: 0, timedOut: false });
    expect(result.tail).toContain("done");
    const file = path.join(worktree, "from-container.txt");
    expect(readFileSync(file, "utf8")).toBe(`hello from ${worktree}\n`);
    expect(statSync(file).uid).toBe(process.getuid!());
  });

  it("reports a failing setup command's exit code and output", async () => {
    const result = await manager.runShell({
      container: containerName(executionId),
      cwd: worktree,
      command: "echo broken >&2; exit 9",
      timeoutMs: 30_000,
    });
    expect(result).toMatchObject({ exitCode: 9, timedOut: false });
    expect(result.tail).toContain("broken");
  });

  it("spawns with stdin, stdout, stderr and exit-code passthrough and only the allowed per-spawn env", async () => {
    const spawn = manager.spawner(containerName(executionId));
    const proc = spawn(
      "sh",
      ["-c", 'read line; echo "got:$line"; echo "token:$ORCHESTRA_TOKEN db:${DATABASE_URL:-none} home:$HOME"; echo oops >&2; exit 7'],
      { cwd: worktree, env: { ...hostEnv, ORCHESTRA_TOKEN: SECRET } },
    );
    proc.stdin.write("hello\n");
    proc.stdin.end();
    const { out, err, exit } = await collect(proc);
    expect(exit).toEqual({ code: 7, signal: null });
    expect(out).toContain("got:hello");
    expect(out).toContain(`token:${SECRET} db:none home:${path.join(root, "agent-home", taskId)}`);
    expect(err).toBe("oops\n");
  });

  it("never shows a secret value on a host command line", async () => {
    const spawn = manager.spawner(containerName(executionId));
    const proc = spawn("sleep", ["30"], { cwd: worktree, env: { ORCHESTRA_TOKEN: SECRET } });
    await waitFor(() => liveProcesses(containerName(executionId), /sleep 30$/).length > 0);
    const ps = execFileSync("ps", ["-axww", "-o", "command="], { encoding: "utf8" });
    expect(ps).toContain(containerName(executionId));
    expect(ps).not.toContain(SECRET);
    proc.kill();
    await proc.exit;
  });

  it("kill stops the whole process group inside the container, child included", async () => {
    const name = containerName(executionId);
    const spawn = manager.spawner(name);
    const proc = spawn("sh", ["-c", "sleep 301 & sleep 302; echo never"], { cwd: worktree, env: {} });
    await waitFor(() => liveProcesses(name, /sleep 30[12]$/).length === 2);

    proc.kill();
    const { exit, out } = await collect(proc);

    expect(out).not.toContain("never");
    expect(exit.code === 0).toBe(false);
    await waitFor(() => liveProcesses(name, /sleep 30[12]$/).length === 0, 5_000);
    expect(docker("exec", name, "sh", "-c", "ls /run/orchestra | wc -l")).toBe("0");
  });

  it("a setup command that overruns its timeout is killed inside the container", async () => {
    const name = containerName(executionId);
    const result = await manager.runShell({
      container: name,
      cwd: worktree,
      command: "sleep 303 & sleep 304",
      timeoutMs: 1_500,
    });
    expect(result.timedOut).toBe(true);
    await waitFor(() => liveProcesses(name, /sleep 30[34]$/).length === 0, 5_000);
  });

  it("mounts the worktree and bare clone read-only for role spec", async () => {
    const handle = await ensure(specExecutionId, "spec");
    const mounts = inspect(handle.name).Mounts;
    expect(mounts.find((m) => m.Destination === worktree)!.RW).toBe(false);
    expect(mounts.find((m) => m.Destination === bare)!.RW).toBe(false);
    expect(mounts.find((m) => m.Destination === handle.home)!.RW).toBe(true);
    const result = await manager.runShell({
      container: handle.name,
      cwd: worktree,
      command: "touch spec-write.txt",
      timeoutMs: 30_000,
    });
    expect(result.exitCode).not.toBe(0);
    expect(existsSync(path.join(worktree, "spec-write.txt"))).toBe(false);
    await manager.remove(specExecutionId);
  });

  it("reuses a running container and recreates a stopped one", async () => {
    expect((await ensure(executionId)).created).toBe(false);
    docker("stop", "-t", "0", containerName(executionId));
    const again = await ensure(executionId);
    expect(again.created).toBe(true);
    expect(inspect(again.name).State.Running).toBe(true);
  });

  it("recreates after removal with the same mounts, and the worktree file is still there", async () => {
    await manager.remove(executionId);
    expect(dockerStatus("container", "inspect", containerName(executionId))).not.toBe(0);

    const handle = await ensure(executionId);
    expect(handle.created).toBe(true);
    const result = await manager.runShell({
      container: handle.name,
      cwd: worktree,
      command: "cat from-container.txt",
      timeoutMs: 30_000,
    });
    expect(result.tail).toBe(`hello from ${worktree}\n`);
  });

  it("remove is idempotent", async () => {
    await manager.remove(executionId);
    await expect(manager.remove(executionId)).resolves.toBeUndefined();
    expect(dockerStatus("container", "inspect", containerName(executionId))).not.toBe(0);
  });

  it("surfaces an exec into a missing container as DockerError", async () => {
    await expect(
      manager.runShell({ container: containerName(executionId), cwd: worktree, command: "true", timeoutMs: 30_000 }),
    ).rejects.toBeInstanceOf(DockerError);
  });

  it("stays running under a per-repository image whose own ENTRYPOINT and CMD are not sleep infinity (F2)", async () => {
    const tag = `orchestra-agent-test-${randomUUID().slice(0, 8)}`;
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "orchestra-agent-image-"));
    const id = randomUUID();
    try {
      await fs.writeFile(
        path.join(dir, "Dockerfile"),
        [`FROM ${IMAGE}`, `ENTRYPOINT ["echo", "should-not-run"]`, `CMD ["hello"]`, ""].join("\n"),
      );
      execFileSync("docker", ["build", "-t", tag, dir], { stdio: "ignore" });

      created.add(containerName(id));
      const handle = await manager.ensure({
        executionId: id,
        taskId,
        repositoryName: "sample_repo",
        role: "implementation",
        env: {},
        image: tag,
        worktreePath: worktree,
      });

      expect(handle.created).toBe(true);
      expect(inspect(handle.name).State.Running).toBe(true);
    } finally {
      dockerStatus("rmi", "-f", tag);
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("surfaces a missing image as DockerError without pulling", async () => {
    const id = randomUUID();
    created.add(containerName(id));
    const err = await manager
      .ensure({
        executionId: id,
        taskId,
        repositoryName: "sample_repo",
        role: "implementation",
        env: {},
        image: "orchestra/agent:does-not-exist",
        worktreePath: worktree,
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DockerError);
    expect((err as DockerError).reason).toBe("failed");
  });

  it("returns the network's IPv4 gateway", async () => {
    expect(await manager.networkGateway()).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
  });

  it("lists only containers whose orchestra.owner label is this deployment's (§9.9 Orphans)", async () => {
    const mine = randomUUID();
    const theirs = randomUUID();
    const unowned = randomUUID();
    const start = (id: string, labels: string[]) => {
      const name = `orchestra-test-${id}`;
      created.add(name);
      docker("run", "-d", "--name", name, "--network", "none", ...labels.flatMap((l) => ["--label", l]), IMAGE);
      return name;
    };
    start(mine, [`orchestra.execution=${mine}`, `orchestra.owner=${owner}`]);
    start(theirs, [`orchestra.execution=${theirs}`, `orchestra.owner=${randomUUID().replaceAll("-", "")}`]);
    start(unowned, [`orchestra.execution=${unowned}`]);

    // Capture what the daemon itself returned, so the check is on docker's
    // label filter and not only on the client-side owner check.
    let raw = "";
    const run: DockerRunner = async (args, options) => {
      const result = await runDocker(args, options);
      raw += result.stdout;
      return result;
    };
    // This run's own manager containers carry the same owner; look only at the three.
    const three: string[] = [mine, theirs, unowned];
    const ours = (ids: string[]) => ids.filter((id) => three.includes(id));
    const listed = await dockerExecutionContainers({ owner, run }).list();

    expect(ours(listed.map((c) => c.executionId))).toEqual([mine]);
    expect(listed.find((c) => c.executionId === mine)).toEqual({
      id: expect.stringMatching(/^[0-9a-f]{64}$/),
      name: `orchestra-test-${mine}`,
      executionId: mine,
      taskId: null,
      owner,
    });
    expect(ours(raw.split("\n").map((line) => line.split("\t")[2] ?? ""))).toEqual([mine]);
  });
});
