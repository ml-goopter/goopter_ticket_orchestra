// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Markdown } from "./Markdown.js";

describe("Markdown", () => {
  it("renders a GFM table", () => {
    const { container } = render(
      <Markdown>{"| A | B |\n| --- | --- |\n| 1 | 2 |\n"}</Markdown>,
    );
    expect(container.querySelector("table")).toBeTruthy();
    expect(container.querySelector("thead")).toBeTruthy();
    expect(screen.getByText("A")).toBeTruthy();
    expect(screen.getByText("2")).toBeTruthy();
  });

  it("renders a fenced code block", () => {
    const { container } = render(<Markdown>{"```js\nconst x = 1;\n```\n"}</Markdown>);
    const pre = container.querySelector("pre");
    expect(pre).toBeTruthy();
    expect(pre?.querySelector("code")?.textContent).toContain("const x = 1;");
  });

  it("does not render a raw <script> string as an actual script element", () => {
    const { container } = render(<Markdown>{"before <script>alert(1)</script> after"}</Markdown>);
    expect(container.querySelector("script")).toBeNull();
  });

  it("does not render a raw <img onerror> string as an actual img element", () => {
    const { container } = render(
      <Markdown>{'before <img src=x onerror="alert(1)"> after'}</Markdown>,
    );
    expect(container.querySelector("img")).toBeNull();
  });

  it("opens links in a new tab with rel=noopener noreferrer", () => {
    render(<Markdown>{"[here](https://example.com)"}</Markdown>);
    const link = screen.getByRole("link", { name: "here" });
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("wraps output in a .markdown container", () => {
    const { container } = render(<Markdown>{"hello"}</Markdown>);
    expect(container.querySelector("div.markdown")).toBeTruthy();
  });
});
