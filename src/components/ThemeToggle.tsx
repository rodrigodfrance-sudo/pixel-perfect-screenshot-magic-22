import { Sun, Moon, Monitor, Check } from "lucide-react";
import { useTheme } from "@/hooks/use-theme";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

interface ThemeToggleProps {
  className?: string;
}

export function ThemeToggle({ className }: ThemeToggleProps) {
  const { theme, resolvedTheme, setTheme, isDark } = useTheme();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Alternar tema de cor (claro, escuro ou sistema)"
          className={`group inline-flex items-center gap-1.5 rounded border border-border bg-card/60 px-2.5 py-1 text-xs font-medium text-foreground transition-all hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring ${className ?? ""}`}
        >
          {isDark ? (
            <Moon className="h-3.5 w-3.5 text-primary transition-transform group-hover:-rotate-12" />
          ) : (
            <Sun className="h-3.5 w-3.5 text-primary transition-transform group-hover:rotate-45" />
          )}
          <span className="font-sans text-xs">
            {theme === "system" ? "Sistema" : isDark ? "Modo escuro" : "Modo claro"}
          </span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-36 text-xs font-sans">
        <DropdownMenuItem
          onClick={() => setTheme("light")}
          className="flex cursor-pointer items-center gap-2 py-1.5 text-xs"
        >
          <Sun className="h-3.5 w-3.5 text-amber-500" />
          <span>Modo claro</span>
          {theme === "light" && <Check className="ml-auto h-3.5 w-3.5 text-primary" />}
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => setTheme("dark")}
          className="flex cursor-pointer items-center gap-2 py-1.5 text-xs"
        >
          <Moon className="h-3.5 w-3.5 text-blue-400" />
          <span>Modo escuro</span>
          {theme === "dark" && <Check className="ml-auto h-3.5 w-3.5 text-primary" />}
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => setTheme("system")}
          className="flex cursor-pointer items-center gap-2 py-1.5 text-xs"
        >
          <Monitor className="h-3.5 w-3.5 text-muted-foreground" />
          <span>Sistema</span>
          {theme === "system" && <Check className="ml-auto h-3.5 w-3.5 text-primary" />}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
