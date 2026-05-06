import { spawn } from "node:child_process";
import {
	appendFileSync,
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	realpathSync,
	type Stats,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { loadAuth, login } from "@/auth.js";
import { runExport } from "@/export.js";
import { projectLogsDir } from "@/paths.js";
import { AGENTS } from "@/providers/types.js";
import { fetchSupabaseSession } from "@/proxy.js";
import { getSupabaseConfig, type SupabaseConfig } from "@/supabase.js";

export interface UploadOptions {
	skipExport?: boolean;
	cwd?: string;
	onStatus?: (message: string) => void;
}

export interface UploadSummary {
	outDir: string;
	found: number;
	uploaded: number;
	skipped: number;
	failed: number;
	errors: { file: string; message: string }[];
}

interface PresignResponse {
	uploadUrl: string;
	conversationId: string;
	storagePath: string;
}

export interface ExistingConversation {
	id: string;
	local_file_path: string | null;
	local_content_hash: string | null;
	uploaded_at: string | null;
}

interface UploadCandidate {
	path: string;
	hash: string;
	previousVersionId: string;
}

const UPLOAD_TIMEOUT_MS = 60_000;

export async function runUpload({
	skipExport = false,
	cwd = process.cwd(),
	onStatus = () => {},
}: UploadOptions = {}): Promise<UploadSummary> {
	if (!skipExport) {
		onStatus("Exporting local conversations...");
		await runExport(onStatus);
	}

	const outDir = projectLogsDir(cwd);
	const files = listMarkdownLogs(outDir);
	const summary: UploadSummary = {
		outDir,
		found: files.length,
		uploaded: 0,
		skipped: 0,
		failed: 0,
		errors: [],
	};
	if (files.length === 0) return summary;

	const config = getSupabaseConfig();
	const auth = await ensureAuth(onStatus);
	onStatus("Exchanging SSO session for Supabase upload session...");
	const supabaseSession = await fetchSupabaseSession(auth.access_token);
	const uploadToken = supabaseSession.access_token;
	onStatus("Checking existing uploads...");
	const existing = await fetchExistingUploads(config, uploadToken);
	const candidates = filterNewFiles(files, existing);
	summary.skipped = files.length - candidates.length;

	for (const candidate of candidates) {
		onStatus(`Uploading ${basename(candidate.path)}...`);
		try {
			await uploadFile(config, uploadToken, candidate);
			summary.uploaded++;
		} catch (err) {
			summary.failed++;
			summary.errors.push({ file: candidate.path, message: String(err) });
		}
	}
	return summary;
}

export function listMarkdownLogs(outDir: string): string[] {
	const files: string[] = [];
	for (const agent of AGENTS) {
		const dir = join(outDir, agent);
		if (!existsSync(dir)) continue;
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (entry.isFile() && entry.name.endsWith(".md")) {
				files.push(join(dir, entry.name));
			}
		}
	}
	return files.sort();
}

export function fileSha256(path: string): string {
	return new Bun.CryptoHasher("sha256")
		.update(readFileSync(path))
		.digest("hex");
}

export function filterNewFiles(
	paths: string[],
	existing: Map<string, ExistingConversation>,
): UploadCandidate[] {
	const out: UploadCandidate[] = [];
	for (const path of paths) {
		const abs = realpathSync(path);
		const hash = fileSha256(abs);
		const previous = existing.get(abs);
		if (previous?.local_content_hash === hash) continue;
		out.push({ path: abs, hash, previousVersionId: previous?.id ?? "" });
	}
	return out;
}

async function ensureAuth(onStatus: (message: string) => void) {
	const auth = loadAuth();
	if (auth) return auth;
	return login(onStatus, (openBrowser) => openBrowser());
}

async function fetchExistingUploads(
	config: SupabaseConfig,
	accessToken: string,
): Promise<Map<string, ExistingConversation>> {
	const url = new URL(`${config.url}/rest/v1/conversations`);
	url.searchParams.set(
		"select",
		"id,local_file_path,local_content_hash,uploaded_at",
	);
	url.searchParams.set("order", "uploaded_at.desc");
	const res = await fetch(url, {
		headers: {
			apikey: config.anonKey,
			Authorization: `Bearer ${accessToken}`,
			Accept: "application/json",
		},
	});
	if (!res.ok) {
		throw new Error(
			`conversations API failed (${res.status}): ${await res.text()}`,
		);
	}
	const rows = (await res.json()) as ExistingConversation[];
	const byPath = new Map<string, ExistingConversation>();
	for (const row of rows) {
		if (row.local_file_path && !byPath.has(row.local_file_path)) {
			byPath.set(row.local_file_path, row);
		}
	}
	return byPath;
}

async function uploadFile(
	config: SupabaseConfig,
	accessToken: string,
	candidate: UploadCandidate,
): Promise<void> {
	const filename = basename(candidate.path);
	const stat = statSync(candidate.path);
	const presign = await presignUpload(config, accessToken, filename);
	await putGzip(candidate.path, presign.uploadUrl);
	await confirmUpload(config, accessToken, presign, candidate, stat);
}

async function presignUpload(
	config: SupabaseConfig,
	accessToken: string,
	filename: string,
): Promise<PresignResponse> {
	const res = await fetch(`${config.url}/functions/v1/presign-upload`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${accessToken}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ filename }),
		signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
	});
	if (!res.ok) {
		throw new Error(
			`presign-upload failed (${res.status}): ${await res.text()}`,
		);
	}
	return (await res.json()) as PresignResponse;
}

async function putGzip(path: string, uploadUrl: string): Promise<void> {
	const payload = Bun.gzipSync(readFileSync(path));
	const res = await fetch(uploadUrl, {
		method: "PUT",
		headers: {
			"Content-Type": "text/markdown",
			"Content-Encoding": "gzip",
		},
		body: payload,
		signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
	});
	if (!res.ok) {
		throw new Error(
			`signed upload failed (${res.status}): ${await res.text()}`,
		);
	}
}

