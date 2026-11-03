<#
.SYNOPSIS
    LAN test mode: allows colleagues on the SAME local network to reach OneInsure Connect on this laptop.
    Run ONCE in an elevated PowerShell (Run as Administrator). Remove later with disable-lan-firewall.ps1.

    Opens only these inbound ports, only for computers on this laptop's own local subnet(s):
      TCP 5173  website + API + video signalling (HTTPS, through the dev server)
      TCP 7881  video media (ICE over TCP, fallback)
      UDP 7882  video media (ICE over UDP, preferred)
    SQL Server, RDP, the API port 7180 and LiveKit's admin/signalling port 7880 are NOT opened.
#>
$ErrorActionPreference = 'Stop'
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { throw 'Please run this script in PowerShell started with "Run as Administrator".' }

$group = 'OneInsure Connect LAN test'
$rules = @(
    @{ Name = 'OneInsure Connect LAN - Web (TCP 5173)';        Protocol = 'TCP'; Port = 5173 },
    @{ Name = 'OneInsure Connect LAN - Video media (TCP 7881)'; Protocol = 'TCP'; Port = 7881 },
    @{ Name = 'OneInsure Connect LAN - Video media (UDP 7882)'; Protocol = 'UDP'; Port = 7882 }
)
foreach ($r in $rules) {
    Get-NetFirewallRule -DisplayName $r.Name -ErrorAction SilentlyContinue | Remove-NetFirewallRule
    # Profile Any: this laptop's office connection is classified "Public"; RemoteAddress LocalSubnet keeps it to the LAN.
    New-NetFirewallRule -DisplayName $r.Name -Group $group -Direction Inbound -Action Allow -Protocol $r.Protocol `
        -LocalPort $r.Port -RemoteAddress LocalSubnet -Profile Any | Out-Null
    Write-Host "Allowed: $($r.Name) (local subnet only)"
}
Write-Host "`nDone. Remove later with: scripts\lan\disable-lan-firewall.ps1 (as Administrator)."
