const PREFIX = "[griffinhgames-server]";

export function logInfo(message) {
  console.log(`${PREFIX} INFO: ${message}`);
}

export function logWarn(message) {
  console.warn(`${PREFIX} WARN: ${message}`);
}

export function logError(message) {
  console.error(`${PREFIX} ERROR: ${message}`);
}
