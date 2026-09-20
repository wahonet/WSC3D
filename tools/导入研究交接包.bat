@echo off
chcp 65001 >nul
powershell -NoProfile -STA -ExecutionPolicy Bypass -File "%~dp0handover.ps1" -Mode import