async function confirmUpload(
	config: SupabaseConfig,
	accessToken: string,
	presign: PresignResponse,
	candidate: UploadCandidate,
	stat: Stats,
): Promise<void> {
	const res = await fetch(`${config.url}/functions/v1/confirm-upload`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${accessToken}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			conversationId: presign.conversationId,
			storagePath: presign.storagePath,
			filename: basename(candidate.path),
			fileSizeBytes: stat.size,
			fileFormat: "markdown",
			fileLastModified: stat.mtime.toISOString(),
			localFilePath: candidate.path,
			localContentHash: candidate.hash,
			previousVersionId: candidate.previousVersionId,
			encoding: "gzip",
		}),
		signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
	});
	if (!res.ok) {
		throw new Error(
			`confirm-upload failed (${res.status}): ${await res.text()}`,
		);
	}
}

// Background-upload daemon: triggered before every `codev claude/codex/opencode`
// invocation so prior sessions keep flowing to the backend without blocking the
// user's workflow. The parent fire-and-forgets a detached `codev upload --daemon`
// child whose stdio is wired to ~/.codev/upload.log; the child takes a lockfile
// to prevent concurrent uploads and writes ~/.codev/last-upload.json with the
// outcome so future runs can surface failures.

const STALE_LOCK_MS = 60 * 60 * 1000;

interface LockContents {
	pid: number;
	startedAt: string;
}

interface UploadStatus {
	ok: boolean;
	startedAt: string;
	finishedAt: string;
	summary?: {
		outDir: string;
		found: number;
		uploaded: number;
		skipped: number;
		failed: number;
	};
	errors?: { file: string; message: string }[];
	error?: string;
}

function codevHomeDir(): string {
	return join(homedir(), ".codev");
}

function uploadLogPath(): string {
	return join(codevHomeDir(), "upload.log");
}

function uploadLockPath(): string {
	return join(codevHomeDir(), "upload.lock");
}

function lastUploadStatusPath(): string {
	return join(codevHomeDir(), "last-upload.json");
}

function logLine(message: string): void {
	try {
		appendFileSync(
			uploadLogPath(),
			`[${new Date().toISOString()}] ${message}\n`,
		);
	} catch {
		// Best-effort.
	}
}

function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

function tryAcquireLock(): boolean {
	const path = uploadLockPath();
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const fd = openSync(path, "wx");
			const lock: LockContents = {
				pid: process.pid,
				startedAt: new Date().toISOString(),
			};
			writeFileSync(fd, JSON.stringify(lock));
			closeSync(fd);
			return true;
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "EEXIST") return false;
			let prior: LockContents | null = null;
			try {
				prior = JSON.parse(readFileSync(path, "utf-8")) as LockContents;
			} catch {
				prior = null;
			}
			const ageMs = prior
				? Date.now() - new Date(prior.startedAt).getTime()
				: Number.POSITIVE_INFINITY;
			if (
				prior &&
				Number.isFinite(ageMs) &&
				ageMs < STALE_LOCK_MS &&
				isPidAlive(prior.pid)
			) {
				return false;
			}
			try {
				unlinkSync(path);
			} catch {
				// Race with another release; loop and retry the create.
			}
		}
	}
	return false;
}

function releaseLock(): void {
	try {
		unlinkSync(uploadLockPath());
	} catch {
		// Already gone.
	}
}

function writeStatusFile(status: UploadStatus): void {
	try {
		const path = lastUploadStatusPath();
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		writeFileSync(path, JSON.stringify(status, null, 2));
	} catch {
		// Best-effort.
	}
}

export async function runUploadDaemon(): Promise<number> {
	const startedAt = new Date().toISOString();
	if (!loadAuth()) {
		logLine("Skipped: not logged in.");
		return 0;
	}
	if (!tryAcquireLock()) {
		logLine("Skipped: another upload is in progress.");
		return 0;
	}
	try {
		logLine("Starting auto-upload.");
		const summary = await runUpload({ onStatus: (m) => logLine(m) });
		writeStatusFile({
			ok: summary.failed === 0,
			startedAt,
			finishedAt: new Date().toISOString(),
			summary: {
				outDir: summary.outDir,
				found: summary.found,
				uploaded: summary.uploaded,
				skipped: summary.skipped,
				failed: summary.failed,
			},
			errors: summary.errors.length > 0 ? summary.errors : undefined,
		});
		logLine(
			`Done: uploaded=${summary.uploaded} skipped=${summary.skipped} failed=${summary.failed}`,
		);
		return summary.failed > 0 ? 1 : 0;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		logLine(`Failed: ${message}`);
		writeStatusFile({
			ok: false,
			startedAt,
			finishedAt: new Date().toISOString(),
			error: message,
		});
		return 1;
	} finally {
		releaseLock();
	}
}

export function spawnUploadDaemon(): void {
	// Skip when not logged in: a detached child has no TTY, so the SSO browser
	// flow inside ensureAuth would land in the log and never resolve.
	if (!loadAuth()) return;
	const selfPath = process.argv[1];
	if (!selfPath) return;
	try {
		mkdirSync(codevHomeDir(), { recursive: true, mode: 0o700 });
		const logFd = openSync(uploadLogPath(), "a");
		try {
			const child = spawn(process.execPath, [selfPath, "upload", "--daemon"], {
				detached: true,
				stdio: ["ignore", logFd, logFd],
			});
			child.unref();
		} finally {
			closeSync(logFd);
		}
	} catch {
		// Never block the agent on a failed daemon launch.
	}
}
