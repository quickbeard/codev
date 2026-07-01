import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import AdmZip from "adm-zip";

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

export async function pathExists(p: string): Promise<boolean> {
	try {
		await stat(p);
		return true;
	} catch {
		return false;
	}
}
