import { createOpenCodeProvider } from "@/providers/opencode.js";
import type { Provider } from "@/providers/types.js";

// The codev-code fork of OpenCode shares OpenCode's session storage schema;
// only the XDG app dir differs (~/.local/share/codev/opencode.db). The agent id
// stays "codev-code" (it names the tool, not the dir).
export const codevCodeProvider: Provider = createOpenCodeProvider(
	"codev-code",
	"codev",
);
