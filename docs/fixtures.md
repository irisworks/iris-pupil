# Fixture and Stub Conventions

Real tool backends (Slack, Jira, a vector store, an LLM provider) make CI expensive, flaky, and
secret-hungry. This document describes how to point your agent at fakes during PR-time
evaluation, and how Pupil keeps a stubbed run from being silently compared against a live one.

Two rules shape everything below:

1. **Pupil does not build a record/replay proxy.** WireMock, mitmproxy, VCR, Polly, and MSW
   already exist for that. Pupil defines the contract — tool endpoints are configurable, here is
   a compose fragment — and your repo owns its stubs.
2. **Interception belongs to the pre-deploy/preview tier only**, never someone else's staging.
   That's what gives the PR tier teeth: preview env + stubbed tools + cached model + forked state
   → cheap, deterministic, fast. Post-deploy stays real-everything, a small smoke suite,
   read-only traces.
