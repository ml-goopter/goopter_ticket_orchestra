import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { main } from "../src/cli.js";
import {
  createTestRepo,
  FakeAdapter,
  reviewTurn,
  startFakeToolsServer,
  type FakeToolsServer,
  type TestRepo,
} from "./support.js";

const TOKEN = "tok-cli-test";

let repo: TestRepo;
let tools: FakeToolsServer;
let originalUrl: string | undefined;
let originalToken: string | undefined;

beforeEach(async () => {
  repo = await createTestRepo();
  tools = await startFakeToolsServer(TOKEN);
  originalUrl = process.env.ORCHESTRA_URL;
  originalToken = process.env.ORCHESTRA_TOKEN;
  process.env.ORCHESTRA_URL = tools.url;
  process.env.ORCHESTRA_TOKEN = TOKEN;
});

afterEach(async () => {
  await tools.stop();
  await repo.cleanup();
  if (originalUrl === undefined) delete process.env.ORCHESTRA_URL;
  else process.env.ORCHESTRA_URL = originalUrl;
  if (originalToken === undefined) delete process.env.ORCHESTRA_TOKEN;
  else process.env.ORCHESTRA_TOKEN = originalToken;
});

describe("main (F1)", () => {
  it("removes ORCHESTRA_TOKEN from process.env before the adapter starts, while the reporter still gets the bearer token", async () => {
    let tokenAtStart: string | undefined | "not-called" = "not-called";
    const adapter = new FakeAdapter(
      reviewTurn(JSON.stringify({ verdict: "clean", findings: [] })),
      () => {
        tokenAtStart = process.env.ORCHESTRA_TOKEN;
      },
    );

    const code = await main({
      argv: ["--round", "1"],
      cwd: repo.dir,
      stdout: async () => {},
      stderr: async () => {},
      createAdapter: () => adapter,
    });

    expect(code).toBe(0);
    expect(tokenAtStart).toBeUndefined();
    expect("ORCHESTRA_TOKEN" in adapter.starts[0]!.env).toBe(false);
    expect(tools.calls.map((c) => c.tool)).toEqual([
      "report_usage",
      "report_review_result",
    ]);
    expect(new Set(tools.authorizations)).toEqual(new Set([`Bearer ${TOKEN}`]));
  });
});
