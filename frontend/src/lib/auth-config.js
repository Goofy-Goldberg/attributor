let configPromise;

export function authConfig() {
  if (!configPromise) {
    configPromise = fetch("/api/auth/config")
      .then((response) => {
        if (!response.ok) {
          throw new Error("Sign-in options are unavailable.");
        }
        return response.json();
      })
      .catch((error) => {
        configPromise = null;
        throw error;
      });
  }
  return configPromise;
}
