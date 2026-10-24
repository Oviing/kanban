import { askText } from "./dialog";

/** Returns the summary text, "" if left blank, or null if the user cancelled. */
export const askSummary = () =>
  askText({ title: "Submit for review", label: "Summary for the reviewer", placeholder: "What changed, and how did you check it?", multiline: true, optional: true, confirm: "Submit" });
export const askAnswer = (question?: string | null) =>
  askText({ title: "Answer the question", description: question ?? undefined, label: "Your answer", multiline: true, confirm: "Send answer" });
export const askName = (title: string, initial?: string) =>
  askText({ title, label: "Project name", initial, confirm: "Save" });
