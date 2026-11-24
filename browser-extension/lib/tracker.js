// Watch-time counting and the "is it watched yet?" rule. Pure functions, so they're testable.

export const POLL_SECONDS = 5;
export const SESSION_EXPIRY_MS = 6 * 3600 * 1000;

/** Stable id for one episode or movie on one service. */
export function mediaKey(service, media) {
  const base = `${service}|${media.kind}|${media.title.toLowerCase()}`;
  return media.kind === "episode" ? `${base}|${media.season ?? 1}|${media.episode}` : base;
}

export function newSession(tabId, service, media, now) {
  return {
    key: mediaKey(service, media),
    tabId,
    service,
    media,
    state: "matching", // matching | tracking | unmatched | done | queued | error
    match: null, // { ref, name, year }
    message: "",
    watchedSeconds: 0,
    progress: 0,
    duration: 0,
    playing: false,
    lastSeen: now,
  };
}

/**
 * Fold one report from the page into the session.
 * Only time that passed while it kept playing between two reports counts, so pausing or
 * skipping ahead adds nothing.
 */
export function applyReport(session, report, now) {
  const elapsed = (now - session.lastSeen) / 1000;
  if (report.playing && session.playing && elapsed > 0 && elapsed <= POLL_SECONDS * 3) {
    session.watchedSeconds += elapsed;
  }
  session.playing = Boolean(report.playing);
  session.progress = Math.max(0, Math.min(100, Number(report.progress) || 0));
  session.duration = Number(report.duration) || 0;
  session.lastSeen = now;
  session.tabId = report.tabId ?? session.tabId;
  return session;
}

export function neededSeconds(session, settings) {
  const min = (Number(settings.minWatchedMinutes) || 0) * 60;
  return session.duration > 0 ? Math.min(min, session.duration * 0.5) : min;
}

export function isReady(session, settings) {
  return (
    session.state === "tracking" &&
    session.match !== null &&
    session.progress >= Number(settings.threshold) &&
    session.watchedSeconds >= neededSeconds(session, settings)
  );
}

export function expired(session, now) {
  return now - session.lastSeen > SESSION_EXPIRY_MS;
}
