# Registry resolver client

This package contains the single bounded HTTP contract used by C_API and C_EXT to resolve an exact Extension candidate from C_REG. It accepts only descriptor ID plus catalog revision, denies redirects and oversized responses, and rejects unknown or inconsistent candidate fields. It has no credentials, cache, retry queue, or mutation capability.
