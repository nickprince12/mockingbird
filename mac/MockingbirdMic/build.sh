#!/bin/sh
# Builds Mockingbird Mic (ad-hoc signed) into ~/.cache/mockingbird so the
# microphone permission survives reinstalls of the package. Rebuilding changes
# the signature, so macOS may ask for the microphone again.
set -e
cd "$(dirname "$0")"
OUT="${MOCKINGBIRD_HOME:-$HOME/.cache/mockingbird}"
APP="$OUT/MockingbirdMic.app"
rm -rf "$APP"; mkdir -p "$APP/Contents/MacOS"
cp Info.plist "$APP/Contents/Info.plist"
swiftc -O -o "$APP/Contents/MacOS/MockingbirdMic" main.swift
codesign --force -s - --identifier app.mockingbird.mic "$APP"
echo "$APP"
