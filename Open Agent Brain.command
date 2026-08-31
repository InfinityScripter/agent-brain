#!/bin/sh
SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
exec "$SCRIPT_DIR/bin/brain" serve --open-browser
