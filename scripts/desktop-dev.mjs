/** Cross-platform desktop development launcher (macOS, Windows, Linux).
 *  Replaces Unix-only inline `LH_DEV_URL=... electron .` env syntax. */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const electronBinary = require("electron");
if (typeof electronBinary !== "string" || !electronBinary) {
	throw new Error("Could not resolve local electron binary");
}

const npmExecPath = process.env.npm_execpath;
const devProc = npmExecPath
	? spawn(process.execPath, [npmExecPath, "run", "dev"], { stdio: "inherit" })
	: spawn(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "dev"], {
		stdio: "inherit",
		shell: process.platform === "win32",
	});

const electronProc = spawn(electronBinary, ["."], {
	stdio: "inherit",
	env: { ...process.env, LH_DEV_URL: "http://localhost:3000" },
});

let shuttingDown = false;
function shutdown(code = 0) {
	if (shuttingDown) return;
	shuttingDown = true;
	for (const child of [devProc, electronProc]) {
		if (child.exitCode === null && child.signalCode === null) {
			try { child.kill(); } catch { /* already exited */ }
		}
	}
	process.exitCode = code;
}

devProc.once("exit", (code) => shutdown(code ?? 0));
electronProc.once("exit", (code) => shutdown(code ?? 0));
for (const signal of ["SIGINT", "SIGTERM"]) {
	process.on(signal, () => shutdown(0));
}
