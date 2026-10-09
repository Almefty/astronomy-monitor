import { load, save } from "./storage";

export type ThemeChoice = "auto" | "light" | "dark";

const media = window.matchMedia("(prefers-color-scheme: dark)");

export function currentChoice(): ThemeChoice {
  return load<ThemeChoice>("theme") ?? "auto";
}

export function effectiveTheme(): "light" | "dark" {
  const c = currentChoice();
  return c === "auto" ? (media.matches ? "dark" : "light") : c;
}

function emit() {
  window.dispatchEvent(new CustomEvent("themechange", { detail: effectiveTheme() }));
}

export function applyTheme(choice: ThemeChoice) {
  if (choice === "auto") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = choice;
  save("theme", choice);
  emit();
}

export function initTheme() {
  const c = currentChoice();
  if (c !== "auto") document.documentElement.dataset.theme = c;
  media.addEventListener("change", () => {
    if (currentChoice() === "auto") emit();
  });
}

/** Read a CSS custom property (used by canvas charts, which can't use var()). */
export function cssVar(name: string, el: Element = document.documentElement): string {
  return getComputedStyle(el).getPropertyValue(name).trim();
}
