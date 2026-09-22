import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const moduleRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path: string) => readFileSync(resolve(moduleRoot, path), "utf8");
const kernel = read("resources/kernel.md");
const readme = read("README.md");
const investigation = read("resources/references/playbooks/investigate-and-decide.md");
const review = read("resources/references/playbooks/review.md");

describe("CX routing policy", () => {
	test("makes direct work the default and routes only concrete consequences", () => {
		expect(kernel).toContain("Direct is the default");
		expect(kernel).toContain("ordinary questions, recommendations, reversible local work, and small fixes");
		expect(kernel).toContain("Route only for:");
		expect(kernel).toContain("Costly, hidden, or hard-to-undo failure");
		expect(kernel).toContain("Material production, data, security, money, deployment, shared-interface, or architecture impact");
		expect(kernel).toContain("Explicit review or delivery");
	});

	test("does not classify routes from user wording or task shape", () => {
		expect(kernel).toContain("Wording, task category, tickets, pull requests, step count, and file count never earn a route");
		expect(kernel).not.toContain("Read, explain, investigate, compare, recommend, or answer");
		expect(investigation).toContain("Ordinary explanations, recommendations, and confidence questions stay direct");
	});

	test("keeps routes proportional and transitions symmetric", () => {
		expect(kernel).toContain("A route names authority, not ceremony");
		expect(kernel).toContain("Transitions are symmetric");
		expect(kernel).toContain("Routed work downgrades when first inspection finds no trigger");
	});

	test("earns maintainability and correctness review from risk", () => {
		expect(review).toContain("Run Simplify when earned");
		expect(review).toContain("Run one Correctness Review when earned");
		expect(review).toContain("only when a wrong result is costly, hidden, hard to undo");
	});

	test("describes the same consumer experience in the README", () => {
		expect(readme).toContain("Direct is the default for ordinary questions, recommendations, reversible local work, and small fixes");
		expect(readme).toContain("A route names the authority boundary, not the amount of ceremony");
		expect(readme).toContain("Todo records actual independent work");
	});
});
