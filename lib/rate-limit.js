const windows = new Map();
const WINDOW_MS = 60 * 1000;
const MAX_PREDICTIONS_PER_WINDOW = 5;

export function clientKey(req) {
  if (typeof req.ip === "string" && req.ip) return req.ip;
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0].trim();
  }
  return req.socket?.remoteAddress || "unknown";
}

export function allowPrediction(key, now = Date.now()) {
  const current = windows.get(key);
  if (!current || now - current.startedAt >= WINDOW_MS) {
    windows.set(key, { startedAt: now, count: 1 });
    if (windows.size > 1000) {
      for (const [entryKey, window] of windows) {
        if (now - window.startedAt >= WINDOW_MS) windows.delete(entryKey);
      }
    }
    return true;
  }
  if (current.count >= MAX_PREDICTIONS_PER_WINDOW) return false;
  current.count += 1;
  return true;
}

export function resetRateLimitsForTests() {
  windows.clear();
}
