import { Component, type ErrorInfo, type ReactNode } from 'react'
import { ErrorState } from '../ui'

interface Props {
  children: ReactNode
  /** When this changes (the route), a caught error is cleared. */
  resetKey?: string
}

/** Catches errors thrown while rendering a page, so the top bar and the rest of the app survive. */
export class ErrorBoundary extends Component<Props, { error: Error | null }> {
  state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(error, info.componentStack)
  }

  componentDidUpdate(prev: Props) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null })
  }

  render() {
    if (this.state.error) {
      return (
        <ErrorState
          title="This page crashed"
          error={this.state.error}
          onRetry={() => this.setState({ error: null })}
          className="py-24"
        />
      )
    }
    return this.props.children
  }
}
