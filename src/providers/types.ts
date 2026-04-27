export type Agent = "claude-code" | "codex" | "opencode";

export interface Message {
	role: "user" | "assistant";
	content: string;
	timestamp?: string;
}

export interface Session {
	id: string;
	agent: Agent;
	createdAt: Date;
	updatedAt?: Date;
	firstUserMessage?: string;
	messages: Message[];
}

export interface Provider {
	agent: Agent;
	detect(cwd: string): Promise<boolean>;
	listSessions(cwd: string): Promise<Session[]>;
}
