import { spawn } from "node:child_process";
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { OFFICE_DOWNLOADS_URL } from "@/lib/const.js";
import { downloadFile } from "@/lib/download.js";
import { loggedFetch, logInfo } from "@/lib/log.js";
import { officeDownloadsDir } from "@/lib/paths.js";

// `codevhub skill office`: fetch the MiniMax-DOCX offline bundle (published by
// the codev-storage MinIO backend) for this OS, verify it against the bucket's
// manifest, and run the bundled setup script. Non-interactive on purpose — the
// second half hands the terminal to an installer that prompts for sudo/UAC,
// which an Ink render would fight over.

export const OFFICE_USAGE =
	"Usage: codevhub skill office [--platform ubuntu|macos|windows] [--dir <path>] [--download-only] [--minimal] [--skip-verify]";

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
	minimal: boolean;
	skipVerify: boolean;
	error?: string;
}

export function parseOfficeArgs(argv: string[]): OfficeArgs {
	const parsed: OfficeArgs = {
		downloadOnly: false,
		minimal: false,
		skipVerify: false,
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
			case "--minimal":
				parsed.minimal = true;
				break;
			case "--skip-verify":
				parsed.skipVerify = true;
				break;
			default:
				parsed.error = `unknown option: ${arg}`;
				return parsed;
		}
	}
	return parsed;
}

export interface OfficeManifest {
	schema: number;
	version: string;
	platforms: Record<OfficePlatform, { bundle: string; script: string }>;
	files: Record<string, { size: number; sha256: string }>;
}

export function parseOfficeManifest(json: unknown): OfficeManifest {
	const bad = (why: string): never => {
		throw new Error(
			`unexpected manifest.json shape (${why}) — the published bundle layout may have changed; update codevhub`,
		);
	};
	if (typeof json !== "object" || json === null) bad("not an object");
	const m = json as Record<string, unknown>;
	if (m.schema !== 1) bad(`schema ${String(m.schema)}`);
	if (typeof m.version !== "string") bad("missing version");
	const platforms = m.platforms as OfficeManifest["platforms"];
	if (typeof platforms !== "object" || platforms === null)
		bad("missing platforms");
	for (const p of OFFICE_PLATFORMS) {
		const entry = platforms[p];
		if (typeof entry?.bundle !== "string" || typeof entry?.script !== "string")
			bad(`platform ${p}`);
	}
	const files = m.files as OfficeManifest["files"];
	if (typeof files !== "object" || files === null) bad("missing files");
	for (const [name, meta] of Object.entries(files)) {
		if (typeof meta?.size !== "number" || typeof meta?.sha256 !== "string")
			bad(`file ${name}`);
	}
	return m as unknown as OfficeManifest;
}

function formatMb(bytes: number): string {
	return (bytes / (1024 * 1024)).toFixed(1);
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
			if (total === null) {
				if (tty) process.stderr.write(`\r${name}  ${formatMb(received)} MB`);
				return;
			}
			const percent = Math.floor((received / total) * 100);
			const line = `${name}  ${formatMb(received)}/${formatMb(total)} MB (${percent}%)`;
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

export function installerArgs(
	parsed: OfficeArgs,
	platform: OfficePlatform,
): string[] {
	// The bash scripts take GNU-style flags; the PowerShell script takes
	// -Minimal / -SkipVerify switches.
	if (platform === "windows") {
		return [
			...(parsed.minimal ? ["-Minimal"] : []),
			...(parsed.skipVerify ? ["-SkipVerify"] : []),
		];
	}
	return [
		...(parsed.minimal ? ["--minimal"] : []),
		...(parsed.skipVerify ? ["--skip-verify"] : []),
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

	const dir = parsed.dir ?? officeDownloadsDir();
	mkdirSync(dir, { recursive: true });

	let manifest: OfficeManifest;
	try {
		const res = await loggedFetch(
			"office.manifest",
			`${baseUrl}/manifest.json`,
			{
				signal: AbortSignal.timeout(30_000),
			},
		);
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		manifest = parseOfficeManifest(await res.json());
	} catch (err) {
		console.error(
			`Could not fetch the bundle manifest from ${baseUrl}/manifest.json: ${err instanceof Error ? err.message : String(err)}`,
		);
		return 1;
	}
	console.error(
		`MiniMax-DOCX offline bundle, version ${manifest.version} (${platform})`,
	);
	logInfo("office bundle download starting", {
		action: "office.install",
		extra: { platform, version: manifest.version, dir, downloadOnly },
	});

	const { bundle, script } = manifest.platforms[platform];
	for (const name of [script, bundle]) {
		const meta = manifest.files[name];
		if (!meta) {
			console.error(
				`manifest.json does not list ${name} — re-publish the bundle`,
			);
			return 1;
		}
		const progress = makeProgressPrinter(name);
		try {
			await downloadFile({
				url: `${baseUrl}/${name}`,
				dest: join(dir, name),
				sha256: meta.sha256,
				size: meta.size,
				endpoint: name === bundle ? "office.bundle" : "office.script",
				onProgress: (p) => progress.print(p.received, p.total),
			});
		} finally {
			progress.done();
		}
		console.error(`✓ ${name} verified (SHA-256)`);
	}
	if (process.platform !== "win32") {
		chmodSync(join(dir, script), 0o755);
	}

	if (downloadOnly) {
		console.error(`\nFiles are in ${dir}. To install, run from that folder:`);
		console.error(`  ${manualRunCommand(platform, script)}`);
		return 0;
	}

	console.error(`\nRunning the installer (${script})...\n`);
	const [command, args] =
		platform === "windows"
			? [
					"powershell.exe",
					[
						"-ExecutionPolicy",
						"Bypass",
						"-File",
						join(dir, script),
						...installerArgs(parsed, platform),
					],
				]
			: ["bash", [join(dir, script), ...installerArgs(parsed, platform)]];
	// cwd = download dir: the scripts locate their bundle zip next to
	// themselves/CWD, and both files were just staged there.
	const code = await spawner(command, args, dir);
	logInfo("office installer finished", {
		action: "office.install",
		extra: { platform, exitCode: code },
	});
	return code;
}
