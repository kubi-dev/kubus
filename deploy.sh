#!/bin/sh
# Wypycha zmiany na GitHub -> GitHub Pages odświeża stronę w ~1 min
cd "$(dirname "$0")"
git add -A
git commit -m "${1:-aktualizacja notatek}" || true
git push
