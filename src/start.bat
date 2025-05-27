@echo off
echo Starting Telegram Bot...
set NODE_TLS_REJECT_UNAUTHORIZED=0
npx ts-node src/bot.ts
pause