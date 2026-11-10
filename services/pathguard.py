"""Path confinement for the transcription service.

The service receives a file path over HTTP. Without a guard, any caller that can
reach the port could ask it to read any file the process can read. Every
requested path must resolve inside WORK_DIR.
"""

from __future__ import annotations

from pathlib import Path


class PathNotAllowed(ValueError):
    """Raised when a requested path resolves outside the work directory."""


def resolve_in_workdir(requested: str, work_dir: str | Path) -> Path:
    base = Path(work_dir).resolve()
    candidate = Path(requested)
    if not candidate.is_absolute():
        candidate = base / candidate
    try:
        resolved = candidate.resolve()
    except (OSError, ValueError) as error:  # e.g. an embedded NUL byte
        raise PathNotAllowed(f"path cannot be resolved: {requested!r}") from error
    if resolved != base and base not in resolved.parents:
        raise PathNotAllowed(f"path is outside the work directory: {requested}")
    return resolved
