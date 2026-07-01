import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import AdmZip from "adm-zip";

// Client-side caps for building a publish archive. The server rejects uploads
// over 100 MB anyway; enforcing here fails fast (no pointless upload) and guards
// against OOM when a user points `skill push` at a huge or mistargeted directory.
const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 10_000;

// Directories never bundled into a skill archive: VCS metadata, dependency
// trees, and local test/log output. Excluded wholesale (their contents are not
// walked).
const IGNORED_DIRS = new Set([
	".git",
	".svn",
	".hg",
	"node_modules",
	"tests",
	"logs",
]);

// Files never bundled: OS junk plus common secret-bearing files. Publishing a
// skill dir must not silently ship a `.env`, private key, or npm token to a hub
// entry that can later go PUBLIC.
function isIgnoredFile(name: string): boolean {
	if (name === ".DS_Store" || name === "Thumbs.db" || name === ".npmrc") {
		return true;
	}
	if (name === ".env" || name.startsWith(".env.")) return true;
	if (/\.(pem|pfx|p12|key)$/i.test(name)) return true;
	if (/^id_(rsa|dsa|ecdsa|ed25519)$/.test(name)) return true;
	return false;
}

// Extract a ZIP buffer into targetDir with zip-slip protection: any entry that
// is absolute or resolves outside the target root is rejected rather than
// written. Directory entries are created; file entries are written verbatim.
export async function extractZip(
	buffer: Buffer,
	targetDir: string,
): Promise<void> {
	await mkdir(targetDir, { recursive: true });
	const zip = new AdmZip(buffer);
	const root = resolve(targetDir);
	for (const entry of zip.getEntries()) {
		const entryName = entry.entryName;
		if (isAbsolute(entryName)) {
			throw new Error(`unsafe zip entry: ${entryName}`);
		}
		const dest = resolve(root, entryName);
		const rel = relative(root, dest);
		if (rel.startsWith("..") || isAbsolute(rel)) {
			throw new Error(`unsafe zip entry: ${entryName}`);
		}
		if (entry.isDirectory) {
			await mkdir(dest, { recursive: true });
			continue;
		}
		await mkdir(dirname(dest), { recursive: true });
		await writeFile(dest, entry.getData());
	}
}

// Strip the top-level directory from zip entries when every entry shares the
// same single prefix. SkillHub server-side publishes ZIPs wrapped in a root
// folder (e.g. `pg-tuner/SKILL.md`); we want the contents extracted directly
// into `<dir>/<name>/` without that extra nesting layer. Returns the original
// buffer unchanged (stripped: null) when there is no single shared root.
export function detectAndStripRoot(zipBuffer: Buffer): {
	buffer: Buffer;
	stripped: string | null;
} {
	const zip = new AdmZip(zipBuffer);
	const entries = zip.getEntries();
	if (entries.length === 0) return { buffer: zipBuffer, stripped: null };

	const firstSegments = new Set<string>();
	for (const e of entries) {
		const seg = e.entryName.split("/")[0];
		if (seg) firstSegments.add(seg);
	}
	if (firstSegments.size !== 1) return { buffer: zipBuffer, stripped: null };

	const root = [...firstSegments][0] as string;
	// Ensure at least one entry lives below the root (not just `root` as a lone
	// file) — otherwise there's nothing to un-nest.
	const hasNested = entries.some(
		(e) =>
			e.entryName.length > root.length + 1 &&
			e.entryName.startsWith(`${root}/`),
	);
	if (!hasNested) return { buffer: zipBuffer, stripped: null };

	const stripped = new AdmZip();
	for (const e of entries) {
		if (e.entryName === `${root}/`) continue;
		if (!e.entryName.startsWith(`${root}/`)) continue;
		const newName = e.entryName.slice(root.length + 1);
		if (!newName) continue;
		if (e.isDirectory) {
			stripped.addFile(newName, Buffer.alloc(0));
		} else {
			stripped.addFile(newName, e.getData());
		}
	}
	return { buffer: stripped.toBuffer(), stripped: root };
}

