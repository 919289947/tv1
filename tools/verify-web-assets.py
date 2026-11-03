#!/usr/bin/env python3
"""Fail-closed validation of a Next.js static export before it enters the APK."""
from __future__ import annotations
import json
import re
import sys
from pathlib import Path

root = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else Path(__file__).resolve().parents[1] / "frontend" / "out"
index = root / "index.html"
static = root / "_next" / "static"
errors: list[str] = []

if not index.is_file() or index.stat().st_size < 1024:
    errors.append("missing/empty index.html")
else:
    html = index.read_text(encoding="utf-8", errors="replace")
    if "ANDROID_TV_FRONTEND_NOT_BUILT" in html or "README_BUILD_REQUIRED" in html:
        errors.append("placeholder/incomplete frontend detected")
    refs = set(re.findall(r"(?:src|href)=[\"']([^\"']+)[\"']", html))
    local_refs = [r for r in refs if r.startswith("/_next/")]
    if not local_refs:
        errors.append("index.html does not reference any local Next.js assets")
    missing = [r for r in local_refs if not (root / r.lstrip("/")).is_file()]
    if missing:
        errors.append(f"referenced Next.js files are missing: {missing[:5]}")

js_files = list(static.rglob("*.js")) if static.is_dir() else []
css_files = list(static.rglob("*.css")) if static.is_dir() else []
if not js_files:
    errors.append("no Next.js JavaScript chunks found")
if not css_files:
    errors.append("no Next.js CSS chunks found")

source_pack = root / "source-pack-20261103.json"
if not source_pack.is_file():
    errors.append("optional 2026-11-03 source-pack JSON is missing")
else:
    try:
        payload = json.loads(source_pack.read_text(encoding="utf-8"))
        if len(payload.get("vod_sources", [])) != 17 or len(payload.get("live_sources", [])) != 3:
            errors.append("source pack does not contain exactly 17 VOD + 3 live entries")
    except Exception as exc:  # pragma: no cover - defensive diagnostic
        errors.append(f"source pack JSON is invalid: {exc}")

if errors:
    print("WEB ASSET VALIDATION FAILED", file=sys.stderr)
    for error in errors:
        print(f" - {error}", file=sys.stderr)
    raise SystemExit(1)

print(f"WEB ASSETS OK: {index.stat().st_size} bytes HTML, {len(js_files)} JS chunks, {len(css_files)} CSS chunks")
print("SOURCE PACK OK: 17 VOD + 3 live (bundled as optional import only)")
