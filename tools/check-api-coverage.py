#!/usr/bin/env python3
"""Static route coverage check for the Android TV local API adapter."""
from pathlib import Path
root = Path(__file__).resolve().parents[1]
api = (root / 'frontend/src/lib/android-tv-api.ts').read_text()
java = (root / 'android/app/src/main/java/com/libretv/tv/MainActivity.java').read_text()
checks = {
    'status': "path === '/api/status'",
    'auth': "path === '/api/auth'",
    'search': "path === '/api/search'",
    'detail': "path === '/api/detail'",
    'source test': "path === '/api/source/test'",
    'source list': "path === '/api/source-list'",
    'publish': "path === '/api/publish'",
    'live playlist': "path === '/api/live/playlist'",
    'live EPG': "path === '/api/live/epg'",
    'live probe': "path === '/api/live/probe'",
    'quality': "path === '/api/quality'",
    'Douban': "path === '/api/douban'",
    'Bangumi': "path === '/api/bangumi/calendar'",
    'hot list': "path === '/api/hot-list'",
}
failed=[]
for name, needle in checks.items():
    ok=needle in api
    print(('PASS' if ok else 'FAIL'), name)
    if not ok: failed.append(name)
for name, needle in [('media proxy interceptor','path.startsWith("/api/proxy")'),('live stream interceptor','path.startsWith("/api/live/stream")'),('HLS playlist rewriting','rewritePlaylist(')]:
    ok=needle in java
    print(('PASS' if ok else 'FAIL'), name)
    if not ok: failed.append(name)
for needle in ['defaultSources: []','defaultLiveSources: []','defaultSubscriptions: []']:
    ok=needle in api
    print(('PASS' if ok else 'FAIL'), 'empty initial sources: '+needle)
    if not ok: failed.append(needle)
print(f'Coverage: {len(checks)+3+3-len(failed)}/{len(checks)+6} static checks')
raise SystemExit(1 if failed else 0)
