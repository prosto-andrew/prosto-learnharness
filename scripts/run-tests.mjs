/** Cross-platform test launcher (macOS, Windows, Linux).
 *  Replaces Unix-only `NODE_ENV=test` shell prefix and shell-expanded globs. */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tsxCli = path.join(root, "node_modules", "tsx", "dist", "cli.mjs");
const userArgs = process.argv.slice(2);

const hasFileArg = userArgs.some((arg) => !arg.startsWith("-"));
const hasConcurrency = userArgs.some((arg) => arg.startsWith("--test-concurrency"));
const hasTimeout = userArgs.some((arg) => arg.startsWith("--test-timeout"));

const defaultFiles = hasFileArg
	? []
	: fs
		.readdirSync(path.join(root, "tests"))
		.filter((name) => /\.test\.tsx?$/.test(name))
		.sort()
		.map((name) => path.join("tests", name));

const args = [
	tsxCli,
	"--test",
	...(hasConcurrency ? [] : ["--test-concurrency=4"]),
	...(hasTimeout ? [] : ["--test-timeout=60000"]),
	...userArgs,
	...defaultFiles,
];

const result = spawnSync(process.execPath, args, {
	cwd: root,
	stdio: "inherit",
	env: { ...process.env, NODE_ENV: "test" },
});

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
