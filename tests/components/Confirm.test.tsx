import { cleanup, render } from "ink-testing-library";
import { afterEach, describe, expect, test, vi } from "vitest";
import { Confirm } from "@/components/Confirm.js";
import * as configure from "@/lib/configure.js";

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

const SOURCE = "/home/u/.claude/settings.json";
const BACKUP = `${SOURCE}.backup`;

describe("Confirm", () => {
	test("renders source → backup arrow when no backup exists yet", () => {
		vi.spyOn(configure, "getBackupStatus").mockReturnValue([
			{
				kind: "claude-settings",
				sourcePath: SOURCE,
				backupPath: BACKUP,
				hasSource: true,
				hasBackup: false,
			},
		]);

		const onConfirm = vi.fn();
		const { lastFrame } = render(
			<Confirm tools={["claude-code"]} onConfirm={onConfirm} />,
		);
		const out = lastFrame() ?? "";
		expect(out).toContain(`${SOURCE} → ${BACKUP}`);
		expect(out).not.toContain("already exists");
	});

	test("flags an existing backup as preserved (no new backup)", () => {
		vi.spyOn(configure, "getBackupStatus").mockReturnValue([
			{
				kind: "claude-settings",
				sourcePath: SOURCE,
				backupPath: BACKUP,
				hasSource: true,
				hasBackup: true,
			},
		]);

		const onConfirm = vi.fn();
		const { lastFrame } = render(
			<Confirm tools={["claude-code"]} onConfirm={onConfirm} />,
		);
		const out = lastFrame() ?? "";
		expect(out).toContain(
			`${BACKUP} already exists and will not be overwritten.`,
		);
		// The arrow line for a fresh backup must NOT appear.
		expect(out).not.toContain(`${SOURCE} → ${BACKUP}`);
	});

	test("omits the backup line entirely when neither source nor backup exists", () => {
		vi.spyOn(configure, "getBackupStatus").mockReturnValue([
			{
				kind: "claude-settings",
				sourcePath: SOURCE,
				backupPath: BACKUP,
				hasSource: false,
				hasBackup: false,
			},
		]);

		const onConfirm = vi.fn();
		const { lastFrame } = render(
			<Confirm tools={["claude-code"]} onConfirm={onConfirm} />,
		);
		const out = lastFrame() ?? "";
		expect(out).not.toContain("Backup:");
		expect(out).toContain(`Path: ${SOURCE}`);
	});
});
