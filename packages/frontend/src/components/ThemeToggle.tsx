import { useTheme } from "../context/ThemeContext";

interface ThemeToggleProps {
  className?: string;
  compact?: boolean;
}

export default function ThemeToggle({ className = "", compact = false }: ThemeToggleProps) {
  const { theme, toggleTheme } = useTheme();
  const nextThemeLabel = theme === "dark" ? "Switch to light mode" : "Switch to dark mode";

  return (
    <button
      type="button"
      onClick={toggleTheme}
      className={`theme-toggle ${compact ? "theme-toggle-compact" : ""} ${className}`.trim()}
      aria-label={nextThemeLabel}
      title={nextThemeLabel}
    >
      <span className="theme-toggle-icon" aria-hidden>
        {theme === "dark" ? (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
            <circle cx="12" cy="12" r="4.4" />
            <path d="M12 2.6v2.2M12 19.2v2.2M21.4 12h-2.2M4.8 12H2.6M18.9 18.9l-1.6-1.6M6.7 6.7L5.1 5.1M18.9 5.1l-1.6 1.6M6.7 17.3l-1.6 1.6" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
            <path d="M21 14.9A8.9 8.9 0 1 1 12.1 6a7.2 7.2 0 0 0 8.9 8.9Z" />
          </svg>
        )}
      </span>
      {!compact && <span className="theme-toggle-label">{theme === "dark" ? "Light" : "Dark"} mode</span>}
    </button>
  );
}
