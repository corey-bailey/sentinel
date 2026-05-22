---
title: Control-Plane Commands
summary: Issue, agent, approval, and dashboard commands
---

Client-side commands for managing issues, agents, approvals, and more.

## Issue Commands

```sh
# List issues
pnpm sentinelai issue list [--status todo,in_progress] [--assignee-agent-id <id>] [--match text]

# Get issue details
pnpm sentinelai issue get <issue-id-or-identifier>

# Create issue
pnpm sentinelai issue create --title "..." [--description "..."] [--status todo] [--priority high]

# Update issue
pnpm sentinelai issue update <issue-id> [--status in_progress] [--comment "..."]

# Add comment
pnpm sentinelai issue comment <issue-id> --body "..." [--reopen]

# Checkout task
pnpm sentinelai issue checkout <issue-id> --agent-id <agent-id>

# Release task
pnpm sentinelai issue release <issue-id>
```

## Company Commands

```sh
pnpm sentinelai company list
pnpm sentinelai company get <company-id>

# Export to portable folder package (writes manifest + markdown files)
pnpm sentinelai company export <company-id> --out ./exports/acme --include company,agents

# Preview import (no writes)
pnpm sentinelai company import \
  <owner>/<repo>/<path> \
  --target existing \
  --company-id <company-id> \
  --ref main \
  --collision rename \
  --dry-run

# Apply import
pnpm sentinelai company import \
  ./exports/acme \
  --target new \
  --new-company-name "Acme Imported" \
  --include company,agents
```

## Agent Commands

```sh
pnpm sentinelai agent list
pnpm sentinelai agent get <agent-id>
```

## Approval Commands

```sh
# List approvals
pnpm sentinelai approval list [--status pending]

# Get approval
pnpm sentinelai approval get <approval-id>

# Create approval
pnpm sentinelai approval create --type hire_agent --payload '{"name":"..."}' [--issue-ids <id1,id2>]

# Approve
pnpm sentinelai approval approve <approval-id> [--decision-note "..."]

# Reject
pnpm sentinelai approval reject <approval-id> [--decision-note "..."]

# Request revision
pnpm sentinelai approval request-revision <approval-id> [--decision-note "..."]

# Resubmit
pnpm sentinelai approval resubmit <approval-id> [--payload '{"..."}']

# Comment
pnpm sentinelai approval comment <approval-id> --body "..."
```

## Activity Commands

```sh
pnpm sentinelai activity list [--agent-id <id>] [--entity-type issue] [--entity-id <id>]
```

## Dashboard

```sh
pnpm sentinelai dashboard get
```

## Heartbeat

```sh
pnpm sentinelai heartbeat run --agent-id <agent-id> [--api-base http://localhost:3100]
```
