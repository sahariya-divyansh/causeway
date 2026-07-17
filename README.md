# Setu

Setu is a sync engine purpose-built and benchmarked for sustained low-bandwidth conditions, unlike existing tools which target brief disconnection.

## The Problem

Most offline-first tooling is designed around a common urban failure mode: a device loses connectivity for a short blackout, then returns to fast Wi-Fi or mobile data and catches up quickly.

That is not the shape of many rural and low-connectivity networks. In sustained low-bandwidth, high-latency, high-packet-loss environments, the network may stay technically available while still being too slow and unreliable for large sync payloads or fragile long-lived connections. EdTech apps, government service workflows, agricultural field tools, healthcare apps, and other public-interest software in low-connectivity areas need sync systems that keep making progress under those conditions.

Setu focuses on that case: small binary deltas, resumable transfer, and a deliberately scoped CRDT model that can be measured honestly under constrained network conditions.

## Architecture

```text
+------------------------------+              +------------------------------+
|           Client A           |              |           Client B           |
|                              |              |                              |
|  +------------------------+  |              |  +------------------------+  |
|  | Local SQLite store     |  |              |  | Local SQLite store     |  |
|  | - current_state        |  |              |  | - current_state        |  |
|  | - change_log           |  |              |  | - change_log           |  |
|  +-----------+------------+  |              |  +-----------+------------+  |
|              |               |              |              |               |
|   CBOR binary delta chunks   |              |   CBOR binary delta chunks   |
|   over resumable HTTP        |              |   over resumable HTTP        |
+--------------+---------------+              +--------------+---------------+
               |                                             |
               |       +----------------------------+        |
               +------>|        Relay server        |<-------+
                       | - stores chunked sessions   |
                       | - supports resume by offset |
                       +----------------------------+
```

Setu uses resumable HTTP chunk requests rather than WebSockets. In the target network profile, a WebSocket can fully die after one bad packet sequence and force the whole transfer path to recover. Individual HTTP chunk requests can be retried without losing already-confirmed progress.

## Core Design Decisions

- LWW-Register CRDT with vector clocks, deliberately scoped down for v1 instead of general-purpose OR-Sets, RGAs, or collaborative text.
- CBOR binary encoding instead of JSON for smaller wire payloads.
- Resumable chunked transport over HTTP.
- Tuple-encoded wire format for register entries to avoid repeating field names in every entry.

## Benchmark Results

Scenario: 50 concurrent edits split across 2 clients, synced through a relay server, under simulated rural 2G conditions using Linux `tc/netem`: 20kbps rate, 800ms delay, 10% packet loss. Setu was compared against RxDB and Yjs performing the equivalent sync over the same relay and network conditions. Results are averaged across 4 runs.

| Engine | Bytes Transferred | Avg Time to Convergence |
| ------ | ----------------: | ----------------------: |
| Setu   |             9,738 |                  ~70.1s |
| RxDB   |            12,722 |                  ~94.7s |
| Yjs    |            11,254 |                  ~69.2s |

Setu transferred the smallest payload of the three: 13.5% smaller than Yjs and 23.5% smaller than RxDB. Byte counts were deterministic run-to-run across all 4 runs.

Convergence time was a statistical tie with Yjs, within about 1% on average, with each engine winning some individual runs. Setu was consistently about 26% faster than RxDB across every run, with no overlap.

## The Optimization Story

The first benchmark pass exposed two real problems in the benchmark harness itself. The convergence check used `JSON.stringify`, which produced false negatives when object key ordering differed even though the logical state had converged. The initial RxDB and Yjs benchmark runners also bypassed the network entirely by syncing in-process, which stood out because their measured times were physically impossible under 800ms simulated latency.

After those harness bugs were fixed, the comparison became trustworthy enough to investigate Setu's own wire format. That investigation found that about 29% of per-entry overhead was avoidable: register entries repeated verbose named fields on the wire, and vector clocks could carry irrelevant clientId counters from unrelated keys.

Two targeted fixes addressed that overhead without expanding the v1 design: tuple-based wire encoding and key-scoped vector clocks. Together, they cut the single-entry encoded size from 135 to 96 bytes, which produced the final competitive benchmark numbers above. The benchmark harness had to be debugged before it was trustworthy, and that process is documented rather than glossed over.

## Install/Usage

Setu is organized as an npm workspace:

```text
packages/core          CRDT, SQLite storage, delta encoding, transport client
packages/relay-server  HTTP relay server for resumable chunk transfer
packages/bench         Setu, RxDB, and Yjs benchmark runners
```

Install dependencies:

```bash
npm install
```

Run the core package tests:

```bash
npm run test -w @setu/core
```

Run the relay server in development mode:

```bash
npm run dev -w @setu/relay-server
```

Run the benchmark suite:

```bash
npm run bench:all -w @setu/bench
```

The package code and local tests are cross-platform. The full netem-throttled comparison requires Linux or WSL specifically for the network simulation scripts, because `tc/netem` is a Linux traffic-control facility.

## Scope and Limitations (v1)

- Single CRDT type: LWW-Register map only.
- No OR-Sets, RGAs, or collaborative text CRDTs in v1.
- Single conflict strategy: vector clocks plus deterministic last-writer resolution.
- Relay-based sync only, with no peer-to-peer transport.
- Remaining wire-format optimizations, including clientId interning and per-key dotted vector clocks, were identified but deliberately deferred as v2 work rather than expanding the v1 scope.

## Resources/Credits

Setu's delta-state CRDT direction is informed by the DSON paper. RxDB and Yjs are used as comparison benchmarks through their public packages and repositories; their code is not copied into Setu.
