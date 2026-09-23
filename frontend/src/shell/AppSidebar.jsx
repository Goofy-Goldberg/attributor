import { FingerprintIcon, GitCompareArrowsIcon, NetworkIcon, PlusIcon, RadarIcon, TableIcon } from "lucide-react";
import { Link, useLocation } from "react-router";

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "@/components/ui/sidebar";
import { Spinner } from "@/components/ui/spinner";
import { useJobs } from "@/features/jobs.jsx";

export const NAV_ITEMS = [
  { to: "/", label: "Channels", icon: TableIcon, hint: "Every channel in the pool" },
  { to: "/compare", label: "Compare", icon: GitCompareArrowsIcon, hint: "Are these channels connected?" },
  { to: "/evidence", label: "Shared evidence", icon: FingerprintIcon, hint: "Browse by shared cert, IP, tracking ID…" },
  { to: "/clusters", label: "Clusters", icon: NetworkIcon, hint: "Groups linked by shared infrastructure" },
];

export default function AppSidebar() {
  const { pathname } = useLocation();
  const { activeCount, jobs, setSheetOpen } = useJobs();

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton asChild size="lg">
              <Link to="/">
                <div className="bg-primary text-primary-foreground flex aspect-square size-8 items-center justify-center rounded-lg">
                  <RadarIcon className="size-4" />
                </div>
                <div className="grid flex-1 text-left leading-tight">
                  <span className="truncate font-semibold">IP Intel</span>
                  <span className="text-muted-foreground truncate text-xs">Attribution workbench</span>
                </div>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  className="bg-primary text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground active:bg-primary/90 active:text-primary-foreground"
                  onClick={() => setSheetOpen(true)}
                  tooltip="Add channels"
                >
                  <PlusIcon />
                  <span>Add channels</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup>
          <SidebarGroupLabel>Investigate</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {NAV_ITEMS.map((item) => {
                const active = item.to === "/" ? pathname === "/" || pathname.startsWith("/domain/") : pathname === item.to;
                return (
                  <SidebarMenuItem key={item.to}>
                    <SidebarMenuButton asChild isActive={active} tooltip={item.label}>
                      <Link to={item.to}>
                        <item.icon />
                        <span>{item.label}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      {jobs.length > 0 ? (
        <SidebarFooter>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton onClick={() => setSheetOpen(true)} tooltip="Scans">
                {activeCount > 0 ? <Spinner /> : <RadarIcon />}
                <span>{activeCount > 0 ? "Scanning…" : "Recent scans"}</span>
              </SidebarMenuButton>
              {activeCount > 0 ? <SidebarMenuBadge>{activeCount}</SidebarMenuBadge> : null}
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarFooter>
      ) : null}
      <SidebarRail />
    </Sidebar>
  );
}
