import { useEffect, useState } from "react";

export type Theme = "light" | "dark" | "system";

const THEME_KEY = "theme";

export function useTheme() {
  const [theme, setThemeState] = useState<Theme>(() => {
    if (typeof window === "undefined") return "dark";
    const saved = localStorage.getItem(THEME_KEY) as Theme | null;
    return saved === "light" || saved === "dark" || saved === "system" ? saved : "dark";
  });

  const [resolvedTheme, setResolvedTheme] = useState<"light" | "dark">(() => {
    if (typeof window === "undefined") return "dark";
    const saved = localStorage.getItem(THEME_KEY) as Theme | null;
    if (saved === "light") return "light";
    if (saved === "system") {
      return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    }
    return "dark";
  });

  useEffect(() => {
    const root = document.documentElement;
    const media = window.matchMedia("(prefers-color-scheme: dark)");

    const applyTheme = (t: Theme) => {
      let isDark = false;
      if (t === "system") {
        isDark = media.matches;
      } else {
        isDark = t === "dark";
      }

      setResolvedTheme(isDark ? "dark" : "light");

      if (isDark) {
        root.classList.add("dark");
      } else {
        root.classList.remove("dark");
      }
    };

    applyTheme(theme);

    const onMediaChange = () => {
      if (theme === "system") {
        applyTheme("system");
      }
    };

    const onStorageChange = (e: StorageEvent) => {
      if (e.key === THEME_KEY) {
        const newTheme = (e.newValue as Theme) || "dark";
        setThemeState(newTheme);
      }
    };

    media.addEventListener("change", onMediaChange);
    window.addEventListener("storage", onStorageChange);

    return () => {
      media.removeEventListener("change", onMediaChange);
      window.removeEventListener("storage", onStorageChange);
    };
  }, [theme]);

  const setTheme = (newTheme: Theme) => {
    setThemeState(newTheme);
    try {
      localStorage.setItem(THEME_KEY, newTheme);
    } catch {
      // storage unavailable or full
    }
  };

  const toggleTheme = () => {
    const next = resolvedTheme === "dark" ? "light" : "dark";
    setTheme(next);
  };

  return {
    theme,
    resolvedTheme,
    setTheme,
    toggleTheme,
    isDark: resolvedTheme === "dark",
  };
}
