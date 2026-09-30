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

  it("displays the subtitle below the heading", async () => {
    const client = makeFakeClient({
      me: vi.fn().mockRejectedValue(new Error("anonymous")),
      login: vi.fn(),
    });

    render(
      <SessionProvider client={client}>
        <LoginPage />
      </SessionProvider>,
    );

    const subtitle = await screen.findByText("Jira tickets to reviewed pull requests.");
    expect(subtitle).toBeTruthy();
  });

  it("displays footer text below the card", async () => {
    const client = makeFakeClient({
      me: vi.fn().mockRejectedValue(new Error("anonymous")),
      login: vi.fn(),
    });

    render(
      <SessionProvider client={client}>
        <LoginPage />
      </SessionProvider>,
    );

    const footer = await screen.findByText("Accounts are created by an admin.");
    expect(footer).toBeTruthy();
  });

  it("displays the alert before the form when an error is shown", async () => {
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
    const form = screen.getByRole("button", { name: "Log in" }).closest("form");

    // Alert should appear before form in DOM order
    if (form) {
      expect(alert.compareDocumentPosition(form)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    }
  });
});
