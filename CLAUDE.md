# CLAUDE.md — Agente IA de Consultas

## Claude Code behavior rules

Read this section first. These rules apply to every task in this repo.

- **Inspect before editing.** Read the relevant file completely before making any change. Never assume its current content from memory.
- **Do not create new files unless explicitly requested.** The structure is established. New files require a clear reason.
- **Do not restructure folders** without explicit instruction.
- **Do not install new dependencies** without explicit instruction.
- **Prefer the smallest safe change.** Do not refactor code that is not part of the requested task.
- **Environment variables must be validated at startup.** If a required variable is missing, the process must throw and exit — never start with silent missing config.
- **When in doubt, ask — do not guess.**

---

## Project overview

**Agente IA de Consultas** is a productized AI agent service for independent professionals
and small service firms. The agent handles first-contact commercial conversations over
WhatsApp: qualifying leads, answering service questions, collecting contact info, booking
consultation requests, and escalating to the human professional when needed.

Built by Grimorio de Plata as a repeatable service — not a one-off custom build.
Each deployment is a configured instance. Only the commercial portfolio changes per client.

**First niche:** Dermatology clinics.
**First hypothetical client:** Clínica Dermatológica Lumina (`client_id: lumina-gdl`).

This project is separate from SALO. It shares architectural patterns but no codebase.

---

## Architecture

```
Prospect (WhatsApp message)
         ↓
Meta WhatsApp Cloud API
         ↓
n8n Cloud — Message Router
  ├─ Validate webhook signature
  ├─ Buffer burst messages (3s window)
  └─ POST → AI Agent Backend
         ↓
Railway — Node.js AI Agent API  ← THIS REPO
  ├─ Load commercial portfolio (/portfolios/{client_id}.md)
  ├─ Load conversation history (MongoDB, rolling 20 turns)
  ├─ Construct prompt (system + history + message)
  ├─ Call Claude API
  └─ Return: { reply, intent, escalate, lead_data }
         ↓
n8n Cloud — Response Router
  ├─ → WhatsApp reply (Meta Cloud API)
  ├─ → Airtable: upsert lead record
  ├─ → Airtable: create appointment (if intent = schedule)
  └─ → Professional alert (if escalate = true)
```

**Boundary rule — enforced always:**
This backend owns all AI logic: prompt construction, Claude API calls, intent
classification, conversation history, escalation flag.
This backend does NOT send WhatsApp messages. That is n8n's job.
This backend does NOT write to Airtable. That is n8n's job.
Never cross this boundary.

---

## API contract

### POST /api/message

**Request body:**

```json
{
  "client_id": "lumina-gdl",
  "phone": "+523312345678",
  "message": "Hola, ¿cuánto cuesta una consulta?",
  "timestamp": 1718000000000
}
```

**Response:**

```json
{
  "reply": "¡Hola! Soy Valeria de la Clínica Dermatológica Lumina...",
  "intent": "inform",
  "escalate": false,
  "lead_data": {
    "name": null,
    "service_interest": "consulta_general",
    "contact_time_preference": null
  }
}
```

**Intent values:**

- `inform` — agent answered a service or commercial question
- `qualify` — agent is collecting information to qualify the lead
- `schedule` — patient requested an appointment (triggers Airtable appointment record)
- `escalate` — case requires immediate human attention (triggers professional alert)
- `out_of_scope` — question outside commercial scope, agent deflected

**escalate: true** triggers the professional alert workflow in n8n regardless of intent value.
A message can have `intent: "inform"` and `escalate: false`, or `intent: "escalate"` and
`escalate: true`. The `escalate` boolean is what n8n reads — always include it.

**lead_data** fields are all nullable. Include only what the patient mentioned naturally.
Never prompt the patient for all fields at once.

### GET /health

Returns `{ status: "ok", client_id: string, timestamp: number }`.
Used by Railway and n8n to verify the service is running.

---

## Project structure

