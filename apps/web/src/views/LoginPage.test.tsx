// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, type User } from "../api/client.js";
import { SessionProvider } from "../auth/SessionProvider.js";
import { makeFakeClient } from "../task/fixtures.js";
import { LoginPage } from "./LoginPage.js";

afterEach(cleanup);

describe("LoginPage", () => {
  it("submits email and password and keeps a heading, labelled fields, and a submit button", async () => {
    const user: User = { id: "1", email: "a@b.com", displayName: "A" };
    const client = makeFakeClient({
      me: vi.fn().mockRejectedValue(new Error("anonymous")),
      login: vi.fn().mockResolvedValue(user),
    });

    render(
      <SessionProvider client={client}>
        <LoginPage />
      </SessionProvider>,
    );

    expect(await screen.findByRole("heading", { name: "Log in" })).toBeTruthy();

    const emailInput = screen.getByLabelText("Email");
    const passwordInput = screen.getByLabelText("Password");
    const submit = screen.getByRole("button", { name: "Log in" });

    fireEvent.change(emailInput, { target: { value: "a@b.com" } });
    fireEvent.change(passwordInput, { target: { value: "secret" } });
    await act(async () => {
      submit.click();
    });

    expect(client.login).toHaveBeenCalledWith("a@b.com", "secret");
  });

  it("shows an ApiError message as an alert on failed login", async () => {
    const client = makeFakeClient({
      me: vi.fn().mockRejectedValue(new Error("anonymous")),
      login: vi.fn().mockRejectedValue(new ApiError(401, "invalid_credentials", "Invalid email or password.")),
    });

    render(
      <SessionProvider client={client}>
        <LoginPage />
      </SessionProvider>,
    );

    await screen.findByRole("heading", { name: "Log in" });
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "a@b.com" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "wrong" } });
    const submit = screen.getByRole("button", { name: "Log in" });

    await act(async () => {
      submit.click();
    });

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Invalid email or password.");
  });
});
