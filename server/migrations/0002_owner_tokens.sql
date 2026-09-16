-- Владелец может входить с нескольких устройств (телевизор, создавший комнату, телефон, бот):
-- у каждого устройства свой токен. rooms.owner_token_hash остаётся токеном создателя.
CREATE TABLE owner_tokens (
  id           INTEGER PRIMARY KEY,
  room_id      INTEGER NOT NULL REFERENCES rooms (id) ON DELETE CASCADE,
  token_hash   TEXT    NOT NULL UNIQUE,
  created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_seen_at TEXT    NULL
);
CREATE INDEX owner_tokens_room_idx ON owner_tokens (room_id);
