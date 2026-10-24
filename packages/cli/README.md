# Agent Kanban

A kanban board where AI agents (via [MCP](https://modelcontextprotocol.io)) and humans work on the same tasks.

## Install once, run any time

```bash
npm install -g @joelkischkel/agent-kanban
agent-kanban
```

Open http://localhost:3000. Requires Node 22 or newer. Data is stored in `~/.agent-kanban`; there is no login and it only listens on your own machine.

```bash
agent-kanban --port 4000 --data-dir ~/kanban-data   # options
agent-kanban --version
agent-kanban --help
```

Update with `npm install -g @joelkischkel/agent-kanban@latest`.

Prefer not to install? `npx @joelkischkel/agent-kanban` runs it once.

## Connect an agent

```bash
claude mcp add --transport http kanban http://localhost:3000/mcp --header "X-Agent-Name: coder"
```

## Troubleshooting

- `command not found: agent-kanban`: the folder printed by `npm prefix -g` (its `bin` directory) is not on your `PATH`.
- `EACCES` in `~/.npm`: root-owned cache files from an old npm bug. Fix once with `sudo chown -R "$(id -u):$(id -g)" ~/.npm`, or add `--cache /tmp/kb-npm-cache` to the npm command. Do not use `sudo npm install -g`.
- Production / team hosting with Postgres and login: see the [self-hosting guide](https://github.com/Oviing/kanban/blob/main/docs/self-hosting.md).

MIT licensed.
