# OpenSphere Console security policy

The active security authority is `../DESIGN/20-MODULE/OpenSphere-Console/06-SECURITY/CONSOLE-SECURITY-TRUST-BOUNDARY-SPECIFICATION.md` and the platform authorization policy it inherits.

Do not commit credentials, private keys, bearer tokens, database passwords, signing material, decrypted evidence, or production data. Local signing keys must be created outside this repository with `scripts/Initialize-LocalCliSigningTrust.ps1`. GitHub release keys remain GitHub environment secrets and are never copied into build artifacts.

Browser code may hold only opaque HttpOnly session state. Mutation endpoints require current authorization, CSRF protection, an idempotency key, an explicit reason for risk class R1 or higher, and a durable audit/receipt transaction before an external side effect.

Report a suspected vulnerability privately to the repository owners. Do not open a public issue containing exploit details, credentials, tenant data, or production evidence. Until a dedicated security advisory address is configured, use GitHub private vulnerability reporting for the repository.

Every security change must include a negative test that proves the rejected path and must preserve redaction in logs, responses, receipts, and CI artifacts.
