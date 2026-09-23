import { describe, expect, it } from "vitest";

import { compareUrl, domainUrl } from "./routes.js";

describe("route builders", () => {
  it("encodes a domain path segment", () => {
    expect(domainUrl("host/name ?")).toBe("/domain/host%2Fname%20%3F");
  });

  it("creates a comparison URL with unique, truthy domains in input order", () => {
    expect(compareUrl(["alpha.example", "beta.example", "alpha.example", ""])).toBe(
      "/compare?d=alpha.example&d=beta.example",
    );
    expect(compareUrl(null)).toBe("/compare");
  });
});
