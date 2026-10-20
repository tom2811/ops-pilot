#!/bin/sh
set -eu

n8n import:workflow --input=/workflow.json || true
n8n update:workflow --id=opspilot-ticket-routing --active=true || true

exec /docker-entrypoint.sh
