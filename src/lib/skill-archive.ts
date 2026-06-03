import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import AdmZip from "adm-zip";

/**
 * Given a path to a directory or a .zip file, return a ZIP buffer ready for
 * upload. Directories are zipped with AdmZip; ZIP files are read directly.
 */
export function createZipFromPath(inputPath: string): {
	buffer: Buffer;
	filename: string;
} {
	if (!existsSync(inputPath)) {
		throw new Error(`Path not found: ${inputPath}`);
	}
	const stat = statSync(inputPath);
	if (stat.isDirectory()) {
		const zip = new AdmZip();
		zip.addLocalFolder(inputPath);
		const dirName = basename(inputPath.replace(/[\\/]+$/, ""));
		return { buffer: zip.toBuffer(), filename: `${dirName}.zip` };
	}
	return { buffer: readFileSync(inputPath), filename: basename(inputPath) };
}

/**
 * Extract a skill ZIP buffer into targetDir.
 *
 * SkillHub server ZIPs always contain a single root folder (e.g.
 * `my-skill/SKILL.md`). stripRoot() removes that wrapper so the
 * contents land directly in targetDir instead of targetDir/my-skill/.
 *
 * Path-traversal entries (absolute paths or `..` escapes) are rejected.
 */
export async function extractSkill(
	zipBuffer: Buffer,
	targetDir: string,
): Promise<void> {
	const buf = stripRoot(zipBuffer);
	const zip = new AdmZip(buf);
	const root = resolve(targetDir);
	await mkdir(root, { recursive: true });
	for (const entry of zip.getEntries()) {
		const entryName = entry.entryName;
		if (isAbsolute(entryName))
			throw new Error(`unsafe zip entry: ${entryName}`);
		const dest = resolve(root, entryName);
		const rel = relative(root, dest);
		if (rel.startsWith("..") || isAbsolute(rel))
			throw new Error(`unsafe zip entry: ${entryName}`);
		if (entry.isDirectory) {
			await mkdir(dest, { recursive: true });
			continue;
		}
		await mkdir(dirname(dest), { recursive: true });
		await writeFile(dest, entry.getData());
	}
}

/**
 * If every entry in the ZIP shares a single top-level folder prefix,
 * return a new ZIP buffer with that folder stripped. Otherwise return
 * the original buffer unchanged.
 */
function stripRoot(zipBuffer: Buffer): Buffer {
	const zip = new AdmZip(zipBuffer);
	const entries = zip.getEntries();
	if (entries.length === 0) return zipBuffer;

	const roots = new Set<string>();
	for (const e of entries) {
		const seg = e.entryName.split("/")[0];
		if (seg) roots.add(seg);
	}
	if (roots.size !== 1) return zipBuffer;

	const root = [...roots][0];
	if (!root) return zipBuffer;
	const hasNested = entries.some(
		(e) =>
			e.entryName.length > root.length + 1 &&
			e.entryName.startsWith(`${root}/`),
	);
	if (!hasNested) return zipBuffer;

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
	return stripped.toBuffer();
}
