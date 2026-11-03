<#
.SYNOPSIS
    Removes the LAN test mode firewall rules created by enable-lan-firewall.ps1. Run as Administrator.
#>
$ErrorActionPreference = 'Stop'
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { throw 'Please run this script in PowerShell started with "Run as Administrator".' }
$rules = Get-NetFirewallRule -Group 'OneInsure Connect LAN test' -ErrorAction SilentlyContinue
if (-not $rules) { Write-Host 'No LAN test rules found.'; return }
$rules | ForEach-Object { Write-Host "Removing: $($_.DisplayName)" }
$rules | Remove-NetFirewallRule
Write-Host 'Done. Colleagues can no longer reach this laptop.'
