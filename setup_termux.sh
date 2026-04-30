#!/bin/bash
# setup_termux.sh
# Run this once inside Termux on Android to set up The Briefing.
# Usage: bash setup_termux.sh

set -e

echo ""
echo "  Setting up The Briefing..."
echo ""

# Make sure Termux packages are up to date
pkg update -y && pkg upgrade -y

# Python + pip
pkg install -y python

# Install Python dependencies
pip install flask feedparser

echo ""
echo "  Done! To start the server, run:"
echo "    python app.py"
echo ""
echo "  Then open your browser and go to:"
echo "    http://localhost:5000"
echo ""
echo "  To access it from other devices on your Wi-Fi,"
echo "  find your phone's local IP (Settings > Wi-Fi > IP address)"
echo "  and visit:  http://<your-ip>:5000"
echo ""
