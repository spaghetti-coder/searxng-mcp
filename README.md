# searxng-mcp

MCP server for web search via SearXNG. Exposes a `search` tool over Streamable HTTP transport, with a built-in queue that adds random 5–9 s delays between requests to avoid rate limiting from the upstream search engines.

## Requirements

- Node.js 22+ or Docker engine
- A running [SearXNG](https://github.com/searxng/searxng) instance with JSON format enabled

## Run

<details><summary>Locally</summary>

Create a `.env` file (see `compose.yaml` for supported env variable) and run:

```bash
npm install
npm start
```
</details>

<details><summary>Docker</summary>

Modify `compose.yaml` file if required and:

```bash
docker compose up -d
docker logs searxng-mcp
```
</details>

## Connect an MCP client

The server listens on `POST /mcp` (Streamable HTTP transport).

<details><summary>Claude Code</summary>

`~/.claude.json`

```json
{
  "mcpServers": {
    "searxng": {
      "type": "http",
      "url": "http://localhost:3000/mcp"
    }
  }
}
```

`~/.claude/settings.json` (to avoid asking permission)

```json
{
  "$schema": "https://json.schemastore.org/claude-code-settings.json",
  "permissions": {
    "allow": [
      "mcp__searxng__*"
    ]
  }
}
```
</details>

<details><summary>OpenCode</summary>

`~/.config/opencode/opencode.json`

```json
{
  "mcp": {
    "searxng": {
      "type": "remote",
      "url": "http://localhost:3000/mcp"
    }
  }
}
```
</details>

<details><summary>OpenClaw</summary>

`~/.openclaw/openclaw.json`

```json
{
  "mcp": {
    "servers": {
      "searxng": {
        "url": "http://localhost:3000/mcp",
        "transport": "streamable-http"
      }
    }
  }
}
```
</details>

## Testing


<details><summary>with curl</summary>

```bash
# Health check
curl http://localhost:3000/health

# List available tools
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'

# Call the search tool
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"search","arguments":{"query":"hello world"}}}'

# Search with pagination
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"search","arguments":{"query":"hello world","pageno":2}}}'
```
</details>

## Tool

| Name | Parameters | Description |
|---|---|---|
| `search` | `query` (string), `pageno` (int, default 1) | Search the web via SearXNG |

## SearXNG setup

SearXNG must have JSON format enabled in `settings.yml`:

```yaml
search:
  formats:
    - html
    - json
```
