import { AlertCircleIcon } from "lucide-react";
import { Component } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

// A render throw anywhere below this point used to unmount the entire tool and
// leave a blank page with nothing in the UI to say why — an analyst mid-triage
// would just lose the app. React only supports class components for this.
//
// Deliberately not a full-page takeover when used around a subtree: wrap the
// graph on its own and the rest of the page keeps working.
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // Keep the stack in the console; there is no error-reporting backend here.
    console.error("Render error:", error, info?.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) {
      return this.props.children;
    }

    return (
      <Alert className="m-4 w-auto" variant="destructive">
        <AlertCircleIcon />
        <AlertTitle>{this.props.title || "Something went wrong"}</AlertTitle>
        <AlertDescription>
          <p>
            This part of the page failed to render. The data it was given may be in an unexpected shape — try again,
            and check the browser console for details.
          </p>
          <pre className="bg-muted text-foreground mt-2 max-w-full overflow-x-auto rounded-md p-2 font-mono text-xs">
            {String(error?.message || error)}
          </pre>
          <div className="mt-3 flex gap-2">
            <Button onClick={() => this.setState({ error: null })} size="sm" variant="outline">
              Try again
            </Button>
            <Button onClick={() => window.location.reload()} size="sm" variant="ghost">
              Reload the page
            </Button>
          </div>
        </AlertDescription>
      </Alert>
    );
  }
}
