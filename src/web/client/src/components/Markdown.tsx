import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { cn } from '@/lib/utils'

interface MarkdownProps {
  children: string
  className?: string
}

export function Markdown({ children, className }: MarkdownProps) {
  return (
    <div className={cn('prose-merlin', className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // Block code: pre wraps code in a styled container
          pre({ children }) {
            return (
              <pre className="rounded bg-black/30 px-3 py-2 overflow-x-auto text-xs font-mono whitespace-pre my-2">
                {children}
              </pre>
            )
          },
          // Inline code only — block code is handled by pre > code
          code({ children, ...props }) {
            return (
              <code className="rounded bg-black/30 px-1 py-0.5 text-[0.85em] font-mono" {...props}>
                {children}
              </code>
            )
          },
          p({ children }) {
            return <p className="mb-2 last:mb-0">{children}</p>
          },
          ul({ children }) {
            return <ul className="mb-2 ml-4 list-disc last:mb-0 space-y-0.5">{children}</ul>
          },
          ol({ children }) {
            return <ol className="mb-2 ml-4 list-decimal last:mb-0 space-y-0.5">{children}</ol>
          },
          li({ children }) {
            return <li className="pl-0.5">{children}</li>
          },
          h1({ children }) {
            return <h1 className="text-base font-bold mt-3 mb-1">{children}</h1>
          },
          h2({ children }) {
            return <h2 className="text-sm font-bold mt-3 mb-1">{children}</h2>
          },
          h3({ children }) {
            return <h3 className="text-sm font-semibold mt-2 mb-1">{children}</h3>
          },
          blockquote({ children }) {
            return (
              <blockquote className="border-l-2 border-muted-foreground/30 pl-3 my-2 text-muted-foreground italic">
                {children}
              </blockquote>
            )
          },
          a({ href, children }) {
            return (
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                className="text-cyan-400 underline underline-offset-2"
              >
                {children}
              </a>
            )
          },
          table({ children }) {
            return (
              <div className="my-2 overflow-x-auto">
                <table className="text-xs border-collapse">{children}</table>
              </div>
            )
          },
          th({ children }) {
            return (
              <th className="border border-border px-2 py-1 text-left font-semibold bg-secondary/30">{children}</th>
            )
          },
          td({ children }) {
            return <td className="border border-border px-2 py-1">{children}</td>
          },
          hr() {
            return <hr className="my-3 border-border" />
          },
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  )
}
