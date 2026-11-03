#!/usr/bin/env python3
"""Fail-closed APK validation. A file is not publishable until all checks pass."""
from __future__ import annotations
import argparse
import json
import re
import subprocess
import sys
import zipfile
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("apk", type=Path)
parser.add_argument("--aapt", required=True, type=Path)
args = parser.parse_args()
apk = args.apk.resolve()
aapt = args.aapt.resolve()
errors: list[str] = []

if not apk.is_file():
    raise SystemExit(f"APK VALIDATION FAILED: file does not exist: {apk}")
if apk.stat().st_size < 100_000:
    errors.append(f"APK is suspiciously small ({apk.stat().st_size} bytes)")
if not aapt.is_file():
    errors.append(f"aapt not found: {aapt}")

entries: set[str] = set()
if not errors:
    try:
        with zipfile.ZipFile(apk) as zf:
            bad = zf.testzip()
            if bad:
                errors.append(f"APK ZIP CRC error: {bad}")
            entries = set(zf.namelist())
            required = [
                "AndroidManifest.xml",
                "classes.dex",
                "assets/index.html",
                "assets/source-pack-20261103.json",
            ]
            for name in required:
                if name not in entries:
                    errors.append(f"required APK entry missing: {name}")
            js = [p for p in entries if p.startswith("assets/_next/static/") and p.endswith(".js")]
            css = [p for p in entries if p.startswith("assets/_next/static/") and p.endswith(".css")]
            if not js:
                errors.append("no local Next.js JS chunks inside APK")
            if not css:
                errors.append("no local Next.js CSS chunks inside APK")
            if "assets/README_BUILD_REQUIRED.txt" in entries:
                errors.append("placeholder build marker is inside APK")
            if "assets/ANDROID_TV_FRONTEND_NOT_BUILT" in entries:
                errors.append("placeholder frontend is inside APK")
            try:
                source_pack = json.loads(zf.read("assets/source-pack-20261103.json"))
                if len(source_pack.get("vod_sources", [])) != 17 or len(source_pack.get("live_sources", [])) != 3:
                    errors.append("bundled optional source pack is not 17 VOD + 3 live")
            except Exception as exc:
                errors.append(f"bundled source pack is invalid: {exc}")
    except zipfile.BadZipFile:
        errors.append("APK is not a valid ZIP/APK file")

if not errors:
    try:
        badging = subprocess.run([str(aapt), "dump", "badging", str(apk)], check=True, text=True, capture_output=True).stdout
        if not re.search(r"^package: name='com\.libretv\.tv\.debug'", badging, re.M):
            errors.append("APK package name is not com.libretv.tv.debug")
        xmltree = subprocess.run([str(aapt), "dump", "xmltree", str(apk), "AndroidManifest.xml"], check=True, text=True, capture_output=True).stdout
        if "android.intent.category.LEANBACK_LAUNCHER" not in xmltree:
            errors.append("AndroidManifest lacks LEANBACK_LAUNCHER category")
        if "screenOrientation" not in xmltree or "landscape" not in xmltree.lower():
            errors.append("AndroidManifest does not declare landscape orientation")
    except subprocess.CalledProcessError as exc:
        errors.append(f"aapt manifest inspection failed: {exc.stderr[-2000:]}")

if errors:
    print("APK VALIDATION FAILED — do not publish this file", file=sys.stderr)
    for error in errors:
        print(f" - {error}", file=sys.stderr)
    raise SystemExit(1)

print(f"APK VALIDATION PASSED: {apk.name} ({apk.stat().st_size:,} bytes)")
print(f"Verified package: com.libretv.tv.debug")
print(f"Verified web payload: {sum(p.startswith('assets/_next/static/') and p.endswith('.js') for p in entries)} JS chunks / {sum(p.startswith('assets/_next/static/') and p.endswith('.css') for p in entries)} CSS chunks")
print("Verified TV manifest category + landscape orientation + optional 17+3 source pack")
