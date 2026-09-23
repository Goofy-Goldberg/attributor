import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router";

import App from "@/App.jsx";
import ErrorBoundary from "@/components/ErrorBoundary.jsx";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { JobsProvider } from "@/features/jobs.jsx";
import { applyInitialTheme, ThemeProvider } from "@/lib/theme.jsx";
import "@/index.css";

applyInitialTheme();

ReactDOM.createRoot(document.getElementById("root")).render(
  <BrowserRouter>
    <ThemeProvider>
      <TooltipProvider delayDuration={300}>
        <JobsProvider>
          <ErrorBoundary title="The app hit an unexpected error">
            <App />
          </ErrorBoundary>
        </JobsProvider>
        <Toaster position="bottom-right" />
      </TooltipProvider>
    </ThemeProvider>
  </BrowserRouter>,
);
