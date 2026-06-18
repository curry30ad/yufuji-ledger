@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0import-monthly-report.ps1" %*
