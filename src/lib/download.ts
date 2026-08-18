import { createHash } from "node:crypto";
import {
	createReadStream,
	createWriteStream,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
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
//
// Staleness without a manifest: the server's ETag is persisted next to the
// file (`${dest}.etag`). A finished file is revalidated with If-None-Match
// (304 = still the published object, anything else = republished, re-download)
// and a resume is guarded with If-Range so stale partial bytes are never
// spliced onto a republished object. The truth lives on the object itself, so
// nothing on the publish side can drift.

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

function readEtag(etagFile: string): string | null {
	try {
		const etag = readFileSync(etagFile, "utf8").trim();
		return etag.length > 0 ? etag : null;
	} catch {
		return null;
	}
}

export async function downloadFile(opts: DownloadOptions): Promise<void> {
	const { url, dest, endpoint, onProgress, signal } = opts;
	const partial = `${dest}.partial`;
	const etagFile = `${dest}.etag`;

	// A finished file short-circuits the download. With an expected sha256 it
	// must verify. Without one, a stored ETag lets us ask the server whether
	// the published object changed; no ETag on record (a manually copied file,
	// or a pre-ETag download) means the local file is trusted as-is.
	if (existsSync(dest)) {
		if (opts.sha256) {
			if ((await fileSha256(dest)) === opts.sha256) return;
			rmSync(dest);
		} else {
			const etag = readEtag(etagFile);
			if (!etag) return;
			let probe: Response;
			try {
				probe = await loggedFetch(endpoint, url, {
					headers: { "If-None-Match": etag },
					signal,
				});
			} catch {
				return; // server unreachable — keep what we have
			}
			if (probe.status === 304 || !probe.ok) {
				// Still the published object (304), or a server hiccup — either
				// way the local file is the best copy available.
				await probe.body?.cancel();
				return;
			}
			// Republished: drop the response (the fresh download below streams
			// its own) and every local trace of the old object.
			await probe.body?.cancel();
			rmSync(dest, { force: true });
			rmSync(partial, { force: true });
			rmSync(etagFile, { force: true });
		}
	}

	mkdirSync(dirname(dest), { recursive: true });

	// Resume: hash the bytes we already have (the final hash must cover the
	// file from byte 0), then ask the server for the rest.
	let hash = createHash("sha256");
	let offset = 0;
	if (existsSync(partial)) {
		// Without an expected sha256 there is nothing downstream to catch a bad
		// splice, so a resume is only trustworthy when the partial's ETag is on
		// record to send as If-Range. A bare Range answered with 206 would
		// append the republished object's bytes onto stale ones — scrap such a
		// partial and download from scratch instead.
		if (!opts.sha256 && !readEtag(etagFile)) {
			rmSync(partial, { force: true });
		} else {
			offset = statSync(partial).size;
			const h = hash;
			await pipeline(createReadStream(partial), async (chunks) => {
				for await (const chunk of chunks) h.update(chunk as Buffer);
			});
		}
	}

	// If-Range makes a resume safe across republishes: when the entity no
	// longer matches the partial's ETag, the server ignores Range and answers
	// 200, and the start-over branch below discards the stale partial bytes.
	const headers: Record<string, string> = {};
	if (offset > 0) {
		headers.Range = `bytes=${offset}-`;
		const etag = readEtag(etagFile);
		if (etag) headers["If-Range"] = etag;
	}
	const res = await loggedFetch(endpoint, url, {
		headers: offset > 0 ? headers : undefined,
		signal,
	});

	let append = false;
	if (res.status === 206 && offset > 0) {
		// Belt and braces on top of If-Range: a middlebox that mishandles it
		// can still answer 206 for a republished entity (this corrupted real
		// bundle downloads — "bad zipfile offset" from spliced halves). When
		// the 206 carries an ETag that differs from the partial's, the range
		// is against a different object: scrap the partial and refetch clean.
		const storedEtag = readEtag(etagFile);
		const gotEtag = res.headers.get("etag");
		if (storedEtag && gotEtag && gotEtag !== storedEtag) {
			await res.body?.cancel();
			rmSync(partial, { force: true });
			rmSync(etagFile, { force: true });
			return downloadFile(opts);
		}
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

	// Persist the entity tag of what we are about to write — before streaming,
	// so an interrupted transfer leaves a partial+ETag pair the next resume can
	// validate with If-Range. A server that sends no ETag clears the record.
	const resEtag = res.headers.get("etag");
	if (resEtag) writeFileSync(etagFile, resEtag);
	else rmSync(etagFile, { force: true });

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
