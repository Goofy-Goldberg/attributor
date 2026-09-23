import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

// "theme" is the key the previous UI persisted to, so an analyst's light/dark
// choice survives the redesign. Absent a stored choice, follow the OS.
const STORAGE_KEY = "theme";
const query = () => window.matchMedia?.("(prefers-color-scheme: dark)");

function readStored() {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return stored === "light" || stored === "dark" ? stored : "system";
  } catch {
    return "system";
  }
}

function resolve(theme) {
  return theme === "system" ? (query()?.matches ? "dark" : "light") : theme;
}

function apply(resolved) {
  const root = document.documentElement;
  root.classList.toggle("dark", resolved === "dark");
  root.style.colorScheme = resolved;
}

// Called once before React mounts so dark-theme users never see a light flash.
export function applyInitialTheme() {
  apply(resolve(readStored()));
}

const ThemeContext = createContext({ theme: "system", resolvedTheme: "light", setTheme: () => {} });

export function ThemeProvider({ children }) {
  const [theme, setThemeState] = useState(readStored);
  const [systemDark, setSystemDark] = useState(() => Boolean(query()?.matches));
  const resolvedTheme = theme === "system" ? (systemDark ? "dark" : "light") : theme;

  useEffect(() => {
    const media = query();
    if (!media) {
      return undefined;
    }
    const onChange = (event) => setSystemDark(event.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  useEffect(() => apply(resolvedTheme), [resolvedTheme]);

  const setTheme = useCallback((next) => {
    try {
      if (next === "system") {
        window.localStorage.removeItem(STORAGE_KEY);
      } else {
        window.localStorage.setItem(STORAGE_KEY, next);
      }
    } catch {
      // Best-effort persistence.
    }
    setThemeState(next);
  }, []);

  const value = useMemo(() => ({ theme, resolvedTheme, setTheme }), [theme, resolvedTheme, setTheme]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  return useContext(ThemeContext);
}