```
/
├── CLAUDE.md                     # This file
├── src/
│   ├── index.ts                  # Entry point — Express app setup, env validation
│   ├── routes/
│   │   └── message.route.ts      # POST /api/message handler
│   ├── services/
│   │   ├── portfolio.service.ts  # Load and cache commercial portfolio per client_id
│   │   ├── history.service.ts    # Read/write conversation history (MongoDB)
│   │   ├── prompt.service.ts     # Build the full prompt (system + history + message)
│   │   └── claude.service.ts     # Call Claude API, parse response, extract intent
│   ├── middleware/
│   │   └── webhook.middleware.ts # Timing-safe webhook signature validation
│   └── types.ts                  # Shared TypeScript types
├── portfolios/
│   └── lumina-gdl.md             # Commercial portfolio — Clínica Dermatológica Lumina
├── tests/
│   └── quality/
│       ├── messages.json         # 50 test messages (categorized)
│       └── run-test.js           # Test runner — POSTs to localhost, writes results.json
├── .env.example                  # Template — safe to commit
├── .env                          # Local dev — never commit
└── package.json
```

---

## Environment variables

All variables are required. The app throws at startup if any are missing.

```
# Core
CLIENT_ID=lumina-gdl
PORT=3000

# Claude API
CLAUDE_API_KEY=

# MongoDB (conversation history)
MONGODB_URI=

# Webhook security
WEBHOOK_SECRET=

# Environment
NODE_ENV=development
```

**Rules:**

- Never hardcode any of these values in source code
- Never commit `.env` — only `.env.example`
- `WEBHOOK_SECRET` must match the secret configured in n8n
- `CLIENT_ID` determines which portfolio file is loaded at startup

---

## Commercial portfolio

**Location:** `/portfolios/{client_id}.md`

The portfolio is a Markdown document that teaches the AI agent everything about a specific
business: services, prices, commercial rules, FAQs, scope limits, tone, and escalation
triggers. It is the single most important configuration artifact.

**Loading:** Loaded once at startup by `portfolio.service.ts` and cached in memory.
A portfolio change requires a redeploy. Communicate a 24-hour turnaround SLA to clients.

**Current portfolio:** `portfolios/lumina-gdl.md` — Clínica Dermatológica Lumina.

**Do not hardcode any business information in prompt construction code.**
All business knowledge lives in the portfolio file. The prompt builder reads it —
it never assumes anything about the business.

---

## Conversation history

**Storage:** MongoDB. Collection: `conversations`.
**Document structure per phone number:**

```json
{
  "client_id": "lumina-gdl",
  "phone": "+523312345678",
  "turns": [
    { "role": "user", "content": "...", "timestamp": 0 },
    { "role": "assistant", "content": "...", "timestamp": 0 }
  ],
  "updated_at": "2024-01-01T00:00:00Z"
}
```

**Rolling window:** Keep the last 20 turns maximum. Older turns are dropped before
building the prompt. Never send the full history to Claude.

**Do not use Airtable for conversation history.** Airtable has API rate limits (5 req/sec
on free tier) that break under concurrent conversations. MongoDB handles this cleanly.

---

## Prompt construction

The system prompt sent to Claude on every message has this structure:

```
[COMMERCIAL PORTFOLIO — full contents of /portfolios/{client_id}.md]

---

REGLAS DEL SISTEMA (no modificar):
- Nunca des consejos médicos, legales, financieros o fiscales
- Nunca confirmes disponibilidad — siempre indica que el equipo confirmará
- Nunca cotices un precio definitivo sin evaluación previa
- Siempre ofrece conectar con el profesional cuando la pregunta exceda tu alcance
- Responde en máximo 3-4 líneas por mensaje
- Devuelve tu respuesta en formato JSON: { reply, intent, escalate, lead_data }

HISTORIAL DE CONVERSACIÓN:
[last N turns from MongoDB]

MENSAJE ACTUAL:
[patient's message]
```

**The JSON response format is mandatory.** `claude.service.ts` parses the JSON and
returns the structured object to the route handler. If parsing fails, return a
graceful fallback reply and log the raw response for debugging.

---

## Hard rules — enforced in every prompt

These rules are included in the system prompt and must never be removed or weakened:

1. Never give medical, legal, financial, or tax advice
2. Never confirm availability — always say the team will confirm
3. Never quote a final price without prior evaluation (unless portfolio explicitly permits)
4. Always offer to connect with the professional when question exceeds scope
5. Never collect sensitive medical documents or health details over WhatsApp
6. If patient describes a severe allergic reaction or medical emergency → direct to
   urgencias / 911 immediately, do not attempt to handle

---

## Escalation logic

The backend sets `escalate: true` when the patient's message matches any of:

**Medical (high priority):**

