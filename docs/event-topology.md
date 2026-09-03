# Event Topology Policy

Rion Studio treats event topology as the default architecture for product
behavior, communication, completion, and errors. A feature is not event-driven
merely because it emits an event after periodically checking state. The event
must originate at the authority that observed or committed the change.

## Required topology

Before implementing asynchronous behavior, identify all of the following:

1. The accepted intent or external event that starts the work.
2. The single owner allowed to commit the relevant state.
3. The identity, revision, generation, epoch, or operation fence that rejects
   stale and duplicate delivery.
4. The authoritative event or typed receipt consumed downstream.
5. The cancellation, supersede, actor-stop, stream-failure, and cleanup edges.

Commands express intent. Stored domain state, native callbacks, and typed event
streams establish facts. Getters may provide an initial revisioned snapshot but
must not be polled to discover a later change. Errors are emitted by the owner
that can prove the failed or indeterminate terminal state; consumers do not
infer errors from elapsed time or repeated readback.

## Completion policies

`EventBound` is the normal correctness policy. It has no deadline. It completes
from the exact authoritative event, cancellation, supersede, actor stop, or
event-stream failure. Surface close/isolation and focus submission/confirmation
are the reference implementations: late native events are fenced and elapsed
time cannot replace the missing lifecycle or focus event.

`DeadlineBound` is an explicit external liveness boundary. Use it only where a
native API, process, network request, storage call, or third-party callback can
fail to respond. The accepted operation declares its completion scope and
deadline before submission. If acknowledgement is absent, queued work becomes
`failed` and already-submitted mutation becomes `indeterminate` unless the owner
can prove a narrower terminal result. A deadline never means success and never
starts reconciliation polling.

Core's operation actor owns cancellation of an admitted desktop effect. It
publishes one ordered `coreEffectCancellations` record carrying the exact effect
ID, operation ID, and `operationCancelled`, `deadlineElapsed`, or `actorStopped`
reason. Electron aborts only that execution and any exact native child it owns;
the original execution promise remains the child-exit, pipe-EOF, and resource-
release fence. A deadline removes the pending Core acknowledgement before the
cancellation event is published, so any later result is classified `late` and
cannot commit. If compensating immediately would mutate a resource still owned
by that cancelled native execution, the domain preserves its durable journal,
quarantine, and ownership fence for shutdown/restart recovery instead of racing
cleanup. Cancellation is never synthesized into success.

Backoff and debounce are permitted only after an event has already established
the pending work. They may control throughput, but they cannot re-read another
authority to decide whether work exists or whether state is correct.

## Production JS and TypeScript classifications

Every direct production `setTimeout` is classified immediately above the use:

- `// event-topology: presentation` delays only visual affordances, animation,
  focus placement, or temporary feedback.
- `// event-topology: coalesce` batches already-accepted events while retaining
  the newest authoritative input.
- `// event-topology-exception: <id>` is a deliberate behavioral expiry or
  external liveness boundary recorded in the exception ledger.

`setInterval`, generic timeout wrappers such as `withTimeout`, `Promise.race`
used as a timer, and polling/watchdog/dirty-check control flow always require an
exception ID. Tests and developer tooling may use timers to bound or simulate
work, but those timers are not product evidence.

## Exception contract

Exceptions live in `docs/event-topology-exceptions.json`. Each entry names the
allowed source paths, mechanism, authoritative event, reason the event alone is
insufficient, terminal outcome, and cleanup/fence. Adding or widening an entry
is an architecture decision, not a local convenience. Remove an entry when its
last source marker disappears.

Source hygiene verifies every restricted production use, every exception ID,
its allowed paths, and unused ledger entries. The guard is a backstop; reviews
must still reject disguised polling loops, scheduled recursive reads, and
timeout-based success paths that avoid the known API names.
