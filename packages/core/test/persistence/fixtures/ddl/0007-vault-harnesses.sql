
ALTER TABLE vault_bindings ADD COLUMN harnesses_json TEXT;
ALTER TABLE vault_group_policies ADD COLUMN harnesses_json TEXT;
ALTER TABLE mcp_connections ADD COLUMN harness_declared TEXT;
ALTER TABLE sessions ADD COLUMN harness_declared TEXT;
