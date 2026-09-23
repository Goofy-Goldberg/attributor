import { lazy, Suspense } from "react";

import ErrorBoundary from "@/components/ErrorBoundary.jsx";
import { LoadingState } from "@/components/page.jsx";

const ClusterGraph = lazy(() => import("@/components/ClusterGraph.jsx"));

export default function LazyClusterGraph(props) {
  // Its own boundary: the graph does the most work on the least predictable
  // data, and a throw in there should cost the analyst the picture, not the
  // whole page of findings underneath it.
  return (
    <ErrorBoundary title="The graph could not be drawn">
      <Suspense fallback={<LoadingState message="Loading graph tools…" />}>
        <ClusterGraph {...props} />
      </Suspense>
    </ErrorBoundary>
  );
}
