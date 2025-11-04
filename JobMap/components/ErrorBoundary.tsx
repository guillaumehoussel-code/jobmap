import React from 'react'

type Props = {
  children: React.ReactNode
  fallback?: React.ReactNode
}

type State = { hasError: boolean }

export default class ErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { hasError: false }
  }
  static getDerivedStateFromError() {
    return { hasError: true }
  }
  componentDidCatch(error: Error, info: any) {
    // Minimal logging; in production forward to your logging service
    // eslint-disable-next-line no-console
    console.error('ErrorBoundary caught', error, info)
  }
  render() {
    if (this.state.hasError) {
      return this.props.fallback ?? <div className="w-full h-full bg-white flex items-center justify-center">Something went wrong</div>
    }
    return this.props.children
  }
}