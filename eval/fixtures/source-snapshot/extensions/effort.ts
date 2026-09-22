import { getSupportedThinkingLevels, type ThinkingLevel } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";

const levels = ["off", "low", "medium", "high", "xhigh", "max"] satisfies ThinkingLevel[];

const choices = levels.map((value) => ({ value, description: `Set thinking to ${value}` }));

const centered = (text: string, width: number) => {
	const visible = truncateToWidth(text, width);
	const left = Math.max(0, Math.floor((width - visible.length) / 2));
	const right = Math.max(0, width - visible.length - left);
	return `${" ".repeat(left)}${visible}${" ".repeat(right)}`;
};

export default function (pi: ExtensionAPI) {
	pi.registerCommand("effort", {
		description: "Show or set the current thinking effort",
		getArgumentCompletions: (prefix) => {
			const normalizedPrefix = prefix.trim().toLowerCase();
			return choices
				.filter(({ value }) => value.startsWith(normalizedPrefix))
				.map(({ value, description }) => ({ value, label: value, description }));
		},
		handler: async (args, ctx) => {
			const requested = args.trim().toLowerCase();
			if (!requested && ctx.hasUI) {
				const availableLevels = ctx.model
					? getSupportedThinkingLevels(ctx.model).filter((level) => level !== "minimal")
					: levels;
				const currentIndex = availableLevels.indexOf(pi.getThinkingLevel());
				const selected = await ctx.ui.custom<ThinkingLevel | undefined>((tui, theme, _kb, done) => {
					let selectedIndex = Math.max(0, currentIndex);

					return {
						invalidate() {},
						handleInput(data) {
							if (matchesKey(data, Key.left) || data === "h") {
								selectedIndex = Math.max(0, selectedIndex - 1);
								tui.requestRender();
								return;
							}
							if (matchesKey(data, Key.right) || data === "l") {
								selectedIndex = Math.min(availableLevels.length - 1, selectedIndex + 1);
								tui.requestRender();
								return;
							}
							if (matchesKey(data, Key.enter)) {
								done(availableLevels[selectedIndex]);
								return;
							}
							if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
								done(undefined);
							}
						},
						render(width) {
							const trackWidth = Math.max(1, Math.min(80, width - 4));
							const slotWidth = Math.max(1, Math.floor(trackWidth / availableLevels.length));
							const sliderWidth = slotWidth * availableLevels.length;
							const pointerPosition = selectedIndex * slotWidth + Math.floor(slotWidth / 2);
							const track = [
								theme.fg("borderMuted", "─".repeat(pointerPosition)),
								theme.fg("accent", "▲"),
								theme.fg("borderMuted", "─".repeat(Math.max(0, sliderWidth - pointerPosition - 1))),
							].join("");
							const labels = availableLevels.map((level, index) => {
								const label = centered(level, slotWidth);
								return index === selectedIndex
									? theme.bold(theme.fg("accent", label))
									: theme.fg("dim", label);
							}).join("");
							return [
								theme.fg("borderMuted", "─".repeat(Math.max(1, width))),
								`  ${theme.bold(theme.fg("accent", "Effort"))}`,
								"",
								`  ${track}`,
								`  ${labels}`,
								"",
								`  ${theme.fg("dim", "←/→ choose · Enter apply · Esc cancel")}`,
								"",
							];
						},
					};
				});

				if (selected) {
					pi.setThinkingLevel(selected);
				}
				return;
			}

			if (!requested) {
				ctx.ui.notify(`Effort: ${pi.getThinkingLevel()}`, "info");
				return;
			}

			const target = levels.find((level) => level === requested);

			if (!target) {
				ctx.ui.notify(`Unknown effort: ${requested}`, "error");
				return;
			}

			pi.setThinkingLevel(target);
			const effective = pi.getThinkingLevel();
			const label = requested === effective ? effective : `${requested} (${effective})`;
			ctx.ui.notify(`Effort: ${label}`, "info");
		},
	});
}
