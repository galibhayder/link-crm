import { Component, type ErrorInfo, type ReactNode } from "react";
import { ErrorState } from "@/components/ui/states";
import { PageContainer } from "@/components/layout/app-shell";

interface Props {
  children: ReactNode;
}
interface State {
  error: Error | null;
}

/**
 * Top-level error boundary.
 *
 * Without this, a render error in any component unmounts the whole tree and the
 * user sees a blank page with no explanation. It also gives us one place to log
 * to an error service later.
 */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    // Kept in the console in Phase 1; swap for the error service in production.
    console.error("Unhandled render error", error, info.componentStack);
  }

  reset = () => this.setState({ error: null });

  override render() {
    if (this.state.error) {
      return (
        <PageContainer>
          <ErrorState
            title="The interface hit an unexpected error"
            description={
              import.meta.env.DEV
                ? this.state.error.message
                : "Something broke while rendering this screen. Reloading usually clears it. If it keeps happening, contact your administrator."
            }
            onRetry={() => {
              this.reset();
              window.location.reload();
            }}
          />
        </PageContainer>
      );
    }
    return this.props.children;
  }
}
