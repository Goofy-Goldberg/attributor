import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { fetchJson, isTerminalStatus, normalizeJob } from "@/api.js";

const ACTIVE_POLL_MS = 5000;
const IDLE_POLL_MS = 15000;
const RECENT_LIMIT = 50;
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

function newestFirst(a, b) {
  return (Date.parse(b.createdAt || b.startedAt || "") || 0) - (Date.parse(a.createdAt || a.startedAt || "") || 0);
}

export function JobsProvider({ children, userId }) {
  const [optimisticJobs, setOptimisticJobs] = useState([]);
  const [dismissed, setDismissed] = useState(() => new Set());
  const [sheetOpen, setSheetOpen] = useState(false);
  const [serverLists, setServerLists] = useState({ active: null, recent: null, error: null });
  const poolListeners = useRef(new Set());
  const knownStatuses = useRef(new Map());
  const baselineAt = useRef(null);
  const optimisticRef = useRef([]);
  const serverSeenIds = useRef(new Set());
  const refreshRef = useRef(null);

  useEffect(() => {
    let live = true;
    let inFlight = false;
    let refreshPending = false;
    let timer;
    let controller;
    let hasServerActive = false;

    const schedule = (delay) => {
      window.clearTimeout(timer);
      timer = window.setTimeout(load, delay);
    };
    const load = async () => {
      if (!live) {
        return;
      }
      if (document.hidden) {
        schedule(IDLE_POLL_MS);
        return;
      }
      if (inFlight) {
        refreshPending = true;
        return;
      }
      inFlight = true;
      controller = new AbortController();
      try {
        const [active, recent] = await Promise.all([
          fetchJson("/api/jobs?status=active&limit=5000", { signal: controller.signal }),
          fetchJson(`/api/jobs?status=recent&limit=${RECENT_LIMIT}`, { signal: controller.signal }),
        ]);
        if (live) {
          hasServerActive = active.jobs.length > 0;
          for (const job of [...active.jobs, ...recent.jobs]) {
            serverSeenIds.current.add(job.id || job.job_id);
          }
          setServerLists({ active: active.jobs, recent: recent.jobs, error: null });
        }
      } catch (error) {
        if (live && error.name !== "AbortError") {
          setServerLists((current) => ({ ...current, error: error.message || "Request failed." }));
        }
      } finally {
        inFlight = false;
        if (live) {
          const hasPending = optimisticRef.current.some((job) => !serverSeenIds.current.has(job.id));
          schedule(refreshPending ? 0 : hasServerActive || hasPending ? ACTIVE_POLL_MS : IDLE_POLL_MS);
          refreshPending = false;
        }
      }
    };

    const onVisibilityChange = () => {
      if (!document.hidden) {
        schedule(0);
      }
    };
    refreshRef.current = () => schedule(0);
    document.addEventListener("visibilitychange", onVisibilityChange);
    load();
    return () => {
      live = false;
      window.clearTimeout(timer);
      controller?.abort();
      refreshRef.current = null;
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);

  const listReady = Array.isArray(serverLists.active) && Array.isArray(serverLists.recent);

  const jobs = useMemo(() => {
    const byId = new Map(optimisticJobs.filter((job) => !serverSeenIds.current.has(job.id)).map((job) => [job.id, job]));
    for (const raw of [...(serverLists.recent || []), ...(serverLists.active || [])]) {
      const job = normalizeJob(raw);
      if (job.id) {
        byId.set(job.id, job);
      }
    }
    return [...byId.values()].filter((job) => !dismissed.has(job.id)).sort(newestFirst);
  }, [serverLists, optimisticJobs, dismissed]);

  useEffect(() => {
    if (!listReady) {
      return;
    }
    if (baselineAt.current === null) {
      baselineAt.current = Date.now();
      if (knownStatuses.current.size === 0) {
        for (const job of jobs) {
          knownStatuses.current.set(job.id, job.status);
        }
        return;
      }
    }

    for (const job of jobs) {
      const previous = knownStatuses.current.get(job.id);
      const finishedAt = Date.parse(job.finishedAt);
      const newlyFinished = previous === undefined && Number.isFinite(finishedAt) && finishedAt > baselineAt.current;
      if (isTerminalStatus(job.status) && ((previous && !isTerminalStatus(previous)) || newlyFinished)) {
        poolListeners.current.forEach((listener) => listener(job.id));
        if (job.createdBy === userId) {
          const failed = job.status.includes("fail") || job.status.includes("error");
          if (failed) {
            toast.error("Scan failed", { description: job.summary || `Scan ${job.id} did not finish.` });
          } else {
            toast.success("Scan finished", {
              description: job.failedTargets
                ? `${job.failedTargets} target(s) failed; the rest joined the pool.`
                : "New results are in the channel pool.",
            });
          }
        }
      }
      knownStatuses.current.set(job.id, job.status);
    }
  }, [jobs, listReady, userId]);

  const addJob = useCallback((job) => {
    const createdAt = new Date().toISOString();
    knownStatuses.current.set(job.id, "queued");
    serverSeenIds.current.delete(job.id);
    const submitted = { status: "queued", createdAt, startedAt: createdAt, createdBy: userId, ...job };
    optimisticRef.current = [submitted, ...optimisticRef.current.filter((entry) => entry.id !== job.id)].slice(0, 10);
    setOptimisticJobs(optimisticRef.current);
    poolListeners.current.forEach((listener) => listener(job.id));
    refreshRef.current?.();
  }, [userId]);

  const clearFinished = useCallback(() => {
    setDismissed((current) => new Set([...current, ...jobs.filter((job) => isTerminalStatus(job.status)).map((job) => job.id)]));
  }, [jobs]);

  const onPoolChanged = useCallback((listener) => {
    poolListeners.current.add(listener);
    return () => poolListeners.current.delete(listener);
  }, []);

  const activeCount = jobs.filter((job) => !isTerminalStatus(job.status)).length;
  const snapshots = useMemo(() => Object.fromEntries(jobs.map((job) => [job.id, job])), [jobs]);
  const jobsError = serverLists.error;
  const value = useMemo(
    () => ({ jobs, snapshots, jobsError, addJob, clearFinished, onPoolChanged, activeCount, sheetOpen, setSheetOpen, userId }),
    [jobs, snapshots, jobsError, addJob, clearFinished, onPoolChanged, activeCount, sheetOpen, userId],
  );

  return <JobsContext.Provider value={value}>{children}</JobsContext.Provider>;
}

export function useJobs() {
  const context = useContext(JobsContext);
  if (!context) {
    throw new Error("useJobs must be used inside <JobsProvider>");
  }
  return context;
}
