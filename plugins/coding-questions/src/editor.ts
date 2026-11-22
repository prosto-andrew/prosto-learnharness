import { Compartment, EditorState } from "@codemirror/state";
import { drawSelection, EditorView, keymap, lineNumbers } from "@codemirror/view";
import { standardKeymap, history, historyKeymap, indentMore, insertNewlineAndIndent } from "@codemirror/commands";
import { bracketMatching, indentUnit, LanguageDescription, syntaxHighlighting } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { oneDarkHighlightStyle } from "@codemirror/theme-one-dark";
import type { PluginQuestionAnswerState, PluginQuestionEditorHandle, PluginQuestionEditorProps, PluginProblemEditorHandle, PluginProblemEditorProps } from "learnharness-plugin-api";
import { isSafeBareExecutable, validateTestProgram } from "./allowlist.ts";
import { isReady, normalizeLineEndings, type CodingPayload, type CodingQuestionPayload } from "./contract.ts";
import type { CodingTests } from "./test-result.ts";
import { supportsSyntaxDiagnostics, syntaxDiagnosticsExtension } from "./diagnostics.ts";

export function findLanguage(name: string): LanguageDescription | null {
  return LanguageDescription.matchLanguageName(languages, name.trim(), false);
}

function codeFromAnswer(answer: PluginQuestionAnswerState): string {
  if (answer.status === "empty") return "";
  if (typeof answer.value !== "string") throw new Error("Coding answers must be strings.");
  return normalizeLineEndings(answer.value);
}

/** Every editor is owned by one host mount; no global editor or plugin draft store. */
function createCodeView(container: HTMLElement, language: string, code: string, active: boolean, onChange?: (code: string) => void) {
  const document = container.ownerDocument;
  const frame = document.createElement("div");
  frame.className = "lh-coding-question";
  const header = document.createElement("div");
  header.className = "lh-coding-question__header";
  const label = document.createElement("span");
  label.textContent = language;
  const status = document.createElement("span");
  status.setAttribute("role", "status");
  header.append(label, status);
  frame.append(header);
  container.append(frame);

  let disposed = false;
  let applyingControlledUpdate = false;
  const editable = new Compartment();
  const languageSupport = new Compartment();
  const reservedKeys = new Set(["Tab", "Shift-Tab", "Enter", "Shift-Enter", "Mod-Enter", "Escape"]);
  const view = new EditorView({
    parent: frame,
    state: EditorState.create({
      doc: normalizeLineEndings(code),
      extensions: [
        lineNumbers(),
        history(),
        drawSelection(),
        bracketMatching(),
        EditorState.tabSize.of(4),
        indentUnit.of("    "),
        syntaxHighlighting(oneDarkHighlightStyle),
        EditorView.contentAttributes.of({ "aria-label": onChange ? "Code answer" : "Submitted code" }),
        editable.of([EditorState.readOnly.of(!active), EditorView.editable.of(active)]),
        languageSupport.of([]),
        keymap.of([...standardKeymap, ...historyKeymap].filter(binding => ![binding.key, binding.mac, binding.win, binding.linux].some(key => key !== undefined && reservedKeys.has(key)))),
        EditorView.updateListener.of(update => {
          if (update.docChanged && !disposed && !applyingControlledUpdate && onChange) onChange(update.state.doc.toString());
        }),
      ],
    }),
  });

  const languageDescription = findLanguage(language);
  if (!languageDescription) status.textContent = "Plain text";
  else {
    status.textContent = "Loading highlighting…";
    void languageDescription.load().then(support => {
      if (disposed) return;
      // Catalog support may include tag insertion, completion keymaps or other
      // editing helpers. Install only its language/parser, never those extras.
      view.dispatch({ effects: languageSupport.reconfigure([
        support.language,
        ...(onChange && supportsSyntaxDiagnostics(languageDescription.name) ? [syntaxDiagnosticsExtension()] : []),
      ]) });
      status.textContent = "";
    }).catch(() => {
      if (!disposed) status.textContent = "Plain text";
    });
  }

  return {
    view,
    update(code: string, nextActive: boolean) {
      if (disposed) return;
      const nextCode = normalizeLineEndings(code);
      const codeChanged = view.state.doc.toString() !== nextCode;
      const activeChanged = active !== nextActive;
      if (!codeChanged && !activeChanged) return;
      applyingControlledUpdate = true;
      try {
        view.dispatch({
          ...(codeChanged ? { changes: { from: 0, to: view.state.doc.length, insert: nextCode } } : {}),
          ...(activeChanged ? { effects: editable.reconfigure([EditorState.readOnly.of(!nextActive), EditorView.editable.of(nextActive)]) } : {}),
        });
        active = nextActive;
      } finally { applyingControlledUpdate = false; }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      view.destroy();
      frame.remove();
    },
  };
}

