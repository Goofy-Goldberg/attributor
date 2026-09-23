import { PlusIcon } from "lucide-react";
import { useState } from "react";

import { normalizeSearchResults, useApi } from "@/api.js";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Spinner } from "@/components/ui/spinner";
import { TierBadge } from "@/features/evidence.jsx";
import { useDebouncedValue } from "@/hooks/use-debounced-value.js";

// Adds channels to a comparison. Suggestions come from the precomputed search
// index rather than downloading the whole pool into the browser (the old
// picker fetched up to 5000 rows just to autocomplete).
export default function DomainPicker({ selected, onAdd, label = "Add channel" }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const debounced = useDebouncedValue(query.trim(), 200);
  const request = useApi(debounced.length >= 2 ? `/api/search?q=${encodeURIComponent(debounced)}&limit=12` : null);
  const results = normalizeSearchResults(request.data);
  const stale = Boolean(results.query) && results.query !== debounced;
  const domains = stale ? [] : results.domains;
  const pending = debounced.length >= 2 && (request.loading || stale || query.trim() !== debounced);
  const typed = query.trim().toLowerCase();

  const add = (domain) => {
    onAdd(domain);
    setQuery("");
  };

  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger asChild>
        <Button size="sm" variant="outline">
          <PlusIcon data-icon="inline-start" />
          {label}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 p-0">
        <Command shouldFilter={false}>
          <CommandInput onValueChange={setQuery} placeholder="Search the pool…" value={query} />
          <CommandList>
            {debounced.length < 2 ? (
              <div className="text-muted-foreground px-3 py-6 text-center text-sm">Type at least two characters.</div>
            ) : null}
            {pending && domains.length === 0 ? (
              <div className="text-muted-foreground flex items-center justify-center gap-2 py-6 text-sm">
                <Spinner />
                Searching…
              </div>
            ) : null}
            {request.error ? <div className="text-destructive px-3 py-6 text-center text-sm">{request.error}</div> : null}
            {!pending && !request.error && debounced.length >= 2 ? <CommandEmpty>No channel matches.</CommandEmpty> : null}
            {domains.length > 0 ? (
              <CommandGroup heading="Channels">
                {domains.map((entry) => {
                  const already = selected.includes(entry.domain);
                  return (
                    <CommandItem
                      data-checked={already}
                      disabled={already}
                      key={entry.domain}
                      onSelect={() => add(entry.domain)}
                      value={entry.domain}
                    >
                      <span className="truncate">{entry.domain}</span>
                      {entry.tier ? <TierBadge tier={entry.tier} /> : null}
                      {already ? null : (
                        <CommandShortcut className="tracking-normal tabular-nums">{entry.connectionCount}</CommandShortcut>
                      )}
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            ) : null}
            {/* The index can lag a fresh ingest; let an exact name through. */}
            {typed.includes(".") && !domains.some((entry) => entry.domain === typed) && !selected.includes(typed) && !pending ? (
              <CommandGroup heading="Use as typed">
                <CommandItem onSelect={() => add(typed)} value={`typed:${typed}`}>
                  <PlusIcon />
                  Add “{typed}”
                </CommandItem>
              </CommandGroup>
            ) : null}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
