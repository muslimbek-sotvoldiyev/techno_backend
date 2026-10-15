#!/bin/sh
set -eu

npx prisma migrate deploy
npm run admin:create
exec node dist/main.js
