import { createHash } from "node:crypto";
import {
	createReadStream,
	createWriteStream,
	existsSync,
	mkdirSync,
	renameSync,
	rmSync,
	statSync,
} from "node:fs";
import { dirname } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { loggedFetch } from "@/lib/log.js";

// Streaming file download for GB-scale artifacts (the office bundles). The
// existing fetch sites (ripgrep.ts, skillhub.ts) buffer whole responses in
// memory, which is fine at 5-100MB and hopeless at 1.1GB — this helper pipes
// the body straight to disk, hashes it as it flows, and resumes interrupted
// transfers from a `.partial` file via HTTP Range.

export interface DownloadProgress {
	received: number;
	// null when the server sent no content-length and the caller gave no size.
	total: number | null;
}

export interface DownloadOptions {
	url: string;
	// Final path. The helper owns `${dest}.partial` while transferring.
	dest: string;
	// Expected SHA-256 (hex). When set, a finished file that doesn't match is
	// deleted and an error thrown; when `dest` already matches, the download is
	// skipped entirely.
	sha256?: string;
	// Expected byte count, used only as the progress total when the server
	// doesn't say.
	size?: number;
	// Endpoint label for loggedFetch (ECS logs), e.g. "office.bundle".
	endpoint: string;
	onProgress?: (p: DownloadProgress) => void;
	signal?: AbortSignal;
}

async function fileSha256(path: string): Promise<string> {
	const hash = createHash("sha256");
	await pipeline(createReadStream(path), async (chunks) => {
		for await (const chunk of chunks) hash.update(chunk as Buffer);
	});
	return hash.digest("hex");
}

export async function downloadFile(opts: DownloadOptions): Promise<void> {
	const { url, dest, endpoint, onProgress, signal } = opts;
	const partial = `${dest}.partial`;

	// A finished file that already verifies makes the whole call a no-op, so
	// re-running after a crash between files never re-downloads.
	if (existsSync(dest)) {
		if (!opts.sha256 || (await fileSha256(dest)) === opts.sha256) return;
		rmSync(dest);
	}

	mkdirSync(dirname(dest), { recursive: true });

	// Resume: hash the bytes we already have (the final hash must cover the
	// file from byte 0), then ask the server for the rest.
	let hash = createHash("sha256");
	let offset = 0;
	if (existsSync(partial)) {
		offset = statSync(partial).size;
		const h = hash;
		await pipeline(createReadStream(partial), async (chunks) => {
			for await (const chunk of chunks) h.update(chunk as Buffer);
		});
	}

	const res = await loggedFetch(endpoint, url, {
		headers: offset > 0 ? { Range: `bytes=${offset}-` } : undefined,
		signal,
	});

	let append = false;
	if (res.status === 206 && offset > 0) {
		append = true;
	} else if (res.ok) {
		// 200 despite Range (server ignored it) or a fresh download: start over.
		hash = createHash("sha256");
		offset = 0;
	} else if (res.status === 416) {
		// The partial is at least as large as the object — it can't be trusted
		// (a stale leftover from an older publish). Scrap it and refetch.
		rmSync(partial, { force: true });
		return downloadFile(opts);
	} else {
		throw new Error(`download failed (${res.status}): ${url}`);
	}
	if (res.body === null) throw new Error(`download had no body: ${url}`);

	// A missing header must fall through to opts.size. `Number(null)` is 0, which
	// is finite — reading it straight would make the fallback unreachable and
	// report a total of `offset` (0 on a fresh download) for every chunked
	// response.
	const header = res.headers.get("content-length");
	const contentLength = header === null ? Number.NaN : Number(header);
	const total = Number.isFinite(contentLength)
		? offset + contentLength
		: (opts.size ?? null);

	let received = offset;
	let lastTick = 0;
	const tap = new Transform({
		transform(chunk: Buffer, _enc, cb) {
			hash.update(chunk);
			received += chunk.length;
			// Throttle progress to ~10/s; always report the final position.
			const now = Date.now();
			if (now - lastTick > 100 || received === total) {
				lastTick = now;
				onProgress?.({ received, total });
			}
			cb(null, chunk);
		},
	});

	await pipeline(
		Readable.fromWeb(res.body as import("node:stream/web").ReadableStream),
		tap,
		createWriteStream(partial, { flags: append ? "a" : "w" }),
		{ signal },
	);
	onProgress?.({ received, total });

	if (opts.sha256) {
		const got = hash.digest("hex");
		if (got !== opts.sha256) {
			rmSync(partial, { force: true });
			throw new Error(
				`SHA-256 mismatch for ${url}: expected ${opts.sha256}, got ${got}. ` +
					"The download was corrupt (or the published bundle changed mid-transfer) — re-run to try again.",
			);
		}
	}
	renameSync(partial, dest);
}
