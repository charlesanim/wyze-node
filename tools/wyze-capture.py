"""
mitmproxy addon to capture and log Wyze vacuum API calls.
Filters and highlights vacuum-related traffic.

Usage:
  mitmweb -s tools/wyze-capture.py --set console_eventlog_verbosity=info

Then configure your Android phone's WiFi proxy to point to this Mac's IP:8080.
Open the Wyze app and interact with the vacuum.
"""

import json
import os
from datetime import datetime
from mitmproxy import http

LOG_DIR = os.path.join(os.path.dirname(__file__), '..', 'captured-traffic')
os.makedirs(LOG_DIR, exist_ok=True)

WYZE_DOMAINS = [
    'api.wyzecam.com',
    'wyze-venus-service.wyzecam.com',
    'auth-prod.api.wyze.com',
    'beta-ams-api.wyzecam.com',
]

# Keywords that suggest vacuum-related API calls
VACUUM_KEYWORDS = [
    'vacuum', 'sweep', 'clean', 'dock', 'charge', 'suction',
    'robot', 'map', 'room', 'venus', 'move', 'motor', 'navigate',
    'manual', 'control', 'direction', 'speed', 'wheel',
]

request_count = 0


def response(flow: http.HTTPFlow) -> None:
    global request_count

    host = flow.request.pretty_host
    if not any(domain in host for domain in WYZE_DOMAINS):
        return

    request_count += 1
    timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
    
    # Parse request body
    req_body = None
    try:
        if flow.request.content:
            req_body = json.loads(flow.request.content.decode('utf-8'))
    except (json.JSONDecodeError, UnicodeDecodeError):
        req_body = flow.request.content.hex() if flow.request.content else None

    # Parse response body
    res_body = None
    try:
        if flow.response and flow.response.content:
            res_body = json.loads(flow.response.content.decode('utf-8'))
    except (json.JSONDecodeError, UnicodeDecodeError):
        res_body = flow.response.content.hex() if flow.response and flow.response.content else None

    # Check if vacuum-related
    is_vacuum = False
    searchable = json.dumps(req_body) if req_body else ''
    searchable += json.dumps(res_body) if res_body else ''
    searchable += flow.request.url
    searchable = searchable.lower()
    is_vacuum = any(kw in searchable for kw in VACUUM_KEYWORDS)

    # Build log entry
    entry = {
        'index': request_count,
        'timestamp': timestamp,
        'is_vacuum_related': is_vacuum,
        'method': flow.request.method,
        'url': flow.request.url,
        'host': host,
        'path': flow.request.path,
        'request_headers': dict(flow.request.headers),
        'request_body': req_body,
        'response_status': flow.response.status_code if flow.response else None,
        'response_body': res_body,
    }

    # Highlight in console
    marker = '🤖 VACUUM' if is_vacuum else '📡'
    has_sig2 = 'Signature2' in dict(flow.request.headers)
    sig_marker = ' 🔐 Signature2' if has_sig2 else ''
    
    print(f"\n{'='*60}")
    print(f"{marker}{sig_marker} [{request_count}] {flow.request.method} {flow.request.url}")
    print(f"  Host: {host}")
    if req_body and isinstance(req_body, dict):
        # Show key fields
        for key in ['action_key', 'provider_key', 'instance_id', 'pid', 'pvalue', 'device_mac', 'device_model']:
            if key in req_body:
                print(f"  {key}: {req_body[key]}")
    if flow.response:
        print(f"  Response: {flow.response.status_code}")
    print(f"{'='*60}")

    # Save to file
    filename = f"{timestamp}_{request_count:04d}_{'VACUUM_' if is_vacuum else ''}{host.replace('.', '_')}.json"
    filepath = os.path.join(LOG_DIR, filename)
    with open(filepath, 'w') as f:
        json.dump(entry, f, indent=2, default=str)
