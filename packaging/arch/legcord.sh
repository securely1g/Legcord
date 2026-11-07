#!/bin/bash
set -euo pipefail
export CHROME_DESKTOP=legcord.desktop
exec /usr/bin/electron44 --app /usr/lib/legcord/app.asar "$@"
