import { describe, expect, it, vi } from "vitest";
import { ApiError, createApiClient } from "./client.js";

function fakeResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

describe("createApiClient", () => {
  it("posts JSON to /auth/login with credentials included", async () => {
    const user = { id: "1", email: "a@b.com", displayName: "A" };
    const fetchMock = vi.fn().mockResolvedValue(fakeResponse(200, user));
    const client = createApiClient({ baseUrl: "/api", fetch: fetchMock });

    const result = await client.login("a@b.com", "secret");

    expect(result).toEqual(user);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/auth/login");
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("include");
    expect(init.body).toBe(JSON.stringify({ email: "a@b.com", password: "secret" }));
    expect(init.headers).toMatchObject({ "Content-Type": "application/json" });
  });

  it("turns a 401 response into an ApiError carrying the api's code", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      fakeResponse(401, {
        error: { code: "AUTH_REQUIRED", message: "Authentication required." },
      }),
    );
    const client = createApiClient({ baseUrl: "/api", fetch: fetchMock });

    let caught: unknown;
    try {
      await client.me();
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ApiError);
    const apiError = caught as ApiError;
    expect(apiError.status).toBe(401);
    expect(apiError.code).toBe("AUTH_REQUIRED");
    expect(apiError.message).toBe("Authentication required.");
  });

  it("throws when the response body fails schema validation", async () => {
    const fetchMock = vi.fn().mockResolvedValue(fakeResponse(200, { nope: true }));
    const client = createApiClient({ baseUrl: "/api", fetch: fetchMock });

    await expect(client.me()).rejects.toThrow();
  });
});
