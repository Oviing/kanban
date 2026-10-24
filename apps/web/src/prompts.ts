/** Returns the summary text, "" if left blank, or null if the user cancelled. */
export const askSummary = (): string | null => prompt("Summary of the work for the reviewer (optional for humans)");
export const askAnswer = (question?: string | null): string | null => prompt(question ? `Question: ${question}\n\nYour answer:` : "Your answer:");
