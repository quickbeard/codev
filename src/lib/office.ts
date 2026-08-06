import { spawn } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readdirSync,
	renameSync,
	rmSync,
} from "node:fs";
import { join } from "node:path";
import { OFFICE_DOWNLOADS_URL } from "@/lib/const.js";
import { downloadFile } from "@/lib/download.js";
import { logInfo } from "@/lib/log.js";
import { legacyOfficeDownloadsDir, officeDownloadsDir } from "@/lib/paths.js";

// `codevhub skill office`: fetch the CoDev Office offline bundle (published by
// the codev-storage MinIO backend) for this OS and run the bundled setup
// script, which installs the Office skills (DOCX, XLSX, PPTX and PDF) into the
// global ~/.claude/skills dir (read by Claude Code and CoDev Code). codevhub
// passes no skills-root — the destination is the setup script's own default,
// which also detects the signed-in user under a different-account Windows
// elevation, so codevhub must not pin a path that would defeat that.
// File names are deterministic per platform — no manifest fetch — and each
// bundle carries its own SHA256SUMS.txt that the setup flow can verify.
// Non-interactive on purpose — the second half hands the terminal to an
// installer that prompts for sudo/UAC, which an Ink render would fight over.

export const OFFICE_USAGE =
	"Usage: codevhub skill office [--platform ubuntu|macos|windows] [--dir <path>] [--download-only] [--skip-verify] [--force-skills]";

export type OfficePlatform = "ubuntu" | "macos" | "windows";

const OFFICE_PLATFORMS: OfficePlatform[] = ["ubuntu", "macos", "windows"];

export function detectPlatform(
	p: NodeJS.Platform = process.platform,
): OfficePlatform | null {
	if (p === "linux") return "ubuntu";
	if (p === "darwin") return "macos";
	if (p === "win32") return "windows";
	return null;
}

export interface OfficeArgs {
	platform?: OfficePlatform;
	dir?: string;
	downloadOnly: boolean;
	skipVerify: boolean;
	forceSkills: boolean;
	// Deliberately unadvertised (absent from OFFICE_USAGE and `codevhub help`):
	// fetches and runs the published uninstall script instead of the installer.
	uninstall: boolean;
	// Uninstall-only passthroughs, equally unadvertised.
	yes: boolean;
	skillsOnly: boolean;
	purgeDownloads: boolean;
	error?: string;
}

export function parseOfficeArgs(argv: string[]): OfficeArgs {
	const parsed: OfficeArgs = {
		downloadOnly: false,
		skipVerify: false,
		forceSkills: false,
		uninstall: false,
		yes: false,
		skillsOnly: false,
		purgeDownloads: false,
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === undefined) continue;
		const eq = arg.indexOf("=");
		const name = eq === -1 ? arg : arg.slice(0, eq);
		const inlineValue = eq === -1 ? undefined : arg.slice(eq + 1);
		const takeValue = (): string | undefined => {
			if (inlineValue !== undefined) return inlineValue;
			const next = argv[++i];
			return next;
		};
		switch (name) {
			case "--platform": {
				const value = takeValue();
				if (!value || !OFFICE_PLATFORMS.includes(value as OfficePlatform)) {
					parsed.error = `--platform must be one of: ${OFFICE_PLATFORMS.join(", ")}`;
					return parsed;
				}
				parsed.platform = value as OfficePlatform;
				break;
			}
			case "--dir": {
				const value = takeValue();
				if (!value) {
					parsed.error = "--dir requires a path";
					return parsed;
				}
				parsed.dir = value;
				break;
			}
			case "--download-only":
				parsed.downloadOnly = true;
				break;
			case "--skip-verify":
				parsed.skipVerify = true;
				break;
			case "--force-skills":
				parsed.forceSkills = true;
				break;
			case "--uninstall":
				parsed.uninstall = true;
				break;
			case "--yes":
				parsed.yes = true;
				break;
			case "--skills-only":
				parsed.skillsOnly = true;
				break;
			case "--purge-downloads":
				parsed.purgeDownloads = true;
				break;
			default:
				parsed.error = `unknown option: ${arg}`;
				return parsed;
		}
	}
	// The two modes take disjoint flag sets — reject mixtures loudly rather
	// than silently forwarding a flag the target script would choke on.
	if (parsed.uninstall) {
		if (parsed.skipVerify || parsed.forceSkills) {
			parsed.error =
				"--skip-verify/--force-skills do not apply with --uninstall";
		}
	} else if (parsed.yes || parsed.skillsOnly || parsed.purgeDownloads) {
		parsed.error = "--yes/--skills-only/--purge-downloads require --uninstall";
	}
	return parsed;
}