type CodeEditorProps = Pick<PluginQuestionEditorProps, "answer" | "active" | "signal" | "onChange"> & {
  readonly input: { payload: Pick<CodingPayload, "language" | "starterCode"> & { tests?: Partial<CodingTests> } };
};

function formatTestCommand(program: string, args: readonly string[]): string {
  return [program, ...args]
    .map((part) => (part === "" || /[\s"'$`\\;|&<>()]/.test(part) ? JSON.stringify(part) : part))
    .join(" ");
}

function createTestReviewPanel(
  container: HTMLElement,
  tests: Partial<CodingTests> | undefined,
  active: boolean,
  onApprovalChange: (approved: boolean) => void,
) {
  const doc = container.ownerDocument;
  const panel = doc.createElement("div");
  panel.className = "lh-coding-test-review";
  panel.setAttribute("data-testid", "coding-test-review");

  const heading = doc.createElement("div");
  heading.className = "lh-coding-test-review__title";
  heading.textContent = "Test runner inspection (runs locally after submission)";
  panel.append(heading);

  const hasRecipe =
    !!tests &&
    typeof tests.program === "string" &&
    /\S/.test(tests.program) &&
    Array.isArray(tests.args) &&
    tests.args.every((arg) => typeof arg === "string") &&
    typeof tests.code === "string" &&
    /\S/.test(tests.code);

  const safeProgram = hasRecipe && isSafeBareExecutable(tests.program!);
  let approved = false;

  if (!hasRecipe) {
    const warn = doc.createElement("p");
    warn.className = "lh-coding-test-review__warning";
    warn.textContent = "Test recipe is missing or malformed — local execution is disabled.";
    panel.append(warn);
    container.append(panel);
    return {
      isAllowed: () => false,
      setActive() {},
      dispose() { panel.remove(); },
    };
  }

  const commandLine = doc.createElement("code");
  commandLine.className = "lh-coding-test-review__command";
  commandLine.setAttribute("data-testid", "coding-test-command");
  commandLine.textContent = formatTestCommand(tests.program!, tests.args!);
  panel.append(commandLine);

  if (!safeProgram) {
    const warn = doc.createElement("p");
    warn.className = "lh-coding-test-review__warning";
    warn.setAttribute("data-testid", "coding-test-blocked");
    warn.textContent = `Blocked executable "${tests.program}": shells and paths are not permitted.`;
    panel.append(warn);
  } else if (!validateTestProgram(tests.program!).ok) {
    const note = doc.createElement("p");
    note.className = "lh-coding-test-review__note";
    note.textContent = "Non-default runtime: execution succeeds only if explicitly permitted via LH_CODING_ALLOWED_PROGRAMS.";
    panel.append(note);
  }

  const codePreview = doc.createElement("pre");
  codePreview.className = "lh-coding-test-review__code";
  codePreview.setAttribute("data-testid", "coding-test-code");
  codePreview.textContent = normalizeLineEndings(tests.code!);
  panel.append(codePreview);

  const consent = doc.createElement("label");
  consent.className = "lh-coding-test-review__consent";
  const checkbox = doc.createElement("input");
  checkbox.type = "checkbox";
  checkbox.checked = false;
  checkbox.disabled = !active || !safeProgram;
  checkbox.setAttribute("data-testid", "coding-test-approve");
  checkbox.addEventListener("change", () => {
    approved = checkbox.checked;
    onApprovalChange(approved);
  });
  const consentText = doc.createElement("span");
  consentText.textContent = "I reviewed this command and test code and allow running it locally";
  consent.append(checkbox, consentText);
  panel.append(consent);

  container.append(panel);
  return {
    isAllowed: () => safeProgram && approved,
    setActive(nextActive: boolean) {
      checkbox.disabled = !nextActive || !safeProgram;
    },
    dispose() {
      panel.remove();
    },
  };
}

function mountCodeEditor(container: HTMLElement, props: CodeEditorProps): PluginQuestionEditorHandle {
  let disposed = false;
  let active = props.active;
  const initialCode = props.answer.status === "empty" ? normalizeLineEndings(props.input.payload.starterCode ?? "") : codeFromAnswer(props.answer);
  let latestCode = initialCode;
  let review!: ReturnType<typeof createTestReviewPanel>;
  const publish = (code: string) => {
    latestCode = code;
    if (!disposed && !props.signal.aborted) {
      props.onChange({ status: isReady(code) && review.isAllowed() ? "ready" : "unready", value: code });
    }
  };
  const editor = createCodeView(container, props.input.payload.language, initialCode, active, code => {
    if (active) publish(code);
  });
  review = createTestReviewPanel(container, props.input.payload.tests, active, () => {
    publish(latestCode);
  });
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    props.signal.removeEventListener("abort", dispose);
    review.dispose();
    editor.dispose();
  };
  if (props.signal.aborted) dispose();
  else {
    props.signal.addEventListener("abort", dispose, { once: true });
    publish(initialCode);
  }
  return {
    update(next) {
      if (disposed) return;
      active = next.active;
      const nextCode = codeFromAnswer(next.answer);
      latestCode = nextCode;
      review.setActive(active);
      editor.update(nextCode, active);
    },
    focus() { if (!disposed && active) editor.view.focus(); },
    handleKeyDown(key) {
      if (disposed || !active || props.signal.aborted) return "pass";
      if (key === "Tab") { indentMore(editor.view); return "handled"; }
      if (key === "Enter" || key === "Shift+Enter") { insertNewlineAndIndent(editor.view); return "handled"; }
      return "pass";
    },
    dispose,
  };
}

export function mountAnswerEditor(container: HTMLElement, props: PluginQuestionEditorProps<CodingQuestionPayload>): PluginQuestionEditorHandle {
  return mountCodeEditor(container, props);
}

/** Adapt only the public controlled-state vocabulary; no fabricated question identity. */
export function mountSubmissionEditor(container: HTMLElement, props: PluginProblemEditorProps<CodingPayload>): PluginProblemEditorHandle {
  const handle = mountCodeEditor(container, {
    input: props.input, signal: props.signal, active: props.active,
    answer: props.submission, onChange: props.onChange,
  });
  return {
    ...handle,
    update(next) { handle.update({ answer: next.submission, active: next.active }); },
  };
}

export function mountAnswered(container: HTMLElement, props: {
  readonly input: { payload: Pick<CodingPayload, "language"> };
  readonly signal: AbortSignal;
  readonly answer: string;
}): () => void {
  const editor = createCodeView(container, props.input.payload.language, props.answer, false);
  const dispose = () => {
    props.signal.removeEventListener("abort", dispose);
    editor.dispose();
  };
  if (props.signal.aborted) dispose();
  else props.signal.addEventListener("abort", dispose, { once: true });
  return dispose;
}
