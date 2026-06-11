import { spawn as nodeSpawn } from "node:child_process";
import { createHash } from "node:crypto";
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
import { gzipSync } from "node:zlib";
import {
	type AuthData,
	loadAuth,
	login,
	refreshCodevConfig,
} from "@/lib/auth.js";
import { runExport } from "@/lib/export.js";
import { projectLogsDir } from "@/lib/paths.js";
import { fetchSupabaseSession } from "@/lib/proxy.js";
import { getSupabaseConfig, type SupabaseConfig } from "@/lib/supabase.js";
import { AGENTS } from "@/providers/types.js";

export interface UploadOptions {
	cwd?: string;
	// Re-upload every exported log even when its content hash matches a prior
	// upload. The previous-version link is still sent, so a forced re-upload
	// supersedes the existing conversation instead of creating a duplicate.
	// Wired to `codev upload --force`; the background daemon never sets it.
	force?: boolean;
	onStatus?: (message: string) => void;
	// Surfaces the SSO authorize URL when ensureAuth has to open a browser.
	// Lets the caller render the URL on its own line (e.g. UploadApp keeps it
	// pinned below the spinner) instead of routing it through onStatus, where
	// the next status update would overwrite it. The daemon doesn't pass this
	// — there's no human watching the log, and it basically never reaches the
	// login path anyway since it's gated on loadAuth().
	onLoginUrl?: (url: string) => void;
	// Hands the interactive caller the paste-back submitter when a fresh SSO
	// login is needed, so a no-browser user can complete login inline (see
	// UploadApp). Returns an inline error string to re-prompt, or null once the
	// pasted code is accepted. The daemon doesn't pass this — no TTY.
	onManualSubmit?: (submit: (pasted: string) => string | null) => void;
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
	cwd = process.cwd(),
	force = false,
	onStatus = () => {},
	onLoginUrl,
	onManualSubmit,
}: UploadOptions = {}): Promise<UploadSummary> {
	onStatus("Exporting local conversations...");
	await runExport(onStatus);

	const outDir = projectLogsDir(cwd);
	const files = listMarkdownLogs(outDir);
	if (files.length === 0) {
		return {
			outDir,
			found: 0,
			uploaded: 0,
			skipped: 0,
			failed: 0,
			errors: [],
		};
	}

	const auth = await ensureAuth(onStatus, onLoginUrl, onManualSubmit);

	// Try the Supabase block once. If it trips a refreshable failure (cache
	// missing, or Supabase rejected our credentials), refresh the cached
	// CoDev config from codev-proxy and retry exactly once. ensureAuth above
	// guarantees auth.access_token is fresh, so refreshCodevConfig will
	// authenticate against the proxy with a valid bearer.
	try {
		return await runSupabaseUpload(outDir, files, auth, onStatus, force);
	} catch (err) {
		if (!isRefreshableError(err)) throw err;
		onStatus("Refreshing CoDev config and retrying...");
		await refreshCodevConfig(auth.access_token, onStatus);
		return await runSupabaseUpload(outDir, files, auth, onStatus, force);
	}
}

