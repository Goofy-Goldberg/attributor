// URL builders shared across pages. The comparison set lives in the URL
// (`/compare?d=a.com&d=b.com`) so a comparison can be linked, bookmarked and
// reached with the back button — the old sessionStorage hand-off could not.

export function domainUrl(domain) {
  return `/domain/${encodeURIComponent(domain)}`;
}

export function compareUrl(domains) {
  const params = new URLSearchParams();
  [...new Set((Array.isArray(domains) ? domains : [domains]).filter(Boolean))].forEach((domain) =>
    params.append("d", domain),
  );
  const query = params.toString();
  return query ? `/compare?${query}` : "/compare";
}
