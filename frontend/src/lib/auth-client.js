import { createAuthClient } from "better-auth/react";
import { emailOTPClient, jwtClient } from "better-auth/client/plugins";

export const authClient = createAuthClient({
  plugins: [emailOTPClient(), jwtClient()],
});

let cachedToken = null;
let cachedUntil = 0;
let pendingToken = null;

export function clearApiToken() {
  cachedToken = null;
  cachedUntil = 0;
  pendingToken = null;
}

export async function getApiToken() {
  if (cachedToken && Date.now() < cachedUntil) {
    return cachedToken;
  }
  if (!pendingToken) {
    pendingToken = authClient.token()
      .then(({ data, error }) => {
        if (error || !data?.token) {
          clearApiToken();
          throw new Error(error?.message || "Your session has ended. Sign in again.");
        }
        const token = data.token;
        try {
          const payload = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
          cachedUntil = Math.max(0, Number(payload.exp) * 1000 - 30_000);
          cachedToken = token;
        } catch {
          clearApiToken();
          throw new Error("The server sent an invalid authentication token.");
        }
        return token;
      })
      .finally(() => {
        pendingToken = null;
      });
  }
  return pendingToken;
}

export async function authorizedHeaders(headers) {
  const result = new Headers(headers);
  result.set("Authorization", `Bearer ${await getApiToken()}`);
  return result;
}
