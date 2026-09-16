-- Схема из раздела 4 server-spec.md (SQLite). Даты — ISO-строки в UTC.
-- Счётчики лимитов — в памяти процесса, не здесь.

CREATE TABLE rooms (
  id               INTEGER PRIMARY KEY,
  code             TEXT    NOT NULL UNIQUE,                 -- LEAF-7K3P
  season           TEXT    NOT NULL DEFAULT 'autumn',
  password_hash    TEXT    NOT NULL,
  owner_token_hash TEXT    NOT NULL,
  settings         TEXT    NOT NULL DEFAULT '{}',           -- JSON: звук, сила ветра, ...
  tg_chat_id       INTEGER NULL,
  created_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_leaf_at     TEXT    NULL,
  expires_at       TEXT    NOT NULL                         -- год с последнего листа; без листьев — сутки
);
CREATE INDEX rooms_expires_at_idx ON rooms (expires_at);
CREATE INDEX rooms_tg_chat_id_idx ON rooms (tg_chat_id) WHERE tg_chat_id IS NOT NULL;

CREATE TABLE screens (
  id           INTEGER PRIMARY KEY,
  room_id      INTEGER NOT NULL REFERENCES rooms (id) ON DELETE CASCADE,
  token_hash   TEXT    NOT NULL UNIQUE,
  label        TEXT    NOT NULL DEFAULT '',                 -- «Телевизор в гостиной»
  user_agent   TEXT    NOT NULL DEFAULT '',
  last_seen_at TEXT    NULL,
  created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX screens_room_id_idx ON screens (room_id);

CREATE TABLE leaves (
  id                TEXT    PRIMARY KEY,                    -- uuid, задаётся приложением
  room_id           INTEGER NOT NULL REFERENCES rooms (id) ON DELETE CASCADE,
  kind              TEXT    NOT NULL,                       -- вид из манифеста: maple, oak, ...
  name              TEXT    NOT NULL DEFAULT '',            -- имя автора, до 20 символов
  author_token_hash TEXT    NOT NULL,                       -- токен гостя: «мои листья», удалить своё
  tex_key           TEXT    NOT NULL,                       -- пути в data/: rooms/{code}/leaves/{id}/...
  thumb_key         TEXT    NOT NULL,
  orig_key          TEXT    NULL,                           -- оригинал 1024 px, живёт 7 дней
  normal_key        TEXT    NOT NULL,
  thick_key         TEXT    NOT NULL,
  atlas_slot        INTEGER NOT NULL,
  created_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at        TEXT    NULL
);
CREATE INDEX leaves_room_live_idx ON leaves (room_id, created_at) WHERE deleted_at IS NULL;
CREATE INDEX leaves_orig_cleanup_idx ON leaves (created_at) WHERE orig_key IS NOT NULL;

-- Коды привязки телевизора: живут 10 минут, просроченные чистятся при обращении.
CREATE TABLE pairing_codes (
  code         TEXT    PRIMARY KEY,                         -- 4 символа с экрана
  screen_token TEXT    NOT NULL,
  room_id      INTEGER NULL REFERENCES rooms (id) ON DELETE CASCADE,
  expires_at   TEXT    NOT NULL
);
CREATE INDEX pairing_codes_expires_idx ON pairing_codes (expires_at);

-- Статистика без персональных данных: что и когда произошло в комнате.
CREATE TABLE events (
  id      INTEGER PRIMARY KEY,
  room_id INTEGER NULL REFERENCES rooms (id) ON DELETE SET NULL,
  type    TEXT    NOT NULL,                                 -- room.created, leaf.new, leaf.deleted, screen.paired, ...
  at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX events_room_at_idx ON events (room_id, at);
CREATE INDEX events_type_at_idx ON events (type, at);
