import { test } from "node:test";
import assert from "node:assert/strict";

import {
	renderPromptTemplate,
	PROMPT_PLACEHOLDERS,
	renderOrchestratorTemplate,
	defaultOrchestratorPrompt,
	ORCHESTRATOR_PLACEHOLDERS,
} from "../source/lib/promptTemplate.js";

const vars = {
	id: "FE-123",
	title: "Landing pública",
	url: "https://linear.app/acme/issue/FE-123",
};

test("renderPromptTemplate: substitutes all placeholders", () => {
	const out = renderPromptTemplate(
		"Trabajá en {{id}} ({{title}}). Contexto: {{url}}",
		vars,
	);
	assert.equal(
		out,
		"Trabajá en FE-123 (Landing pública). Contexto: https://linear.app/acme/issue/FE-123",
	);
});

test("renderPromptTemplate: tolerates whitespace inside braces", () => {
	const out = renderPromptTemplate("{{ id }} - {{  title  }}", vars);
	assert.equal(out, "FE-123 - Landing pública");
});

test("renderPromptTemplate: replaces every occurrence of a placeholder", () => {
	const out = renderPromptTemplate("{{id}} {{id}} {{id}}", vars);
	assert.equal(out, "FE-123 FE-123 FE-123");
});

test("renderPromptTemplate: leaves unknown placeholders untouched", () => {
	const out = renderPromptTemplate("{{id}} {{unknown}}", vars);
	assert.equal(out, "FE-123 {{unknown}}");
});

test("renderPromptTemplate: returns template verbatim when there are no placeholders", () => {
	const out = renderPromptTemplate("Empezá a trabajar el ticket", vars);
	assert.equal(out, "Empezá a trabajar el ticket");
});

test("PROMPT_PLACEHOLDERS lists the supported tokens", () => {
	assert.deepEqual([...PROMPT_PLACEHOLDERS], ["{{id}}", "{{title}}", "{{url}}"]);
});

const orchVars = { ids: "FE-81, FE-84, FE-82", count: 3 };

test("renderOrchestratorTemplate: substitutes {{ids}} and {{count}}", () => {
	const out = renderOrchestratorTemplate("Orquestá {{count}} tickets: {{ids}}", orchVars);
	assert.equal(out, "Orquestá 3 tickets: FE-81, FE-84, FE-82");
});

test("renderOrchestratorTemplate: tolerates whitespace inside braces", () => {
	const out = renderOrchestratorTemplate("{{ ids }} ({{  count  }})", orchVars);
	assert.equal(out, "FE-81, FE-84, FE-82 (3)");
});

test("renderOrchestratorTemplate: leaves unknown placeholders untouched", () => {
	const out = renderOrchestratorTemplate("{{ids}} {{unknown}}", orchVars);
	assert.equal(out, "FE-81, FE-84, FE-82 {{unknown}}");
});

test("defaultOrchestratorPrompt: includes the ticket ids", () => {
	const out = defaultOrchestratorPrompt("FE-81, FE-84");
	assert.ok(out.includes("FE-81, FE-84"));
	assert.ok(out.toLowerCase().includes("orquestador"));
});

test("ORCHESTRATOR_PLACEHOLDERS lists the supported tokens", () => {
	assert.deepEqual([...ORCHESTRATOR_PLACEHOLDERS], ["{{ids}}", "{{count}}"]);
});
