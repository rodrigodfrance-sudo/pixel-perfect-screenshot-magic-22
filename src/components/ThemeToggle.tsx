import { Sun, Moon, Monitor } from "lucide-react";
import { useTheme, type Theme } from "@/hooks/use-theme";

interface ThemeToggleProps {
  className?: string;
  showLabels?: boolean;
}

const THEME_OPTIONS: Array<{
  value: Theme;
  label: string;
  icon: typeof Sun;
  activeColor: string;
}> = [
  {
    value: "light",
    label: "Claro",
    icon: Sun,
    activeColor: "text-amber-500",
  },
  {
    value: "dark",
    label: "Escuro",
    icon: Moon,
    activeColor: "text-blue-400",
  },
  {
    value: "system",
    label: "Sistema",
    icon: Monitor,
    activeColor: "text-primary",
  },
];

export function ThemeToggle({ className, showLabels = true }: ThemeToggleProps) {
  const { theme, setTheme } = useTheme();

  return (
    <div
      role="radiogroup"
      aria-label="Escolher tema visual (claro, escuro ou sistema)"
      className={`inline-flex items-center rounded-md border border-border bg-muted/60 p-0.5 text-xs font-sans backdrop-blur-xs ${className ?? ""}`}
    >
      {THEME_OPTIONS.map((opt) => {
        const Icon = opt.icon;
        const isSelected = theme === opt.value;

        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={isSelected}
            aria-label={`Ativar modo ${opt.label.toLowerCase()}`}
            title={`Ativar modo ${opt.label.toLowerCase()}`}
            onClick={() => setTheme(opt.value)}
            className={`group inline-flex items-center gap-1.5 rounded-[calc(var(--radius)-2px)] px-2.5 py-1 font-medium transition-all duration-150 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring ${
              isSelected
                ? "bg-background text-foreground shadow-xs"
                : "text-muted-foreground hover:bg-background/40 hover:text-foreground"
            }`}
          >
            <Icon
              className={`h-3.5 w-3.5 transition-transform duration-150 ${
                isSelected
                  ? `${opt.activeColor} scale-110`
                  : "text-muted-foreground/80 group-hover:scale-105"
              }`}
            />
            {showLabels && <span className="hidden sm:inline font-sans text-xs">{opt.label}</span>}
          </button>
        );
      })}
    </div>
  );
}
