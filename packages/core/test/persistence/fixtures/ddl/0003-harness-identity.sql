
ALTER TABLE mcp_connections ADD COLUMN client_title TEXT;
ALTER TABLE mcp_connections ADD COLUMN workspace TEXT;
ALTER TABLE mcp_connections ADD COLUMN harness_source TEXT;
ALTER TABLE mcp_connections ADD COLUMN model_source TEXT;
ALTER TABLE mcp_connections ADD COLUMN harness_conflicts_json TEXT;
ALTER TABLE mcp_connections ADD COLUMN meta_json TEXT;
UPDATE mcp_connections SET workspace = agent_name WHERE agent_name IS NOT NULL;
UPDATE mcp_connections SET harness_source = 'header' WHERE harness IS NOT NULL;
UPDATE mcp_connections SET model_source = 'header' WHERE model IS NOT NULL;
CREATE INDEX idx_mcp_connections_seen ON mcp_connections(last_seen_at, connection_id);
ALTER TABLE sessions ADD COLUMN harness TEXT;
CREATE INDEX idx_sessions_harness ON sessions(harness, created_at);
