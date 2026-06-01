# Product Requirements Document

## Vision

A mobile-first assistant that gives developers full awareness and control over long-running CLI coding agents (Claude Code) while away from their desk. Not a remote desktop. Not a chat interface to the agent. A smart proxy that understands what the agents are doing and lets you look at diffs, artifacts and direct it naturally — by voice, by text, by tap — from your phone.

## Core Experience

You start a daemon on your host with projects. It connects to a relay server and begins watching the agentic sessions state. On your phone, you see what the agent is doing, can speak or type to a controller LLM (CLLM) that interprets your intent, and either answers from context or acts on the agent on your behalf as if you were at the terminal. You can walk in the park, check in on multiple projects, give direction, approve sensitive actions, and review outputs — all without touching your laptop.

## User Stories

- Direct: I want a direct chat interface to Claude Code
- Indirect: I want to chat to an assistant who sees the agents and their states, responses
- As a developer stepping away from my desk, I want to stay aware of what my agent is doing without having to read raw terminal output
- As a developer, I want to speak a direction to my assistant and have it passed to the agent correctly, without misinterpreting my project-specific terminology
- As a developer managing multiple projects, I want to switch between running agent sessions and get a quick briefing on each
- As a developer, I want to know clearly what actions will be triggered in the agent before they happen, and approve or reject them
- As a developer, I want to ask "show me that file" and see it rendered on my phone immediately, without going through the agent
- As a developer, I want to hear a short spoken summary of what the agent just did, not a full readback, and be able to interrupt it
- As a developer walking in the park or away from distractions, I want to dictate a long, thoughtful prompt to my agent — pausing mid-flow to look at a file, ask what the agent did earlier, or reconsider a direction — and have all of that woven into a coherent instruction delivered to the agent. Composing complex prompts is often easier when moving and thinking freely, without a keyboard in front of me.

## What This Is Not

- Not a way to run the agent from your phone — the agent runs on your machine
- Not a screen share or remote desktop
- Not a subscription service with hidden costs — users bring their own API keys

## Usability Risks

**Voice feel and latency** — the primary UX risk. If the round-trip from speaking to hearing a response feels slow or robotic, the product fails. Everything from STT pipeline to CLLM response to TTS streaming needs to feel sub-second for short commands. Target: <1.5s to first audio byte for a simple query.

**STT and custom terminology** — the primary feasibility risk. Internal project names, acronyms, and concepts will be transcribed inconsistently across utterances ("AuthZService" → "auth z service", "auth zee service", "authorize service"). Multiple inconsistent transcriptions of the same term are harder for the CLLM to recover than a consistently wrong one. Mitigation required at the STT layer, not just the CLLM layer.

**Action confidence** — users need to feel certain about what they're triggering in the agent. Ambiguity here erodes trust fast. The product must make pending actions explicit and confirmable before dispatch.

**Context coherence across sessions** — switching between projects while walking requires the CLLM to instantly have the right context. A stale or wrong briefing is worse than no briefing.
