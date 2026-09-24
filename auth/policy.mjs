const domains = (process.env.AUTH_EMAIL_DOMAINS || "stratc.org")
  .split(",")
  .map((domain) => domain.trim().toLowerCase())
  .filter(Boolean);

export function emailDomainAllowed(email, allowedDomains = domains) {
  const value = String(email || "").trim().toLowerCase();
  const at = value.lastIndexOf("@");
  return at > 0 && at === value.indexOf("@") && !/\s/.test(value) && at < value.length - 1
    && (allowedDomains.includes("*") || allowedDomains.includes(value.slice(at + 1)));
}

export function identityAllowed({ user, source }) {
  // Mattermost controls who has an account there; email codes prove address ownership.
  if (source.oauth?.providerId === "mattermost" || emailDomainAllowed(user.email)) {
    return;
  }
  return { error: "email_not_allowed", errorDescription: "Use a permitted work email address." };
}
