#!/usr/bin/env bash
# Start both the Vite dev server and the BLE backend server.
# Usage: ./start.sh [--no-ble]

set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
BLE_PID=""

cleanup() {
  [ -n "$BLE_PID" ] && kill "$BLE_PID" 2>/dev/null
  wait 2>/dev/null
}
trap cleanup EXIT

# Install Python deps if missing.
# websockets >= 11 is required: uvicorn passes a `logger` kwarg that older
# versions (e.g. the apt-installed websockets 9.1 on Ubuntu) reject.
if ! python3 -c "import fastapi, bleak, Crypto; import websockets; from packaging.version import Version; assert Version(websockets.__version__) >= Version('11.0')" 2>/dev/null; then
  echo "[start] Installing Python dependencies..."
  pip3 install --user -r "$DIR/server/requirements.txt"
fi

# Start BLE server unless --no-ble
if [ "$1" != "--no-ble" ]; then
  echo "[start] Starting BLE server on :5051..."
  python3 "$DIR/server/ble_server.py" &
  BLE_PID=$!
fi

# Start Vite
echo "[start] Starting Vite dev server..."
npx --prefix "$DIR" vite --host

