import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { cleanup, render } from "ink-testing-library";
import { Confirm } from "@/components/Confirm.js";
import * as configure from "@/lib/configure.js";

afterEach(() => {
	cleanup();
	mock.restore();
});

const SOURCE = "/home/u/.claude/settings.json";
const BACKUP = `${SOURCE}.backup`;

describe("Confirm", () => {
	test("renders source → backup arrow when no backup exists yet", () => {
		spyOn(configure, "getBackupStatus").mockReturnValue([
			{
				kind: "claude-settings",
				sourcePath: SOURCE,
				backupPath: BACKUP,
				hasSource: true,
				hasBackup: false,
			},
		]);

		const onConfirm = mock();
		const { lastFrame } = render(
			<Confirm tools={["claude-code"]} onConfirm={onConfirm} />,
		);
		const out = lastFrame() ?? "";
		expect(out).toContain(`${SOURCE} → ${BACKUP}`);
		expect(out).not.toContain("already exists");
	});

	test("flags an existing backup as preserved (no new backup)", () => {
		spyOn(configure, "getBackupStatus").mockReturnValue([
			{
				kind: "claude-settings",
				sourcePath: SOURCE,
				backupPath: BACKUP,
				hasSource: true,
				hasBackup: true,
			},
		]);

		const onConfirm = mock();
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
		spyOn(configure, "getBackupStatus").mockReturnValue([
			{
				kind: "claude-settings",
				sourcePath: SOURCE,
				backupPath: BACKUP,
				hasSource: false,
				hasBackup: false,
			},
		]);

		const onConfirm = mock();
		const { lastFrame } = render(
			<Confirm tools={["claude-code"]} onConfirm={onConfirm} />,
		);
		const out = lastFrame() ?? "";
		expect(out).not.toContain("Backup:");
		expect(out).toContain(`Path: ${SOURCE}`);
	});
});
