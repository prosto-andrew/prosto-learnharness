import type { PluginProblemTypeDefinition, PluginQuestionTypeDefinition } from "learnharness-plugin-api";
import { validateTestProgram } from "./allowlist.ts";
import type { CodingTests } from "./test-result.ts";

export const QUESTION_TYPE_ID = "code";
export const PROBLEM_TYPE_ID = "code";
export type CodingPayload = {
  language: string;
  starterCode?: string;
  tests: CodingTests;
};
export type CodingQuestionPayload = CodingPayload & { modelSolution: string };

export const TEST_RUN_TRUST_NOTICE = "The test code runs on this computer with your user account's permissions, without a sandbox.";

const executionInstructions = "On submission the exact learner code is written to answer.txt in a fresh working directory, and tests.code is sent unchanged to the standard input of tests.program with tests.args. Choose bare allowlisted language runtimes/compilers and stdin options, such as python3 with ['-'] (on Windows use python with ['-']: python3 there is usually the Microsoft Store alias), node with ['-'], or another allowlisted runtime; shells (sh, bash, cmd, powershell) and explicit executable paths are prohibited. Use the test code to load answer.txt, create any small driver files, compile if needed, and actually check the answer. Exit 0 only when the supplied tests pass; a nonzero exit means tests failed. Runtimes/compilers must already be installed; never install or download runtimes, compilers, or packages, or change machine configuration. Executables are resolved through the application's PATH from the allowed runtime list. The run has a 30-second limit and captures at most 64 KiB each of stdout and stderr. Temporary files are removed afterward. Any language is permitted; highlighting depends on the bundled catalog. After submission, review the learner's exact code, separate thinking, and recorded test outcome. Tests passed/failed are observations, not proof of correctness.";

export const instructions = "When a teaching prediction or understanding check calls for writing or editing code, you may use coding_question. Specify the language, optionally supply starter code, and always supply tests:{program,args,code} and modelSolution. Write modelSolution as Markdown with the model code in a fenced code block and an optional explanation; author it with the question, not after seeing the learner's answer. It is preserved with the question and revealed only in the answered transcript, not executed or automatically checked. " + executionInstructions;

export const practiceInstructions = "When a practice problem calls for writing or editing code, use coding_problem. Supply the host's statement, mode, optional target, and committed modelSolution, plus payload:{language,starterCode?,tests:{program,args,code}}. Write modelSolution as Markdown with fenced solution code and an optional explanation; commit it when posing, not after seeing learner submissions. Never execute the model solution. " + executionInstructions + " A practice problem accepts repeated submissions. Test results are per-submission observations, not the final assessment and not an automatic conclusion. Review the code, separate thinking and test observations, and allow revisions. Only the existing conclude tool records your final assessment and closes the problem; the host then reveals the original committed modelSolution. Do not reveal it before conclusion.";

