/** Shared provenance only: no credential-store reads in the agent layer. */
interface AuthBoot {
	/** Names owned by the original launch environment. */
	realEnv: Set<string>;
	/** Names reflected into process.env by LearnHarness's key store. */
	fillGap: Set<string>;
}
const BOOT_KEY = Symbol.for("lh.authBoot");

export function authEnvRecord(): AuthBoot {
	const g = globalThis as Record<symbol, AuthBoot | undefined>;
	if (!g[BOOT_KEY]) g[BOOT_KEY] = { realEnv: new Set(), fillGap: new Set() };
	return g[BOOT_KEY];
}

const INTERNAL_LEARN_HARNESS_ENV = [
	"LH_DESKTOP_API_SECRET",
	"LH_DESKTOP_SERVER",
	"LH_AUTH_FILE",
	"LH_DATA_DIR",
	"LH_DEV_URL",
	"ELECTRON_RUN_AS_NODE",
] as const;

/** External CLIs own their authentication. Never pass LearnHarness-only injections. */
export function externalCliEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const result = { ...env };
	const { realEnv, fillGap } = authEnvRecord();
	for (const name of fillGap) {
		if (!realEnv.has(name)) delete result[name];
	}
	// Strip internal LearnHarness runtime secrets/config (including desktop API
	// capability vars) so external CLIs never inherit them.
	for (const name of INTERNAL_LEARN_HARNESS_ENV) {
		delete result[name];
	}
	return result;
}
