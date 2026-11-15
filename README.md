# makefun-github-forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/MerioneEason/makefun-github-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/MerioneEason/makefun-github-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone GitHub-compatible git forge in a single TypeScript process (Node standard library only), with its own object store and no outside services. It speaks git smart HTTP (protocol v0 and v2: ls-refs, fetch with shallow/deepen, receive-pack with report-status and side-band progress), the REST v3 API (repositories, branches, refs, commits, contents, labels, issues, comments, and pull requests with real three-way merges), a GraphQL endpoint with a hand-written parser and executor (queries, mutations, Relay global ids, cursor connections, batched requests, introspection), and an MCP endpoint exposing the canonical github-mcp-server tool set. All state lives behind one store, timestamps come from a logical clock, and a replayed run reproduces byte for byte. It passes all 120 conformance checks in each of the kit's three practice trials (git 30/30, repos 15/15, issues 15/15, pulls 20/20, GraphQL 20/20, MCP 15/15, protocol 5/5) and was verified end-to-end with the real git client: push, clone, annotated tags, shallow clone and deepen.

## Run it

```sh
node main.ts
```

The forge listens on its configured port and serves git HTTP, REST, GraphQL and MCP from the one process; point a real git client, gh-style REST calls or an MCP client at it.

---

<sub>Entered on [make.fun](https://make.fun/?ref=fxwd174g&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
