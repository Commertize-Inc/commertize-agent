"""Read-only client and CLI for the public Commertize agent surface."""

__version__ = "0.1.0"

from .client import (  # noqa: E402
    DEFAULT_BASE_URL,
    MCP_PROTOCOL_VERSION,
    NOT_OPEN_MESSAGE,
    READ_TOOLS,
    CommertizeClient,
    CommertizeError,
    NotOpenError,
)
from .keys import (  # noqa: E402
    AGENT_ACTIONS,
    PassportKey,
    address_from_private_key,
    agent_message,
    body_digest,
    canonical_json,
    generate_passport_key,
    hash_message,
    new_nonce,
    recover_address,
    sign_agent_request,
    sign_message,
)

__all__ = [
    "AGENT_ACTIONS",
    "DEFAULT_BASE_URL",
    "MCP_PROTOCOL_VERSION",
    "NOT_OPEN_MESSAGE",
    "READ_TOOLS",
    "CommertizeClient",
    "CommertizeError",
    "NotOpenError",
    "PassportKey",
    "address_from_private_key",
    "agent_message",
    "body_digest",
    "canonical_json",
    "generate_passport_key",
    "hash_message",
    "new_nonce",
    "recover_address",
    "sign_agent_request",
    "sign_message",
]
