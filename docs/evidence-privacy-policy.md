# Evidence privacy and retention

Agent Run Evidence is an operational audit trail, not a second health-record store. It keeps identifiers, event types, lengths, hashes, structured labels, receipts, and projection revisions. It must not contain raw free-text health narratives.

## Storage policy

| Payload | Default retention | Stored form |
| --- | ---: | --- |
| Raw audio | 0 days | Not persisted |
| Raw ASR transcript | Up to 1 day | AES-256-GCM payload when a deployment key is configured |
| Corrected transcript | 0 days in Evidence | Converted to structured health facts through domain commands |
| Agent objective | 30 days | AES-256-GCM payload plus a redacted reference |
| Agent response summary | 30 days | AES-256-GCM payload plus a redacted reference |
| Agent Run Evidence | Audit retention | Redacted structure and references only |

`COMPASS_HEALTH_SENSITIVE_PAYLOAD_KEY` must contain at least 32 characters. `COMPASS_HEALTH_SENSITIVE_PAYLOAD_KEY_VERSION` identifies the active key version. If no key is configured, the server drops raw Objective and Summary text and stores only length and SHA-256 metadata; it never falls back to plaintext.

The server crypto-shreds expired ciphertext at startup by setting `ciphertext` to `NULL` and recording `deleted_at`. Hash, length, type, and non-sensitive labels remain for audit. Raw audio remains outside this table and is not retained by default.

## Access policy

Sensitive payload reads are denied by default. A requester must:

1. resolve to an active actor whose `actor_type` is `reviewer`;
2. hold an unrevoked grant for the exact Payload ID;
3. use the matching user, key version, and active encryption key;
4. request a payload that has not expired or been deleted.

Manager actors cannot read sensitive payloads, even if they know a Payload ID. Successful Reviewer reads write a metadata-only access audit containing the Reviewer Actor ID, Payload ID, and Payload Type.

Key rotation currently requires re-encrypting every live payload before replacing the configured key. Payloads under a different key version fail closed with `key_unavailable`.