export const definition = {
  id: QUESTION_TYPE_ID,
  label: "Coding question",
  contractVersion: 1,
  showThinking: true,
  questionSchema: {
    type: "object",
    properties: {
      language: {
        type: "string",
        pattern: "\\S",
        description: "Language name or alias, such as python, javascript, typescript, c, cpp, or sql. Any language is permitted; unknown languages use a plain-text editor.",
      },
      starterCode: {
        type: "string",
        description: "Optional code for the learner to edit. Omit or leave empty for a code-writing answer from scratch.",
      },
      modelSolution: {
        type: "string",
        pattern: "\\S",
        description: "Required model solution, authored with the question. Markdown with fenced solution code and an optional explanation. Preserved and shown only after submission; not executed or automatically tested.",
      },
      tests: {
        type: "object",
        description: "Required test process recipe. Runs automatically after a valid submission, using installed user tools; nothing is installed or bundled.",
        properties: {
          program: { type: "string", pattern: "\\S", description: "Allowlisted bare executable name on PATH (e.g. python3, node, gcc). Paths and shells (sh, bash, cmd, powershell) are prohibited." },
          args: { type: "array", items: { type: "string" }, description: "Literal argument vector; include the program's stdin-reading option. No shell expansion is performed by the runner." },
          code: { type: "string", pattern: "\\S", description: "Complete test/driver code supplied to the program's stdin. Read the learner submission from answer.txt in the working directory. Exit 0 for tests passed; nonzero for tests failed. Handle any compilation in this code. No runtime/package installs or downloads." },
        },
        required: ["program", "args", "code"],
        additionalProperties: false,
      },
    },
    required: ["language", "tests", "modelSolution"],
    additionalProperties: false,
  },
  answerSchema: { type: "string", pattern: "\\S" },
  validateQuestion(context) {
    const payload = context.input?.payload as { tests?: { program?: unknown } } | undefined;
    if (typeof payload?.tests?.program !== "string") return ["Missing test program."];
    const extra = typeof process !== "undefined" ? process.env?.LH_CODING_ALLOWED_PROGRAMS : undefined;
    const check = validateTestProgram(payload.tests.program, extra);
    return check.ok ? undefined : [check.reason];
  },
  teach: {
    toolName: "coding_question",
    description: "Ask the learner to write or edit code. Supply a language, optional starter code, required tests:{program,args,code}, and a required Markdown modelSolution containing fenced solution code and an optional explanation. On submission the tests run against answer.txt using installed user tools, then you receive the full code, separate thinking, and test outcome. Tests passed/failed do not mean correct/incorrect.",
  },
} satisfies PluginQuestionTypeDefinition;

export const problemDefinition = {
  id: PROBLEM_TYPE_ID,
  label: "Coding problem",
  contractVersion: 1,
  tool: {
    toolName: "coding_problem",
    description: "Pose a coding practice problem with required tests:{program,args,code}, a language, and optional starter code in payload. Commit the Markdown modelSolution in the host's common field. Each submission runs tests against answer.txt and returns observations, not a final assessment. Allow revisions and use the existing conclude tool to assess and close the problem.",
  },
  problemSchema: {
    type: "object",
    properties: {
      language: definition.questionSchema.properties.language,
      starterCode: definition.questionSchema.properties.starterCode,
      tests: definition.questionSchema.properties.tests,
    },
    required: ["language", "tests"],
    additionalProperties: false,
  },
  submissionSchema: definition.answerSchema,
  validateProblem(context) {
    const payload = context.input?.payload as { tests?: { program?: unknown } } | undefined;
    if (typeof payload?.tests?.program !== "string") return ["Missing test program."];
    const extra = typeof process !== "undefined" ? process.env?.LH_CODING_ALLOWED_PROGRAMS : undefined;
    const check = validateTestProgram(payload.tests.program, extra);
    return check.ok ? undefined : [check.reason];
  },
} satisfies PluginProblemTypeDefinition;

/** Narrow the public plain-schema payload without relying on a TypeBox-only static brand. */
export function readTests(payload: unknown): CodingTests {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Coding question payload is unavailable.");
  const tests = (payload as Record<string, unknown>).tests;
  if (tests === null || typeof tests !== "object" || Array.isArray(tests)) throw new Error("Coding question test recipe is unavailable.");
  const recipe = tests as Record<string, unknown>;
  if (typeof recipe.program !== "string" || !/\S/.test(recipe.program) || !Array.isArray(recipe.args) || !recipe.args.every(arg => typeof arg === "string") || typeof recipe.code !== "string" || !/\S/.test(recipe.code)) throw new Error("Coding question test recipe is invalid.");
  return { program: recipe.program, args: recipe.args, code: recipe.code };
}

/** Readiness is not correctness, and must never trim the actual answer. */
export function isReady(code: string): boolean {
  return /\S/.test(code);
}

export function normalizeLineEndings(code: string): string {
  return code.replace(/\r\n?/g, "\n");
}
