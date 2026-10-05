# ADR 028: Cloudflare Email Service for email Triggers and notifications

- **Status:** Proposed
- **Date:** 2026-09-12
- **Extends:** ADR 012 (Triggers), ADR 037 (endpoint/webhook Triggers, renumbered from 018 by issue #225), ADR 003 (Integration capabilities)

## Context

Email is a common automation input/output channel for MSP and enterprise workflows: approvals, vendor notices, ticket-related messages, operator notifications, and systems that expose no useful webhook but can send mail.

Cloudflare Email Service provides two relevant Worker-native capabilities:

- inbound Email Routing to a Worker's `email()` handler; and
- outbound transactional sending through a `send_email` binding.

Cloudflare also supports email as a communication channel for Agents, including routing replies back to an agent/session.

## Decision

### Inbound email is a Trigger adapter

Email received by Wrangnarok is treated as another Trigger source, not as a special execution engine.

```text
Email Service routing rule
        -> Worker email() handler
             -> validate/normalize message
                  -> Trigger delivery
                       -> Saga or Agent
```

The email handler must normalize bounded metadata/content into a Wrangnarok Trigger payload and then use the same Organization, run-as, authorization, idempotency/replay, and execution contracts as other Trigger types.

Email source identity is not trusted merely because SMTP delivery succeeded. Any sender-based trust, allowlists, verification rules, signed-message requirements, or reply-token schemes are explicit endpoint policy.

### Outbound email is a capability, not ambient authority

Saga and Agent code should send email through a typed Wrangnarok capability. The implementation may use a Cloudflare `send_email` binding with configured sender/recipient restrictions.

```text
Saga / Agent
  -> ctx.notifications.email.send(...)
       -> Wrangnarok policy
            -> Email Service binding
```

Do not expose unrestricted mail-sending bindings directly to arbitrary model-generated code.

### Prefer binding-level restrictions

Where the use case has known senders or destinations, use Email Service binding restrictions (`allowed_sender_addresses`, destination restrictions/allowlists) in addition to application policy. Deployment configuration should narrow authority before runtime code sees the capability.

### Email bodies and attachments are bounded external input

Inbound messages can contain large HTML bodies, complex MIME, attachments, and hostile/untrusted content. The Trigger adapter must:

- enforce size/count bounds before durable persistence or model use;
- normalize headers/body into a predictable representation;
- keep raw/large attachments in the appropriate file/blob primitive rather than D1 rows;
- apply existing file scanning/type/retention policy where applicable;
- treat HTML/text as untrusted content, including when passed to an Agent.

### Agent replies require stable routing identity

If Agents support conversational email, replies must contain or map to a stable opaque identifier that resolves to the correct Organization, Agent, and conversation/session. Sender-controlled subject text or quoted bodies are not sufficient routing identity.

The agent runtime remains responsible for authorization/tool scope; email is only a communication channel.

### Plan/deployment constraints

Inbound Email Routing is available independently from paid outbound sending, while broad transactional sending may require Workers Paid and Cloudflare DNS/domain onboarding. Wrangnarok must therefore treat inbound and outbound support as separately detectable capabilities.

No core Saga/execution feature may require outbound Email Service for the first useful deployment.

## Consequences

### Positive

- Email becomes a native Trigger/notification channel without external mail-processing infrastructure.
- Sender/recipient restrictions can be enforced at the binding layer.
- Fits both deterministic Sagas and durable Agent conversations.
- Reuses Wrangnarok's existing Trigger and capability contracts.

### Costs / risks

- Email/MIME parsing and attachments create a large untrusted-input surface.
- Sender identity and forwarding chains are easy to misinterpret.
- Outbound service availability/plan requirements differ from inbound routing.
- Agent email content must be treated as potentially adversarial input.

## Invariants

1. Receiving an email never bypasses normal Trigger authorization/scope rules.
2. Email sender strings alone are not sufficient authorization.
3. Outbound email is a scoped capability, not ambient Worker authority for authored/model-generated code.
4. Large/raw attachments live in the file/blob path, not D1 message rows.
5. Agent reply routing uses stable opaque identifiers and rechecks authorization at execution time.
6. Email remains optional; core execution does not depend on an onboarded mail domain.

## References

- Cloudflare Email Service: inbound routing to Workers and outbound Workers binding.
- Cloudflare Email Service send-binding restrictions.
- Cloudflare Agents email communication channel guidance.
