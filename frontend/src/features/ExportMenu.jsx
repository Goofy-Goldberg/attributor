import { DownloadIcon, FileJsonIcon, FileSpreadsheetIcon, FileTextIcon } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { describeExportCoverage, downloadReportCsv, downloadReportJson, printReport } from "@/features/exportReport.js";

// A point-in-time report of exactly what is on screen (direct pairs plus any
// multi-hop chains), for someone who does not need to open the tool.
export default function ExportMenu({ scope, disabled = false }) {
  const coverage = describeExportCoverage(scope?.coverage);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button disabled={disabled} variant="outline">
          <DownloadIcon data-icon="inline-start" />
          Export
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel>Share these findings</DropdownMenuLabel>
        <p className="text-muted-foreground px-2 pb-2 text-xs">{coverage}</p>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem
            onSelect={() => {
              // printReport returns false when the browser blocked the popup;
              // without saying so, the menu item would silently do nothing.
              if (!printReport(scope)) {
                toast.error("Pop-up blocked", { description: "Allow pop-ups for this site to open the printable report." });
              }
            }}
          >
            <FileTextIcon />
            Printable report (PDF)
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => downloadReportCsv(scope)}>
            <FileSpreadsheetIcon />
            Connections as CSV
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => downloadReportJson(scope)}>
            <FileJsonIcon />
            Raw data as JSON
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