- Lesion that changed rapidly in shape, color, or size
- Wound or sore that does not heal
- Bleeding, ulceration, or crust on a lesion
- Systemic symptoms alongside skin manifestation
- Signs of severe allergic reaction (swelling, difficulty breathing)

**Procedural (medium priority):**

- Complication from a previous procedure (this clinic or another)
- Request to reverse a treatment

**Commercial (medium priority):**

- Direct request to speak with the doctor
- Referral from a known contact
- Group booking request (5+ people)
- Any question the agent cannot answer from the portfolio

When `escalate: true`, n8n sends an immediate WhatsApp alert to the professional
with: patient name, phone, summary, and timestamp.

---

## Security

**Webhook validation:** Every incoming request to `/api/message` must pass
timing-safe HMAC signature validation against `WEBHOOK_SECRET`.
See `middleware/webhook.middleware.ts`. Never bypass this in any environment.

**What is safe:**

- No secrets or API keys in source code
- `.env` excluded from version control
- Conversation history contains no sensitive medical data — only message text

**What to never do:**

- Never log the full conversation payload in production (may contain patient info)
- Never store diagnosed conditions, medications, or health records
- Never share banking details with patients — that is the human team's job
- Never commit `.env` to version control

---

## Multi-tenancy — current state

**MVP:** Single client per deployment. `CLIENT_ID` is set in environment variables.
One Railway service per client. Simple and isolated.

**Do not build multi-tenant routing yet.** This changes after client 3.
When that time comes, the refactor is: read `client_id` from the request body,
validate it against an allowed list, load the correct portfolio dynamically.

---

## Quality testing

### 50-message quality test

Required before any Go Live. Must be re-run after any significant portfolio change.

**Test file:** `tests/quality/messages.json`
**Test runner:** `tests/quality/run-test.js`
**Results output:** `tests/quality/results.json`

**Pass threshold:** 40/50 messages score 3/3 (80%)

### Scoring dimensions (1 point each)

1. **Scope compliance** — agent stayed within commercial role, no medical advice given
2. **Response quality** — correct length (3-4 lines), tone, and relevance for WhatsApp
3. **Intent accuracy** — correct intent classification and escalation flag

### Message categories (50 total)

- 8 basic service inquiry
- 8 price questions
- 6 availability and scheduling
- 6 qualification edge cases
- 8 advice-seeking (must deflect)
- 6 urgency and escalation triggers
- 4 off-topic noise
- 4 multi-turn sequences (2 sequences of 2 messages)

### Stages

- **Stage 1 (pre-code):** Run manually in Claude chat with portfolio as system context.
  Score with spreadsheet. Iterate portfolio until 80% pass. ✅ Completed — 97.5% pass rate.
- **Stage 2 (post-backend):** `node tests/quality/run-test.js` → review `results.json`
- **Stage 3 (pre-Go Live):** Full flow via Meta sandbox number

### Portfolio validation status

Stage 1 completed. Score: 39/40 messages tested = 97.5%.

**Two corrections applied to portfolio after test:**

1. Prices must be written in prose, never listed with dashes or special characters
2. Deflection responses must not suggest treatment alternatives even in general terms

---

## n8n workflow responsibilities

n8n is the orchestration layer. Logic lives here in the backend. n8n routes and connects.

| Workflow             | Trigger                        | Actions                                           |
| -------------------- | ------------------------------ | ------------------------------------------------- |
| Receive message      | Meta webhook POST              | Validate sig → buffer 3s → POST /api/message      |
| Send reply           | Backend response               | Send WhatsApp text via Meta Cloud API             |
| Log lead             | Every response                 | Upsert Airtable Leads record                      |
| Schedule appointment | intent = schedule              | Create Airtable Appointments record + notify team |
| Escalation alert     | escalate = true                | WhatsApp alert to professional with summary       |
| Follow-up #1         | Lead inactive 24h              | Send follow-up message                            |
| Follow-up #2         | Lead inactive 72h after #1     | Send final message, set status = no_convertido    |
| Out of hours         | Message outside business hours | Send out-of-hours response, log contact           |

---

## Airtable — client CRM layer

Airtable is the client-facing data interface. The professional sees all lead data there.
This backend does NOT write to Airtable directly — n8n handles all Airtable operations.

**Tables:** Leads, Appointments, Services (catalog reference), Conversations (optional log)

**Airtable limitations — inform every client in writing:**

