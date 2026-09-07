#!/bin/sh
# Uruchamia notatki przez lokalny serwer (gdyby Chrome blokował mikrofon na file://)
cd "$(dirname "$0")"
open "http://localhost:8765/index.html"
python3 -m http.server 8765
