import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
  componentStack: string | null;
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, componentStack: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error, componentStack: null };
  }

  componentDidCatch(_error: Error, errorInfo: ErrorInfo): void {
    this.setState({ componentStack: errorInfo.componentStack ?? null });
  }

  render(): ReactNode {
    const { error, componentStack } = this.state;
    if (!error) {
      return this.props.children;
    }

    return (
      <div className="error-boundary" style={{ padding: "1.5rem", maxWidth: "960px" }}>
        <h1>Application error</h1>
        <p>
          <strong>{error.name}</strong>: {error.message}
        </p>
        {componentStack && (
          <pre
            className="error-boundary-stack"
            style={{ whiteSpace: "pre-wrap", fontSize: "0.85rem", marginTop: "1rem" }}
          >
            {componentStack}
          </pre>
        )}
      </div>
    );
  }
}
