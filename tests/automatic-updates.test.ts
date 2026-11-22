/** Actual shell functions with fake Electron/updater/filesystem. No app,
 * profile, network, timer or updater download/install operation is run. */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createContext, runInContext } from "node:vm";
import { describe, it } from "node:test";

const mainFile = fileURLToPath(new URL("../electron/main.cjs", import.meta.url));
const mainSource = readFileSync(mainFile, "utf8");
const mainRequire = createRequire(mainFile);

function fixture({ packaged = true, updaterMissing = false, env = {} }: { packaged?: boolean; updaterMissing?: boolean; env?: Record<string, string> } = {}) {
	let settings: string | Error = JSON.stringify({ version: 1, general: { autoUpdate: true } });
	const settingsReads: string[] = [];
	const order: string[] = [];
	const intervals: { callback: () => void; delay: number }[] = [];
	const handles = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
	const ons = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
	const windows: FakeWindow[] = [];
	let enumerationFails = false;
	let userData = "/fixture/custom-user-data";
	let menu: { submenu?: { label?: string; click?: () => void }[] }[] = [];
	class FakeUpdater extends EventEmitter {
		checks = 0;
		autoDownload = false;
		autoInstallOnAppQuit = false;
		result: object | null = { updateInfo: { version: "0.3.7" } };
		failure: Error | null = null;
		checkForUpdates() {
			this.checks++;
			this.emit("checking-for-update");
			if (this.failure) return Promise.reject(this.failure);
			if (this.result) this.emit("update-not-available", { version: "0.3.7" });
			return Promise.resolve(this.result);
		}
		quitAndInstall() { order.push("install"); }
	}
	const updater = new FakeUpdater();
	class FakeWebContents extends EventEmitter {
		mainFrame = { url: "http://127.0.0.1:9000/" };
		messages: { channel: string; value: unknown }[] = [];
		loading = false;
		fails = false;
		send(channel: string, value: unknown) {
			if (this.fails) throw new Error("window destroyed");
			this.messages.push({ channel, value: JSON.parse(JSON.stringify(value)) });
		}
		isLoadingMainFrame() { return this.loading; }
		setWindowOpenHandler() {}
		getZoomFactor() { return 1; }
	}
	class FakeWindow extends EventEmitter {
		webContents = new FakeWebContents();
		minimized = false;
		focused = false;
		bounds = { x: 0, y: 0, width: 700, height: 700 };
		constructor() { super(); windows.push(this); }
		loadURL() { this.webContents.loading = true; }
		isDestroyed() { return false; }
		isMinimized() { return this.minimized; }
		restore() { this.minimized = false; }
		focus() { this.focused = true; }
		show() {}
		getBounds() { return this.bounds; }
		setBounds(next: { x: number; y: number; width: number; height: number }) { this.bounds = next; }
		static getAllWindows() {
			if (enumerationFails) throw new Error("window enumeration failed");
			return windows;
		}
		static fromWebContents(contents: FakeWebContents) { return windows.find(win => win.webContents === contents); }
	}
	const app = Object.assign(new EventEmitter(), {
		isPackaged: packaged,
		name: "LearnHarness",
		setName() {},
		getPath: () => userData,
		setPath: (_: string, value: string) => { userData = value; },
		requestSingleInstanceLock: () => false,
		quit() {},
		whenReady: async () => {},
	});
	const electron = {
		app, BrowserWindow: FakeWindow,
		Menu: { buildFromTemplate: (value: typeof menu) => value, setApplicationMenu: (value: typeof menu) => { menu = value; } },
		ipcMain: {
			on: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => ons.set(channel, fn),
			handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => handles.set(channel, fn),
		},
		nativeTheme: { shouldUseDarkColors: true, themeSource: "system", on() {} },
		session: { defaultSession: { setPermissionRequestHandler() {}, setPermissionCheckHandler() {} } },
	};
	const context = createContext({
		require: (id: string) => {
			if (id === "electron") return electron;
			if (id === "./dev-server-readiness.cjs") return { waitForDevServer: async () => {} };
			if (id === "electron-updater") {
				if (updaterMissing) throw new Error("missing updater");
				return { autoUpdater: updater };
			}
			if (id === "node:fs") return {
				readFileSync: (file: string) => {
					settingsReads.push(file);
					if (settings instanceof Error) throw settings;
					return settings;
				}, mkdirSync() {}, appendFileSync() {},
			};
			return mainRequire(id);
		},
		process: { argv: [], env: { LH_DEV_URL: "http://127.0.0.1:9000", ...env }, platform: "darwin", on() {} },
		__dirname: path.dirname(mainFile), URL, AbortController,
		setInterval: (callback: () => void, delay: number) => intervals.push({ callback, delay }),
		setTimeout() {},
		fixtureChild: { kill: (signal: string) => order.push(signal) },
	});
	runInContext(mainSource, context, { filename: mainFile });
	const run = (code: string) => runInContext(code, context);
	return {
		run, updater, windows, intervals, handles, ons, settingsReads, order, app,
		setSettings: (value: unknown) => { settings = JSON.stringify(value); },
		setSettingsFailure: (value: string | Error) => { settings = value; },
		setEnumerationFailure: (value: boolean) => { enumerationFails = value; },
		window: () => new FakeWindow(),
		state: () => JSON.parse(JSON.stringify(run("updateState"))),
		check: async (manual = false) => { run(`checkForUpdates({ manual: ${manual} })`); await Promise.resolve(); await Promise.resolve(); },
		menuCheck: () => menu[0]!.submenu!.find(item => item.label === "Check for Updates…")!.click!(),
	};
}

