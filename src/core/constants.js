'use strict';

module.exports = {
  APP_ID: 'beam',
  PROTOCOL_VERSION: 1,
  PROTOCOL_CONTEXT: 'BEAM-LAN-v1',

  DEFAULT_TCP_PORT: 47812,
  DISCOVERY_PORT: 47811,
  BEACON_INTERVAL_MS: 2000,
  PEER_TIMEOUT_MS: 7000,

  // Largest frame accepted off the wire (ciphertext). Anything larger kills the connection.
  MAX_FRAME_BYTES: 1024 * 1024 + 1024,
  // Plaintext file chunk size. Must stay comfortably below MAX_FRAME_BYTES.
  CHUNK_BYTES: 256 * 1024,
  MAX_TEXT_BYTES: 512 * 1024,
  MAX_FILES_PER_BATCH: 1000,

  HANDSHAKE_TIMEOUT_MS: 10000,
  PROMPT_TIMEOUT_MS: 60000,
  IDLE_TIMEOUT_MS: 30000,
  MAX_INBOUND_CONNECTIONS: 16,

  // Message types inside the encrypted channel.
  MSG: {
    PAIR_REQ: 0x10,
    PAIR_RES: 0x11,
    OFFER: 0x20,
    OFFER_RES: 0x21,
    TEXT: 0x22,
    FILE_START: 0x23,
    FILE_CHUNK: 0x24,
    FILE_END: 0x25,
    DONE: 0x26,
    ACK: 0x27,
    ERROR: 0x7f,
  },
};
