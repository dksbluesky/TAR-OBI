#!/bin/sh
set -eu
cd "$(dirname "$0")"
exec caffeinate -i node monitor-service.js
