# Analysis Log Redesign — Agent Detail

**Date:** 2026-03-13
**Scope:** `apps/web/pages/agents/[id].vue` — Decision Log section only
**Backend changes:** None (all parsing/diffing on frontend)

---

## Goal

Shift focus from "what did the agent decide" to "how did the LLM reach that decision" — making the full Prompt ↔ LLM exchange visible and understandable.

---

## Layout

Each analysis cycle renders as a two-column chat exchange:

```
┌─────────────────────────────────┬──────────────────────────────┐
│  PROMPT →                       │                 ← LLM        │
│  ┌─────────────────────────┐    │  ┌──────────────────────┐    │
│  │ [SYSTEM · 32]      ▸    │    │  │ BUY  conf: 87%       │    │
│  │ [MARKET DATA · 312] ▸   │    │  │                      │    │
│  │ [EDITABLE SETUP · 89] ▸ │    │  │ Reasoning text…      │    │
│  └─────────────────────────┘    │  │                      │    │
│  total: 847↑                    │  │ [RESPONSE] ▸         │    │
│                                 │  └──────────────────────┘    │
│                                 │  model · latency · 433↓      │
└─────────────────────────────────┴──────────────────────────────┘
```

- **Left bubble:** prompt broken into collapsed section pills
- **Right bubble:** decision badge + reasoning (always visible) + raw response toggle
- On narrow screens: stacks vertically, prompt above response

---

## Prompt Section Parsing (frontend-only)

Split `llmPromptText` by known `##` markdown headers:

| Section | Headers captured | Label | Color |
|---|---|---|---|
| SYSTEM | Everything before `## Portfolio` | `[SYSTEM]` | `--text-muted`, neutral border |
| MARKET DATA | `## Portfolio State` `## Market Data` `## Recent Decisions` `## Constraints` | `[MARKET DATA]` | amber `#f59e0b` |
| EDITABLE SETUP | `## Your Behavior Profile` `## Your Persona` | `[EDITABLE SETUP]` | blue `#60a5fa` |

Token count per section: `Math.ceil(sectionText.length / 4)` — rough estimate, shown as `[SECTION · N]`.

---

## Edited Indicator

On `[EDITABLE SETUP]`, compare the extracted EDITABLE SETUP text of the current decision against the previous decision in the list. If different, append a small `edited` tag to the pill label.

```
[EDITABLE SETUP · 89  edited]
```

Shown in amber. No backend — pure string comparison of adjacent `llmPromptText` slices.

---

## Ghost "Next" Entry

At the bottom of the feed, a ghost entry (opacity `0.35`) shows what will be sent next:

- Left: same three collapsed pills using current agent config
- Right: `— awaiting LLM —` + countdown (`next in 4m 32s`)
- Pulsing dot when `secondsUntilNextAction <= 0`
- When stopped: right shows `— stopped —`, no countdown
- Ghost uses the same layout but no expand interaction

---

## Visual Tokens

```css
/* Section pill colors */
--pill-system:  var(--text-muted)   /* neutral */
--pill-market:  #f59e0b             /* amber */
--pill-human:   #60a5fa             /* blue */
--pill-llm:     #4ade80             /* green */

/* Edited tag */
--tag-edited:   #f59e0b
```

Section pills use mono font, uppercase label, `border-left: 2px solid <color>`, collapsed by default. Expanded content is `<pre>` with word-wrap, same mono style as existing `dec-code-block`.

---

## What Changes

**Removed:**
- Tab bar (Market Data | Prompt | Response) inside decision cards
- Market Data tab panel (market data is folded into `[MARKET DATA]` section of the prompt)

**Added:**
- Two-column chat layout per decision
- Section pill components with token count + color
- Edited indicator on EDITABLE SETUP pill
- Ghost "next" entry at feed bottom

**Unchanged:**
- Decision badge (BUY/SELL/HOLD) and confidence bar
- Meta row (model, latency, tokens, time)
- All existing data fetching and state

---

## Files Affected

- `apps/web/pages/agents/[id].vue` — template + script (decision log section only)
- Possibly extract: `apps/web/components/PromptBubble.vue` if the pill logic grows large
