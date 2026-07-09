export type Agent = "claude-code" | "codex" | "opencode" | "codev-code";

// Canonical display order shared by export and upload flows.
export const AGENTS: Agent[] = [
	"claude-code",
	"codex",
	"opencode",
	"codev-code",
];

export interface Message {
	role: "user" | "assistant";
	content: string;
	timestamp?: string;
	model?: string;
}

export interface Session {
	id: string;
	agent: Agent;
	createdAt: Date;
	updatedAt?: Date;
	title?: string;
	firstUserMessage?: string;
	messages: Message[];
	/** Base URL the tool used for this session. Read from CoDev-managed config at export time. */
	baseUrl?: string;
	/**
	 * Aggregated character counts from all descendant subagent sessions (normal
	 * mode only, where subagents have parent_id set and are not uploaded as
	 * standalone sessions). Used to produce accurate token estimates for the
	 * parent session even though the child sessions are folded in.
	 */
	subagentCharsIn?: number;
	subagentCharsOut?: number;
}

export interface Provider {
	agent: Agent;
	detect(cwd: string): Promise<boolean>;
	listSessions(cwd: string): Promise<Session[]>;
	/**
	 * Human-readable filesystem location this provider inspects for `cwd` — the
	 * project session dir (Claude Code), the sessions root (Codex), or the db
	 * file (OpenCode). Surfaced in the "inactive for this project" log so a user
	 * (or we, reading their `codev logs`) can see exactly where detection looked
	 * and compare it against what's actually on disk. Pure path computation, no
	 * I/O — safe to call even when detect() returned false.
	 */
	describeTarget(cwd: string): string;
}
