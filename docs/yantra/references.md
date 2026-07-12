# References & inspiration

External products/ideas that inform Yantra's direction. Each entry notes why
it's relevant to this project. (Summaries below were written from prior
knowledge — the sites block automated fetching — so correct anything stale.)

## Operator-facing agentic assistant

- **Atomicwork** — https://www.atomicwork.com/
  Agentic IT / employee service management: an AI agent ("Atom") that resolves
  employee requests and runs workflows from inside Slack/Teams.
  _Relevance:_ a model for Yantra's operator surface — an agent a team *talks
  to* that gets work done, versus a read-only cockpit. Informs the Phase-4
  "rooms/chat" wrapper (personal-team agent + team agent + human).

## Model gateway / routing / observability

- **Portkey** — https://portkey.ai/
  An LLM gateway: routing/fallbacks/load-balancing across many model providers,
  plus observability (cost, latency, traces), guardrails, caching, and prompt
  management.
  _Relevance:_ the layer Yantra's model routing (`ops/yantra/routing.json`,
  `routeModel` in `turn_shared.yantra.service.ts`) and telemetry
  (`yantra_telemetry`) grow into once it runs many models and spend/quotas
  matter. Reference for the gateway + guardrails + spend-observability design.

## Conversational (WhatsApp) interface to an action-taking agent

- **Pokee AI — WhatsApp interface** —
  https://pokee.ai/blog/how-to-use-whatsapp-with-pokee-ai
  Using WhatsApp as the front door to an agent that takes real actions across
  tools and replies in-thread.
  _Relevance:_ the "chat window where I and my team-agents collaborate" idea —
  WhatsApp as the human↔agent interface for the Phase-4 wrapper, instead of (or
  alongside) a web UI.
