/// <reference lib="dom" />
// Admin prompt-editor island. Replaces the textarea on /admin/prompts
// with a CodeMirror 6 editor — markdown syntax highlighting, line
// wrapping, line numbers, larger keyboard surface than a plain
// textarea.
//
// Mounting strategy: CodeMirror takes over visually but the underlying
// <textarea name="prompt_md"> stays in the DOM (hidden). On form
// submit, the editor's current doc is written back to the textarea so
// the POST body has the edited prompt — no extra route plumbing
// needed. The form action keeps working for users without JS too:
// they just see the textarea fallback.
//
// Bundled via `bun run build:admin`; loaded by admin-prompts.tsx via
// the AdminNav clientBundles prop.

import { EditorView, basicSetup } from "codemirror";
import { markdown } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";

function mount(): void {
  const textarea = document.querySelector<HTMLTextAreaElement>(
    'textarea[name="prompt_md"]',
  );
  if (textarea === null) return;

  // Build the editor from the textarea's current value. Hide the
  // textarea visually but keep it in the form so the existing POST
  // handler reads `prompt_md` unchanged.
  const view = new EditorView({
    state: EditorState.create({
      doc: textarea.value,
      extensions: [
        basicSetup,
        markdown(),
        EditorView.lineWrapping,
        EditorView.theme({
          "&": {
            fontSize: "13px",
            border: "1px solid var(--rule, #d4d0c8)",
            backgroundColor: "#fff",
          },
          ".cm-scroller": {
            fontFamily:
              "ui-monospace, Menlo, Consolas, monospace",
            minHeight: "520px",
            maxHeight: "70vh",
          },
          ".cm-content": { padding: "12px 0" },
          ".cm-gutters": {
            backgroundColor: "transparent",
            border: "none",
            color: "#a59f95",
          },
        }),
      ],
    }),
  });

  textarea.style.display = "none";
  textarea.parentElement?.insertBefore(view.dom, textarea);

  const form = textarea.form;
  if (form !== null) {
    form.addEventListener("submit", () => {
      textarea.value = view.state.doc.toString();
    });
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", mount);
} else {
  mount();
}
