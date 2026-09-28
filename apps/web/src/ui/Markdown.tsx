import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

const components: Components = {
  a: ({ href, children, ...rest }) => (
    <a {...rest} href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ),
};

export interface MarkdownProps {
  /** Raw markdown source, e.g. an issue description or agent message. */
  children: string;
}

/**
 * Agent- and user-authored markdown (issue descriptions, spec builder
 * chat, timeline notes). GFM tables/strikethrough/task lists via
 * `remark-gfm`; raw HTML stays disabled (react-markdown's default: no
 * `rehype-raw`), so an embedded `<script>` or `<img onerror>` string
 * renders as inert text, never as a DOM element. Links open in a new tab.
 */
export function Markdown({ children }: MarkdownProps) {
  return (
    <div className="markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {children}
      </ReactMarkdown>
    </div>
  );
}
