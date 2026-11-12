#!/bin/sh
set -eu
for value in "$POSTGRES_PASSWORD" "$LUMEN_TEST_DB_PASSWORD" "$LUMEN_TEST_DISPOSABLE_TOKEN"; do
  case "$value" in *[!a-f0-9]*|'') exit 1;; esac
  [ "${#value}" -eq 64 ]
done
psql --username "$POSTGRES_USER" --dbname lumen_test --set=ON_ERROR_STOP=1 \
  --set=runner_password="$LUMEN_TEST_DB_PASSWORD" \
  --set=disposable_token="$LUMEN_TEST_DISPOSABLE_TOKEN" <<'SQL'
CREATE ROLE lumen_test_runner LOGIN PASSWORD :'runner_password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
REVOKE CONNECT ON DATABASE postgres FROM PUBLIC;
REVOKE CONNECT ON DATABASE template1 FROM PUBLIC;
REVOKE ALL ON DATABASE lumen_test FROM PUBLIC;
GRANT CONNECT ON DATABASE lumen_test TO lumen_test_runner;
GRANT USAGE, CREATE ON SCHEMA public TO lumen_test_runner;
CREATE SCHEMA lumen_test_safety;
REVOKE ALL ON SCHEMA lumen_test_safety FROM PUBLIC;
CREATE TABLE lumen_test_safety.disposable_environment (
  singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK (singleton),
  purpose TEXT NOT NULL,
  token TEXT NOT NULL
);
INSERT INTO lumen_test_safety.disposable_environment (purpose, token)
  VALUES ('lumen-disposable-integration-v1', :'disposable_token');
REVOKE ALL ON lumen_test_safety.disposable_environment FROM PUBLIC;
GRANT USAGE ON SCHEMA lumen_test_safety TO lumen_test_runner;
GRANT SELECT ON lumen_test_safety.disposable_environment TO lumen_test_runner;
SQL
