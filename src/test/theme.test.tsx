import { describe, expect, it, beforeEach } from "vitest";
import { renderHook, act, render, screen, fireEvent } from "@testing-library/react";
import { useTheme } from "@/hooks/use-theme";
import { ThemeToggle } from "@/components/ThemeToggle";

describe("useTheme", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.className = "";
  });

  it("defaults to dark theme when no preference stored", () => {
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe("dark");
    expect(result.current.resolvedTheme).toBe("dark");
    expect(result.current.isDark).toBe(true);
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  it("can switch to light mode and remove .dark class", () => {
    const { result } = renderHook(() => useTheme());

    act(() => {
      result.current.setTheme("light");
    });

    expect(result.current.theme).toBe("light");
    expect(result.current.resolvedTheme).toBe("light");
    expect(result.current.isDark).toBe(false);
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(localStorage.getItem("theme")).toBe("light");
  });

  it("toggleTheme switches between dark and light", () => {
    const { result } = renderHook(() => useTheme());

    act(() => {
      result.current.toggleTheme();
    });

    expect(result.current.theme).toBe("light");
    expect(result.current.isDark).toBe(false);

    act(() => {
      result.current.toggleTheme();
    });

    expect(result.current.theme).toBe("dark");
    expect(result.current.isDark).toBe(true);
  });

  it("renders ThemeToggle with Claro, Escuro, and Sistema options and allows clicking Claro", () => {
    render(<ThemeToggle />);

    const claroBtn = screen.getByRole("radio", { name: /ativar modo claro/i });
    const escuroBtn = screen.getByRole("radio", { name: /ativar modo escuro/i });
    const sistemaBtn = screen.getByRole("radio", { name: /ativar modo sistema/i });

    expect(claroBtn).toBeInTheDocument();
    expect(escuroBtn).toBeInTheDocument();
    expect(sistemaBtn).toBeInTheDocument();

    // Initial default is dark
    expect(escuroBtn).toHaveAttribute("aria-checked", "true");
    expect(claroBtn).toHaveAttribute("aria-checked", "false");

    // Click Claro
    fireEvent.click(claroBtn);

    expect(claroBtn).toHaveAttribute("aria-checked", "true");
    expect(escuroBtn).toHaveAttribute("aria-checked", "false");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(localStorage.getItem("theme")).toBe("light");

    // Click Escuro back
    fireEvent.click(escuroBtn);
    expect(escuroBtn).toHaveAttribute("aria-checked", "true");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(localStorage.getItem("theme")).toBe("dark");
  });
});
