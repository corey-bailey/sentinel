# CLI Reference

Paperclip CLI now supports both:

- instance setup/diagnostics (`onboard`, `doctor`, `configure`, `env`, `allowed-hostname`, `env-lab`)
- control-plane client operations (issues, approvals, agents, activity, dashboard)

## Base Usage

Use repo script in development:

```sh
pnpm sentinelai --help
```

First-time local bootstrap + run:

```sh
pnpm sentinelai run
```

Choose local instance:

```sh
pnpm sentinelai run --instance dev
```

## Deployment Modes

Mode taxonomy and design intent are documented in `doc/DEPLOYMENT-MODES.md`.

Current CLI behavior:

- `sentinelai onboard` and `sentinelai configure --section server` set deployment mode in config
- server onboarding/configure ask for reachability intent and write `server.bind`
- `sentinelai run --bind <loopback|lan|tailnet>` passes a quickstart bind preset into first-run onboarding when config is missing
- runtime can override mode with `PAPERCLIP_DEPLOYMENT_MODE`
- `sentinelai run` and `sentinelai doctor` still do not expose a direct low-level `--mode` flag

Canonical behavior is documented in `doc/DEPLOYMENT-MODES.md`.

Allow an authenticated/private hostname (for example custom Tailscale DNS):

```sh
pnpm sentinelai allowed-hostname dotta-macbook-pro
```

Bring up the default local SSH fixture for environment testing:

```sh
pnpm sentinelai env-lab up
pnpm sentinelai env-lab doctor
pnpm sentinelai env-lab status --json
pnpm sentinelai env-lab down
```

All client commands support:

- `--data-dir <path>`
- `--api-base <url>`
- `--api-key <token>`
- `--context <path>`
- `--profile <name>`
- `--json`

Company-scoped commands also support `--company-id <id>`.

Use `--data-dir` on any CLI command to isolate all default local state (config/context/db/logs/storage/secrets) away from `~/.sentinel`:

```sh
pnpm sentinelai run --data-dir ./tmp/paperclip-dev
pnpm sentinelai issue list --data-dir ./tmp/paperclip-dev
```

## Context Profiles

Store local defaults in `~/.sentinel/context.json`:

```sh
pnpm sentinelai context set --api-base http://localhost:3100 --company-id <company-id>
pnpm sentinelai context show
pnpm sentinelai context list
pnpm sentinelai context use default
```

To avoid storing secrets in context, set `apiKeyEnvVarName` and keep the key in env:

```sh
pnpm sentinelai context set --api-key-env-var-name PAPERCLIP_API_KEY
export PAPERCLIP_API_KEY=...
```

## Company Commands

```sh
pnpm sentinelai company list
pnpm sentinelai company get <company-id>
pnpm sentinelai company delete <company-id-or-prefix> --yes --confirm <same-id-or-prefix>
```

Examples:

```sh
pnpm sentinelai company delete PAP --yes --confirm PAP
pnpm sentinelai company delete 5cbe79ee-acb3-4597-896e-7662742593cd --yes --confirm 5cbe79ee-acb3-4597-896e-7662742593cd
```

Notes:

- Deletion is server-gated by `PAPERCLIP_ENABLE_COMPANY_DELETION`.
- With agent authentication, company deletion is company-scoped. Use the current company ID/prefix (for example via `--company-id` or `PAPERCLIP_COMPANY_ID`), not another company.

## Issue Commands

```sh
pnpm sentinelai issue list --company-id <company-id> [--status todo,in_progress] [--assignee-agent-id <agent-id>] [--match text]
pnpm sentinelai issue get <issue-id-or-identifier>
pnpm sentinelai issue create --company-id <company-id> --title "..." [--description "..."] [--status todo] [--priority high]
pnpm sentinelai issue update <issue-id> [--status in_progress] [--comment "..."]
pnpm sentinelai issue comment <issue-id> --body "..." [--reopen]
pnpm sentinelai issue checkout <issue-id> --agent-id <agent-id> [--expected-statuses todo,backlog,blocked]
pnpm sentinelai issue release <issue-id>
```

## Agent Commands

```sh
pnpm sentinelai agent list --company-id <company-id>
pnpm sentinelai agent get <agent-id>
pnpm sentinelai agent local-cli <agent-id-or-shortname> --company-id <company-id>
```

`agent local-cli` is the quickest way to run local Claude/Codex manually as a Paperclip agent:

- creates a new long-lived agent API key
- installs missing Paperclip skills into `~/.codex/skills` and `~/.claude/skills`
- prints `export ...` lines for `PAPERCLIP_API_URL`, `PAPERCLIP_COMPANY_ID`, `PAPERCLIP_AGENT_ID`, and `PAPERCLIP_API_KEY`

