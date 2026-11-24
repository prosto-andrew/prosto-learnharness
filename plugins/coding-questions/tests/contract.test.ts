import assert from "node:assert/strict";
import { test } from "node:test";
import { Compile } from "typebox/compile";
import type { PluginBackendContext, PluginQuestionTypeDefinition } from "learnharness-plugin-api";
import { activate } from "../src/backend.ts";
import { readFileSync } from "node:fs";
import { definition, instructions, practiceInstructions, problemDefinition, isReady, normalizeLineEndings, readTests, TEST_RUN_TRUST_NOTICE } from "../src/contract.ts";
import { findLanguage } from "../src/editor.ts";

const question = Compile(definition.questionSchema);
const answer = Compile(definition.answerSchema);
const tests = { program: "node", args: ["-"], code: "process.exit(0);" };
const modelSolution = "```python\ndef example():\n    return 42\n```\n\nReturn the requested value.";

test("teacher question and practice problem register separately with role-scoped instructions and cleanup", () => {
  const calls: unknown[] = [];
  const cleanup = activate({
    registerQuestionType(value) { calls.push(value); return () => { calls.push("question disposed"); }; },
    registerProblemType(value) { calls.push(value); return () => { calls.push("problem disposed"); }; },
    registerInstructions(value) { calls.push(value); return () => { calls.push("instructions disposed"); }; },
  } as PluginBackendContext);
  const registered = calls[0] as PluginQuestionTypeDefinition;
  assert.equal(typeof registered.gradeAnswer, "function");
  const { gradeAnswer: _grader, ...rest } = registered;
  assert.deepEqual(rest, definition);
  const problem = calls[1] as typeof problemDefinition & { processSubmission: unknown };
  const { processSubmission, ...problemRest } = problem;
  assert.equal(typeof processSubmission, "function");
  assert.deepEqual(problemRest, problemDefinition);
  assert.equal(problemDefinition.tool.toolName, "coding_problem");
  assert.deepEqual(calls[2], { agents: ["practice"], text: practiceInstructions });
  assert.deepEqual(calls[3], { agents: ["teacher"], text: instructions });
  assert.equal(definition.teach.toolName, "coding_question");
  assert.equal("probe" in definition, false);
  assert.equal("execute" in definition, false);
  assert.equal(definition.showThinking, true);
  assert.equal("validateAnswer" in definition, false);
  cleanup();
  assert.deepEqual(calls.slice(4), ["instructions disposed", "instructions disposed", "problem disposed", "question disposed"]);
});

test("practice requires language and tests, shares the code schema and keeps the solution in host common fields", () => {
  const problem = Compile(problemDefinition.problemSchema);
  assert.equal(problem.Check({ language: "unknown-language", tests }), true);
  assert.equal(problem.Check({ language: "Python", starterCode: "", tests }), true);
  for (const value of [{ language: "Python" }, { language: " ", tests }, { language: "Python", tests, modelSolution }, { language: "Python", tests, statement: "not payload" }, { language: "Python", tests: { ...tests, args: [1] } }]) assert.equal(problem.Check(value), false);
  assert.deepEqual(problemDefinition.submissionSchema, definition.answerSchema);
  assert.equal("conclude" in problemDefinition, false);
  assert.match(practiceInstructions, /repeated submissions/);
  assert.match(practiceInstructions, /Only the existing conclude tool/);
  assert.match(practiceInstructions, /Never execute the model solution/);
  assert.match(practiceInstructions, /30-second/);
});

test("optional/empty starter code and arbitrary language, not a restricted language enum", () => {
  for (const value of [{ language: "Python", tests, modelSolution }, { language: "unknown-language", starterCode: "", tests, modelSolution }, { language: "C++", starterCode: "  int x;\r\n", tests, modelSolution }]) assert.equal(question.Check(value), true);
  for (const value of [{}, { language: " \n", tests, modelSolution }, { language: 4, tests, modelSolution }, { language: "js", starterCode: null, tests, modelSolution }, { language: "js", hiddenReference: "no", tests, modelSolution }]) assert.equal(question.Check(value), false);
});

test("new questions require a literal program/args/code test recipe, without adding a runtime catalog", () => {
  for (const recipe of [tests, { program: "/path with spaces/custom-runtime", args: ["--stdin", "a b", "$(literal)"], code: "some test program" }]) {
    assert.equal(question.Check({ language: "any-language", tests: recipe, modelSolution }), true);
  }
  for (const recipe of [undefined, null, {}, { args: [], code: "test" }, { program: " \n", args: [], code: "test" }, { program: "node", code: "test" }, { program: "node", args: [1], code: "test" }, { program: "node", args: [], code: " \n" }, { ...tests, install: "something" }]) {
    assert.equal(question.Check({ language: "Python", tests: recipe, modelSolution }), false);
  }
  assert.match(instructions, /answer\.txt/);
  assert.match(instructions, /standard input/);
  assert.doesNotMatch(instructions, /version.check.*tool/i);
});

