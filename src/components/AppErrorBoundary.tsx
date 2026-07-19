import { Component, type ErrorInfo, type ReactNode } from "react";
import "./app-error-boundary.css";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class AppErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("MTGit renderer failed", error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <main className="app-error" role="alert">
        <div className="app-error-card">
          <div className="app-error-mark">!</div>
          <h1>MTGit could not finish loading</h1>
          <p>
            The renderer encountered an unexpected error. Reload the window to try
            again; the details below can help diagnose the problem if it returns.
          </p>
          <pre>{error.stack || error.message}</pre>
          <button type="button" onClick={() => window.location.reload()}>
            Reload MTGit
          </button>
        </div>
      </main>
    );
  }
}
