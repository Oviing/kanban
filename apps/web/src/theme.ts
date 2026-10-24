import { useEffect, useState } from "react";

export type Theme = "system" | "light" | "dark";
const KEY = "kb_theme";
export const getTheme = (): Theme => { try { const v = localStorage.getItem(KEY); if (v === "light" || v === "dark") return v; } catch {} return "system"; };
export function applyTheme(t: Theme) {
  if (t === "system") delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = t;
  try { t === "system" ? localStorage.removeItem(KEY) : localStorage.setItem(KEY, t); } catch {}
}
export const NEXT_THEME: Record<Theme, Theme> = { system: "light", light: "dark", dark: "system" };

export function useTheme() {
  const [theme, set] = useState<Theme>(getTheme);
  useEffect(() => applyTheme(theme), [theme]);
  return [theme, set] as const;
}
