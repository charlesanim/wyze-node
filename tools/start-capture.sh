#!/bin/bash
# Quick setup script for mitmproxy interception
# Run this on your Mac to start capturing Wyze traffic

set -e

echo "🔧 Wyze Vacuum Traffic Capture Setup"
echo "======================================"
echo ""

# Get Mac's IP
MAC_IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo "UNKNOWN")
echo "📡 Your Mac's IP: $MAC_IP"
echo ""

echo "📱 Android Setup Instructions:"
echo "   1. Connect Android to the SAME WiFi as this Mac"
echo "   2. Go to: Settings → Wi-Fi → tap your network → Advanced"
echo "   3. Set Proxy to 'Manual'"
echo "      - Hostname: $MAC_IP"
echo "      - Port: 8080"
echo "   4. Open Chrome on Android → go to http://mitm.it"
echo "   5. Download the Android certificate"
echo "   6. Go to: Settings → Security → Install from storage"
echo "   7. Install the downloaded certificate"
echo ""
echo "📱 iPhone Setup Instructions:"
echo "   1. Connect iPhone to the SAME WiFi as this Mac"
echo "   2. Go to: Settings → Wi-Fi → tap (i) next to your network"
echo "   3. Scroll down → Configure Proxy → Manual"
echo "      - Server: $MAC_IP"
echo "      - Port: 8080"
echo "   4. Open Safari → go to http://mitm.it"
echo "   5. Download the iOS certificate"
echo "   6. Go to: Settings → General → VPN & Device Management → install profile"
echo "   7. Go to: Settings → General → About → Certificate Trust Settings"
echo "   8. Enable full trust for mitmproxy certificate"
echo ""

echo "Press Enter to start mitmweb with Wyze capture script..."
read

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
echo "🚀 Starting mitmweb..."
echo "   Web UI: http://localhost:8081"
echo "   Proxy port: 8080"
echo "   Captured traffic saved to: $SCRIPT_DIR/../captured-traffic/"
echo ""

mitmweb -s "$SCRIPT_DIR/wyze-capture.py" --set console_eventlog_verbosity=info