Example for shortname-based local setup:

```sh
pnpm sentinelai agent local-cli codexcoder --company-id <company-id>
pnpm sentinelai agent local-cli claudecoder --company-id <company-id>
```

## Secrets Commands

```sh
pnpm sentinelai secrets list --company-id <company-id>
pnpm sentinelai secrets declarations --company-id <company-id> [--include agents,projects] [--kind secret]
pnpm sentinelai secrets create --company-id <company-id> --name anthropic-api-key --value-env ANTHROPIC_API_KEY
pnpm sentinelai secrets link --company-id <company-id> --name prod-stripe-key --provider aws_secrets_manager --external-ref <provider-ref>
pnpm sentinelai secrets doctor --company-id <company-id>
pnpm sentinelai secrets migrate-inline-env --company-id <company-id> [--apply]
```

Secret listing and declarations never print secret values. `create` accepts
`--value-env` so shell history does not capture the value. `link` records
provider-owned references without copying the secret value into Paperclip.
For AWS-backed secrets, `secrets doctor` reports missing non-secret provider
env and the expected AWS SDK runtime credential source; do not store AWS
bootstrap credentials in Paperclip secrets.

Per-company provider vaults (multiple vault instances per provider, default
vault selection, coming-soon GCP/Vault) are configured from the board UI under
`Company Settings → Secrets → Provider vaults` or through
`/api/companies/{companyId}/secret-provider-configs`. There is no CLI surface
for vault management today. See the
[secrets deploy guide](../docs/deploy/secrets.md#provider-vaults) and
[API reference](../docs/api/secrets.md#provider-vaults) for the contract.

## Approval Commands

```sh
pnpm sentinelai approval list --company-id <company-id> [--status pending]
pnpm sentinelai approval get <approval-id>
pnpm sentinelai approval create --company-id <company-id> --type hire_agent --payload '{"name":"..."}' [--issue-ids <id1,id2>]
pnpm sentinelai approval approve <approval-id> [--decision-note "..."]
pnpm sentinelai approval reject <approval-id> [--decision-note "..."]
pnpm sentinelai approval request-revision <approval-id> [--decision-note "..."]
pnpm sentinelai approval resubmit <approval-id> [--payload '{"...":"..."}']
pnpm sentinelai approval comment <approval-id> --body "..."
```

## Activity Commands

```sh
pnpm sentinelai activity list --company-id <company-id> [--agent-id <agent-id>] [--entity-type issue] [--entity-id <id>]
```

## Dashboard Commands

```sh
pnpm sentinelai dashboard get --company-id <company-id>
```

## Heartbeat Command

`heartbeat run` now also supports context/api-key options and uses the shared client stack:

```sh
pnpm sentinelai heartbeat run --agent-id <agent-id> [--api-base http://localhost:3100] [--api-key <token>]
```

## Local Storage Defaults

Local Paperclip data lives under the selected instance root. `PAPERCLIP_HOME` chooses the home directory and `PAPERCLIP_INSTANCE_ID` chooses the instance.

```text
~/.sentinel/                                     # PAPERCLIP_HOME
└── instances/
    └── default/                                  # instance root (PAPERCLIP_INSTANCE_ID)
        ├── config.json                           # runtime config
        ├── .env                                  # instance env file
        ├── db/                                   # embedded PostgreSQL data
        ├── data/
        │   ├── storage/                          # local_disk uploads
        │   └── backups/                          # automatic DB backups
        ├── logs/
        ├── secrets/
        │   └── master.key                        # local_encrypted master key
        ├── workspaces/                           # default agent workspaces
        ├── projects/                             # project execution workspaces
        ├── companies/                            # per-company adapter homes (e.g. codex-home)
        └── codex-home/                           # per-instance codex home (when not company-scoped)
```

Default paths for the canonical install:

- config: `~/.sentinel/instances/default/config.json`
- embedded db: `~/.sentinel/instances/default/db`
- logs: `~/.sentinel/instances/default/logs`
- storage: `~/.sentinel/instances/default/data/storage`
- secrets key: `~/.sentinel/instances/default/secrets/master.key`

Override base home or instance with env vars:

```sh
PAPERCLIP_HOME=/custom/home PAPERCLIP_INSTANCE_ID=dev pnpm sentinelai run
```

## Storage Configuration

Configure storage provider and settings:

```sh
pnpm sentinelai configure --section storage
```

Supported providers:

- `local_disk` (default; local single-user installs)
- `s3` (S3-compatible object storage)
