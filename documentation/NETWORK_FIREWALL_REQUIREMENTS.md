# OneInsure Connect — Network & Firewall Requirements

**Audience:** OneInsure IT / network / security team
**Status:** REQUEST FOR REVIEW. **Nothing here has been approved or configured.** No rule may be applied until the authorised network team approves it.
**Version:** 0.1 (31 Oct 2026)

> **Not decided yet.** Hostnames, IP addresses and port choices below are *proposals*. The customer URL `meet.oneinsure.com` depends on confirming domain ownership, DNS control and IT approval. All names are configuration values in the application and can change without code changes.

---

## 1. What needs to be reachable, and why

OneInsure Connect has four server roles, all on OneInsure premises, on Windows Server 2019:

| Role | Software | Reachable from the internet? |
|---|---|---|
| **A. Application server** | IIS 10: web app + ASP.NET Core API + SignalR, Windows background worker | **Yes**: HTTPS 443 only, through the perimeter firewall/reverse proxy |
| **B. Media server** | LiveKit SFU (WebRTC), embedded TURN | **Yes**: HTTPS/WSS 443 (via A's reverse proxy) + WebRTC media ports |
| **C. Recording server** | OneInsure recorder service (headless Chromium + FFmpeg) | **No**: internal only |
| **D. Existing SQL Server** | OneInsureVideoMeetingDB | **No**: internal only |
| Supporting | Company SMTP relay, monitoring (Prometheus/Grafana), backup share | **No**: internal only |

Customers join from ordinary browsers on home Wi-Fi, mobile data and corporate networks. They install nothing. Employees join from the LAN/VPN or remotely.

## 2. DNS (proposed names, pending confirmation)

| Proposed name | Points to | Purpose |
|---|---|---|
| `meet.oneinsure.com` | Public IP-1 (application / reverse proxy) | Web app, customer join links, REST API (`/api`), SignalR (`/hubs`) |
| `media.meet.oneinsure.com` | Public IP-1 (WSS signalling via reverse proxy) | LiveKit signalling over WSS. Media itself uses IP-2 (see §4) |
| `turn.meet.oneinsure.com` | Public IP-2 (media server) | TURN/TLS relay for networks that block UDP |

- **Split-horizon DNS recommended.** Internal DNS resolves the same names to internal addresses, so employee traffic stays on the LAN and no hairpin NAT is needed.
- Records: A records (IPv4). See §7 for IPv6.
- TTL: 300 s during rollout, then the normal value.

## 3. TLS certificates

- A certificate from a **publicly trusted CA** covering `meet.oneinsure.com`, `media.meet.oneinsure.com` and `turn.meet.oneinsure.com` (SAN or wildcard `*.meet.oneinsure.com` + apex). Browsers refuse camera/microphone access and secure WebSockets without a trusted certificate.
- TLS 1.2 minimum, TLS 1.3 preferred. Legacy protocols and ciphers disabled on IIS (IIS Crypto or registry, per your hardening standard).
- Renewal: your existing CA process, or ACME (win-acme, free) if policy allows. Needs IT decision.

## 4. Public IP addresses

| Option | Description | Trade-off |
|---|---|---|
| **Recommended: 2 public IPs** | IP-1 → application/reverse proxy (443). IP-2 → media server via **1:1 static NAT** (media ports + TURN/TLS on **443**) | TURN/TLS on 443 passes through almost every customer/corporate firewall |
| Minimum: 1 public IP | 443 → reverse proxy. Media ports + TURN/TLS on **5349** forwarded to the media server | Customers behind strict firewalls (only 443 allowed) may fail to connect |

The media server must know its own public address (LiveKit `rtc.node_ip`, set explicitly). We deliberately do **not** let it discover the address through public STUN servers, so no third-party service is contacted.

## 5. Inbound firewall rules (internet → OneInsure)

| # | Source | Destination | Protocol / port | Purpose | Required? |
|---|---|---|---|---|---|
| IN-1 | Any | IP-1 → App server | TCP 443 | HTTPS web/API/SignalR + WSS signalling (reverse-proxied to LiveKit 7880) | Yes |
| IN-2 | Any | IP-1 → App server | TCP 80 | Redirect to HTTPS only (and ACME HTTP-01 if chosen) | Optional |
| IN-3 | Any | IP-2 → Media server | **UDP 7882** | WebRTC media (single multiplexed port; no large port range) | Yes |
| IN-4 | Any | IP-2 → Media server | TCP 7881 | WebRTC over TCP fallback | Yes |
| IN-5 | Any | IP-2 → Media server | UDP 3478 | TURN/UDP | Yes |
| IN-6 | Any | IP-2 → Media server | TCP 443 (2-IP option) **or** TCP 5349 (1-IP option) | TURN/TLS for UDP-blocked networks | Yes |

**Reverse-proxy rule for IN-1:** forward `wss://media.meet.oneinsure.com/rtc*` to LiveKit `:7880` and **block `/twirp/*` from the internet**. That path is LiveKit's server-administration API, used only internally by the application server.

## 6. Internal traffic (LAN only, never exposed)

| # | From | To | Protocol / port | Purpose |
|---|---|---|---|---|
| INT-1 | App server | SQL Server | TCP 1433 (TLS, encrypted connection) | Database (dedicated least-privilege login) |
| INT-2 | App server | SMTP relay | TCP 25/587 (per existing relay) | Invitations, reminders, alerts |
| INT-3 | App server | Media server | TCP 7880 | LiveKit server API (create/end rooms, mute/remove participants) |
| INT-4 | Media server | App server | TCP 443 | LiveKit webhooks (signed) |
| INT-5 | Recording server | Media server | TCP 7880 (WSS), TCP 7881, UDP 7882 | Recorder joins rooms as a hidden participant |
| INT-6 | Recording server | App server | TCP 443 | Claim recording jobs, report status |
| INT-7 | Recording server | Recording storage (local disk or file share) | SMB 445 if a separate share | Write verified MP4 files |
| INT-8 | App server | Recording storage | SMB 445 if a separate share | Authenticated playback/download streaming |
| INT-9 | Monitoring | All servers | TCP 9182 (windows_exporter), 6789 (LiveKit metrics), API metrics port | Prometheus scraping |
| INT-10 | Admin workstations | Grafana | TCP 3000 | Dashboards (internal only) |
| INT-11 | Admin workstations | Servers | RDP 3389 / WinRM 5985-5986 | Administration **from the management network/VPN only** |

## 7. Must never be exposed to the internet

- SQL Server (1433), RDP (3389), WinRM (5985/5986), SMB (445).
- LiveKit HTTP API (`7880` directly, and `/twirp/*` through the proxy), LiveKit metrics (6789), pprof/debug endpoints.
- Prometheus (9090), Alertmanager (9093), Grafana (3000), windows_exporter (9182).
- The entire recording server.
- Application administration screens. These require login, MFA and role permissions. We **also recommend** restricting `/admin` and `/api/v1/admin/*` to corporate IP ranges at the reverse proxy (your decision).

**IPv6:** recommended **off** for media unless the network team wants it. During the PoC, LiveKit advertised the host's public IPv6 and virtual-adapter addresses, and browsers picked a path with 1.5–2.4-second round-trip spikes. Production configuration pins LiveKit to the approved media NIC and IP (`rtc.ips.includes`), and Hyper-V/vEthernet adapters are excluded.

## 8. Outbound connectivity

| From | To | Purpose |
|---|---|---|
| All servers | Windows Update / WSUS, NTP, CA OCSP/CRL endpoints | Patching, time sync, certificate revocation checks |
| App server | Company SMTP relay (internal) | Email |
| Media / recording servers | **No internet access required** | Verified in the PoC: clients receive **no third-party STUN/TURN servers**. LiveKit is configured not to query public STUN |
| Customer / employee browsers | `meet.oneinsure.com` TCP 443; IP-2 UDP 7882, TCP 7881, UDP 3478, TCP 443/5349 | Joining meetings |

No paid or third-party cloud service is contacted at runtime.

## 9. Host firewall (Windows Defender Firewall), for the network team to apply after approval

Templates only. Do not apply without approval. Scope `RemoteAddress` per your zones.

```powershell
# Media server (inbound from Internet via NAT)
New-NetFirewallRule -DisplayName "OIC LiveKit RTC UDP 7882" -Direction Inbound -Protocol UDP -LocalPort 7882 -Action Allow -Program "D:\OneInsureConnect\video-server\bin\livekit-server.exe"
New-NetFirewallRule -DisplayName "OIC LiveKit RTC TCP 7881" -Direction Inbound -Protocol TCP -LocalPort 7881 -Action Allow -Program "D:\OneInsureConnect\video-server\bin\livekit-server.exe"
New-NetFirewallRule -DisplayName "OIC TURN UDP 3478"        -Direction Inbound -Protocol UDP -LocalPort 3478 -Action Allow -Program "D:\OneInsureConnect\video-server\bin\livekit-server.exe"
New-NetFirewallRule -DisplayName "OIC TURN TLS"             -Direction Inbound -Protocol TCP -LocalPort 443  -Action Allow -Program "D:\OneInsureConnect\video-server\bin\livekit-server.exe"
# LiveKit API/signalling 7880: only from the app server and recording server
New-NetFirewallRule -DisplayName "OIC LiveKit API (internal)" -Direction Inbound -Protocol TCP -LocalPort 7880 -RemoteAddress <APP_SERVER_IP>,<RECORDER_IP> -Action Allow
```

## 10. Bandwidth (estimate, to be confirmed by load test)

| Scenario | Internet uplink + downlink at the media server |
|---|---|
| Per participant at 720p | ≈ 1.5–2.5 Mbps each direction |
| 25 concurrent 1:1 customer meetings (50 participants) | ≈ 75–125 Mbps in + 75–125 Mbps out |
| Recording traffic | LAN only (recorder → media server), ≈ same again **internally** |

**Recommendation:** at least **200 Mbps symmetric** internet capacity available to the media server, plus QoS/DSCP priority for UDP 7882 if your edge supports it. This is an estimate; the 10/25-meeting load test will replace it with measured numbers.

## 11. Validation once configured (performed with the network team)

1. External TLS test of `meet.oneinsure.com` (certificate chain, TLS ≥ 1.2).
2. From a mobile-data device: open a test meeting and confirm media flows over **UDP 7882**.
3. Block UDP on a test network: confirm fallback to **TCP 7881**, then **TURN/TLS**.
4. From a strict corporate network (only 443 allowed): confirm TURN/TLS works.
5. Confirm `/twirp/*`, 7880, 1433, 3389 and Grafana are **not** reachable from outside (external port scan).
6. Confirm employees on the LAN resolve internal addresses (split-horizon DNS).

## 12. Approval record

| Item | Approved by | Date | Reference |
|---|---|---|---|
| Domain `meet.oneinsure.com` ownership / DNS control | | | |
| Public IP(s) and NAT | | | |
| Inbound rules IN-1 … IN-6 | | | |
| TLS certificate | | | |
| Internal rules INT-1 … INT-11 | | | |
| Bandwidth / QoS | | | |
