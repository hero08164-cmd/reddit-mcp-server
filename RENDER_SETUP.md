# Reddit MCP Server — Render deployment bundle

This bundle contains the compiled Reddit MCP server from the supplied `.mcpb` package,
plus a Render Blueprint (`render.yaml`) for deploying it as an HTTP Streamable MCP service.

## Deploy

1. Extract this ZIP.
2. Create a GitHub repository and upload the extracted files (not the ZIP itself).
3. In Render, choose **New → Blueprint** and connect that GitHub repository.
4. Review the `reddit-mcp-server` service and deploy it.
5. In Render → service → Environment, confirm `OAUTH_TOKEN` has a generated secret value.
6. After deploy, the MCP endpoint is:
   `https://YOUR-RENDER-SERVICE.onrender.com/mcp`

For clients, send the HTTP Authorization header:
`Authorization: Bearer YOUR_OAUTH_TOKEN`

Keep the token private. Do not paste it into public repositories, screenshots, or chats.

## Reddit credentials

No Reddit API credentials are included. The server will run in keyless mode.
Read capabilities depend on the upstream sources supported by this version. Reddit RSS
ended on 2026-11-13 according to the package README, so some listing features may be
limited; archive-backed results may be delayed or unavailable.

Write operations require Reddit API credentials and account credentials; this bundle
does not enable or promise write access without them.

## Important ChatGPT limitation

Deploying this service does not connect it to a ChatGPT Free account. Custom MCP
connections are subject to ChatGPT plan and workspace availability. Treat the Render
deployment as a separately hosted MCP endpoint for a client that supports remote MCP.

## Files

- `dist/` — compiled server
- `package.json`, `package-lock.json` — runtime package metadata/dependencies
- `render.yaml` — Render Blueprint
- `README.md`, `LICENSE` — upstream project docs and license
- `manifest.json` — original extension manifest, retained for reference

The original extension package was supplied by the user. This bundle does not alter
the upstream server implementation.