- Not a certified platform for sensitive medical or health data
- API rate limit: 5 req/sec (free), 50 req/sec (paid)
- No automatic backups — client owns their data
- If Airtable has downtime, lead logging stops but AI conversations continue

---

## Meta / WhatsApp setup — per client

Each client requires their own:

- Meta Business Manager (owned by client)
- WhatsApp Business Account / WABA (owned by client)
- Business phone number (owned by client)

Grimorio de Plata gets developer access to the client's WABA — does not own it.
If the client stops the service, they revoke access. Their number and history stay with them.

**Meta verification:** Takes 2–4 weeks per client. Cannot be accelerated.
Start verification on day one of signing. Never promise a Go Live date without
confirmed verification status.

**Always use a sandbox test number during development.** Never test on the client's
production WhatsApp number.

---

## Patterns inherited from SALO (validated, reuse directly)

| Pattern                                 | Implementation                                       |
| --------------------------------------- | ---------------------------------------------------- |
| Message buffer (burst messages)         | n8n: 3-second accumulation window before processing  |
| Escalation flag in API response         | `escalate: boolean` in every response — n8n reads it |
| Rolling conversation window             | Last 20 turns from MongoDB — older turns dropped     |
| Timing-safe webhook validation          | `middleware/webhook.middleware.ts`                   |
| Env variable validation at startup      | Throw and exit if any required var is missing        |
| Separate test and production numbers    | Never use production number during development       |
| Portfolio as file loaded at startup     | `/portfolios/{client_id}.md` — cached in memory      |
| Graceful fallback on Claude API failure | Return safe default reply, log raw response          |

---

## What is NOT built yet — do not implement

- Multi-tenant routing (one `CLIENT_ID` per deployment for now)
- Media or document responses (text only in MVP)
- Calendar integration (appointment requests only — no booking confirmation)
- Payment collection
- Client-facing dashboard or app (Airtable is the interface)
- Automated portfolio updates by client
- Multi-language support
- SaaS billing or subscription management
- Analytics or reporting layer

---

## Deployment

**Platform:** Railway
**Runtime:** Node.js (TypeScript, compiled)
**Process:** Single service per client deployment
**Health check:** `GET /health` — Railway uses this to verify the service is up

**Environment:** Set all variables in Railway's environment config panel.
Never commit secrets. Never use Railway's public domain for webhook endpoints during
development — use a tunnel (ngrok or similar) until the service is stable.

---

## Ownership structure — asset responsibility

| Asset                     | Owner                                  | Grimorio de Plata role        |
| ------------------------- | -------------------------------------- | ----------------------------- |
| Meta Business Manager     | Client                                 | Developer access only         |
| WhatsApp Business Account | Client                                 | App sends on client's behalf  |
| Business phone number     | Client                                 | No ownership                  |
| Meta Developer App        | Grimorio de Plata                      | Full ownership                |
| Airtable base             | Client (you share it to them as Owner) | Collaborator seat             |
| n8n workflows             | Grimorio de Plata                      | Full ownership                |
| Railway service           | Grimorio de Plata                      | Full ownership                |
| Commercial portfolio      | Client content, your format            | You write it, client approves |
| Claude API key            | Grimorio de Plata                      | Never shared with client      |

---

## Roadmap — what comes next

**Phase 0 — Foundation (current)**

- ✅ Architecture defined
- ✅ Commercial portfolio created (lumina-gdl)
- ✅ Stage 1 quality test passed (97.5%)
- ⬜ Build backend scaffold (this repo)
- ⬜ Build n8n workflow templates
- ⬜ Create Airtable base template
- ⬜ Deploy to Railway with test environment
- ⬜ Stage 2 quality test (backend + test script)
- ⬜ End-to-end test with Meta sandbox number

**Phase 1 — First client**

- ⬜ Identify and close first dermatology client
- ⬜ Collect all client information
- ⬜ Start Meta Business Verification (day one of signing)
- ⬜ Write client-specific portfolio
- ⬜ Configure Airtable base for client

**Phase 2 — Hybrid Go Live**

- ⬜ Deploy with client config on Railway
- ⬜ Run 30-day hybrid review mode (you approve responses before send)
- ⬜ Track: approval rate, edit patterns, escalation accuracy

**Phase 3 — Full automation**

- ⬜ If approval rate ≥ 80%: remove hybrid gate
- ⬜ Document all client-specific learnings for next deployment
