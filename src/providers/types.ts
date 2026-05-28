export type Agent = "claude-code" | "codex" | "opencode";

// Canonical display order shared by export and upload flows.
export const AGENTS: Agent[] = ["claude-code", "codex", "opencode"];

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
}

export interface Provider {
	agent: Agent;
	detect(cwd: string): Promise<boolean>;
	listSessions(cwd: string): Promise<Session[]>;
}
