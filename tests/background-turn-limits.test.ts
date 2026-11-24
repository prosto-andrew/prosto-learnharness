import assert from "node:assert/strict";
import { test } from "node:test";
import { Type } from "typebox";
import { createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall, getCurrentTools, type FauxResponseStep, type TranscriptContext } from "@earendil-works/pi-ai";
import { FINAL_TURN_NOTICE, runSubagent } from "../src/agent/subagents/pi-run.ts";
import { runResearcherAgent } from "../src/agent/subagents/researcher.ts";
import { runSubmitAgent } from "../src/agent/subagents/submit-agent.ts";

function scripted(steps: FauxResponseStep[]) {
	const faux = createFauxCore({ tokenSize: { min: 64, max: 64 } });
	faux.setResponses(steps);
	return { faux, engine: { model: faux.getModel(), streamFn: faux.streamSimple } };
}
const toolTurn = (index: number) => fauxAssistantMessage([
	fauxText(`Progress ${index}; not the deliverable.`),
	fauxToolCall("again", {}, { id: `again_${index}` }),
], { stopReason: "toolUse" });
const again = { name: "again", label: "again", description: "Offline continuation", parameters: Type.Object({}),
	execute: async () => ({ content: [{ type: "text" as const, text: "Evidence retained" }], details: null }) };

test("research runs past twelve tool turns and delivers only the natural final answer", async () => {
	const final = "## Summary\nVerified fixture. [Source](https://example.invalid/evidence)\n\n## Gaps\nNone in this fixture.";
	const { faux, engine } = scripted([
		...Array.from({ length: 15 }, (_, index) => fauxAssistantMessage([
			fauxText(`Searching ${index}; this is progress only.`),
			fauxToolCall("web_search", { query: `query_${index}` }, { id: `search_${index}` }),
		], { stopReason: "toolUse" })),
		(context) => {
			assert.ok(context.messages.some(m => m.role === "user" && m.content === "Original research question"));
			assert.equal(context.messages.filter(m => m.role === "toolResult").length, 15);
			assert.match(JSON.stringify(context.messages.at(-1)), /query_14/);
			return fauxAssistantMessage(final);
		},
	]);
	const queries: string[] = []; let usage = 0;
	const brief = await runResearcherAgent("Original research question", { engine,
		search: () => ({ id: "tavily", async search(query) { queries.push(query); return [{ title: "Offline", url: "https://example.invalid/evidence", snippet: `Evidence for ${query}` }]; } }),
		onUsage: () => usage++,
	});
	assert.equal(brief, final);
	assert.equal(faux.state.callCount, 16);
	assert.equal(queries.length, 15);
	assert.equal(usage, 16);
});

for (const maxTurns of [undefined, 2]) test(`shared runner ${maxTurns === undefined ? "allows deep runs within safety ceiling" : "enforces an explicit cap"}`, async () => {
	const { faux, engine } = scripted([...Array.from({ length: 25 }, (_, index) => toolTurn(index)), fauxAssistantMessage("Completed")]);
	const events: string[] = [];
	const result = await runSubagent([again], { engine, systemPrompt: "Offline", prompt: "Offline", maxTurns,
		onEvent: event => { events.push(event.type); },
	});
	assert.equal(faux.state.callCount, maxTurns ?? 26);
	assert.equal(events.filter(type => type === "agent_end").length, 1);
	assert.equal(events.filter(type => type === "turn_end").length, maxTurns ?? 26);
	assert.equal(result.text, maxTurns === undefined ? "Completed" : "Progress 1; not the deliverable.");
});

test("default safety ceilings stop runaway background loops without unbounded spending", async () => {
	const infiniteSubagent = scripted(Array.from({ length: 40 }, (_, index) => toolTurn(index)));
	await runSubagent([again], { engine: infiniteSubagent.engine, systemPrompt: "Offline", prompt: "Offline" });
	assert.equal(infiniteSubagent.faux.state.callCount, 32);

	const loopTurn = (index: number) => fauxAssistantMessage([
		fauxToolCall("web_search", { query: `loop_${index}` }, { id: `loop_${index}` }),
	], { stopReason: "toolUse" });
	let firstTools: string[] | undefined;
	let finalTools: string[] | undefined;
	const infiniteResearch = scripted(Array.from({ length: 40 }, (_, index): FauxResponseStep => index === 0
		? (context: TranscriptContext) => { firstTools = getCurrentTools(context.messages).map(t => t.name); return loopTurn(index); }
		: index === 31
			? (context: TranscriptContext) => { finalTools = getCurrentTools(context.messages).map(t => t.name); return loopTurn(index); }
			: loopTurn(index)));
	await runResearcherAgent("Looping question", {
		engine: infiniteResearch.engine,
		search: () => ({ id: "tavily", async search() { return []; } }),
	});
	assert.equal(infiniteResearch.faux.state.callCount, 32);
	assert.ok(firstTools?.includes("web_search"), "earlier requests still offer the research tools");
	assert.deepEqual(finalTools, [], "the 32nd request offers no tools");
});

