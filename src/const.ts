import pkg from "../package.json" with { type: "json" };

export const BASE_URL = atob("aHR0cHM6Ly9uZXRtaW5kLnZpZXR0ZWwudm4v");
export const SUPABASE_URL = atob(
	"aHR0cHM6Ly91YXhjdWpxZWJ5cmVid29qZGtidy5zdXBhYmFzZS5jbw==",
);
export const SUPABASE_ANON_KEY = atob(
	"ZXlKaGJHY2lPaUpJVXpJMU5pSXNJblI1Y0NJNklrcFhWQ0o5LmV5SnBjM01pT2lKemRYQmhZbUZ6WlNJc0luSmxaaUk2SW5WaGVHTjFhbkZsWW5seVpXSjNiMnBrYTJKM0lpd2ljbTlzWlNJNkltRnViMjRpTENKcFlYUWlPakUzTnpZMk5EZzNNakFzSW1WNGNDSTZNakE1TWpJeU5EY3lNSDAuRE9NbDYxR040dzhJaFk5amUyUmpDWEg5bjdfajJNM00tYm9xUDRDZGlwaw==",
);
export const VERSION: string = pkg.version;

export const HELP_HINT = "Run `codev --help` to see all commands.";
export const HAPPY_CODING = "Happy coding! 🎉";
