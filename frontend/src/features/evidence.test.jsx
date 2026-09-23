import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";

import { ConnectionList, isInfrastructureOnlyLink, partitionInfrastructureOnlyLinks } from "./evidence.jsx";

const link = (evidence) => ({ evidence, target: "other.example" });

describe("infrastructure-only connection folding", () => {
  it("folds only CDN or shared-hosting IPs and infrastructure selector kinds", () => {
    expect(isInfrastructureOnlyLink(link([{ kind: "shared_ip", network: "cdn" }]))).toBe(true);
    expect(isInfrastructureOnlyLink(link([{ kind: "shared_ip", network: "pool" }]))).toBe(true);
    expect(isInfrastructureOnlyLink(link([{ kind: "asn" }, { kind: "network_cidr" }, { kind: "nameserver" }]))).toBe(true);

    expect(isInfrastructureOnlyLink(link([{ kind: "shared_ip", network: "origin" }]))).toBe(false);
    expect(isInfrastructureOnlyLink(link([{ kind: "shared_ip", network: "cdn" }, { kind: "tracking_id" }]))).toBe(false);
    expect(isInfrastructureOnlyLink(link([]))).toBe(false);
  });

  it("keeps an analyst-selected Compare pair out of the collapsed group", () => {
    const selectedPair = { ...link([{ kind: "asn" }]), target: "selected.example" };
    const poolLink = { ...link([{ kind: "nameserver" }]), target: "pool.example" };

    expect(partitionInfrastructureOnlyLinks([selectedPair, poolLink], (entry) => entry.target !== "selected.example")).toEqual({
      visible: [selectedPair],
      infrastructure: [poolLink],
    });
  });

  it("renders one collapsed group instead of individual infrastructure links", () => {
    const markup = renderToStaticMarkup(
      <MemoryRouter>
        <ConnectionList
          foldInfrastructure
          leftLabel="alpha.example"
          links={[
            { ...link([{ kind: "shared_ip", network: "cdn" }]), target: "cdn.example" },
            { ...link([{ kind: "nameserver" }]), target: "ns.example" },
          ]}
        />
      </MemoryRouter>,
    );

    expect(markup).toContain("2 links share only infrastructure");
    expect(markup).not.toContain("cdn.example");
    expect(markup).not.toContain("ns.example");
  });
});
