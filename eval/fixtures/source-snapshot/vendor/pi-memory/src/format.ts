const META_REGEX =
  /^<!-- pi-memory \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \[[^\]\r\n]{1,8}\] -->$/;

export function isMetadataLine(line: string) {
  return META_REGEX.test(line.trim());
}

export function metadataLine(sessionId?: string, date = new Date()) {
  return `<!-- pi-memory ${date.toISOString()} [${sessionId?.slice(0, 8) || "unknown"}] -->`;
}
