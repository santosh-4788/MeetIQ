# Production Approval Checklist: OneInsure Connect

Every item must be ✅ with an owner and evidence before production deployment. Status on 31 Oct 2026: **nothing is approved**.

| # | Area | Item | Owner | Status | Evidence |
|---|---|---|---|---|---|
| 1 | Domain | Ownership and DNS control of `meet.oneinsure.com` confirmed | IT | ⛔ Pending | |
| 2 | Domain | Final hostnames approved (meet / media / turn) | IT | ⛔ Pending | NETWORK_FIREWALL_REQUIREMENTS §2 |
| 3 | TLS | Publicly trusted certificate issued; renewal process defined | IT | ⛔ Pending | §3 |
| 4 | Network | Public IP(s) + 1:1 NAT for media server | Network team | ⛔ Pending | §4 |
| 5 | Network | Inbound rules IN-1…IN-6 approved and applied | Network team | ⛔ Pending | §5 |
| 6 | Network | Internal rules INT-1…INT-11 approved | Network team | ⛔ Pending | §6 |
| 7 | Network | External scan confirms SQL/RDP/admin/`/twirp` are not exposed | Security | ⛔ Pending | §7, §11 |
| 8 | Network | Bandwidth/QoS confirmed | Network team | ⛔ Pending | §10 |
| 9 | Infrastructure | Windows Server 2019 hosts provisioned (app, media, recording), with sizing confirmed after load test | IT | ⛔ Pending | |
| 10 | Infrastructure | Recording volume: capacity, BitLocker, NTFS ACLs, backup | IT | ⛔ Pending | |
| 11 | Recording policy | Existing policy reference + its consent wording/version entered (customer recording is an existing approved activity) | Compliance (policy owner) | ⏳ Values to be supplied | RECORDING_POLICY_CONFIGURATION §0 items 1–2 |
| 12 | Recording policy | Existing retention period and expiry action entered | Compliance | ⏳ Values to be supplied | §0 item 3 |
| 13 | Recording policy | Existing legal-hold practice mapped (if any) | Compliance | ⏳ To confirm | |
| 14 | Recording policy | Existing play/download access rules mapped to roles | Compliance | ⏳ Values to be supplied | §0 item 4 |
| 15 | Recording policy | Status set to `ExistingBusinessPolicy` with the policy reference (confirm it covers OneInsure Connect, §0 item 5) | Compliance + Admin | ⏳ | Enforced by RecordingPolicyGate |
| 16 | Recording | R2 PoC: all mandatory tests PASS on Windows Server 2019 | Dev + you | ⏳ In progress | R2_RECORDER_POC_REPORT |
| 17 | Recording | Capacity for the target number of concurrent recorded meetings measured | Dev | ⏳ Not started | |
| 18 | Security | OWASP ASVS L2 verification, threat model, penetration test | Security | ⏳ Not started | |
| 19 | Performance | 10/25 concurrent meeting load test passed | Dev + IT | ⏳ Not started | |
| 20 | Resilience | SQL outage, SFU restart, recorder crash, network loss tests passed | Dev | ⏳ Partially designed | |
| 21 | Operations | Backup/restore drill passed (DB + recordings) | IT | ⏳ Not started | |
| 22 | Operations | Monitoring and alerting in place | IT | ⏳ Not started | |
| 23 | Business | UAT sign-off | Business owners | ⏳ Not started | |
| 24 | Go-live | Final go-live approval | You | ⏳ | |
