import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import type { AssistantMessage, UserMessage } from "@earendil-works/pi-ai";
import {
  SessionManager,
  buildSessionContext,
  convertToLlm,
  getMarkdownTheme,
  type ExtensionAPI,
  type ExtensionContext,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Input,
  Key,
  Markdown,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type Focusable,
  type KeybindingsManager,
  type OverlayHandle,
  type TUI,
} from "@earendil-works/pi-tui";

const BTW_SYSTEM_PROMPT = [
  "You are having a private side conversation with the user.",
  "Use the supplied main conversation as read-only context.",
  "You have no tools and must not claim to inspect anything outside that context.",
  "Do not continue or steer the main agent's work.",
  "Answer directly and keep the side conversation focused.",
].join(" ");

const SIDE_SYSTEM_PROMPT = [
  "You are an interactive side session forked from another Pi conversation.",
  "You share its working directory and may use your normal tools.",
  "Do not assume you have exclusive access to the checkout.",
].join(" ");

const MAX_BTW_TURNS = 20;
const IS_MACOS = process.platform === "darwin";
const FOCUS_SHORTCUT = Key.alt("/");
const SIDE_SHORTCUT = IS_MACOS ? Key.super(Key.enter) : Key.ctrl(Key.enter);
const FOCUS_SHORTCUT_LABEL = IS_MACOS ? "option+/" : "alt+/";
const SIDE_SHORTCUT_LABEL = IS_MACOS ? "cmd+enter" : "ctrl+enter";
const FAKE_CURSOR = /\x1b\[7m(.*?)\x1b\[(?:0|27)m/g;

type BtwTurn =
  | { id: string; question: string; status: "pending"; answer: string }
  | { id: string; question: string; status: "complete"; answer: string; message: AssistantMessage }
  | { id: string; question: string; status: "failed"; message: string };

type CompletedBtwTurn = Extract<BtwTurn, { status: "complete" }>;

type BtwCompletion =
  | { kind: "complete"; answer: string; message: AssistantMessage }
  | { kind: "cancelled" }
  | { kind: "failed"; message: string };

type DrawerRuntime = {
  handle?: OverlayHandle;
  refresh?: () => void;
  close?: () => void;
  closed?: boolean;
};

const extractResponseText = (content: ReadonlyArray<{ type: string; text?: string }>) =>
  content
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text ?? "")
    .join("\n")
    .trim();

const completedBtwTurns = (turns: BtwTurn[]) =>
  turns.filter((turn): turn is CompletedBtwTurn => turn.status === "complete");

const formatBtwQuestion = (turns: BtwTurn[], question: string) => {
  const previous = completedBtwTurns(turns)
    .slice(-MAX_BTW_TURNS)
    .map((turn) => `User: ${turn.question}\nAssistant: ${turn.answer}`)
    .join("\n\n");

  return previous
    ? `Earlier side conversation:\n\n${previous}\n\nCurrent question:\n${question}`
    : question;
};

const formatSideContinuation = (turns: BtwTurn[]) => {
  const conversation = completedBtwTurns(turns)
    .map((turn) => `User: ${turn.question}\n\nAssistant: ${turn.answer}`)
    .join("\n\n---\n\n");

  return `Continue this side conversation with full tools.\n\n${conversation}`;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const findPaneId = (value: unknown): string | undefined => {
  if (!isRecord(value)) return undefined;
  if (typeof value.pane_id === "string") return value.pane_id;
  if (typeof value.paneId === "string") return value.paneId;

  return Object.values(value)
    .map(findPaneId)
    .find((paneId) => paneId !== undefined);
};

const findSupersetTerminalId = (value: unknown): string | undefined => {
  if (!isRecord(value)) return undefined;
  if (value.kind === "terminal" && typeof value.sessionId === "string") return value.sessionId;

  return Object.values(value)
    .map(findSupersetTerminalId)
    .find((sessionId) => sessionId !== undefined);
};

const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

class SideSessionStillRunningError extends Error {}

interface HerdrAgent {
  cwd: string;
  name: string;
  paneId: string;
  tabId: string;
}

const findAgentList = (value: unknown): HerdrAgent[] => {
  if (Array.isArray(value)) return value.flatMap(findAgentList);
  if (!isRecord(value)) return [];

  if (Array.isArray(value.agents)) return value.agents.flatMap(findAgentList);
  if (
    typeof value.cwd === "string" &&
    typeof value.name === "string" &&
    typeof value.pane_id === "string" &&
    typeof value.tab_id === "string"
  ) {
    return [{ cwd: value.cwd, name: value.name, paneId: value.pane_id, tabId: value.tab_id }];
  }

  return Object.values(value).flatMap(findAgentList);
};

const findTabId = (value: unknown): string | undefined => {
  if (!isRecord(value)) return undefined;
  if (typeof value.tab_id === "string") return value.tab_id;
  return Object.values(value)
    .map(findTabId)
    .find((tabId) => tabId !== undefined);
};

const delay = (milliseconds: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });

const fitLine = (text: string, width: number) => {
  const truncated = truncateToWidth(text, width, "");
  return `${truncated}${" ".repeat(Math.max(0, width - visibleWidth(truncated)))}`;
};

const renderBtwTurn = (turn: BtwTurn | undefined, width: number, theme: Theme, thinkingFrame: number) => {
  if (!turn) return [theme.fg("dim", "Ask without interrupting the main agent.")];

  const command = theme.fg("accent", theme.bold("/btw"));
  const questionLines = wrapTextWithAnsi(turn.question, Math.max(1, width - 5));
  const renderedQuestion = questionLines.map((line, index) =>
    index === 0 ? `${command} ${theme.fg("muted", line)}` : `     ${theme.fg("muted", line)}`,
  );

  if (turn.status === "pending") {
    if (!turn.answer) {
      const dots = ".".repeat((thinkingFrame % 3) + 1);
      return [...renderedQuestion, "", `  ${theme.fg("warning", `* Answering${dots}`)}`];
    }

    const answerLines = new Markdown(turn.answer, 0, 0, getMarkdownTheme()).render(Math.max(1, width - 4));
    return [...renderedQuestion, "", ...answerLines.map((line) => `  ${line}`)];
  }

  if (turn.status === "failed") {
    return [...renderedQuestion, "", `  ${theme.fg("error", turn.message)}`];
  }

  const answerLines = new Markdown(turn.answer, 0, 0, getMarkdownTheme()).render(Math.max(1, width - 4));
  return [...renderedQuestion, "", ...answerLines.map((line) => `  ${line}`)];
};

class BtwDrawer implements Component, Focusable {
  private readonly input = new Input();
  private _focused = false;
  private scrollFromBottom = 0;
  private viewportHeight = 6;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly keybindings: KeybindingsManager,
    private readonly readTurns: () => BtwTurn[],
    private readonly readThinkingFrame: () => number,
    private readonly onSubmit: (question: string) => void,
    private readonly onClose: () => void,
    private readonly onUnfocus: () => void,
    private readonly onEscalate: () => void,
  ) {
    this.input.onSubmit = (value) => {
      const question = value.trim();
      if (!question) return;
      this.input.setValue("");
      this.scrollFromBottom = 0;
      this.onSubmit(question);
    };
    this.input.onEscape = this.onClose;
  }

  get focused() {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.input.focused = value;
  }

  setDraft(value: string) {
    this.input.setValue(value);
    this.tui.requestRender();
  }

  handleInput(data: string) {
    if (matchesKey(data, FOCUS_SHORTCUT)) {
      this.onUnfocus();
      return;
    }
    if (matchesKey(data, SIDE_SHORTCUT)) {
      this.onEscalate();
      return;
    }
    if (matchesKey(data, Key.up) || matchesKey(data, Key.pageUp)) {
      const distance = matchesKey(data, Key.pageUp) ? Math.max(1, this.viewportHeight - 1) : 1;
      this.scrollFromBottom += distance;
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.down) || matchesKey(data, Key.pageDown)) {
      const distance = matchesKey(data, Key.pageDown) ? Math.max(1, this.viewportHeight - 1) : 1;
      this.scrollFromBottom = Math.max(0, this.scrollFromBottom - distance);
      this.tui.requestRender();
      return;
    }
    if (this.keybindings.matches(data, "tui.select.cancel")) {
      this.onClose();
      return;
    }
    this.input.handleInput(data);
  }

  render(width: number) {
    const contentWidth = Math.max(30, width);
    const terminalRows = process.stdout.rows ?? 30;
    this.viewportHeight = Math.max(5, Math.min(12, Math.floor(terminalRows * 0.3)));

    const selectedTurn = this.readTurns().at(-1);
    const transcript = renderBtwTurn(selectedTurn, contentWidth, this.theme, this.readThinkingFrame());
    const maxScroll = Math.max(0, transcript.length - this.viewportHeight);
    this.scrollFromBottom = Math.min(this.scrollFromBottom, maxScroll);
    const start = Math.max(0, transcript.length - this.viewportHeight - this.scrollFromBottom);
    const visibleTranscript = transcript.slice(start, start + this.viewportHeight);
    const inputWidth = Math.max(1, contentWidth - 6);
    const renderedInput = this.input.render(inputWidth)[0] ?? "";
    const inputContent = renderedInput.startsWith("> ") ? renderedInput.slice(2) : renderedInput;
    const visibleInput = this.focused ? inputContent : inputContent.replace(FAKE_CURSOR, "$1");
    const composerLabel = this.focused
      ? this.theme.fg("accent", this.theme.bold("btw ›"))
      : this.theme.fg("dim", "btw ›");
    const focusHint = this.focused
      ? `btw focused · ↑↓ scroll · ${FOCUS_SHORTCUT_LABEL} main · ${SIDE_SHORTCUT_LABEL} side · esc close`
      : `main focused · ${FOCUS_SHORTCUT_LABEL} btw`;

    return [
      ...visibleTranscript.map((line) => fitLine(line, contentWidth)),
      fitLine("", contentWidth),
      fitLine(`${composerLabel} ${visibleInput}`, contentWidth),
      fitLine(this.theme.fg("dim", focusHint), contentWidth),
    ];
  }

  invalidate() {}
}

