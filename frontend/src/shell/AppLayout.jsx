import { LinkIcon, LogOutIcon, MoonIcon, SunIcon, UserRoundIcon } from "lucide-react";
import { Fragment, useEffect, useState } from "react";
import { Link, Outlet, useLocation, useNavigate, useParams } from "react-router";
import { toast } from "sonner";

import { clearResponseCache } from "@/api.js";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
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
import { Separator } from "@/components/ui/separator";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import IngestSheet from "@/features/IngestSheet.jsx";
import { authClient, clearApiToken } from "@/lib/auth-client.js";
import { authConfig } from "@/lib/auth-config.js";
import { useTheme } from "@/lib/theme.jsx";
import AppSidebar, { NAV_ITEMS } from "@/shell/AppSidebar.jsx";
import CommandSearch from "@/shell/CommandSearch.jsx";

export default function AppLayout() {
  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset className="min-w-0">
        <header className="bg-background/90 sticky top-0 z-10 flex h-14 shrink-0 items-center gap-2 border-b px-4 backdrop-blur">
          <SidebarTrigger className="-ml-1" />
          <Separator className="mr-2 data-[orientation=vertical]:h-4" orientation="vertical" />
          <Crumbs />
          <div className="ml-auto flex items-center gap-2">
            <CommandSearch />
            <ThemeToggle />
            <AccountMenu />
          </div>
        </header>
        <main className="mx-auto flex w-full max-w-7xl min-w-0 flex-1 flex-col gap-6 p-4 md:p-6">
          <Outlet />
        </main>
      </SidebarInset>
      <IngestSheet />
    </SidebarProvider>
  );
}

async function connectMattermost() {
  const result = await authClient.linkSocial({ provider: "mattermost", callbackURL: window.location.pathname });
  if (result.error) {
    toast.error("Could not connect Mattermost", { description: result.error.message });
  }
}

function AccountMenu() {
  const navigate = useNavigate();
  const session = authClient.useSession();
  const [mattermostEnabled, setMattermostEnabled] = useState(false);

  useEffect(() => {
    let active = true;
    authConfig().then((config) => active && setMattermostEnabled(Boolean(config.mattermostEnabled))).catch(() => {});
    return () => { active = false; };
  }, []);

  const signOut = async () => {
    const result = await authClient.signOut();
    if (result.error) {
      toast.error("Could not sign out", { description: result.error.message });
      return;
    }
    clearApiToken();
    clearResponseCache();
    navigate("/login", { replace: true });
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button aria-label="Account" size="icon" variant="ghost"><UserRoundIcon /></Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel className="truncate">{session.data?.user?.email || "Account"}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          {mattermostEnabled ? (
            <DropdownMenuItem onSelect={connectMattermost}><LinkIcon />Connect Mattermost</DropdownMenuItem>
          ) : null}
          <DropdownMenuItem onSelect={signOut}><LogOutIcon />Sign out</DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function Crumbs() {
  const { pathname } = useLocation();
  const params = useParams();
  const trail = [];

  if (pathname.startsWith("/domain/")) {
    trail.push({ label: "Channels", to: "/" }, { label: params.value });
  } else {
    const item = NAV_ITEMS.find((entry) => entry.to === pathname);
    trail.push({ label: item ? item.label : "Not found" });
  }

  return (
    <Breadcrumb className="min-w-0">
      <BreadcrumbList className="flex-nowrap">
        {trail.map((crumb, index) => (
          <Fragment key={`${crumb.label}-${index}`}>
            {index > 0 ? <BreadcrumbSeparator /> : null}
            <BreadcrumbItem className="min-w-0">
              {crumb.to ? (
                <BreadcrumbLink asChild>
                  <Link to={crumb.to}>{crumb.label}</Link>
                </BreadcrumbLink>
              ) : (
                <BreadcrumbPage className="truncate">{crumb.label}</BreadcrumbPage>
              )}
            </BreadcrumbItem>
          </Fragment>
        ))}
      </BreadcrumbList>
    </Breadcrumb>
  );
}

function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const dark = resolvedTheme === "dark";
  return (
    <Button
      aria-label={dark ? "Switch to light theme" : "Switch to dark theme"}
      onClick={() => setTheme(dark ? "light" : "dark")}
      size="icon"
      title={dark ? "Switch to light theme" : "Switch to dark theme"}
      variant="ghost"
    >
      {dark ? <SunIcon /> : <MoonIcon />}
    </Button>
  );
}
