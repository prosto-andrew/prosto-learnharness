export const DEFAULT_ALLOWED_PROGRAMS = [
  "python3",
  "python",
  "node",
  "bun",
  "deno",
  "go",
  "rustc",
  "cargo",
  "gcc",
  "g++",
  "clang",
  "clang++",
  "java",
  "javac",
  "ruby",
  "php",
  "swift",
  "dotnet",
] as const;

export const BLOCKED_SHELL_PROGRAMS = new Set([
  "sh",
  "bash",
  "zsh",
  "dash",
  "fish",
  "ksh",
  "csh",
  "tcsh",
  "ash",
  "cmd",
  "powershell",
  "pwsh",
  "wscript",
  "cscript",
  "mshta",
  "env",
]);

function normalizeBareName(raw: string): { ok: true; bare: string; base: string } | { ok: false; reason: string } {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { ok: false, reason: "Test program must not be empty." };
  }
  if (/[\s/\\:\0]/.test(trimmed) || trimmed.includes("..")) {
    return {
      ok: false,
      reason: "Test program must be a plain executable name without paths, whitespace, or drive specifiers.",
    };
  }
  const lower = trimmed.toLowerCase();
  const base = lower.endsWith(".exe") ? lower.slice(0, -4) : lower;
  if (!base || BLOCKED_SHELL_PROGRAMS.has(base)) {
    return { ok: false, reason: `Shell or wrapper executable "${trimmed}" is blocked.` };
  }
  return { ok: true, bare: trimmed, base };
}

/** Safe bare check usable in UI without server env knowledge. */
export function isSafeBareExecutable(raw: string): boolean {
  return normalizeBareName(raw).ok;
}

/** Enforce bare allowlisted interpreter/compiler names without shells or paths. */
export function validateTestProgram(
  program: string,
  extraAllowedCsv?: string,
): { ok: true; program: string } | { ok: false; reason: string } {
  const normalized = normalizeBareName(program);
  if (!normalized.ok) return normalized;

  const allowed = new Set<string>(DEFAULT_ALLOWED_PROGRAMS.map((name) => name.toLowerCase()));
  if (typeof extraAllowedCsv === "string" && extraAllowedCsv.trim()) {
    for (const entry of extraAllowedCsv.split(",")) {
      const extra = normalizeBareName(entry);
      if (extra.ok) allowed.add(extra.base);
    }
  }
  if (!allowed.has(normalized.base)) {
    return {
      ok: false,
      reason: `Test program "${normalized.bare}" is not in the allowlist (${DEFAULT_ALLOWED_PROGRAMS.join(", ")}; extend via LH_CODING_ALLOWED_PROGRAMS).`,
    };
  }
  return { ok: true, program: normalized.bare };
}
