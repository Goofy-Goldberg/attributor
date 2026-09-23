import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { fetchJson, isTerminalStatus, normalizeJob, useApi } from "@/api.js";

// The backend has no "list jobs" endpoint, so the jobs shown in the UI are the
// ones started from this browser. They are persisted so a scan started before
// a reload (or on another page) keeps reporting progress instead of vanishing
// the moment the analyst navigates away — the old inline progress card did.
const STORAGE_KEY = "ipintel.jobs";
const MAX_JOBS = 10;
const POLL_MS = 4000;

const JobsContext = createContext(null);

export async function postIngest({ file, targets, label }) {
  if (file) {
    const formData = new FormData();
    formData.append("file", file);
    if (label) {
      formData.append("label", label);
    }
    return fetchJson("/api/ingest", {
      method: "POST",
      body: formData,
    });
  }
  return fetchJson("/api/ingest", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(targets.length === 1 ? { target: targets[0], label } : { targets, label }),
  });
}

function loadJobs(userId) {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(`${STORAGE_KEY}.${userId}`) || "[]");
    return Array.isArray(parsed) ? parsed.filter((job) => job && job.id) : [];
  } catch {
    return [];
  }
}

function saveJobs(jobs, userId) {
  try {
    window.localStorage.setItem(`${STORAGE_KEY}.${userId}`, JSON.stringify(jobs));
  } catch {
    // Best effort; the in-memory list still works for this session.
  }
}

export function JobsProvider({ children, userId }) {
  const [jobs, setJobs] = useState(() => loadJobs(userId));
  // Live snapshots from polling, keyed by job id. Not persisted: only the
  // terminal status is, so a finished job is never polled again after reload.
  const [snapshots, setSnapshots] = useState({});
  const [sheetOpen, setSheetOpen] = useState(false);
  // Pages that show pool contents (the channel table) refresh when a scan
  // starts — targets land in the pool immediately — and again when it ends.
  const poolListeners = useRef(new Set());

  useEffect(() => saveJobs(jobs, userId), [jobs, userId]);

  const addJob = useCallback((job) => {
    setJobs((current) => [{ status: "queued", startedAt: new Date().toISOString(), ...job }, ...current.filter((entry) => entry.id !== job.id)].slice(0, MAX_JOBS));
    poolListeners.current.forEach((listener) => listener(job.id));
  }, []);

  const clearFinished = useCallback(() => {
    setJobs((current) => current.filter((job) => !isTerminalStatus(job.status)));
  }, []);

  const handleSnapshot = useCallback((id, snapshot) => {
    setSnapshots((current) => ({ ...current, [id]: snapshot }));
    if (!isTerminalStatus(snapshot.status)) {
      return;
    }
    setJobs((current) => current.map((job) => (job.id === id ? { ...job, status: snapshot.status, finishedAt: new Date().toISOString() } : job)));
    const failed = snapshot.status.includes("fail") || snapshot.status.includes("error");
    if (failed) {
      toast.error("Scan failed", { description: snapshot.summary || `Job ${id} did not finish.` });
    } else {
      toast.success("Scan finished", {
        description: snapshot.failedTargets
          ? `${snapshot.failedTargets} target(s) failed; the rest joined the pool.`
          : "New results are in the channel pool.",
      });
    }
    poolListeners.current.forEach((listener) => listener(id));
  }, []);

  const onPoolChanged = useCallback((listener) => {
    poolListeners.current.add(listener);
    return () => poolListeners.current.delete(listener);
  }, []);

  const activeCount = jobs.filter((job) => !isTerminalStatus(job.status)).length;

  const value = useMemo(
    () => ({ jobs, snapshots, addJob, clearFinished, onPoolChanged, activeCount, sheetOpen, setSheetOpen }),
    [jobs, snapshots, addJob, clearFinished, onPoolChanged, activeCount, sheetOpen],
  );

  return (
    <JobsContext.Provider value={value}>
      {children}
      {jobs
        .filter((job) => !isTerminalStatus(job.status))
        .map((job) => (
          <JobWatcher id={job.id} key={job.id} onSnapshot={handleSnapshot} />
        ))}
    </JobsContext.Provider>
  );
}

// Renders nothing; exists so each running job gets its own polling hook.
function JobWatcher({ id, onSnapshot }) {
  const request = useApi(`/api/jobs/${encodeURIComponent(id)}`, { pollInterval: POLL_MS });
  useEffect(() => {
    if (request.data) {
      onSnapshot(id, normalizeJob(request.data, id));
    }
  }, [request.data, id, onSnapshot]);
  // A job the server no longer knows (restart, cleanup) would otherwise poll
  // forever and keep the sidebar spinner turning.
  useEffect(() => {
    if (request.status === 404) {
      onSnapshot(id, { ...normalizeJob(null, id), status: "failed", summary: "The server no longer has this job." });
    }
  }, [request.status, id, onSnapshot]);
  return null;
}

export function useJobs() {
  const context = useContext(JobsContext);
  if (!context) {
    throw new Error("useJobs must be used inside <JobsProvider>");
  }
  return context;
}
