#!/bin/sh
# Lokalny podgląd (mikrofon wymaga http://, nie file://)
cd "$(dirname "$0")"
open "http://localhost:8765/"
python3 -m http.server 8765
