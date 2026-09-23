import { FingerprintIcon, GlobeIcon, PlusIcon, SearchIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router";

import { normalizeSearchResults, useApi } from "@/api.js";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "@/components/ui/command";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { Spinner } from "@/components/ui/spinner";
import { sharedNodeLabel, TierBadge } from "@/features/evidence.jsx";
import { useJobs } from "@/features/jobs.jsx";
import { compareUrl } from "@/lib/routes.js";
import { NAV_ITEMS } from "@/shell/AppSidebar.jsx";

const DEBOUNCE_MS = 200;
const MIN_QUERY_LENGTH = 2;

// Global "find anything" — a channel, a subdomain, or an evidence value (cert
// hash, tracking ID, ...). Hits the precomputed /api/search index, not a live
// scan or scoring pass, so it is always instant.
export default function CommandSearch() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const navigate = useNavigate();
  const { setSheetOpen } = useJobs();

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === "k" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        setOpen((current) => !current);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    const handle = setTimeout(() => setDebounced(query.trim()), DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [query]);

  const searching = debounced.length >= MIN_QUERY_LENGTH;
  const request = useApi(searching ? `/api/search?q=${encodeURIComponent(debounced)}&limit=8` : null);
  const results = normalizeSearchResults(request.data);
  // The hook holds the previous query's payload for a render after the path
  // changes; compare against the query the server answered to avoid listing
  // stale matches.
  const stale = Boolean(results.query) && results.query !== debounced;
  const domains = stale ? [] : results.domains;
  const selectors = stale ? [] : results.selectors;
  const pending = searching && (request.loading || stale || query.trim() !== debounced);

  const go = (to) => {
    setOpen(false);
    setQuery("");
    navigate(to);
  };

  return (
    <>
      <Button
        aria-label="Search"
        className="text-muted-foreground w-9 justify-start gap-2 px-2 sm:w-72 sm:px-3"
        onClick={() => setOpen(true)}
        variant="outline"
      >
        <SearchIcon data-icon="inline-start" />
        <span className="hidden min-w-0 flex-1 truncate text-left font-normal sm:inline">Search channels, certs, IPs…</span>
        <KbdGroup className="hidden sm:inline-flex">
          <Kbd>⌘</Kbd>
          <Kbd>K</Kbd>
        </KbdGroup>
      </Button>

      <CommandDialog
        className="sm:max-w-xl"
        description="Find a channel or an evidence value such as a certificate hash, IP or tracking ID."
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) {
            setQuery("");
          }
        }}
        open={open}
        title="Search"
      >
        <Command shouldFilter={false}>
          <CommandInput onValueChange={setQuery} placeholder="Search channels, certs, IPs, tracking IDs…" value={query} />
          <CommandList>
            {searching ? (
              <>
                {request.error ? (
                  <div className="text-destructive px-3 py-6 text-center text-sm">Search unavailable — {request.error}</div>
                ) : null}
                {pending && domains.length === 0 && selectors.length === 0 ? (
                  <div className="text-muted-foreground flex items-center justify-center gap-2 py-6 text-sm">
                    <Spinner />
                    Searching…
                  </div>
                ) : null}
                {/* "No matches" is an answer about the corpus, so it must not
                    stand in for a failed or still-running request. */}
                {!pending && !request.error ? <CommandEmpty>No channels or evidence match “{debounced}”.</CommandEmpty> : null}
                {domains.length > 0 ? (
                  <CommandGroup heading="Channels">
                    {domains.map((entry) => (
                      <CommandItem
                        key={entry.domain}
                        onSelect={() => go(`/domain/${encodeURIComponent(entry.domain)}`)}
                        value={`domain:${entry.domain}`}
                      >
                        <GlobeIcon />
                        <span className="truncate">{entry.domain}</span>
                        {entry.tier ? <TierBadge tier={entry.tier} /> : null}
                        <CommandShortcut className="tracking-normal tabular-nums">
                          {entry.connectionCount} connection{entry.connectionCount === 1 ? "" : "s"}
                        </CommandShortcut>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                ) : null}
                {selectors.length > 0 ? (
                  <CommandGroup heading="Evidence — opens a comparison of the channels that share it">
                    {selectors.map((entry) => (
                      <CommandItem
                        key={entry.id}
                        onSelect={() => go(compareUrl(entry.sampleDomains))}
                        value={`selector:${entry.id}`}
                      >
                        <FingerprintIcon />
                        <div className="flex min-w-0 flex-col">
                          <span className="truncate font-mono text-xs">{entry.value}</span>
                          <span className="text-muted-foreground text-xs">{sharedNodeLabel(entry.kind)}</span>
                        </div>
                        <CommandShortcut className="tracking-normal tabular-nums">
                          {entry.domainCount ?? entry.sampleDomains.length} channels
                        </CommandShortcut>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                ) : null}
              </>
            ) : (
              <>
                <CommandGroup heading="Actions">
                  <CommandItem
                    onSelect={() => {
                      setOpen(false);
                      setSheetOpen(true);
                    }}
                    value="action:add"
                  >
                    <PlusIcon />
                    Add channels
                  </CommandItem>
                </CommandGroup>
                <CommandSeparator />
                <CommandGroup heading="Go to">
                  {NAV_ITEMS.map((item) => (
                    <CommandItem key={item.to} onSelect={() => go(item.to)} value={`nav:${item.to}`}>
                      <item.icon />
                      {item.label}
                      <CommandShortcut className="tracking-normal">{item.hint}</CommandShortcut>
                    </CommandItem>
                  ))}
                </CommandGroup>
              </>
            )}
          </CommandList>
        </Command>
      </CommandDialog>
    </>
  );
}
