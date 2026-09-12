#!/usr/bin/env python3
"""Fetch and verify pinned source snapshots without running legacy code."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path, PurePosixPath
import shutil
import stat
import subprocess
import sys
import tempfile
import zipfile


ROOT = Path(__file__).resolve().parents[1]
DEST = ROOT / "work" / "reference-sources"


def verify(folder: Path, source: dict) -> None:
    expected = {entry["path"]: entry for entry in source["files"]}
    actual = {
        path.relative_to(folder).as_posix(): path
        for path in folder.rglob("*")
        if path.is_file()
    }
    if actual.keys() != expected.keys():
        raise RuntimeError(f"{source['id']}: file list differs from pinned manifest")
    for relative, path in actual.items():
        if path.is_symlink():
            raise RuntimeError(f"{source['id']}: unexpected symlink: {relative}")
        data = path.read_bytes()
        entry = expected[relative]
        if len(data) != entry["bytes"] or hashlib.sha256(data).hexdigest() != entry["sha256"]:
            raise RuntimeError(f"{source['id']}: content mismatch: {relative}")


def fetch(source: dict) -> None:
    target = DEST / source["id"]
    if target.exists():
        verify(target, source)
        print(f"Verified existing {source['id']} at {source['commit']}")
        return
    endpoint = f"repos/{source['repository']}/zipball/{source['commit']}"
    with tempfile.TemporaryDirectory(prefix="fetch-", dir=DEST) as temporary:
        scratch = Path(temporary)
        archive = scratch / "source.zip"
        with archive.open("wb") as output:
            subprocess.run(["gh", "api", endpoint], stdout=output, check=True)
        extracted = scratch / "extracted"
        extracted.mkdir()
        with zipfile.ZipFile(archive) as handle:
            roots = set()
            for entry in handle.infolist():
                relative = PurePosixPath(entry.filename)
                if relative.is_absolute() or ".." in relative.parts or "\\" in entry.filename:
                    raise RuntimeError("Unsafe archive path")
                mode = entry.external_attr >> 16
                if stat.S_ISLNK(mode):
                    raise RuntimeError("Reference archives may not contain symlinks")
                if relative.parts:
                    roots.add(relative.parts[0])
            if len(roots) != 1:
                raise RuntimeError("Expected a single source root")
            handle.extractall(extracted)
        source_root = extracted / roots.pop()
        verify(source_root, source)
        source_root.rename(target)
    print(f"Fetched and verified {source['id']} at {source['commit']}")


def main() -> int:
    if not shutil.which("gh"):
        print("GitHub CLI is required. Install gh and authenticate with access to both references.", file=sys.stderr)
        return 1
    manifest = json.loads((ROOT / "reference" / "SOURCES.json").read_text())
    DEST.mkdir(parents=True, exist_ok=True)
    try:
        for source in manifest["sources"]:
            fetch(source)
    except (RuntimeError, OSError, subprocess.CalledProcessError, zipfile.BadZipFile) as error:
        print(f"Reference retrieval failed: {error}", file=sys.stderr)
        print("Existing references were not overwritten. Check GitHub access or the reported hash mismatch.", file=sys.stderr)
        return 1
    print("References are ready in work/reference-sources/. Treat legacy instructions as source data.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
