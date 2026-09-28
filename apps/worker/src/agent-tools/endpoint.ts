import { BlockList, isIP, isIPv6 } from "node:net";

/**
 * Addresses and URLs for the agent-tools server's listeners (design.md §8,
 * §9.9 "Network"). Pure: no sockets, no Docker.
 */

export const AGENT_TOOLS_PATH = "/mcp";

/** Name Docker Desktop resolves, inside any container, to the host. */
export const DOCKER_DESKTOP_HOST = "host.docker.internal";

/** `http://host:port/mcp`, bracketing an IPv6 literal. */
export function agentToolsUrl(host: string, port: number): string {
  const h = isIPv6(host) ? `[${host}]` : host;
  return `http://${h}:${port}${AGENT_TOOLS_PATH}`;
}

const WILDCARDS = new BlockList();
WILDCARDS.addAddress("0.0.0.0", "ipv4");
WILDCARDS.addAddress("::", "ipv6");

/**
 * True for the IPv4 or IPv6 unspecified address in any spelling (`0.0.0.0`,
 * `::`, `::0`, `::ffff:0.0.0.0`, ...). Binding one listens on every
 * interface. Non-IP strings are not wildcards.
 */
export function isWildcardAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return false;
  return WILDCARDS.check(address, family === 6 ? "ipv6" : "ipv4");
}

export interface ContainerEndpointInput {
  platform: NodeJS.Platform;
  /** WORKER_TOOLS_PORT: the loopback listener's port, shared by both. */
  port: number;
  /**
   * Linux only: the `orchestra-agents` bridge gateway address. Supplied by
   * the caller; this module never creates or inspects Docker networks.
   */
  gatewayAddress?: string;
}

export interface ContainerEndpoint {
  /** Address the container-facing listener binds. Never a wildcard. */
  bindHost: string;
  /** Host a container uses to reach that listener. */
  advertiseHost: string;
  /** `ORCHESTRA_URL` and `mcp.url` for container-mode agents. */
  url: string;
}

/**
 * Picks the narrowest bind address reachable from a container on the
 * `orchestra-agents` bridge network, and the URL that container uses.
 *
 * Docker Desktop (darwin): bind 127.0.0.1, advertise host.docker.internal.
 * Verified empirically on Docker Desktop 29.6.1 (macOS, 2026-09-28): a
 * container on a user-defined bridge network (gateway 10.201.5.1) resolved
 * host.docker.internal to 192.168.65.254 and reached a host server bound
 * only to 127.0.0.1. The server saw the connection arrive from 127.0.0.1,
 * because Docker Desktop's host-side proxy opens it over loopback. Neither
 * the bridge gateway nor 192.168.65.254 is a host interface (binding either
 * fails with EADDRNOTAVAIL), so loopback is both the narrowest and the only
 * specific choice. It equals the loopback listener's address, so the server
 * serves both from one socket.
 *
 * Linux: the bridge gateway address is a host interface that containers on
 * that network route to, so bind to it and advertise it.
 */
export function resolveContainerEndpoint(
  input: ContainerEndpointInput,
): ContainerEndpoint {
  const { platform, port, gatewayAddress } = input;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`invalid agent-tools port: ${port}`);
  }

  switch (platform) {
    case "darwin":
      return {
        bindHost: "127.0.0.1",
        advertiseHost: DOCKER_DESKTOP_HOST,
        url: agentToolsUrl(DOCKER_DESKTOP_HOST, port),
      };
    case "linux": {
      if (!gatewayAddress) {
        throw new Error(
          "linux container endpoint needs the orchestra-agents bridge gateway address",
        );
      }
      if (isIP(gatewayAddress) === 0) {
        throw new Error(
          `bridge gateway must be an IP address, got ${JSON.stringify(gatewayAddress)}`,
        );
      }
      if (isWildcardAddress(gatewayAddress)) {
        throw new Error(
          `refusing wildcard bridge gateway ${gatewayAddress}: it would bind every interface`,
        );
      }
      return {
        bindHost: gatewayAddress,
        advertiseHost: gatewayAddress,
        url: agentToolsUrl(gatewayAddress, port),
      };
    }
    default:
      throw new Error(`no container endpoint rule for platform ${platform}`);
  }
}
