import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ContainerManager,
  DOCKER_CAPABILITY,
  DockerError,
  detectDockerCapability,
  startDockerStack,
  workerCapabilities,
  type DockerResult,
  type DockerRunner,
} from "../src/containers/index.js";

/**
 * design.md §9.9 Scheduling and Network, C4: the start-up capability check
 * and the container stack a docker-capable worker builds. Fake docker
 * runner and a fake agent-tools server; no Docker, no sockets.
 */

const IMAGE = "orchestra/agent:0.0.1";
const OWNER = "0123456789abcdef0123456789abcdef";

function fakeRun(reply: (args: readonly string[]) => Partial<DockerResult> | Error) {
  const calls: string[][] = [];
  const run: DockerRunner = async (args) => {
    calls.push([...args]);
    const r = reply(args);
    if (r instanceof Error) throw r;
    return { exitCode: 0, stdout: "", stderr: "", ...r };
  };
  return { run, calls };
}

describe("detectDockerCapability (§9.9 Scheduling)", () => {
  it("is available when docker info succeeds and the image is present", async () => {
    const { run, calls } = fakeRun(() => ({ exitCode: 0, stdout: "ok\n" }));
    const result = await detectDockerCapability({ image: IMAGE, run });
    expect(result.available).toBe(true);
    expect(calls[0]!.slice(0, 1)).toEqual(["info"]);
    expect(calls[1]!).toContain("image");
    expect(calls[1]!).toContain(IMAGE);
  });

  it("is unavailable, and asks nothing more of Docker, when docker info fails", async () => {
    const { run, calls } = fakeRun(() => ({
      exitCode: 1,
      stderr: "Cannot connect to the Docker daemon at unix:///var/run/docker.sock",
    }));
    const result = await detectDockerCapability({ image: IMAGE, run });
    expect(result.available).toBe(false);
    expect(result.reason).toMatch(/docker info/);
    expect(calls).toHaveLength(1);
  });

  it("is unavailable when the docker CLI cannot start", async () => {
    const { run } = fakeRun(
      () =>
        new DockerError({ reason: "unavailable", args: ["info"], exitCode: null, stderr: "spawn docker ENOENT" }),
    );
    const result = await detectDockerCapability({ image: IMAGE, run });
    expect(result.available).toBe(false);
    expect(result.reason).toMatch(/ENOENT/);
  });

  it("is unavailable when the configured image is not present", async () => {
    const { run } = fakeRun((args) =>
      args[0] === "info"
        ? { exitCode: 0, stdout: "29.6.1\n" }
        : { exitCode: 1, stderr: `Error response from daemon: No such image: ${IMAGE}` },
    );
    const result = await detectDockerCapability({ image: IMAGE, run });
    expect(result.available).toBe(false);
    expect(result.reason).toContain(IMAGE);
  });
});

describe("workerCapabilities (§9.9 Scheduling)", () => {
  it("adds docker only when detected", () => {
    expect(workerCapabilities(["node"], true)).toEqual(["node", DOCKER_CAPABILITY]);
    expect(workerCapabilities(["node"], false)).toEqual(["node"]);
  });

  it("never registers docker the check did not find, and never twice", () => {
    expect(workerCapabilities(["docker", "node"], false)).toEqual(["node"]);
    expect(workerCapabilities(["docker", "node"], true)).toEqual(["node", "docker"]);
  });
});

function fakeToolsServer() {
  const listened: Array<{ bindHost: string; advertiseHost: string }> = [];
  let url: string | undefined;
  return {
    listened,
    server: {
      async startContainerListener(endpoint: { bindHost: string; advertiseHost: string }) {
        listened.push(endpoint);
        url = `http://${endpoint.advertiseHost}:4317/mcp`;
      },
      get containerUrl() {
        if (!url) throw new Error("not listening");
        return url;
      },
    },
  };
}

const CONFIG = {
  workspaceRoot: path.join(os.tmpdir(), "orchestra-stack-unit"),
  agentContainerImage: IMAGE,
  agentContainerCpus: 2,
  agentContainerMemory: "4g",
  toolsPort: 4317,
};

describe("startDockerStack (§9.9 Network, C4)", () => {
  it("darwin: starts the listener on loopback, advertises host.docker.internal, never a wildcard", async () => {
    const { run, calls } = fakeRun(() => ({ exitCode: 0 }));
    const tools = fakeToolsServer();
    const stack = await startDockerStack({
      config: CONFIG,
      owner: OWNER,
      toolsServer: tools.server,
      platform: "darwin",
      run,
    });
    expect(tools.listened).toHaveLength(1);
    expect(tools.listened[0]).toMatchObject({ bindHost: "127.0.0.1", advertiseHost: "host.docker.internal" });
    expect(stack.toolsUrl()).toBe("http://host.docker.internal:4317/mcp");
    expect(stack.manager).toBeInstanceOf(ContainerManager);
    expect(stack.executionContainers.owner).toBe(OWNER);
    // Docker Desktop needs no gateway lookup.
    expect(calls).toHaveLength(0);
  });

  it("linux: binds and advertises the orchestra-agents gateway from ContainerManager.networkGateway", async () => {
    const { run } = fakeRun((args) =>
      args.includes("{{json .IPAM.Config}}")
        ? { exitCode: 0, stdout: '[{"Subnet":"172.30.0.0/16","Gateway":"172.30.0.1"}]\n' }
        : { exitCode: 0, stdout: "orchestra-agents\n" },
    );
    const tools = fakeToolsServer();
    const stack = await startDockerStack({
      config: CONFIG,
      owner: OWNER,
      toolsServer: tools.server,
      platform: "linux",
      run,
    });
    expect(tools.listened).toHaveLength(1);
    expect(tools.listened[0]).toMatchObject({ bindHost: "172.30.0.1", advertiseHost: "172.30.0.1" });
    expect(stack.toolsUrl()).toBe("http://172.30.0.1:4317/mcp");
  });

  it("linux: fails when the network has no IPv4 gateway", async () => {
    const { run } = fakeRun((args) =>
      args.includes("{{json .IPAM.Config}}") ? { exitCode: 0, stdout: "[]\n" } : { exitCode: 0 },
    );
    const tools = fakeToolsServer();
    await expect(
      startDockerStack({ config: CONFIG, owner: OWNER, toolsServer: tools.server, platform: "linux", run }),
    ).rejects.toThrow(/gateway/);
    expect(tools.listened).toHaveLength(0);
  });
});

describe("ContainerManager.agentHome (§9.9 Mounts)", () => {
  it("is <workspace_root>/agent-home/<task id>", () => {
    const manager = new ContainerManager({
      workspaceRoot: CONFIG.workspaceRoot,
      image: IMAGE,
      cpus: 1,
      memory: "1g",
      owner: OWNER,
      run: fakeRun(() => ({})).run,
    });
    expect(manager.agentHome("66666666-7777-4888-9999-000000000000")).toBe(
      path.join(CONFIG.workspaceRoot, "agent-home", "66666666-7777-4888-9999-000000000000"),
    );
  });
});