// Bundle and script names are a naming contract with the codev-scripts repo
// (codev-office/*) — deterministic per platform, so no manifest round-trip is
// needed before downloading.
export function officeBundleName(platform: OfficePlatform): string {
	return `codev-office-${platform}.zip`;
}

export function officeScriptName(platform: OfficePlatform): string {
	return platform === "windows"
		? "codev-office-windows-setup.ps1"
		: `codev-office-${platform}-setup.sh`;
}

export function officeUninstallScriptName(platform: OfficePlatform): string {
	return platform === "windows"
		? "codev-office-windows-uninstall.ps1"
		: `codev-office-${platform}-uninstall.sh`;
}

// Rough bundle sizes for the pre-download heads-up only; progress totals come
// from the server's content-length.
const APPROX_BUNDLE_MB: Record<OfficePlatform, number> = {
	ubuntu: 1200,
	windows: 1400,
	macos: 3100,
};

// Adaptive size for progress lines: the setup script is ~13 KB and rendered
// "0.0/0.0 MB (100%)" under a fixed-MB format. Exported for tests.
export function formatSize(bytes: number): string {
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Single rewriting progress line on a TTY; on pipes/CI, a line roughly every
// 5% so logs stay readable.
function makeProgressPrinter(name: string): {
	print: (received: number, total: number | null) => void;
	done: () => void;
} {
	const tty = process.stderr.isTTY === true;
	let lastPercent = -5;
	return {
		print(received, total) {
			// `0` as well as `null`: a zero total is either an unknown length or an
			// empty body, and dividing by it renders NaN%/Infinity%.
			if (total === null || total === 0) {
				if (tty) process.stderr.write(`\r${name}  ${formatSize(received)}`);
				return;
			}
			const percent = Math.floor((received / total) * 100);
			const line = `${name}  ${formatSize(received)}/${formatSize(total)} (${percent}%)`;
			if (tty) {
				process.stderr.write(`\r${line}`);
			} else if (percent >= lastPercent + 5) {
				lastPercent = percent;
				console.error(line);
			}
		},
		done() {
			if (tty) process.stderr.write("\n");
		},
	};
}

function manualRunCommand(platform: OfficePlatform, script: string): string {
	return platform === "windows"
		? `powershell -ExecutionPolicy Bypass -File .\\${script}`
		: `bash ${script}`;
}

// The exact command the user types in an ELEVATED PowerShell — after field
// testing every alternative launcher, this is the only launch mode the
// endpoint protection tolerates: anything codevhub starts (directly or via a
// staged launcher) gets killed or quarantined, while the same command typed
// interactively runs to "Verification passed". Exported for tests.
export function officeManualWindowsCommand(
	script: string,
	args: string[],
): string {
	const argStr = args.map((a) => ` ${/\s/.test(a) ? `"${a}"` : a}`).join("");
	return `powershell -ExecutionPolicy Bypass -File .\\${script}${argStr}`;
}

// One-time migration: move files staged under the old per-user dot-folder
// into the new Public dir, so multi-GB bundles are not re-downloaded just
// because the staging folder moved. Same-volume renames; anything locked or
// cross-volume is left behind (the downloader treats it as absent and
// re-fetches). Exported for tests.
// Create the staging dir, falling back when the preferred location is not
// writable (e.g. hardened ACLs on C:\Users\Public). Returns the dir that
// actually exists. Exported for tests.
export function ensureStagingDir(
	preferred: string,
	fallback: string | null,
): string {
	try {
		mkdirSync(preferred, { recursive: true });
		return preferred;
	} catch (err) {
		if (!fallback || fallback === preferred) throw err;
		console.error(
			`Could not create ${preferred} (${err instanceof Error ? err.message : String(err)}) - using ${fallback} instead`,
		);
		mkdirSync(fallback, { recursive: true });
		return fallback;
	}
}

export function migrateLegacyOfficeDir(fromDir: string, toDir: string): void {
	if (fromDir === toDir || !existsSync(fromDir)) return;
	mkdirSync(toDir, { recursive: true });
	for (const name of readdirSync(fromDir)) {
		const to = join(toDir, name);
		if (existsSync(to)) continue;
		try {
			renameSync(join(fromDir, name), to);
		} catch {
			// Locked or cross-volume — leave it; the download layer copes.
		}
	}
}

export function installerArgs(
	parsed: OfficeArgs,
	platform: OfficePlatform,
): string[] {
	// The bash scripts take GNU-style flags; the PowerShell script takes
	// -SkipVerify / -ForceSkills switches.
	if (platform === "windows") {
		return [
			...(parsed.skipVerify ? ["-SkipVerify"] : []),
			...(parsed.forceSkills ? ["-ForceSkills"] : []),
		];
	}
	return [
		...(parsed.skipVerify ? ["--skip-verify"] : []),
		...(parsed.forceSkills ? ["--force-skills"] : []),
	];
}

export function uninstallerArgs(
	parsed: OfficeArgs,
	platform: OfficePlatform,
): string[] {
	if (platform === "windows") {
		return [
			...(parsed.yes ? ["-Yes"] : []),
			...(parsed.skillsOnly ? ["-SkillsOnly"] : []),
			...(parsed.purgeDownloads ? ["-PurgeDownloads"] : []),
		];
	}
	return [
		...(parsed.yes ? ["--yes"] : []),
		...(parsed.skillsOnly ? ["--skills-only"] : []),
		...(parsed.purgeDownloads ? ["--purge-downloads"] : []),
	];
}

// Exposed for tests (mocked); production always uses the default.
export type OfficeSpawner = (
	command: string,
	args: string[],
	cwd: string,
) => Promise<number>;

const defaultSpawner: OfficeSpawner = (command, args, cwd) =>
	new Promise((resolve, reject) => {
		const child = spawn(command, args, { cwd, stdio: "inherit" });
		child.on("error", reject);
		child.on("close", (code) => resolve(code ?? 1));
	});

export async function runSkillOffice(
	argv: string[],
	baseUrl: string = OFFICE_DOWNLOADS_URL,
	spawner: OfficeSpawner = defaultSpawner,
): Promise<number> {
	const parsed = parseOfficeArgs(argv);
	if (parsed.error) {
		console.error(parsed.error);
		console.error(OFFICE_USAGE);
		return 1;
	}

	const hostPlatform = detectPlatform();
	const platform = parsed.platform ?? hostPlatform;
	if (platform === null) {
		console.error(
			`Unsupported OS: ${process.platform}. Use --platform to download a bundle for ${OFFICE_PLATFORMS.join("/")}.`,
		);
		return 1;
	}

	// Never execute a script built for another OS. The override stays useful
	// for fetching a bundle to carry to a different machine.
	let downloadOnly = parsed.downloadOnly;
	const crossPlatform =
		parsed.platform !== undefined && platform !== hostPlatform;
	if (crossPlatform && !downloadOnly) {
		console.error(
			`Downloading the ${platform} bundle on a ${hostPlatform ?? process.platform} machine — the installer will not be run here.`,
		);
		downloadOnly = true;
	}

	// Windows staging prefers the profile-independent %PUBLIC% folder, but a
	// hardened image can deny non-admin writes under C:\Users\Public — fall
	// back to the old per-user folder rather than crashing.
	const dir = ensureStagingDir(
		parsed.dir ?? officeDownloadsDir(),
		parsed.dir === undefined && hostPlatform === "windows"
			? legacyOfficeDownloadsDir()
			: null,
	);
	// Windows moved its default staging from ~/.codev-hub/office to the
	// profile-independent %PUBLIC%\Downloads\codev-office — pull already
	// downloaded files across so nothing multi-GB is fetched twice.
	if (hostPlatform === "windows" && parsed.dir === undefined) {
		migrateLegacyOfficeDir(legacyOfficeDownloadsDir(), dir);
	}

	const bundle = officeBundleName(platform);
	const script = parsed.uninstall
		? officeUninstallScriptName(platform)
		: officeScriptName(platform);
	if (parsed.uninstall) {
		console.error(`CoDev Office offline skills uninstaller (${platform})`);
	} else {
		console.error(`CoDev Office offline skills bundle (${platform})`);
		console.error(
			`Heads-up: the bundle is ~${APPROX_BUNDLE_MB[platform]} MB — downloading might ` +
				"take a while. An interrupted run picks up where it left off; an " +
				"already-downloaded bundle is reused after checking with the server " +
				"that it is still the published version.",
		);
	}
	logInfo(
		parsed.uninstall
			? "office uninstall starting"
			: "office bundle download starting",
		{
			action: parsed.uninstall ? "office.uninstall" : "office.install",
			extra: { platform, dir, downloadOnly },
		},
	);

	// The scripts are tiny and must track the published version — always
	// refetch them (belt and braces on top of the ETag revalidation). The
	// `.partial` goes too: downloadFile resumes from it via Range, so a
	// leftover from an interrupted run would splice stale bytes onto a script
	// that has since been republished.
	rmSync(join(dir, script), { force: true });
	rmSync(join(dir, `${script}.partial`), { force: true });

	// Uninstall needs no bundle — only the script.
	for (const name of parsed.uninstall ? [script] : [script, bundle]) {
		const progress = makeProgressPrinter(name);
		try {
			await downloadFile({
				url: `${baseUrl}/${name}`,
				dest: join(dir, name),
				endpoint: name === bundle ? "office.bundle" : "office.script",
				onProgress: (p) => progress.print(p.received, p.total),
			});
		} catch (err) {
			progress.done();
			console.error(
				`Could not download ${baseUrl}/${name}: ${err instanceof Error ? err.message : String(err)}`,
			);
			return 1;
		}
		progress.done();
		console.error(`✓ ${name} downloaded`);
	}
	if (process.platform !== "win32") {
		chmodSync(join(dir, script), 0o755);
	}

	const scriptArgs = parsed.uninstall
		? uninstallerArgs(parsed, platform)
		: installerArgs(parsed, platform);

	// Windows: never launch the installer from codevhub. Endpoint protection
	// (Kaspersky Endpoint Security in the field) kills or quarantines any
	// launch codevhub initiates — the only mode it tolerates is the user
	// typing the command in an elevated PowerShell themselves, which is
	// field-proven to run to "Verification passed". Print that exact command,
	// bare: the setup script itself defaults to profile-safe paths (shared
	// %PUBLIC% dirs, console-user detection), so an elevation under a
	// different admin account still installs to the real user's profile.
	if (platform === "windows") {
		const verb = parsed.uninstall ? "uninstaller" : "installer";
		const commandLine = officeManualWindowsCommand(script, scriptArgs);
		console.error(`\nFiles are in ${dir}.`);
		console.error(
			`codevhub does not auto-run the Windows ${verb}: endpoint protection ` +
				"(e.g. Kaspersky) is known to kill installers it launches. Run it " +
				"yourself in an ELEVATED PowerShell:",
		);
		console.error("  1. In this (or any) PowerShell window, run:");
		console.error("       Start-Process powershell -Verb RunAs");
		console.error(
			"     (in the UAC dialog: More choices -> Use a different account -> enter the ADMIN username and password)",
		);
		console.error("  2. Copy-paste these two lines into that window:");
		console.error(`       cd "${dir}"`);
		console.error(`       ${commandLine}`);
		console.error(
			'  3. Wait for the green "Verification passed" closing message',
		);
		logInfo("office windows manual handoff", {
			action: parsed.uninstall ? "office.uninstall" : "office.install",
			extra: { platform, dir },
		});
		return 0;
	}

	if (downloadOnly) {
		console.error(
			`\nFiles are in ${dir}. To ${parsed.uninstall ? "uninstall" : "install"}, run from that folder:`,
		);
		console.error(`  ${manualRunCommand(platform, script)}`);
		return 0;
	}
	console.error(
		`\nRunning the ${parsed.uninstall ? "uninstaller" : "installer"} (${script})...\n`,
	);
	// Windows returned above with the printed manual command — only the bash
	// platforms reach the spawn.
	const command = "bash";
	const args = [join(dir, script), ...scriptArgs];
	// cwd = download dir: the scripts locate their bundle zip next to
	// themselves/CWD, and the staged files are there.
	const code = await spawner(command, args, dir);
	logInfo(
		parsed.uninstall
			? "office uninstaller finished"
			: "office installer finished",
		{
			action: parsed.uninstall ? "office.uninstall" : "office.install",
			extra: { platform, exitCode: code },
		},
	);
	return code;
}