test("final turn steers a notice and withholds tools, so a capped run still delivers text", async () => {
	let firstTools: string[] | undefined;
	let finalTools: string[] | undefined;
	let finalLast: TranscriptContext["messages"][number] | undefined;
	const { faux, engine } = scripted([
		(context) => { firstTools = getCurrentTools(context.messages).map(t => t.name); return toolTurn(0); },
		toolTurn(1),
		(context) => {
			finalTools = getCurrentTools(context.messages).map(t => t.name);
			finalLast = context.messages.at(-1);
			return fauxAssistantMessage("Final brief");
		},
	]);
	const result = await runSubagent([again], { engine, systemPrompt: "Offline", prompt: "Offline", maxTurns: 3,
		finalTurn: { notice: FINAL_TURN_NOTICE, keepTools: [] } });
	assert.deepEqual(firstTools, ["again"]);
	assert.deepEqual(finalTools, []);
	assert.equal(finalLast?.role, "user");
	assert.equal(finalLast?.content, FINAL_TURN_NOTICE);
	assert.equal(result.text, "Final brief");
	assert.equal(faux.state.callCount, 3);
});

test("a final-turn tool call still ends at the cap without an extra request", async () => {
	const { faux, engine } = scripted([toolTurn(0), toolTurn(1), toolTurn(2), toolTurn(3)]);
	await runSubagent([again], { engine, systemPrompt: "Offline", prompt: "Offline", maxTurns: 3,
		finalTurn: { notice: FINAL_TURN_NOTICE, keepTools: [] } });
	assert.equal(faux.state.callCount, 3);
});

test("no notice when the run finishes naturally before the cap", async () => {
	const { faux, engine } = scripted([fauxAssistantMessage("Done")]);
	const result = await runSubagent([], { engine, systemPrompt: "Offline", prompt: "Offline", maxTurns: 2,
		finalTurn: { notice: FINAL_TURN_NOTICE, keepTools: [] } });
	assert.equal(faux.state.callCount, 1);
	assert.ok(!result.newMessages.some(m => m.role === "user" && m.content === FINAL_TURN_NOTICE));
});

test("keepTools keeps only the named tools on the final request", async () => {
	const submitResult = { ...again, name: "submit_result", label: "submit_result" };
	let finalTools: string[] | undefined;
	const { faux, engine } = scripted([toolTurn(0), (context) => {
		finalTools = getCurrentTools(context.messages).map(t => t.name);
		return fauxAssistantMessage("Done");
	}]);
	await runSubagent([again, submitResult], { engine, systemPrompt: "Offline", prompt: "Offline", maxTurns: 2,
		finalTurn: { notice: FINAL_TURN_NOTICE, keepTools: ["submit_result"] } });
	assert.deepEqual(finalTools, ["submit_result"]);
	assert.equal(faux.state.callCount, 2);
});

for (const role of ["extractor", "auditor"] as const) test(`${role} can correct/explore beyond its former cap and stops on accepted submission`, async () => {
	const attempts = role === "extractor" ? 6 : 18;
	const { faux, engine } = scripted([
		...Array.from({ length: attempts }, (_, index) => role === "extractor"
			? fauxAssistantMessage([fauxToolCall("submit", { value: "reject" }, { id: `bad_${index}` })], { stopReason: "toolUse" })
			: toolTurn(index)),
		fauxAssistantMessage([fauxToolCall("submit", { value: "accepted" }, { id: "good" })], { stopReason: "toolUse" }),
	]);
	let steps = 0;
	const result = await runSubmitAgent({ role, toolName: "submit", toolDescription: "Submit fixture", parameters: Type.Object({ value: Type.String() }),
		fill: value => value as { value: string }, validate: value => value.value === "accepted" ? null : "Correct the result",
		engine, signal: undefined, systemPrompt: "Offline", prompt: "Offline", onStep: () => steps++, neverSubmitted: "Missing submission",
		extraTools: role === "auditor" ? { again } : undefined,
	});
	assert.deepEqual(result, { value: "accepted" });
	assert.equal(faux.state.callCount, attempts + 1, "acceptance needs no follow-up request");
	assert.equal(steps, attempts + 1);
});

test("unbounded shared runs still stop on cancellation and propagate provider failure", async () => {
	const controller = new AbortController();
	const { faux, engine } = scripted([...Array.from({ length: 15 }, (_, index) => toolTurn(index)), fauxAssistantMessage("Must not reach")]);
	let usage = 0;
	await assert.rejects(runSubagent([again], { engine, systemPrompt: "Offline", prompt: "Offline", abortSignal: controller.signal,
		onUsage: () => { if (++usage === 13) controller.abort(); },
	}), { name: "AbortError" });
	assert.equal(faux.state.callCount, 13);
	const failed = scripted([fauxAssistantMessage("", { stopReason: "error", errorMessage: "Offline provider failure" })]);
	await assert.rejects(runResearcherAgent("Offline", { engine: failed.engine }), /Offline provider failure/);
	assert.equal(failed.faux.state.callCount, 1);
});

test("removing the cap does not reinterpret a naturally empty response as successful research text", async () => {
	const { faux, engine } = scripted([fauxAssistantMessage("")]);
	assert.equal(await runResearcherAgent("Offline", { engine }), "");
	assert.equal(faux.state.callCount, 1, "no new retry or finalization policy");
});
