/**
 * start-standalone.mjs — run Next.js's standalone server safely in web mode.
 *
 * Avoids the `next start` warning under `output: "standalone"` while keeping
 * loopback-only binding (`HOSTNAME=localhost` by default, never `0.0.0.0`)
 * and pinning `LH_DATA_DIR` / `LH_AUTH_FILE` to the repository root (since
 * standalone `server.js` chdirs into `.next/standalone`).
 */
import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..");

const REQUIRED_CURATED_ASSETS = [
	path.join(".next", "static"),
	"core-plugins",
	path.join("scripts", "plugin-loader.cjs"),
	path.join("public", "plugin-loader.js"),
];

/**
 * @param {Record<string, string | undefined>} [env]
 * @param {string} [root]
 */
export function resolveStandaloneLaunch(env = process.env, root = ROOT) {
	const standalone = path.join(root, ".next", "standalone");
	const hostname = env.HOSTNAME?.trim() || "localhost";
	const port = env.PORT?.trim() || "3000";
	const dataDir = env.LH_DATA_DIR?.trim() ? path.resolve(env.LH_DATA_DIR.trim()) : path.join(root, "data");
	const authFile = env.LH_AUTH_FILE?.trim() ? path.resolve(env.LH_AUTH_FILE.trim()) : path.join(root, "auth.json");
	return {
		standalone,
		server: path.join(standalone, "server.js"),
		env: {
			...env,
			NODE_ENV: "production",
			HOSTNAME: hostname,
			PORT: port,
			LH_DATA_DIR: dataDir,
			LH_AUTH_FILE: authFile,
		},
	};
}

/** @param {string} standalone */
export function missingCuratedAssets(standalone) {
	return REQUIRED_CURATED_ASSETS.filter((rel) => !fs.existsSync(path.join(standalone, rel)));
}

function main() {
	const launch = resolveStandaloneLaunch(process.env, ROOT);
	if (!fs.existsSync(launch.server)) {
		console.error('[start-standalone] .next/standalone/server.js missing — run "npm run build" first.');
		process.exit(1);
	}
	if (missingCuratedAssets(launch.standalone).length > 0) {
		execFileSync(process.execPath, [path.join(ROOT, "scripts", "build-server.mjs")], {
			cwd: ROOT,
			stdio: "inherit",
		});
	}
	const child = spawn(process.execPath, [launch.server], {
		cwd: launch.standalone,
		env: launch.env,
		stdio: "inherit",
	});
	const forward = (signal) => {
		try {
			child.kill(signal);
		} catch {
			/* child already exited */
		}
	};
	process.on("SIGINT", () => forward("SIGINT"));
	process.on("SIGTERM", () => forward("SIGTERM"));
	child.on("exit", (code, signal) => {
		if (signal) process.exit(1);
		process.exit(code ?? 0);
	});
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main();
}
