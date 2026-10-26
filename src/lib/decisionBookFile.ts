import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import type { DecisionBook } from "./autocullDecisionBook.ts";
import { nativeLearnerAvailable } from "./autocullNative.ts";

type SaveResult = { kind: "saved"; filename: string } | { kind: "cancelled" | "superseded" };

export async function saveDecisionBookFile({ book, isCurrent }: {
  book: DecisionBook;
  isCurrent: () => boolean;
}): Promise<SaveResult> {
  const filename = `hologram-decision-book-${book.created_at.slice(0, 10)}.json`;
  const contents = `${JSON.stringify(book, null, 2)}\n`;
  if (nativeLearnerAvailable()) {
    const path = await save({
      title: "Save decision book",
      defaultPath: filename,
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (!isCurrent()) return { kind: "superseded" };
    if (path === null) return { kind: "cancelled" };
    await invoke<void>("save_decision_book", { path, contents });
    return { kind: "saved", filename: path.replaceAll("\\", "/").split("/").at(-1) || filename };
  }
  if (!isCurrent()) return { kind: "superseded" };
  const url = URL.createObjectURL(new Blob([contents], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return { kind: "saved", filename };
}
