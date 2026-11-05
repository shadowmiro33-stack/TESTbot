@echo off
title AUTOHANDS AI QA SYSTEM - Docker All-in-One

cd /d "%~dp0"

if not exist ".env" (
    copy .env.example .env > nul
)

echo Starting Docker containers (PostgreSQL, Redis, API, Worker, Web)...
docker compose up --build

pause
