import { lazy, Suspense } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router";

import { SkeletonRows } from "@/components/page.jsx";
import AppLayout from "@/shell/AppLayout.jsx";

// Pages load on demand so the first paint only pays for the shell and the page
// actually being opened.
const ChannelsPage = lazy(() => import("@/pages/ChannelsPage.jsx"));
const ClustersPage = lazy(() => import("@/pages/ClustersPage.jsx"));
const ComparePage = lazy(() => import("@/pages/ComparePage.jsx"));
const DomainPage = lazy(() => import("@/pages/DomainPage.jsx"));
const EvidencePage = lazy(() => import("@/pages/EvidencePage.jsx"));
const NotFoundPage = lazy(() => import("@/pages/NotFoundPage.jsx"));

// /connections was the old combined compare + browse-by-edge page. Keep old
// links working by forwarding them (query string included) to /compare.
function LegacyConnectionsRedirect() {
  const location = useLocation();
  return <Navigate replace to={`/compare${location.search}`} />;
}

function page(element) {
  return <Suspense fallback={<SkeletonRows rows={6} />}>{element}</Suspense>;
}

export default function App() {
  return (
    <Routes>
      <Route element={<AppLayout />}>
        <Route element={page(<ChannelsPage />)} index />
        <Route element={page(<DomainPage />)} path="domain/:value" />
        <Route element={page(<ComparePage />)} path="compare" />
        <Route element={page(<EvidencePage />)} path="evidence" />
        <Route element={page(<ClustersPage />)} path="clusters" />
        <Route element={<LegacyConnectionsRedirect />} path="connections" />
        <Route element={page(<NotFoundPage />)} path="*" />
      </Route>
    </Routes>
  );
}
