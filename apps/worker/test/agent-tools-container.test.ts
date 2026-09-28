import { describe, expect, it } from "vitest";
import {
  DOCKER_DESKTOP_HOST,
  isWildcardAddress,
  resolveContainerEndpoint,
} from "../src/agent-tools/index.js";

/**
 * design.md §9.9 "Network": the pure resolver that picks the container-facing
 * bind address and advertised URL. No Docker, no sockets.
 */

describe("resolveContainerEndpoint (design.md §9.9 Network)", () => {
  it("Docker Desktop (darwin) binds loopback and advertises host.docker.internal", () => {
    expect(resolveContainerEndpoint({ platform: "darwin", port: 4317 })).toEqual({
      bindHost: "127.0.0.1",
      advertiseHost: DOCKER_DESKTOP_HOST,
      url: "http://host.docker.internal:4317/mcp",
    });
  });

  it("Docker Desktop ignores a gateway address", () => {
    const endpoint = resolveContainerEndpoint({
      platform: "darwin",
      port: 4317,
      gatewayAddress: "172.18.0.1",
    });
    expect(endpoint.bindHost).toBe("127.0.0.1");
    expect(endpoint.url).toBe("http://host.docker.internal:4317/mcp");
  });

  it("Linux binds to and advertises the orchestra-agents bridge gateway", () => {
    expect(
      resolveContainerEndpoint({
        platform: "linux",
        port: 4317,
        gatewayAddress: "172.18.0.1",
      }),
    ).toEqual({
      bindHost: "172.18.0.1",
      advertiseHost: "172.18.0.1",
      url: "http://172.18.0.1:4317/mcp",
    });
  });

  it("Linux brackets an IPv6 gateway in the URL", () => {
    const endpoint = resolveContainerEndpoint({
      platform: "linux",
      port: 4317,
      gatewayAddress: "fd00:dead:beef::1",
    });
    expect(endpoint.bindHost).toBe("fd00:dead:beef::1");
    expect(endpoint.url).toBe("http://[fd00:dead:beef::1]:4317/mcp");
  });

  it("Linux without a gateway address throws", () => {
    expect(() => resolveContainerEndpoint({ platform: "linux", port: 4317 })).toThrow(
      /gateway/,
    );
  });

  it("Linux rejects a gateway that is not an IP literal", () => {
    expect(() =>
      resolveContainerEndpoint({
        platform: "linux",
        port: 4317,
        gatewayAddress: "gateway.local",
      }),
    ).toThrow(/IP address/);
  });

  for (const wildcard of ["0.0.0.0", "::", "::0", "0:0:0:0:0:0:0:0"]) {
    it(`Linux refuses the wildcard gateway ${wildcard}`, () => {
      expect(() =>
        resolveContainerEndpoint({
          platform: "linux",
          port: 4317,
          gatewayAddress: wildcard,
        }),
      ).toThrow(/wildcard/);
    });
  }

  it("throws on a platform it has no rule for", () => {
    expect(() => resolveContainerEndpoint({ platform: "win32", port: 4317 })).toThrow(
      /win32/,
    );
  });

  for (const port of [0, -1, 65536, 1.5, Number.NaN]) {
    it(`rejects port ${port}`, () => {
      expect(() => resolveContainerEndpoint({ platform: "darwin", port })).toThrow(
        /invalid agent-tools port/,
      );
    });
  }
});

describe("isWildcardAddress", () => {
  it("recognises IPv4 and IPv6 unspecified addresses in any spelling", () => {
    for (const a of ["0.0.0.0", "::", "::0", "0:0:0:0:0:0:0:0", "::ffff:0.0.0.0"]) {
      expect(isWildcardAddress(a)).toBe(true);
    }
  });

  it("does not flag loopback or specific addresses", () => {
    for (const a of ["127.0.0.1", "::1", "172.18.0.1", "fd00::1", "localhost"]) {
      expect(isWildcardAddress(a)).toBe(false);
    }
  });
});
