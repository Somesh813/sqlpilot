#!/bin/sh
# Runs once, on first start of an empty data volume. Creates the application user for the
# sqlpilot database. The password comes from the container environment (MONGO_APP_PASSWORD),
# which docker-compose fills from .env, so no credential is stored in this repository.
set -eu
: "${MONGO_APP_USER:?MONGO_APP_USER is required}"
: "${MONGO_APP_PASSWORD:?MONGO_APP_PASSWORD is required}"

mongosh --quiet --eval '
  const app = db.getSiblingDB("sqlpilot");
  app.createUser({
    user: process.env.MONGO_APP_USER,
    pwd: process.env.MONGO_APP_PASSWORD,
    roles: [{ role: "readWrite", db: "sqlpilot" }],
  });
'
