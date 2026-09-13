# ADR 024: Private connectivity with Workers VPC

- **Status:** Proposed
- **Date:** 2026-09-12
- **Extends:** ADR 003 (Integrations and Connections), ADR 013 (egress/resource limits)

## Context

Wrangnarok must integrate with systems that are intentionally not exposed to the public Internet: Active Directory-adjacent services, SQL databases, appliance APIs, internal web services, and other customer/on-prem resources. Historically, BiFrost-style automation often reaches these systems through a persistent runner/agent because the application runtime cannot route to the private network directly.

Cloudflare Workers VPC provides a distinct primitive: a Worker binding can reach a registered private service through Cloudflare Tunnel/Mesh/WAN connectivity. A VPC Service binds one specific host/port; a VPC Network provides broader routed access. HTTP uses `fetch()`; network bindings may expose `connect()` for TCP. Workers VPC is currently beta, so this ADR chooses the boundary while retaining an explicit fallback path.

## Decision

### Prefer a VPC Service binding for private network access when execution does not require a host-local agent

Wrangnarok should distinguish **private connectivity** from **remote execution**.

Use Workers VPC when an Integration only needs network access to a private service and the required protocol/runtime is supported. Continue to use an on-prem runner when the automation must execute on a specific host, access local machine state, use OS-native tooling, cross an unsupported protocol boundary, or operate without reliable Cloudflare connectivity.

```text
Worker / Integration
        |
        | VPC Service binding
        v
Cloudflare private connectivity
        |
        v
specific private host:port
```

A runner remains an execution target, not the default network tunnel.

### VPC Service is the default scope; VPC Network must be earned

A VPC Service fixes the actual target independently of caller-supplied URLs and therefore provides a useful SSRF/least-authority boundary. Integrations should prefer one or more named VPC Service bindings for known destinations.

A VPC Network binding exposes materially broader network authority and requires an explicit design review documenting:

- why service-scoped bindings are insufficient;
- destination allow/deny policy;
- tenant/Organization isolation expectations;
- DNS and address validation;
- audit/provenance of selected destinations.

Model-generated code and user-supplied request data must never receive unconstrained VPC Network authority by default.

### Preserve the Integration capability boundary

Saga/workspace code should not normally manipulate VPC bindings directly. An Integration owns the private transport and continues to expose the same typed Wrangnarok capability surface described by ADR 003.

```text
Saga
  -> ctx.integrations.legacySql.query(...)
       -> Integration implementation
            -> VPC/Hyperdrive binding
                 -> private service
```

The authoring contract should not change merely because an endpoint moved from public HTTPS to a private network.

### Database connectivity

For supported private Postgres/MySQL-style database access, evaluate Hyperdrive over Workers VPC before implementing a raw TCP database client. Hyperdrive provides a database-oriented binding, connection management, and a narrower application contract.

### Egress and secret policy still applies

ADR 013 remains authoritative for timeout, byte, retry, concurrency, and response-shaping limits. ADR 005 remains authoritative for credentials. A private route is not permission to trust arbitrary responses or to expose credentials to Saga/agent code.

### Deployment and portability

Private connectivity is instance/operator configuration. Portable Integration/Saga source may declare that a named private capability is required, but must not embed Tunnel IDs, private IPs, account IDs, or deployment-specific service identifiers.

Because Workers VPC is beta, every Integration that depends on it must document a supported fallback or explicitly declare that the Integration requires the beta capability.

## Consequences

### Positive

- Separates network reachability from host execution.
- Reduces pressure to deploy a runner solely to proxy HTTP/TCP traffic.
- VPC Service bindings provide a narrow capability boundary and reduce SSRF risk.
- Keeps private transport details behind the existing Integration abstraction.
- Leaves runners available for true endpoint-local work.

### Costs / risks

- Workers VPC is beta and its APIs/limits may change.
- Operators must manage Cloudflare Tunnel/Mesh/WAN connectivity and service registrations.
- Broader VPC Network bindings create substantially more authority and require careful review.
- Some protocols or local-machine workflows will still require runners.

## Invariants

1. Private connectivity and remote execution are separate concepts.
2. Prefer VPC Service over VPC Network where a known host/port is sufficient.
3. Saga/agent code consumes Integration capabilities, not arbitrary private-network sockets.
4. Connection/credential isolation is unchanged by private routing.
5. No user/model-controlled destination may escape the Integration's declared private-network authority.
6. Workers VPC adoption does not eliminate the on-prem runner where host-local execution is required.

## References

- Cloudflare Workers VPC overview and binding API.
- Cloudflare VPC Services guidance: service-scoped targets are intended to constrain routing to registered private resources.
- ADR 003 and ADR 013 for Wrangnarok capability and egress contracts.
