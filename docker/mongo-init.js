// Runs on first container start. Creates the application user for the sqlpilot db.
db = db.getSiblingDB('sqlpilot');
db.createUser({
  user: 'sqlpilot',
  pwd: 'sqlpilot',
  roles: [{ role: 'readWrite', db: 'sqlpilot' }],
});