export interface ZipDirResult {
	buffer: Buffer;
	// Included entries, relative to the zipped directory (e.g. "SKILL.md",
	// "scripts/run.sh") — the top-level `rootName` prefix is not shown here.
	files: string[];
	// Uncompressed total of the included files.
	totalBytes: number;
	// Names skipped by the ignore list (dirs shown with a trailing slash), so the
	// caller can surface exactly what was left out.
	skipped: string[];
}

// Recursively zip a directory's contents into an archive wrapped in a single
// top-level folder named `rootName` — the layout the SkillHub validator expects.
// Junk/secret files and VCS/dependency dirs are dropped (see IGNORED_DIRS /
// isIgnoredFile), symlinks are ignored (a dirent that is neither a file nor a
// directory), and the size/entry caps are enforced as it walks so an oversized
// tree fails before it is read into memory.
export async function zipDirectory(
	dir: string,
	rootName: string,
): Promise<ZipDirResult> {
	const zip = new AdmZip();
	const files: string[] = [];
	const skipped: string[] = [];
	const state = { totalBytes: 0 };

	const addDir = async (absDir: string, rel: string): Promise<void> => {
		const items = await readdir(absDir, { withFileTypes: true });
		// Add the directory entry first so empty dirs survive the round-trip.
		zip.addFile(`${rootName}/${rel ? `${rel}/` : ""}`, Buffer.alloc(0));
		for (const item of items) {
			const relPath = rel ? `${rel}/${item.name}` : item.name;
			const abs = join(absDir, item.name);
			if (item.isDirectory()) {
				if (IGNORED_DIRS.has(item.name)) {
					skipped.push(`${relPath}/`);
					continue;
				}
				await addDir(abs, relPath);
				continue;
			}
			// Only real files are archived; symlinks (isFile()/isDirectory() both
			// false) are silently and deliberately dropped.
			if (!item.isFile()) continue;
			if (isIgnoredFile(item.name)) {
				skipped.push(relPath);
				continue;
			}
			const st = await stat(abs);
			if (state.totalBytes + st.size > MAX_ARCHIVE_BYTES) {
				throw new Error(
					`Skill exceeds the ${MAX_ARCHIVE_BYTES / 1024 / 1024} MB upload limit.`,
				);
			}
			if (files.length + 1 > MAX_ARCHIVE_ENTRIES) {
				throw new Error(
					`Skill has too many files (limit ${MAX_ARCHIVE_ENTRIES}).`,
				);
			}
			const data = await readFile(abs);
			zip.addFile(`${rootName}/${relPath}`, data);
			files.push(relPath);
			state.totalBytes += data.length;
		}
	};

	await addDir(dir, "");
	return {
		buffer: zip.toBuffer(),
		files,
		totalBytes: state.totalBytes,
		skipped,
	};
}

// Enumerate a pre-built ZIP's file entries and uncompressed total. Used to
// preview and size-check a user-supplied `.zip` before uploading it. Throws if
// it blows past the same caps zipDirectory enforces.
export function inspectZip(zipBuffer: Buffer): {
	files: string[];
	totalBytes: number;
} {
	const zip = new AdmZip(zipBuffer);
	const files: string[] = [];
	let totalBytes = 0;
	for (const e of zip.getEntries()) {
		if (e.isDirectory) continue;
		files.push(e.entryName);
		totalBytes += e.header.size;
	}
	if (totalBytes > MAX_ARCHIVE_BYTES) {
		throw new Error(
			`Archive exceeds the ${MAX_ARCHIVE_BYTES / 1024 / 1024} MB upload limit.`,
		);
	}
	if (files.length > MAX_ARCHIVE_ENTRIES) {
		throw new Error(
			`Archive has too many files (limit ${MAX_ARCHIVE_ENTRIES}).`,
		);
	}
	return { files, totalBytes };
}

export async function pathExists(p: string): Promise<boolean> {
	try {
		await stat(p);
		return true;
	} catch {
		return false;
	}
}
