---
title: Setup Commands
summary: Onboard, run, doctor, and configure
---

Instance setup and diagnostics commands.

## `sentinelai run`

One-command bootstrap and start:

```sh
pnpm sentinelai run
```

Does:

1. Auto-onboards if config is missing
2. Runs `sentinelai doctor` with repair enabled
3. Starts the server when checks pass

Choose a specific instance:

```sh
pnpm sentinelai run --instance dev
```

## `sentinelai onboard`

Interactive first-time setup:

```sh
pnpm sentinelai onboard
```

If Paperclip is already configured, rerunning `onboard` keeps the existing config in place. Use `sentinelai configure` to change settings on an existing install.

First prompt:

1. `Quickstart` (recommended): local defaults (embedded database, no LLM provider, local disk storage, default secrets)
2. `Advanced setup`: full interactive configuration

Start immediately after onboarding:

```sh
pnpm sentinelai onboard --run
```

Non-interactive defaults + immediate start (opens browser on server listen):

```sh
pnpm sentinelai onboard --yes
```

On an existing install, `--yes` now preserves the current config and just starts Paperclip with that setup.

## `sentinelai doctor`

Health checks with optional auto-repair:

```sh
pnpm sentinelai doctor
pnpm sentinelai doctor --repair
```

Validates:

- Server configuration
- Database connectivity
- Secrets adapter configuration, including AWS Secrets Manager non-secret env
  config when selected
- Storage configuration
- Missing key files

## `sentinelai configure`

Update configuration sections:

```sh
pnpm sentinelai configure --section server
pnpm sentinelai configure --section secrets
pnpm sentinelai configure --section storage
```

`--section secrets` updates the deployment-level provider used as the fallback
for secrets that do not target a specific company vault. Per-company provider
vaults (named instances, default vault selection, multiple vaults per provider,
coming-soon GCP/Vault) live in the board UI under
`Company Settings → Secrets → Provider vaults` and the
`/api/companies/{companyId}/secret-provider-configs` API.

## `sentinelai env`

Show resolved environment configuration:

```sh
pnpm sentinelai env
```

This now includes bind-oriented deployment settings such as `PAPERCLIP_BIND` and `PAPERCLIP_BIND_HOST` when configured.

## `sentinelai allowed-hostname`

Allow a private hostname for authenticated/private mode:

```sh
pnpm sentinelai allowed-hostname my-tailscale-host
```

## Local Storage Paths

| Data | Default Path |
|------|-------------|
| Config | `~/.sentinel/instances/default/config.json` |
| Database | `~/.sentinel/instances/default/db` |
| Logs | `~/.sentinel/instances/default/logs` |
| Storage | `~/.sentinel/instances/default/data/storage` |
| Secrets key | `~/.sentinel/instances/default/secrets/master.key` |

Override with:

```sh
PAPERCLIP_HOME=/custom/home PAPERCLIP_INSTANCE_ID=dev pnpm sentinelai run
```

Or pass `--data-dir` directly on any command:

```sh
pnpm sentinelai run --data-dir ./tmp/paperclip-dev
pnpm sentinelai doctor --data-dir ./tmp/paperclip-dev
```
