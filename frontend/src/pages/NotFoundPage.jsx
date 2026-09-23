import { CompassIcon } from "lucide-react";
import { Link } from "react-router";

import { EmptyState } from "@/components/page.jsx";
import { Button } from "@/components/ui/button";

export default function NotFoundPage() {
  return (
    <EmptyState className="mt-12" description="This page does not exist." icon={CompassIcon} title="Page not found">
      <Button asChild>
        <Link to="/">Back to channels</Link>
      </Button>
    </EmptyState>
  );
}
