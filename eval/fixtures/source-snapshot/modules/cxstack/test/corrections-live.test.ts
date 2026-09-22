import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createFauxCore,
	fauxAssistantMessage,
	fauxText,
	type Provider,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import registerCorrections from "../extensions/corrections.ts";
import registerCx from "../extensions/cx.ts";
import { correctionState, correctionsFile, readCorrectionEvents } from "../lib/corrections.ts";
import { CX_STATE_ENTRY } from "../lib/cx.ts";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("captures model-marked corrections without another model turn", async () => {
	const root = await mkdtemp(join(tmpdir(), "corrections-live-"));
	roots.push(root);
	const cwd = join(root, "repo");
	const agentDir = join(root, "agent");
	const sessionsDir = join(root, "sessions");
	await Promise.all([mkdir(cwd), mkdir(agentDir), mkdir(sessionsDir)]);

	const providerId = "openai-codex";
	const modelId = "correction-driver";
	const faux = createFauxCore({ provider: providerId, models: [{ id: modelId }] });
	faux.setResponses([
		fauxAssistantMessage("Build a transcript sanitizer."),
		fauxAssistantMessage([
			fauxText("You're right. There is no current failure, so we should defer it."),
			fauxText(`<cx-correction>{"category":"prioritization","agentDecision":"Proposed a transcript sanitizer without a current failure","userFeedback":"The sanitizer is unnecessary","expectedBehavior":"Compare against doing nothing before proposing machinery","strength":"strong"}</cx-correction>`),
		]),
		fauxAssistantMessage("Agreed. I will keep it in project memory."),
		fauxAssistantMessage("Continued without replay errors."),
	]);
	const runtime = await ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: join(agentDir, "models.json"),
		allowModelNetwork: false,
	});
	const provider: Provider = {
		id: providerId,
		name: "Correction test provider",
		auth: {
			apiKey: {
				name: "Correction test API key",
				resolve: async ({ credential }) => credential?.key ? { auth: { apiKey: credential.key } } : undefined,
			},
		},
		getModels: () => faux.models,
		stream: (model, context, options) => faux.stream(model as never, context, options),
		streamSimple: (model, context, options?: SimpleStreamOptions) => faux.streamSimple(model as never, context, options),
	};
	runtime.registerNativeProvider(provider);
	await runtime.setRuntimeApiKey(providerId, "runtime-test-key");
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		extensionFactories: [
			{ name: "cx", factory: registerCx },
			{ name: "corrections", factory: (pi) => registerCorrections(pi, { agentDir, group: async () => [] }) },
		],
	});
	await loader.reload();
	const sessionManager = SessionManager.create(cwd, sessionsDir);
	sessionManager.appendCustomEntry(CX_STATE_ENTRY, { active: true, version: "test" });
	const model = runtime.getModel(providerId, modelId)!;
	const parent = await createAgentSession({
		cwd,
		agentDir,
		modelRuntime: runtime,
		model,
		scopedModels: [{ model }],
		tools: [],
		resourceLoader: loader,
		sessionManager,
	});

	try {
		await parent.session.prompt("What should we improve next?");
		await parent.session.prompt("That sanitizer seems unnecessary.");
		const assistants = parent.session.messages.filter((message) => message.role === "assistant");
		expect(assistants).toHaveLength(2);
		expect(assistants[1]?.content.some((part) => part.type === "text" && part.text === "You're right. There is no current failure, so we should defer it.")).toBeTrue();
		expect(assistants[1]?.content.some((part) => part.type === "text" && part.text === "")).toBeFalse();
		await parent.session.prompt("I don't think that technical note belongs in the wiki.");
		expect(parent.session.messages.filter((message) => message.role === "assistant")).toHaveLength(3);
		await parent.session.prompt("Continue.");
		expect(parent.session.messages.filter((message) => message.role === "assistant")).toHaveLength(4);
		const state = correctionState(readCorrectionEvents(correctionsFile(agentDir)));
		expect(state.candidates).toHaveLength(1);
		expect(state.candidates[0]?.evidence).toEqual({
			complete: true,
			messages: [
				{ id: expect.any(String), role: "user", text: "What should we improve next?" },
				{ id: expect.any(String), role: "assistant", text: "Build a transcript sanitizer." },
				{ id: expect.any(String), role: "user", text: "That sanitizer seems unnecessary." },
			],
		});
		expect(state.candidates[0]?.source).toMatchObject({
			requestEntryId: expect.any(String),
			assistantEntryId: expect.any(String),
			correctionEntryId: expect.any(String),
		});
	} finally {
		parent.session.dispose();
	}
});
