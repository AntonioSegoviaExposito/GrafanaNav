# GrafanaNav

MCP server that lets an agent read Grafana Loki logs with free LogQL queries, using the Grafana web session of the user's Firefox. It discovers datasources, labels and label values, runs log and metric queries, and returns Grafana Explore links. Tool descriptions are complete usage manuals, LogQL cheat sheet included, so agents need no extra instructions.

## Configuration

| Variable | Required | Meaning |
|----------|----------|---------|
| `GRAFANA_URL` | yes | Grafana address as opened in the browser, including any sub-path, e.g. `https://grafana.example.com` |
| `LOKI_DATASOURCE` | no | Name or uid of the Loki datasource used when a tool call does not pass `datasource`. Without it, the only Loki datasource, or the one marked default in Grafana. |

Requires Node.js 22.13 or later (built-in `node:sqlite`).

opencode (`~/.config/opencode/opencode.json`):

```json
{
  "mcp": {
    "grafana-nav": {
      "type": "local",
      "command": ["pnpm", "dlx", "github:AntonioSegoviaExposito/GrafanaNav"],
      "environment": { "GRAFANA_URL": "https://grafana.example.com", "LOKI_DATASOURCE": "Loki" },
      "enabled": true
    }
  }
}
```

Clients using the `mcpServers` format (Claude Desktop, Cursor, …):

```json
{
  "mcpServers": {
    "grafana-nav": {
      "command": "pnpm",
      "args": ["dlx", "github:AntonioSegoviaExposito/GrafanaNav"],
      "env": { "GRAFANA_URL": "https://grafana.example.com", "LOKI_DATASOURCE": "Loki" }
    }
  }
}
```

### Sign-in

There is no token to configure. Sign in to Grafana once in Firefox or a Firefox-based browser (Zen, LibreWolf, Waterfox, Floorp), as usual. The server reads the cookies of the Grafana host from the profile that used them most recently, copying `cookies.sqlite` and its `-wal` file so the browser can stay open. Cookies of parent domains are left out.

The cookie is cached and reused until Grafana rejects it; then it is read again from the browser. If Grafana still rejects it, the tool asks the user to sign in again in the browser.

## Tools

| Tool | Does |
|------|------|
| `loki_datasources` | Loki datasources (uid, name) and which one is used by default |
| `loki_labels` | Label names, or the values of one label, in a time range; optionally only for the streams of a selector and filtered by text |
| `loki_query` | Any LogQL query: log lines (with stream labels, tail/middle truncation, optional regex `extract`, and paging) or metric series; optional Explore link |

Times accept `now`, `now-30m` (units `s m h d w`), short dates (`2026-02-11` or `11/02/2026`, spanning 00:00:00.000 in `from` to 23:59:59.999 in `to` local time), ISO timestamps (without zone = local time), and epoch seconds, milliseconds or nanoseconds. Multi-day ranges exceeding Loki's `max_query_length` are transparently split into sub-windows. The default range is the last hour.

```
STREAMS  ·  Loki  ·  2026-10-08 11:51:22.363 → 2026-10-08 12:06:22.363 Europe/Madrid

4 lines from 2 streams
labels: {app="api", env="prod", namespace="shop"}
s1: {level="error", pod="api-7b9c-x2"}
s2: {level="info", pod="api-7b9c-k8"}

2026-10-08 12:06:21.640  s1  {"level":"error","msg":"upstream timeout","route":"/orders","duration_ms":3001}
2026-10-08 12:06:21.637  s2  {"level":"info","msg":"request done","route":"/orders","duration_ms":12}
2026-10-08 12:06:21.058  s2  {"level":"info","msg":"request done","route":"/cart","duration_ms":8}
2026-10-08 12:06:21.052  s1  {"level":"error","msg":"upstream timeout","route":"/cart","duration_ms":3002}

Limit of 4 lines reached. Next page: same query with to="1791453981052000000" (the boundary line may repeat), or narrow the query.
```

Errors start with `ERR` and carry the next step: Loki's own message (syntax errors with line and column, missing matchers, too much data), the available datasources, or the accepted time formats.

## Cache

Everything lives under `<os temp dir>/grafana-nav/<hash of GRAFANA_URL>/`, readable only by the user:

- `session.json`: Grafana cookies and the browser profile they came from.
- `datasources.json`: Loki datasources, refreshed after an hour or when a requested one is missing.

Deleting the folder is harmless: the cookies are read again from the browser.

## Limits

- Queries go through Grafana's datasource proxy (`/api/datasources/proxy/uid/<uid>/loki/api/v1/...`), so they get the permissions and server limits of the signed-in user.
- Up to 5000 log lines per call; page with the `to` (or `from`) given in the footer.
- `loki_labels` lists up to 500 names or values per call.
