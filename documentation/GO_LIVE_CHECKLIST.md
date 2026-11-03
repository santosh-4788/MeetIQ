# Go-live checklist

Every line needs a name and a date. Status today (3 Nov 2026): **not ready to go live**. The release package is built. The open items below are UAT and decisions that belong to OneInsure.

| # | Item | Owner | Status |
|---|---|---|---|
| 1 | UAT signed off: Phases 2, 3, 4, recording, Phase B (`UAT_TESTING_REPORT.md`, `ACCEPTANCE_TEST_CHECKLIST.md`) | Business | ⏳ Pending |
| 2 | Production database chosen; backup taken; migrations applied (`-Plan` first) | IT / DBA | ⏳ |
| 3 | Domain (proposed `meet.oneinsure.in`), DNS record, TLS certificate | IT | ⏳ Blocked (awaiting IT) |
| 4 | Server provisioned (section 2 of the deployment guide), IIS + URL Rewrite + ARR installed | IT | ⏳ |
| 5 | Firewall/NAT approved and opened: TCP 443/80, TCP 7881, UDP 7882; SQL/RDP not public | Network team | ⏳ Blocked (approval) |
| 6 | Installer run; health check 200; services auto-start after a reboot (test once) | IT | ⏳ |
| 7 | External test: meeting from outside the office + Android phone + iPhone on mobile data (audio/video both ways, guest via link, waiting room) | Business + IT | ⏳ |
| 8 | E-mail: invitation to an external address arrives, links open the production domain | Business | ⏳ |
| 9 | Recording policies confirmed (name/version, wording, retention, access) or recording left switched off | Compliance | ⏳ Pending confirmation |
| 10 | Two-factor users informed they must set up two-factor again on the new server | IT | ⏳ |
| 11 | Backups scheduled: database, `data\keys`, `data\recordings` | IT | ⏳ |
| 12 | Monitoring of `/api/v1/health` and disk space | IT | ⏳ |
| 13 | Security testing (external scan, penetration test) | Security | ⏳ Not done yet |
| 14 | Load test with the expected 10–25 parallel meetings | Dev + IT | ⏳ Not done yet |
