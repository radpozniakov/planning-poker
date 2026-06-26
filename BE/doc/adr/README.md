# Architecture Decision Records

Short documents capturing significant architectural decisions in the BE service: the
context, the decision, and its consequences. Referenced from code comments by id
(e.g. `ADR-001`) and from the [glossary](../glossary.md).

| ID                                                | Title                                                  | Status   |
| ------------------------------------------------- | ------------------------------------------------------ | -------- |
| [ADR-001](0001-domain-stays-socket-free.md)       | The domain stays socket-free                           | Accepted |
| [ADR-002](0002-validate-every-inbound-message.md) | Validate every inbound message, reply instead of throw | Accepted |

## Conventions

- One file per decision: `NNNN-kebab-title.md`, numbered sequentially.
- Status is one of: Proposed · Accepted · Deprecated · Superseded by ADR-NNNN.
- Don't edit an accepted ADR's decision after the fact — supersede it with a new one and
  link them, so history stays intact.
