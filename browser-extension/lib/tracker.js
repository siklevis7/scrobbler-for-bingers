// Watch-time counting and the "is it watched yet?" rule. Pure functions, so they're testable.

export const POLL_SECONDS = 5;
export const SESSION_EXPIRY_MS = 6 * 3600 * 1000;
export const MIN_VIDEO_SECONDS = 240; // shorter videos are trailers, previews or clips: never marked
const MAX_GAP_SECONDS = 30 * 60; // longer gaps between reports: start counting afresh

const keyText = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Stable id for one episode or movie on one service. */
export function mediaKey(service, media) {
  const base = `${service}|${media.kind}|${keyText(media.title)}`;
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
    position: null,
    playing: false,
    counting: true, // false for previews/trailers (muted autoplay, very short videos)
    lastSeen: now,
  };
}

/**
 * Fold one report from the page into the session.
 *
 * Watch time comes from how far the video itself moved between two reports, capped by the real
 * time that passed. That way:
 * - pausing adds nothing (the position doesn't move);
 * - skipping ahead adds nothing (it moved much further than time allows);
 * - 2x speed counts real minutes, not video minutes;
 * - background tabs still count, even though Chrome slows their timers to once a minute.
 */
export function applyReport(session, report, now) {
  const elapsed = (now - session.lastSeen) / 1000;
  const position = Number.isFinite(report.position) ? report.position : null;
  const counting = report.counting !== false && !(report.duration > 0 && report.duration < MIN_VIDEO_SECONDS);
  const wasActive = session.playing || report.playing;

  if (counting && wasActive && elapsed > 0 && elapsed <= MAX_GAP_SECONDS) {
    if (position !== null && session.position !== null) {
      const moved = position - session.position;
      if (moved > 0 && moved <= elapsed * 2.5 + 5) session.watchedSeconds += Math.min(moved, elapsed);
    } else if (report.playing && session.playing && elapsed <= POLL_SECONDS * 3) {
      session.watchedSeconds += elapsed; // older pages that don't send a position
    }
  }

  session.counting = counting;
  session.playing = Boolean(report.playing);
  session.position = position;
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
    !(session.media.kind === "episode" && session.media.episode == null) && // still looking it up
    session.counting !== false &&
    session.duration >= MIN_VIDEO_SECONDS &&
    session.progress >= Number(settings.threshold) &&
    session.watchedSeconds >= neededSeconds(session, settings)
  );
}

export function expired(session, now) {
  return now - session.lastSeen > SESSION_EXPIRY_MS;
}