export default function (pi: ExtensionAPI) {
  let btwTurns: BtwTurn[] = [];
  let activeBtwController: AbortController | undefined;
  let drawerRuntime: DrawerRuntime | undefined;
  let thinkingFrame = 0;
  let thinkingTimer: ReturnType<typeof setInterval> | undefined;

  const runHostCommand = async (command: string, args: string[], timeout: number) => {
    const result = await pi.exec(command, args, { timeout });
    if (result.code !== 0) {
      throw new Error(result.stderr.trim() || result.stdout.trim() || `${command} ${args.join(" ")} failed`);
    }
    return result.stdout;
  };

  const runHerdr = (args: string[], timeout = 30_000) => runHostCommand("herdr", args, timeout);
  const runSuperset = (args: string[], timeout = 30_000) => runHostCommand("superset", args, timeout);

  const startHerdrSideAgent = async (paneId: string, sessionPath: string | undefined, name: string) => {
    const piArgs = [
      ...(sessionPath ? ["--session", sessionPath] : []),
      "--name",
      name,
      "--append-system-prompt",
      SIDE_SYSTEM_PROMPT,
    ];
    const args = ["agent", "start", name, "--kind", "pi", "--pane", paneId, "--timeout", "30000", "--", ...piArgs];

    for (let attempt = 0; attempt < 12; attempt++) {
      const result = await pi.exec("herdr", args, { timeout: 35_000 });
      if (result.code === 0) return;

      const output = `${result.stderr}\n${result.stdout}`;
      if (!output.includes("agent_pane_busy") || attempt === 11) {
        throw new Error(result.stderr.trim() || result.stdout.trim() || "Could not start the side Pi session");
      }
      await delay(150);
    }
  };

  const findExistingSideAgent = async (parentPaneId: string, ctx: ExtensionContext) => {
    const [paneOutput, agentsOutput] = await Promise.all([
      runHerdr(["pane", "get", parentPaneId], 5_000),
      runHerdr(["agent", "list"], 5_000),
    ]);
    const parentPane: unknown = JSON.parse(paneOutput);
    const agents: unknown = JSON.parse(agentsOutput);
    const tabId = findTabId(parentPane);
    if (!tabId) return undefined;

    return findAgentList(agents)
      .filter(
        (agent) =>
          agent.name.startsWith("side-") &&
          agent.cwd === ctx.cwd &&
          agent.tabId === tabId &&
          agent.paneId !== parentPaneId,
      )
      .at(-1);
  };

  const splitForSide = async (parentPaneId: string, ctx: ExtensionContext) => {
    const existing = await findExistingSideAgent(parentPaneId, ctx).catch(() => undefined);
    const attempts = existing
      ? [
          { paneId: existing.paneId, direction: "down" },
          { paneId: parentPaneId, direction: "down" },
          { paneId: parentPaneId, direction: "right" },
        ]
      : [
          { paneId: parentPaneId, direction: "right" },
          { paneId: parentPaneId, direction: "down" },
        ];
    let lastError: unknown;

    for (const attempt of attempts) {
      try {
        return await runHerdr([
          "pane",
          "split",
          "--pane",
          attempt.paneId,
          "--direction",
          attempt.direction,
          "--ratio",
          "0.5",
          "--cwd",
          ctx.cwd,
          "--focus",
        ]);
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError instanceof Error ? lastError : new Error("Could not create a side pane");
  };

  const seedSideConversation = (
    prompt: string,
    sessionPath: string | undefined,
    seedTurns: CompletedBtwTurn[],
  ) => {
    if (seedTurns.length === 0) return prompt;
    if (!sessionPath) return formatSideContinuation(seedTurns);

    const sideSession = SessionManager.open(sessionPath);
    seedTurns.forEach((turn, index) => {
      const timestamp = Date.now() + index * 2;
      sideSession.appendMessage({
        role: "user",
        content: [{ type: "text", text: turn.question }],
        timestamp,
      });
      sideSession.appendMessage({ ...turn.message, timestamp: timestamp + 1 });
    });
    return "";
  };

  const createSideSession = (
    prompt: string,
    name: string,
    ctx: ExtensionContext,
    seedTurns: CompletedBtwTurn[],
  ) => {
    const leafId = ctx.sessionManager.getLeafId();
    const sessionFile = ctx.sessionManager.getSessionFile();
    const sessionPath = leafId && sessionFile
      ? SessionManager.open(sessionFile).createBranchedSession(leafId)
      : undefined;

    if (sessionPath) {
      const sideSession = SessionManager.open(sessionPath);
      sideSession.appendSessionInfo(name);
      sideSession.appendCustomMessageEntry("side-session", SIDE_SYSTEM_PROMPT, false);
    }

    return {
      effectivePrompt: seedSideConversation(prompt, sessionPath, seedTurns),
      sessionPath,
    };
  };

  const launchHerdrSide = async (
    parentPaneId: string,
    sessionPath: string | undefined,
    effectivePrompt: string,
    name: string,
    ctx: ExtensionContext,
  ) => {
    const splitOutput = await splitForSide(parentPaneId, ctx);
    const parsedSplitOutput: unknown = JSON.parse(splitOutput);
    const paneId = findPaneId(parsedSplitOutput);
    if (!paneId) throw new Error("Herdr did not return the new pane id");

    try {
      await startHerdrSideAgent(paneId, sessionPath, name);
      if (effectivePrompt) {
        await runHerdr(["agent", "prompt", paneId, effectivePrompt], 10_000);
      }
      return name;
    } catch (error) {
      const closeResult = await pi.exec("herdr", ["pane", "close", paneId], { timeout: 5_000 });
      if (closeResult.code !== 0) {
        const message = closeResult.stderr.trim() || closeResult.stdout.trim() || "Herdr could not close the side pane";
        throw new SideSessionStillRunningError(`${error instanceof Error ? error.message : String(error)}. ${message}`);
      }
      throw error;
    }
  };

  const launchSupersetSide = async (
    workspaceId: string,
    sessionPath: string | undefined,
    effectivePrompt: string,
  ) => {
    if (!sessionPath) {
      throw new Error("/side needs a saved Pi session before Superset can resume it");
    }

    const sessionId = SessionManager.open(sessionPath).getSessionId();
    const output = await runSuperset([
      "agents",
      "create",
      "--workspace",
      workspaceId,
      "--agent",
      "pi",
      "--resume-session",
      sessionId,
      "--json",
    ], 35_000);
    const parsedOutput: unknown = JSON.parse(output);
    const terminalId = findSupersetTerminalId(parsedOutput);
    if (!terminalId) throw new Error("Superset did not return the new terminal id");
    if (!effectivePrompt) return terminalId;

    try {
      await runSuperset([
        "terminals",
        "send",
        "--workspace",
        workspaceId,
        "--terminal",
        terminalId,
        "--text",
        effectivePrompt,
        "--json",
      ], 10_000);
      return terminalId;
    } catch (error) {
      const closeResult = await pi.exec("superset", [
        "terminals",
        "close",
        "--workspace",
        workspaceId,
        "--terminal",
        terminalId,
        "--json",
      ], { timeout: 10_000 });
      if (closeResult.code !== 0) {
        const message = closeResult.stderr.trim() || closeResult.stdout.trim() || "Superset could not close the side terminal";
        throw new SideSessionStillRunningError(`${error instanceof Error ? error.message : String(error)}. ${message}`);
      }
      throw error;
    }
  };

  const showTerminalFallback = (
    sessionPath: string | undefined,
    effectivePrompt: string,
    ctx: ExtensionContext,
  ) => {
    if (!sessionPath) {
      throw new Error("/side needs a saved Pi session when no supported terminal host is available");
    }

    const command = `pi --session ${shellQuote(sessionPath)}`;
    ctx.ui.setWidget("side-session-launch", [
      "Side session ready. Run this in another terminal:",
      command,
      ...(effectivePrompt ? ["Then submit this prompt:", effectivePrompt] : []),
    ]);
    return "side session command";
  };

  const launchSide = async (prompt: string, ctx: ExtensionContext, seedTurns: CompletedBtwTurn[] = []) => {
    const name = `side-${randomUUID().slice(0, 6)}`;
    let sessionPath: string | undefined;

    ctx.ui.setWidget("side-session-launch", undefined);
    ctx.ui.notify("Opening side session…", "info");

    try {
      const sideSession = createSideSession(prompt, name, ctx, seedTurns);
      sessionPath = sideSession.sessionPath;
      const opened = process.env.SUPERSET_WORKSPACE_ID
        ? await launchSupersetSide(process.env.SUPERSET_WORKSPACE_ID, sessionPath, sideSession.effectivePrompt)
        : process.env.HERDR_PANE_ID
          ? await launchHerdrSide(process.env.HERDR_PANE_ID, sessionPath, sideSession.effectivePrompt, name, ctx)
          : showTerminalFallback(sessionPath, sideSession.effectivePrompt, ctx);

      ctx.ui.notify(`Opened ${opened}`, "info");
      return true;
    } catch (error) {
      if (sessionPath && !(error instanceof SideSessionStillRunningError)) {
        await unlink(sessionPath).catch(() => undefined);
      }
      ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      return false;
    }
  };

  const completeBtw = async (
    question: string,
    ctx: ExtensionContext,
    signal: AbortSignal,
    onText: (text: string) => void,
  ): Promise<BtwCompletion> => {
    const model = ctx.model;
    if (!model) return { kind: "failed", message: "No model selected" };

    const context = buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId());
    const userMessage: UserMessage = {
      role: "user",
      content: [{ type: "text", text: formatBtwQuestion(btwTurns, question) }],
      timestamp: Date.now(),
    };

    try {
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
      if (!auth.ok) return { kind: "failed", message: auth.error };

      const provider = ctx.modelRegistry.getProvider(model.provider);
      if (!provider) return { kind: "failed", message: `Provider not found: ${model.provider}` };

      const requestModel = auth.baseUrl ? { ...model, baseUrl: auth.baseUrl } : model;
      const stream = provider.stream(
        requestModel,
        { systemPrompt: BTW_SYSTEM_PROMPT, messages: [...convertToLlm(context.messages), userMessage] },
        { signal, apiKey: auth.apiKey, headers: auth.headers, env: auth.env },
      );
      let streamedText = "";

      for await (const event of stream) {
        if (event.type !== "text_delta") continue;
        streamedText += event.delta;
        onText(streamedText);
      }

      const response = await stream.result();
      if (response.stopReason === "aborted") return { kind: "cancelled" };
      if (response.stopReason === "error") {
        return { kind: "failed", message: response.errorMessage ?? "BTW request failed" };
      }

      const answer = extractResponseText(response.content) || streamedText || "(No text response)";
      return {
        kind: "complete",
        answer,
        message: { ...response, content: [{ type: "text", text: answer }] },
      };
    } catch (error) {
      if (signal.aborted) return { kind: "cancelled" };
      return { kind: "failed", message: error instanceof Error ? error.message : String(error) };
    }
  };

  const refreshDrawer = () => {
    drawerRuntime?.refresh?.();
  };

  const stopThinkingAnimation = () => {
    if (thinkingTimer) clearInterval(thinkingTimer);
    thinkingTimer = undefined;
    thinkingFrame = 0;
  };

  const startThinkingAnimation = () => {
    stopThinkingAnimation();
    thinkingTimer = setInterval(() => {
      thinkingFrame += 1;
      refreshDrawer();
    }, 350);
    thinkingTimer.unref();
  };

  const submitBtw = (question: string, ctx: ExtensionContext) => {
    if (activeBtwController) {
      ctx.ui.notify("BTW is still answering", "warning");
      return;
    }

    const id = randomUUID();
    const controller = new AbortController();
    const pendingTurn: BtwTurn = { id, question, status: "pending", answer: "" };
    activeBtwController = controller;
    btwTurns = [...btwTurns, pendingTurn].slice(-MAX_BTW_TURNS);
    startThinkingAnimation();
    refreshDrawer();

    void completeBtw(question, ctx, controller.signal, (answer) => {
      if (activeBtwController !== controller) return;
      stopThinkingAnimation();
      btwTurns = btwTurns.map((turn): BtwTurn =>
        turn.id === id ? { id, question, status: "pending", answer } : turn,
      );
      refreshDrawer();
    }).then((completion) => {
      if (activeBtwController !== controller) return;
      activeBtwController = undefined;
      stopThinkingAnimation();

      if (completion.kind === "cancelled") {
        btwTurns = btwTurns.filter((turn) => turn.id !== id);
        refreshDrawer();
        return;
      }

      btwTurns = btwTurns.map((turn): BtwTurn => {
        if (turn.id !== id) return turn;
        if (completion.kind === "failed") {
          return { id, question, status: "failed", message: completion.message };
        }
        return {
          id,
          question,
          status: "complete",
          answer: completion.answer,
          message: completion.message,
        };
      });
      refreshDrawer();
    });
  };

  const closeDrawer = () => {
    activeBtwController?.abort();
    activeBtwController = undefined;
    stopThinkingAnimation();
    btwTurns = btwTurns.filter((turn) => turn.status !== "pending");
    drawerRuntime?.close?.();
    drawerRuntime = undefined;
  };

  const escalateBtw = (ctx: ExtensionContext) => {
    const turns = completedBtwTurns(btwTurns);
    if (turns.length === 0) {
      ctx.ui.notify("Finish a BTW answer before opening a side session", "warning");
      return;
    }

    void launchSide("", ctx, turns).then((opened) => {
      if (opened) closeDrawer();
    });
  };

  const ensureDrawer = (ctx: ExtensionContext, draft = "") => {
    if (drawerRuntime?.handle) {
      drawerRuntime.handle.setHidden(false);
      drawerRuntime.handle.focus();
      drawerRuntime.refresh?.();
      return;
    }

    const runtime: DrawerRuntime = {};
    drawerRuntime = runtime;

    void ctx.ui.custom<void>(
      (tui, theme, keybindings, done) => {
        const drawer = new BtwDrawer(
          tui,
          theme,
          keybindings,
          () => btwTurns,
          () => thinkingFrame,
          (question) => submitBtw(question, ctx),
          closeDrawer,
          () => {
            runtime.handle?.unfocus();
            runtime.refresh?.();
          },
          () => escalateBtw(ctx),
        );
        drawer.setDraft(draft);
        runtime.refresh = () => {
          drawer.focused = runtime.handle?.isFocused() ?? false;
          tui.requestRender();
        };
        runtime.close = () => {
          if (runtime.closed) return;
          runtime.closed = true;
          runtime.handle?.hide();
          done();
        };
        return drawer;
      },
      {
        overlay: true,
        overlayOptions: {
          width: "100%",
          minWidth: 50,
          maxHeight: "42%",
          anchor: "bottom-center",
          margin: { bottom: 5 },
          nonCapturing: true,
        },
        onHandle: (handle) => {
          runtime.handle = handle;
          handle.focus();
          runtime.refresh?.();
        },
      },
    ).catch((error) => {
      if (drawerRuntime === runtime) drawerRuntime = undefined;
      ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
    });
  };

  pi.on("session_shutdown", (_event, ctx) => {
    closeDrawer();
    ctx.ui.setWidget("side-session-launch", undefined);
  });

  pi.registerShortcut(FOCUS_SHORTCUT, {
    description: "Move focus between BTW and the main editor",
    handler: async (ctx) => {
      const handle = drawerRuntime?.handle;
      if (!handle) {
        ensureDrawer(ctx);
        return;
      }
      if (handle.isFocused()) {
        handle.unfocus();
      } else {
        handle.setHidden(false);
        handle.focus();
      }
      drawerRuntime?.refresh?.();
    },
  });

  pi.registerCommand("side", {
    description: "Open a context-aware Pi side session",
    handler: async (args, ctx) => {
      await launchSide(args.trim(), ctx);
    },
  });

  pi.registerCommand("btw", {
    description: "Open a parallel, tool-free conversation using the current context",
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/btw requires interactive mode", "error");
        return;
      }

      const question = args.trim();
      if (question === "--clear") {
        closeDrawer();
        btwTurns = [];
        return;
      }

      ensureDrawer(ctx);
      if (question) submitBtw(question, ctx);
    },
  });
}