async function runSupabaseUpload(
	outDir: string,
	files: string[],
	auth: AuthData,
	onStatus: (message: string) => void,
	force: boolean,
): Promise<UploadSummary> {
	const summary: UploadSummary = {
		outDir,
		found: files.length,
		uploaded: 0,
		skipped: 0,
		failed: 0,
		errors: [],
	};

	const config = getSupabaseConfig();
	onStatus("Exchanging SSO session for Supabase upload session...");
	const supabaseSession = await fetchSupabaseSession(auth.access_token);
	const uploadToken = supabaseSession.access_token;
	onStatus("Checking existing uploads...");
	const existing = await fetchExistingUploads(config, uploadToken);
	const candidates = filterNewFiles(files, existing, force);
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

// Narrow refresh trigger: empty cache, or Supabase/proxy returning 401/403.
// 5xx, network errors, and timeouts are NOT retried — refreshing config won't
// help and we'd just amplify the outage.
//
// The pattern is anchored to `failed (NNN)` — the exact shape every thrower in
// upload.ts/proxy.ts/auth.ts emits for HTTP errors. A bare `\((\d{3})\)` match
// would pick up any 3-digit number in parens anywhere in the message (e.g. an
// id like `(401abc)` is fine — that one doesn't actually match — but a 500 body
// containing a literal `(403)` reference would falsely trigger a refresh).
export function isRefreshableError(err: unknown): boolean {
	const msg = err instanceof Error ? err.message : String(err);
	if (msg.includes("Missing supabase_")) return true;
	const match = msg.match(/failed \((\d{3})\)/);
	if (!match?.[1]) return false;
	const status = Number.parseInt(match[1], 10);
	return status === 401 || status === 403;
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
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function filterNewFiles(
	paths: string[],
	existing: Map<string, ExistingConversation>,
	force = false,
): UploadCandidate[] {
	const out: UploadCandidate[] = [];
	for (const path of paths) {
		const abs = realpathSync(path);
		const hash = fileSha256(abs);
		const previous = existing.get(abs);
		// `codev upload --force` re-uploads everything; otherwise an unchanged
		// file (hash matches the stored row) is skipped. Either way we keep the
		// previous version id so a re-upload supersedes rather than duplicates.
		if (!force && previous?.local_content_hash === hash) continue;
		out.push({ path: abs, hash, previousVersionId: previous?.id ?? "" });
	}
	return out;
}

async function ensureAuth(
	onStatus: (message: string) => void,
	onLoginUrl?: (url: string) => void,
	onManualSubmit?: (submit: (pasted: string) => string | null) => void,
) {
	const auth = loadAuth();
	if (auth) return auth;
	const fresh = await login(onStatus, (openBrowser, url, submitManualCode) => {
		// Hand the URL to the dedicated channel when the caller provides one
		// (UploadApp pins it under the spinner). Fall back to onStatus so the
		// daemon log — or any future caller that doesn't wire onLoginUrl —
		// still has a paste fallback.
		if (onLoginUrl) onLoginUrl(url);
		else
			onStatus(`If your browser didn't open, visit this URL manually: ${url}`);
		// Expose the paste-back submitter to an interactive caller (UploadApp) so
		// a no-browser user can finish login without leaving `codev upload`. The
		// daemon doesn't wire this — it has no TTY and bails when logged out.
		onManualSubmit?.(submitManualCode);
		openBrowser();
	});
	// login() no longer refreshes CoDev config on its own — every caller does
	// it explicitly so the call uses the user's chosen proxy URL. On a fresh
	// login we don't have a cache yet, so populating it here avoids burning
	// the first Supabase attempt + retry path just to fetch coords.
	await refreshCodevConfig(fresh.access_token, onStatus);
	return fresh;
}

// PostgREST caps responses at a per-deployment max (commonly 1000). Without
// paging, heavy users miss prior-upload rows and re-upload every daemon tick.
// Walk Range pages until the server reports we've consumed the whole set, or
// a safety cap trips.
const PAGE_SIZE = 1000;
const MAX_PAGES = 100;

async function fetchExistingUploads(
	config: SupabaseConfig,
	accessToken: string,
): Promise<Map<string, ExistingConversation>> {
	const byPath = new Map<string, ExistingConversation>();
	for (let page = 0; page < MAX_PAGES; page++) {
		const from = page * PAGE_SIZE;
		const to = from + PAGE_SIZE - 1;
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
				// `count=exact` is expensive on big tables; the Content-Range upper
				// bound is enough to know when we're done. `*` means "don't count".
				Prefer: "count=none",
				Range: `${from}-${to}`,
			},
			// Per-page timeout, matching presign/put/confirm. Without it a hung
			// conversations endpoint stalls the whole upload indefinitely — and in
			// the daemon holds the lockfile until the 1h stale reclaim.
			signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
		});
		if (!res.ok) {
			throw new Error(
				`conversations API failed (${res.status}): ${await res.text()}`,
			);
		}
		const rows = (await res.json()) as ExistingConversation[];
		for (const row of rows) {
			if (row.local_file_path && !byPath.has(row.local_file_path)) {
				byPath.set(row.local_file_path, row);
			}
		}
		// A short page means we've drained the table — no further request needed.
		if (rows.length < PAGE_SIZE) break;
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
	const payload = gzipSync(readFileSync(path));
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
		const path = uploadLogPath();
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		appendFileSync(path, `[${new Date().toISOString()}] ${message}\n`);
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

// Indirection so tests can spy on the spawn call without reaching into
// child_process directly (mirrors `browserOpener` in auth.ts).
export const spawner = {
	spawn: nodeSpawn,
};

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
			const child = spawner.spawn(
				process.execPath,
				[selfPath, "upload", "--daemon"],
				{ detached: true, stdio: ["ignore", logFd, logFd] },
			);
			child.unref();
		} finally {
			closeSync(logFd);
		}
	} catch {
		// Never block the agent on a failed daemon launch.
	}
}