test("instructions give Windows python guidance and the editor shows an honest no-sandbox notice", () => {
  assert.match(instructions, /on Windows use python/);
  assert.match(practiceInstructions, /on Windows use python/);
  assert.match(TEST_RUN_TRUST_NOTICE, /without a sandbox/);
  const editor = readFileSync(new URL("../src/editor.ts", import.meta.url), "utf8");
  assert.ok(editor.includes("TEST_RUN_TRUST_NOTICE"));
  assert.ok(editor.includes("coding-test-trust"));
});

test("new questions require a nonblank Markdown model solution, without changing the saved answer schema", () => {
  assert.equal(question.Check({ language: "Python", tests, modelSolution }), true);
  for (const value of [undefined, null, "", " \t\n", false, 42, {}, []]) {
    assert.equal(question.Check({ language: "Python", tests, modelSolution: value }), false);
  }
  assert.equal(answer.Check("  learner code  \n"), true);
  assert.match(instructions, /modelSolution/);
  assert.match(instructions, /fenced code block/);
  assert.match(instructions, /not executed or automatically checked/);
});

test("grader recipe narrowing preserves literal strings/arguments and rejects unavailable input", () => {
  const recipe = { program: "/a path/runtime", args: ["-", "$literal", ""], code: "  exact test\r\n\n" };
  Object.freeze(recipe.args);
  Object.freeze(recipe);
  assert.deepEqual(readTests({ language: "anything", tests: recipe }), recipe);
  for (const payload of [undefined, null, [], {}, { tests: null }, { tests: false }, { tests: {} }, { tests: { ...recipe, program: " \n" } }, { tests: { ...recipe, args: [1] } }, { tests: { ...recipe, code: " \n" } }]) assert.throws(() => readTests(payload), /unavailable|invalid/);
});

test("readiness and saved answer schema agree; never trim code", () => {
  for (const code of ["", " ", "\t\n\r", "\u00a0"]) {
    assert.equal(isReady(code), false); assert.equal(answer.Check(code), false);
  }
  for (const code of ["0", "  x  \n", "\treturn false;\n\n", "<script>literal text</script>"]) {
    assert.equal(isReady(code), true); assert.equal(answer.Check(code), true);
    assert.equal(normalizeLineEndings(code), code);
  }
  for (const value of [null, false, {}, ["code"], 0]) assert.equal(answer.Check(value), false);
  assert.equal(normalizeLineEndings("  a\r\nb\rc\n\n"), "  a\nb\nc\n\n");
});

test("full standard catalog resolves language names and aliases without fuzzy guessing", () => {
  for (const name of ["python", " JAVASCRIPT ", "TypeScript", "C", "C++", "cpp", "sql", "Rust", "yaml", "shell", "LaTeX"]) assert.ok(findLanguage(name), name);
  assert.equal(findLanguage("not-a-known-language"), null);
  assert.equal(findLanguage("python-maybe"), null);
});

test("every standard language module can load locally", async () => {
  const { languages } = await import("@codemirror/language-data");
  assert.ok(languages.length > 100);
  for (const language of languages) assert.ok(await language.load(), language.name);
});

test("validateQuestion and validateProblem enforce bare allowlisted programs and honor LH_CODING_ALLOWED_PROGRAMS", () => {
  const baseInput = { question: "Q", payload: { language: "js", modelSolution, tests } };
  assert.equal(definition.validateQuestion!({ input: baseInput } as never), undefined);
  assert.equal(problemDefinition.validateProblem!({ input: { statement: "S", mode: "composition", payload: { language: "py", tests: { ...tests, program: "python3" } } } } as never), undefined);
  for (const program of ["bash", "powershell", "/usr/bin/python3", "C:\\node.exe", "curl"]) {
    const qErr = definition.validateQuestion!({ input: { ...baseInput, payload: { ...baseInput.payload, tests: { ...tests, program } } } } as never);
    const pErr = problemDefinition.validateProblem!({ input: { statement: "S", payload: { language: "js", tests: { ...tests, program } } } } as never);
    assert.ok(Array.isArray(qErr) && qErr.length === 1, program);
    assert.ok(Array.isArray(pErr) && pErr.length === 1, program);
  }
  const denoErr = definition.validateQuestion!({ input: { ...baseInput, payload: { ...baseInput.payload, tests: { ...tests, program: "deno" } } } } as never);
  assert.ok(Array.isArray(denoErr) && denoErr.length === 1, "deno");
  assert.match(denoErr[0]!, /allowlist/);
  const prev = process.env.LH_CODING_ALLOWED_PROGRAMS;
  try {
    process.env.LH_CODING_ALLOWED_PROGRAMS = "bash, custom-runner";
    assert.equal(definition.validateQuestion!({ input: { ...baseInput, payload: { ...baseInput.payload, tests: { ...tests, program: "custom-runner" } } } } as never), undefined);
    assert.ok(definition.validateQuestion!({ input: { ...baseInput, payload: { ...baseInput.payload, tests: { ...tests, program: "bash" } } } } as never));
  } finally {
    if (prev === undefined) delete process.env.LH_CODING_ALLOWED_PROGRAMS; else process.env.LH_CODING_ALLOWED_PROGRAMS = prev;
  }
});
