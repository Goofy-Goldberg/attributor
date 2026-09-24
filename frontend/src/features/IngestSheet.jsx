import { CheckCircle2Icon, CircleAlertIcon, CloudDownloadIcon, FileSpreadsheetIcon, ListPlusIcon } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { fetchJson, formatDate, formatPercent, isTerminalStatus } from "@/api.js";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { postIngest, useJobs } from "@/features/jobs.jsx";
import { authClient } from "@/lib/auth-client.js";

// Links, domains and IPs arrive pasted from anywhere — one per line, but also
// comma- or space-separated lists. URLs never contain raw whitespace, so
// splitting on it is safe; the backend reduces each URL to its host.
function parseTargets(text) {
  return [...new Set(text.split(/[\s,;]+/).map((entry) => entry.trim()).filter(Boolean))];
}

export default function IngestSheet() {
  const { sheetOpen, setSheetOpen, addJob, jobs, snapshots, jobsError, clearFinished, userId } = useJobs();
  const session = authClient.useSession();
  const isAdmin = session.data?.user?.role === "admin";
  const [mode, setMode] = useState("paste");
  const [text, setText] = useState("");
  const [file, setFile] = useState(null);
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const textareaRef = useRef(null);

  const targets = useMemo(() => parseTargets(text), [text]);
  const canSubmit = !busy && (mode === "paste" ? targets.length > 0 : Boolean(file));
  const hasFinished = jobs.some((job) => isTerminalStatus(job.status));
  const yourJobs = jobs.filter((job) => job.createdBy === userId);
  const otherJobs = jobs.filter((job) => job.createdBy !== userId);

  const submit = async (event) => {
    event.preventDefault();
    if (!canSubmit) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const trimmedLabel = label.trim() || undefined;
      const payload = await postIngest(mode === "paste" ? { targets, label: trimmedLabel } : { file, label: trimmedLabel });
      const id = payload?.job_id || payload?.job?.id;
      const count = payload?.accepted ?? (mode === "paste" ? targets.length : null);
      const title = mode === "paste" ? (targets.length === 1 ? targets[0] : `${targets.length} targets`) : file.name;
      if (id) {
        addJob({ id, title, label: trimmedLabel || null, count });
      }
      toast.success("Scan started", { description: `${title} queued. Results join the pool as they finish.` });
      setText("");
      setFile(null);
    } catch (err) {
      setError(err.message || "Could not start the scan.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet onOpenChange={setSheetOpen} open={sheetOpen}>
      <SheetContent
        className="flex w-full flex-col gap-0 sm:max-w-lg"
        // Radix focuses the first focusable (the tab list) on open; the analyst
        // almost always came here to paste, so put the caret in the box.
        onOpenAutoFocus={(event) => {
          if (mode === "paste") {
            event.preventDefault();
            textareaRef.current?.focus();
          }
        }}
      >
        <SheetHeader>
          <SheetTitle>Add channels</SheetTitle>
          <SheetDescription>
            Scan websites, domains or IPs. Each one joins the shared pool and is correlated against everything
            already in it.
          </SheetDescription>
        </SheetHeader>

        {/* A plain overflow container, not ScrollArea: Radix's viewport sizes
            its content to the widest child, so a long log line pushed the whole
            form past the panel's right edge instead of truncating. */}
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="flex min-w-0 flex-col gap-6 px-4 pb-6">
            <form className="flex flex-col gap-4" onSubmit={submit}>
              <Tabs onValueChange={setMode} value={mode}>
                <TabsList className="w-full">
                  <TabsTrigger value="paste">
                    <ListPlusIcon />
                    Paste a list
                  </TabsTrigger>
                  <TabsTrigger value="csv">
                    <FileSpreadsheetIcon />
                    Upload CSV
                  </TabsTrigger>
                </TabsList>
                <TabsContent className="pt-2" value="paste">
                  <FieldGroup>
                    <Field>
                      <FieldLabel htmlFor="ingest-targets">Links, domains or IPs</FieldLabel>
                      <Textarea
                        className="min-h-40 font-mono text-sm"
                        id="ingest-targets"
                        onChange={(event) => setText(event.target.value)}
                        placeholder={"https://example.com/news/article\nexample.org\n203.0.113.10"}
                        ref={textareaRef}
                        spellCheck={false}
                        value={text}
                      />
                      <FieldDescription>
                        One per line (commas work too). Page links are fine — we scan the site&apos;s domain.
                        {targets.length > 0 ? (
                          <>
                            {" "}
                            <span className="text-foreground font-medium">
                              {targets.length} target{targets.length === 1 ? "" : "s"} detected.
                            </span>
                          </>
                        ) : null}
                      </FieldDescription>
                    </Field>
                  </FieldGroup>
                </TabsContent>
                <TabsContent className="pt-2" value="csv">
                  <FieldGroup>
                    <Field>
                      <FieldLabel htmlFor="ingest-csv">CSV file</FieldLabel>
                      <Input
                        accept=".csv,text/csv"
                        id="ingest-csv"
                        // Remount on clear so the native input drops the file name too.
                        key={file ? "has-file" : "empty"}
                        onChange={(event) => setFile(event.target.files?.[0] || null)}
                        type="file"
                      />
                      <FieldDescription>The first column is read as the target list.</FieldDescription>
                    </Field>
                  </FieldGroup>
                </TabsContent>
              </Tabs>

              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="ingest-label">Label (optional)</FieldLabel>
                  <Input
                    id="ingest-label"
                    onChange={(event) => setLabel(event.target.value)}
                    placeholder="Campaign, source or analyst note"
                    value={label}
                  />
                </Field>
              </FieldGroup>

              {error ? (
                <p className="text-destructive text-sm" role="alert">
                  {error}
                </p>
              ) : null}

              <Button disabled={!canSubmit} type="submit">
                {busy ? <Spinner data-icon="inline-start" /> : null}
                {busy
                  ? "Starting…"
                  : mode === "paste" && targets.length > 1
                    ? `Scan ${targets.length} targets`
                    : "Start scan"}
              </Button>
            </form>

            {isAdmin ? <OpenCtiImport /> : null}

            {jobsError ? <p className="text-destructive text-sm" role="alert">Could not refresh scans: {jobsError}</p> : null}

            {jobs.length > 0 ? (
              <>
                <Separator />
                <div className="flex flex-col gap-3">
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-medium">Recent scans</h3>
                    {hasFinished ? (
                      <Button onClick={clearFinished} size="xs" variant="ghost">
                        Clear finished
                      </Button>
                    ) : null}
                  </div>
                  <div className="flex flex-col gap-3">
                    <h4 className="text-muted-foreground text-xs font-medium">Your scans</h4>
                    {yourJobs.length > 0
                      ? yourJobs.map((job) => <JobRow job={job} key={job.id} snapshot={snapshots[job.id]} />)
                      : <p className="text-muted-foreground text-xs">You haven&apos;t started a scan yet.</p>}
                  </div>
                  <div className="flex flex-col gap-3">
                    <h4 className="text-muted-foreground text-xs font-medium">Other analysts&apos; scans</h4>
                    {otherJobs.length > 0
                      ? otherJobs.map((job) => <JobRow job={job} key={job.id} snapshot={snapshots[job.id]} showCreator />)
                      : <p className="text-muted-foreground text-xs">No scans from other analysts.</p>}
                  </div>
                </div>
              </>
            ) : null}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

// Same sweep as `scripts/ingest_opencti_channels.py`: every OpenCTI website
// channel, skipping ones already in the pool. The server submits the first
// batch before answering and the rest one after another; later batches show
// up in the scan list below as the jobs poll picks them up.
function OpenCtiImport() {
  const { addJob } = useJobs();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [limit, setLimit] = useState("10");
  const parsedLimit = Number(limit);
  const validLimit = Number.isInteger(parsedLimit) && parsedLimit >= 1 && parsedLimit <= 250;

  const runImport = async () => {
    setBusy(true);
    const pending = toast.loading("Fetching website channels from OpenCTI…");
    try {
      // Paging through every channel on OpenCTI can outlast the default timeout.
      const payload = await fetchJson("/api/ingest/opencti", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ limit: parsedLimit }),
        timeoutMs: 5 * 60 * 1000,
      });
      const skipped = payload?.skipped
        ? ` ${payload.skipped} already in the pool were skipped.`
        : "";
      const deferred = payload?.deferred ? ` ${payload.deferred} remain for a later import.` : "";
      if (!payload?.job_id) {
        toast.success("Nothing new on OpenCTI", {
          id: pending,
          description: `No new website channels to import.${skipped}`,
        });
        return;
      }
      const batches = payload.batches > 1 ? ` in ${payload.batches} batches` : "";
      addJob({
        id: payload.job_id,
        title: payload.batches > 1 ? `OpenCTI import · batch 1 of ${payload.batches}` : "OpenCTI import",
        count: payload.job?.total_targets ?? payload.accepted,
      });
      toast.success("OpenCTI import started", {
        id: pending,
        description: `Scanning ${payload.accepted} new channel${payload.accepted === 1 ? "" : "s"}${batches}.${skipped}${deferred}`,
      });
    } catch (err) {
      toast.error("OpenCTI import failed", { id: pending, description: err.message || "Could not reach OpenCTI." });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Separator />
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-1">
          <h3 className="text-sm font-medium">Import from OpenCTI</h3>
          <p className="text-muted-foreground text-xs">
            Scan new website channels from OpenCTI.
          </p>
        </div>
        <Button disabled={busy} onClick={() => setConfirmOpen(true)} size="sm" variant="outline">
          {busy ? <Spinner data-icon="inline-start" /> : <CloudDownloadIcon data-icon="inline-start" />}
          {busy ? "Importing…" : "Import"}
        </Button>
      </div>
      <AlertDialog onOpenChange={setConfirmOpen} open={confirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Import website channels from OpenCTI?</AlertDialogTitle>
            <AlertDialogDescription>
              Analysis may discover related targets beyond the channel count.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Field>
            <FieldLabel htmlFor="opencti-import-limit">New channels</FieldLabel>
            <Input
              id="opencti-import-limit"
              max={250}
              min={1}
              onChange={(event) => setLimit(event.target.value)}
              type="number"
              value={limit}
            />
          </Field>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction disabled={!validLimit || busy} onClick={runImport}>Import</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function JobRow({ job, snapshot, showCreator = false }) {
  const status = snapshot?.status || job.status;
  const terminal = isTerminalStatus(status);
  const failed = status.includes("fail") || status.includes("error");
  const partial = status.includes("partial");
  const percent = terminal ? 100 : (snapshot?.percent ?? 0);
  const recentLogs = (snapshot?.logs || []).slice(-3);
  const providerRows = snapshot?.providerCoverage?.providers || [];
  const providerFailures = providerRows.reduce((count, row) => count + (row.failed?.length || 0), 0);
  const providerSkips = providerRows.reduce((count, row) => count + (row.skipped?.length || 0), 0);

  return (
    <div className="flex flex-col gap-2 rounded-lg border p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-sm font-medium">
            {job.title || job.label || (job.totalTargets ? `${job.totalTargets} targets` : `Scan ${job.id}`)}
          </span>
          <span className="text-muted-foreground text-xs">
            {showCreator ? `${job.createdByDisplay || "Unknown analyst"} · ` : ""}
            {formatDate(job.startedAt)}
          </span>
        </div>
        {terminal ? (
          <Badge variant={failed ? "destructive" : "secondary"}>
            {failed || partial ? <CircleAlertIcon data-icon="inline-start" /> : <CheckCircle2Icon data-icon="inline-start" />}
            {failed ? "Failed" : partial ? "Partial" : "Done"}
          </Badge>
        ) : (
          <Badge variant="outline">
            <Spinner data-icon="inline-start" />
            {formatPercent(Math.round(percent))}
          </Badge>
        )}
      </div>
      {!terminal ? (
        <>
          <Progress value={percent} />
          <span className="text-muted-foreground truncate text-xs">
            {snapshot?.stage || snapshot?.currentStep || "Queued"}
            {snapshot?.currentTarget ? ` · ${snapshot.currentTarget}` : ""}
          </span>
          {recentLogs.length > 0 ? (
            <div className="bg-muted flex flex-col gap-0.5 rounded-md p-2 font-mono text-[11px] leading-snug">
              {recentLogs.map((line) => (
                <span className="truncate" key={line.id}>
                  <span className="text-muted-foreground uppercase">{line.level}</span> {line.message}
                </span>
              ))}
            </div>
          ) : null}
        </>
      ) : null}
      {snapshot?.failedTargets ? (
        <span className="text-destructive text-xs">{snapshot.failedTargets} target(s) failed.</span>
      ) : null}
      {snapshot?.partialTargets ? (
        <span className="text-muted-foreground text-xs">{snapshot.partialTargets} target(s) have partial provider coverage.</span>
      ) : null}
      {providerFailures || providerSkips ? (
        <span className="text-muted-foreground text-xs">
          Provider coverage: {providerFailures} failed, {providerSkips} skipped.
        </span>
      ) : null}
    </div>
  );
}
