const domains = (process.env.AUTH_EMAIL_DOMAINS || "stratc.org")
  .split(",")
  .map((domain) => domain.trim().toLowerCase())
  .filter(Boolean);

export function emailDomainAllowed(email, allowedDomains = domains) {
  const value = String(email || "").trim().toLowerCase();
  const at = value.lastIndexOf("@");
  return at > 0 && at < value.length - 1 && allowedDomains.includes(value.slice(at + 1));
}

export function identityAllowed({ user, source }) {
  // Mattermost itself controls who has an account there. Other methods must
  // prove ownership of an address on the configured email-domain list.
  if (source.oauth?.providerId === "mattermost" || emailDomainAllowed(user.email)) {
    return;
  }
  return { error: "email_not_allowed", errorDescription: "Use a permitted work email address." };
}
