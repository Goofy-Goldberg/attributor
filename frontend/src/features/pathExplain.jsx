import { ConnectionRow } from "@/features/evidence.jsx";

// Renders a multi-hop chain (from /api/graph/path or /api/graph/related/*,
// both precomputed — see db.intel_db.graph_paths) as one expandable
// connection per hop, joined by a vertical rail so it reads as a path.
export function PathChain({ chain }) {
  if (!chain || chain.length === 0) {
    return null;
  }
  return (
    <div className="flex flex-col gap-2">
      <p className="text-muted-foreground text-xs">
        Each step is a separate match between two channels. The chain shows an indirect path; it does not give one match
        score for its endpoints.
      </p>
      <ol className="flex flex-col gap-2">
        {chain.map((hop, index) => (
          <li className="relative flex gap-3" key={`${hop.from}|${hop.to}`}>
            <div className="flex flex-col items-center">
              <span className="bg-muted text-muted-foreground flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-medium">
                {index + 1}
              </span>
              {index < chain.length - 1 ? <span className="bg-border w-px flex-1" /> : null}
            </div>
            <div className="min-w-0 flex-1 pb-1">
              <ConnectionRow leftLabel={hop.from} link={{ ...hop, target: hop.to }} rightLabel={hop.to} showPair />
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