describe("hardened disabled auto-updater gate", () => {
	it("disables automatic updates unconditionally regardless of settings, manual checks, or LH_UPDATE_FEED", async () => {
		for (const setting of [
			{ general: { autoUpdate: true } },
			{ general: { autoUpdate: false } },
			{ general: {} },
			null,
		]) {
			const f = fixture({ env: { LH_UPDATE_FEED: "https://evil.example/feed" } });
			f.setSettings(setting);
			f.run("setupAutoUpdater()");
			assert.equal(f.state().status, "disabled");
			await f.check(false);
			await f.check(true);
			assert.equal(f.updater.checks, 0);
			assert.equal(f.updater.autoDownload, false);
			assert.equal(f.updater.autoInstallOnAppQuit, false);
			assert.equal(f.settingsReads.length, 0);
		}
	});

	it("installUpdateNow is a no-op when updater is disabled and never kills server or installs", () => {
		const f = fixture();
		f.run("setupAutoUpdater(); serverProcess = fixtureChild; installUpdateNow()");
		assert.deepEqual(f.order, []);
	});
});

describe("startup, menu wiring, and trusted IPC window guards", () => {
	it("never starts a background update interval and keeps update checks disabled", async () => {
		const f = fixture();
		await f.run("main()");
		assert.equal(f.updater.checks, 0);
		assert.equal(f.intervals.length, 0);
		assert.equal(f.state().status, "disabled");
	});

	it("menu restores/focuses a minimized window and opens General while updater stays disabled", async () => {
		const f = fixture();
		await f.run("main()");
		const win = f.windows[0]!;
		win.webContents.loading = false;
		win.minimized = true;
		f.menuCheck();
		assert.equal(win.minimized, false);
		assert.equal(win.focused, true);
		assert.ok(win.webContents.messages.some(message => message.channel === "lh:open-settings" && message.value === "general"));
		assert.equal(f.updater.checks, 0);
	});

	it("IPC handlers enforce both trustedAppWindows membership and trustedSender origin", async () => {
		const f = fixture();
		await f.run("main()");
		const appWin = f.windows[0]!;
		const sender = appWin.webContents;
		const validEvent = { sender, senderFrame: sender.mainFrame };
		const untrustedWin = f.window(); // not registered via createWindow -> not in trustedAppWindows
		const untrustedEvent = { sender: untrustedWin.webContents, senderFrame: untrustedWin.webContents.mainFrame };

		const getUpdate = f.handles.get("lh:update:get")!;
		const checkUpdate = f.handles.get("lh:update:check")!;
		const getZoom = f.handles.get("lh:zoom:get")!;
		const updateInstall = f.ons.get("lh:update-install")!;
		const expandWindow = f.ons.get("lh:expand-window")!;

		assert.equal((getUpdate(validEvent) as { status: string }).status, "disabled");
		assert.equal(getZoom(validEvent), 1);
		checkUpdate(validEvent);
		assert.equal(f.updater.checks, 0);

		const beforeWidth = appWin.bounds.width;
		assert.ok(beforeWidth < 928);
		// Untrusted sender does not expand window
		expandWindow({ sender, senderFrame: { url: sender.mainFrame.url } });
		assert.equal(appWin.bounds.width, beforeWidth);
		expandWindow(untrustedEvent);
		assert.equal(untrustedWin.bounds.width, 700);
		// Trusted sender expands window to SIDEBAR_AUTOCLOSE
		expandWindow(validEvent);
		assert.equal(appWin.bounds.width, 928);

		f.run("serverProcess = fixtureChild");
		updateInstall(untrustedEvent);
		updateInstall(validEvent);
		assert.deepEqual(f.order, []);

		for (const bad of [
			untrustedEvent,
			{ sender: {}, senderFrame: sender.mainFrame },
			{ sender, senderFrame: { url: sender.mainFrame.url } },
			{ sender, senderFrame: { url: "https://untrusted.invalid/" } },
		]) {
			assert.throws(() => getUpdate(bad), /Untrusted/);
			assert.throws(() => checkUpdate(bad), /Untrusted/);
			assert.throws(() => getZoom(bad), /Untrusted/);
		}
		sender.mainFrame.url = "https://untrusted.invalid/";
		assert.throws(() => checkUpdate(validEvent), /Untrusted/);
	});

	it("startup-message IPC stays a safe no-op without loading startup-messages.cjs", async () => {
		const f = fixture({ packaged: true });
		await f.run("main()");
		const appWin = f.windows[0]!;
		const sender = appWin.webContents;
		const validEvent = { sender, senderFrame: sender.mainFrame };
		const take = f.handles.get("lh:startup-message:take")!;
		const dismiss = f.handles.get("lh:startup-message:dismiss")!;
		assert.equal(take(validEvent), null);
		assert.equal(dismiss(validEvent, "msg-1"), false);
		assert.equal(take({ sender: {}, senderFrame: sender.mainFrame }), null);
		assert.equal(dismiss({ sender: {}, senderFrame: sender.mainFrame }, "msg-1"), false);
	});

	it("menu navigation failure does not throw or trigger update checks", async () => {
		const f = fixture();
		await f.run("main()");
		f.windows[0]!.webContents.fails = true;
		f.windows[0]!.webContents.loading = false;
		f.menuCheck();
		assert.equal(f.updater.checks, 0);
	});
});
