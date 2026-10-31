import { Link } from 'react-router-dom'
import { useDocumentTitle } from '../lib/hooks'
import { EmptyState } from '../ui'

export function NotFound() {
  useDocumentTitle('Not found')
  return (
    <EmptyState title="Page not found" className="py-24">
      There is nothing at this address. <Link to="/">Go to Sessions</Link> or <Link to="/cost">Cost</Link>.
    </EmptyState>
  )
}
