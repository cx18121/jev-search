import { resolve } from "node:path";
import {
	CX_ACTIVE_MESSAGE,
	CX_REFERENCE_ENTRY,
	CX_STATE_ENTRY,
} from "./cx.js";

export type CxAuditSessionSource = {
	path: string;
	id: string;
	modified: Date;
};

export type CxAuditSession = {
	path: string;
	id: string;
	modified: string;
	kernelVersions: string[];
	references: Array<{
		reference: string;
		version: string;
	}>;
};

type CxSessionEvidence = {
	used: boolean;
	kernelVersions: string[];
	references: CxAuditSession["references"];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const stringValue = (value: unknown) => (typeof value === "string" ? value : undefined);

const parseRecord = (line: string) => {
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch {
		return undefined;
	}
	return isRecord(value) ? value : undefined;
};

export const extractCxSessionEvidence = (content: string): CxSessionEvidence => {
	let used = false;
	const kernelVersions = new Set<string>();
	const references = new Map<string, CxAuditSession["references"][number]>();

	for (const line of content.split("\n")) {
		if (
			!line.includes(`"customType":"${CX_STATE_ENTRY}"`) &&
			!line.includes(`"customType":"${CX_ACTIVE_MESSAGE}"`) &&
			!line.includes(`"customType":"${CX_REFERENCE_ENTRY}"`)
		) {
			continue;
		}
		const entry = parseRecord(line);
		if (entry === undefined) continue;

		if (entry.type === "custom" && entry.customType === CX_STATE_ENTRY && isRecord(entry.data)) {
			if (entry.data.active === true) used = true;
			const version = stringValue(entry.data.version);
			if (entry.data.active === true && version !== undefined) kernelVersions.add(version);
		}

		if (
			entry.type === "custom_message" &&
			entry.customType === CX_ACTIVE_MESSAGE &&
			isRecord(entry.details)
		) {
			used = true;
			const version = stringValue(entry.details.version);
			if (version !== undefined) kernelVersions.add(version);
		}

		if (
			entry.type === "custom" &&
			entry.customType === CX_REFERENCE_ENTRY &&
			isRecord(entry.data)
		) {
			const reference = stringValue(entry.data.reference);
			const version = stringValue(entry.data.version);
			if (reference === undefined || version === undefined) continue;
			references.set(`${reference}\u0000${version}`, { reference, version });
		}
	}

	return {
		used,
		kernelVersions: [...kernelVersions].sort(),
		references: [...references.values()].sort(
			(left, right) =>
				left.reference.localeCompare(right.reference) ||
				left.version.localeCompare(right.version),
		),
	};
};

export const selectCxAuditSessions = (
	sources: readonly CxAuditSessionSource[],
	currentSessionFile: string | undefined,
	readSession: (path: string) => string,
	currentKernelVersion: string,
	onReadError?: (source: CxAuditSessionSource, error: unknown) => void,
): CxAuditSession[] => {
	const currentPath = currentSessionFile === undefined ? undefined : resolve(currentSessionFile);
	const sessions: CxAuditSession[] = [];

	for (const source of [...sources].sort(
		(left, right) => right.modified.getTime() - left.modified.getTime(),
	)) {
		if (currentPath !== undefined && resolve(source.path) === currentPath) continue;
		let evidence: CxSessionEvidence;
		try {
			evidence = extractCxSessionEvidence(readSession(source.path));
		} catch (error) {
			onReadError?.(source, error);
			continue;
		}
		if (!evidence.used) continue;

		sessions.push({
			path: source.path,
			id: source.id,
			modified: source.modified.toISOString(),
			kernelVersions: evidence.kernelVersions,
			references: evidence.references,
		});
	}

	const currentCohort = sessions.filter((session) =>
		session.kernelVersions.includes(currentKernelVersion),
	);
	return currentCohort.length > 0 ? currentCohort : sessions;
};
