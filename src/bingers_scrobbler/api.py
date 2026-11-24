"""Small client for the Bingers API (https://bingers.app/developers.md).

Only the calls a scrobbler needs: who am I, search, and mark watched.
"""

from __future__ import annotations

from typing import Any

import requests

from . import __version__

BASE_URL = "https://api.bingers.app/v1"
MAX_ITEMS_PER_WRITE = 100


class BingersError(Exception):
    """A request the API rejected; retrying the same request won't help."""

    def __init__(self, message: str, status: int | None = None, code: str | None = None):
        super().__init__(message)
        self.status = status
        self.code = code


class AuthError(BingersError):
    """401/403: bad or revoked token, missing write scope, or no Legend/Icon plan."""


class TransientError(BingersError):
    """Network trouble, server errors, or rate limiting; safe to retry later."""

    def __init__(self, message: str, status: int | None = None, retry_after: float | None = None):
        super().__init__(message, status=status)
        self.retry_after = retry_after


class BingersClient:
    def __init__(
        self,
        token: str,
        base_url: str = BASE_URL,
        timeout: float = 15.0,
        session: requests.Session | None = None,
    ):
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.session = session or requests.Session()
        self.session.headers.update(
            {
                "Authorization": f"Bearer {token}",
                "Accept": "application/json",
                "User-Agent": f"bingers-scrobbler/{__version__}",
            }
        )

    # -- calls -------------------------------------------------------------

    def me(self) -> dict[str, Any]:
        return self._request("GET", "/me")

    def search(self, query: str, kind: str | None = None, limit: int = 10) -> list[dict[str, Any]]:
        params: dict[str, Any] = {"q": query, "limit": max(1, min(20, limit))}
        if kind:
            params["kind"] = kind
        return self._request("GET", "/search", params=params).get("items", [])

    def scrobble(self, items: list[dict[str, Any]], dry_run: bool = False) -> list[dict[str, Any]]:
        """Mark episodes/movies watched. Safe to retry: repeats within 12h are no-ops."""
        if not items:
            return []
        if len(items) > MAX_ITEMS_PER_WRITE:
            raise ValueError(f"at most {MAX_ITEMS_PER_WRITE} items per request")
        body: dict[str, Any] = {"items": items}
        if dry_run:
            body["dry_run"] = True
        return self._request("POST", "/scrobble", json=body).get("results", [])

    # -- plumbing ----------------------------------------------------------

    def _request(self, method: str, path: str, **kwargs: Any) -> dict[str, Any]:
        try:
            resp = self.session.request(method, self.base_url + path, timeout=self.timeout, **kwargs)
        except requests.RequestException as exc:
            raise TransientError(f"network error: {exc}") from exc

        status = resp.status_code
        if status == 429:
            raise TransientError(
                "rate limited by Bingers", status=status, retry_after=_retry_after(resp)
            )
        if status >= 500:
            raise TransientError(f"Bingers server error ({status})", status=status)
        if status in (401, 403):
            message, code = _error_details(resp)
            raise AuthError(message, status=status, code=code)
        if status >= 400:
            message, code = _error_details(resp)
            raise BingersError(message, status=status, code=code)

        if not resp.content:
            return {}
        try:
            data = resp.json()
        except ValueError as exc:
            raise TransientError("Bingers returned a response that isn't JSON", status=status) from exc
        return data if isinstance(data, dict) else {"data": data}


def _retry_after(resp: requests.Response) -> float:
    try:
        return max(1.0, float(resp.headers.get("Retry-After", "60")))
    except ValueError:
        return 60.0


def _error_details(resp: requests.Response) -> tuple[str, str | None]:
    try:
        err = resp.json().get("error", {})
        return err.get("message") or f"HTTP {resp.status_code}", err.get("code")
    except (ValueError, AttributeError):
        return f"HTTP {resp.status_code}", None


def display_name(me: dict[str, Any]) -> str:
    """Readable account name from GET /me, which nests the profile under "user"."""
    user = me.get("user") or {}
    handle = user.get("handle")
    name = user.get("name")
    if name and handle:
        return f"{name} (@{handle})"
    return name or (f"@{handle}" if handle else "your account")


def describe_result(result: dict[str, Any]) -> str:
    """One readable line for an ActionResult from POST /scrobble."""
    title = (result.get("title") or {}).get("title") or "?"
    ep = result.get("episode") or {}
    if ep.get("season") is not None and ep.get("number") is not None:
        title += f" S{ep['season']:02d}E{ep['number']:02d}"
    status = result.get("status", "?")
    outcome = result.get("outcome")
    text = f"{title}: {status}" + (f" ({outcome})" if outcome else "")
    if result.get("message"):
        text += f" - {result['message']}"
    return text
