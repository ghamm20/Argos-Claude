# Threat Model — v1

## Addressed
- Data exfiltration via cloud calls → network-default-off, dependency audit
- Persistent host artifacts → Seven Rules + filesystem diff verification

## Named Gaps (v2+)
- Prompt injection through vault documents → week 4-5
- Model/vault tampering → week 12-13 (signed weights, audit log)
- Drive theft / physical access → week 12-13 (encryption at rest)
- Supply chain → week 2-3 (SBOM, dependency pinning)
