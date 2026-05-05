import { createHash } from "node:crypto";
import {
	existsSync,
	readdirSync,
	readFileSync,
	realpathSync,
	statSync,
} from "node:fs";
import { basename, join } from "node:path";
import { gzipSync } from "node:zlib";
import { loadAuth, login } from "@/auth.js";
import { runExport } from "@/export.js";
import { projectLogsDir } from "@/paths.js";
import type { Agent } from "@/providers/types.js";
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

interface ExistingConversation {
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

const AGENT_DIRS: Agent[] = ["claude-code", "codex", "opencode"];
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
	for (const agent of AGENT_DIRS) {
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
	const presign = await presignUpload(config, accessToken, filename);
	await putGzip(candidate.path, presign.uploadUrl);
	const stat = statSync(candidate.path);
	await confirmUpload(config, accessToken, presign, candidate, stat.size);
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
	fileSizeBytes: number,
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
			fileSizeBytes,
			fileFormat: "markdown",
			fileLastModified: statSync(candidate.path).mtime.toISOString(),
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
