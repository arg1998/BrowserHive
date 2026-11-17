
UPDATE credentials SET scopes_json = '[]'
WHERE kind = 'api_token'
  AND principal_id IN (SELECT principal_id FROM principals WHERE kind = 'operator')
  AND (
    scopes_json = '["sessions:read","sessions:write","sessions:takeover","attention:read","attention:resolve","vault:read","vault:write","vault:confirm","blocklist:read","blocklist:write","system:read","system:write","logs:read","notifications:read","notifications:write","channels:read","channels:write","preferences:write","mcp:tools"]'
    OR (
      scopes_json = '["sessions:read","sessions:write","sessions:takeover","attention:read","attention:resolve","vault:read","vault:write","vault:confirm","blocklist:read","blocklist:write","system:read","system:write","logs:read","notifications:read","notifications:write","preferences:write","mcp:tools"]'
      AND created_at < (SELECT applied_at FROM schema_migrations WHERE version = 3)
    )
  );
