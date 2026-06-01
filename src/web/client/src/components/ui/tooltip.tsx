/** Lightweight tooltip using title attribute — avoids Radix dependency. */
function Tooltip({ children, content }: { children: React.ReactElement<{ title?: string }>; content: string }) {
  return <span title={content}>{children}</span>
}

export { Tooltip }
