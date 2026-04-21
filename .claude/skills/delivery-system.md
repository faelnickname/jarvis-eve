# DELIVERY SYSTEM — Maximum Speed × Maximum Quality

> This skill governs HOW every task is executed.
> Goal: best result in minimum time, short AND long term.

---

## THE CORE PRINCIPLE

**Assess and execute simultaneously. Never pause to plan — plan while doing.**

Assessment is instantaneous and invisible. It runs in the same moment as the first tool call, not before it.

---

## DELIVERY TIERS — Choose Before Starting

| Tier | When | Pattern |
|------|------|---------|
| **⚡ INSTANT** | Single clear task, 1 file, no risk | Execute immediately |
| **🚀 FAST** | Multi-file, moderate complexity | Plan → parallel execute |
| **🧠 STRATEGIC** | Architecture, system design, risky change | Conclave → plan → parallel execute → QA |
| **🌊 EPIC** | Full feature, new system | Spec → squad → parallel → QA → deliver |

**Decision rule:** When in doubt, go one tier up. Under-planning costs 10x more than over-planning.

---

## PARALLEL EXECUTION — The Multiplier

Never run independent subtasks sequentially. Identify what can run simultaneously:

```
SEQUENTIAL (slow):           PARALLEL (fast):
1. Research                  ┌─ Research (@analyst)
2. Design                    ├─ Design (@ux)          ← all at once
3. Architecture              ├─ Architecture (@architect)
4. Code                      └─ Requirements (@pm)
5. Test                      
6. Deploy                    Then: Code (@dev) ← uses all outputs above
                             Then: Test (@qa) + Deploy prep (@devops) ← parallel
```

**Rule:** If task B doesn't need task A's output → run them in parallel.

---

## ASSESSMENT (instantaneous — runs IN PARALLEL with first tool call, never before)

Four questions answered in zero seconds, while already executing:
1. Deliverable → already starting it
2. Parallelizable parts → already dispatching them
3. Risk → already addressing it inline
4. Done criteria → built-in to execution

**There is no waiting step. Assessment and execution are the same moment.**

---

## AGENT DISPATCH PATTERNS

### Pattern 1: Research + Build (most common)
```
@analyst researches → @architect decides → @dev builds → @qa validates
         ↕ parallel where possible
@ux designs → @dev implements (UI parts)
```

### Pattern 2: Conclave + Execute (for risky decisions)
```
@conclave-critico  ┐
@conclave-advogado ├─ simultaneous → @conclave-sintetizador → execute
                   ┘
```

### Pattern 3: Full Squad (epic features)
```
@pm writes spec → @po validates
@architect designs → @data-engineer schemas    ← parallel
@ux designs flows → @dev estimates             ← parallel
→ @dev implements (with @architect context)
→ @qa gates → @devops ships
```

### Pattern 4: Fast Fix (bugs, small changes)
```
@dev reads → fixes → @qa spot-checks → done
(< 5 minutes for anything under 50 lines)
```

---

## QUALITY GATES — Non-Negotiable

Every delivery passes through at minimum:

| Gate | Check | Who |
|------|-------|-----|
| **Correctness** | Does it do what was asked? | @dev self-review |
| **No regression** | Did it break anything? | @qa |
| **Completeness** | Is anything missing? | @po checklist |
| **Performance** | Will it be slow/expensive? | @architect |

For **⚡ INSTANT** tier: self-review only (30s mental check).
For **🚀 FAST** and above: at minimum @qa spot-check.

---

## LONG-TERM COMPOUNDING — How We Get Better Over Time

After every significant delivery, update `system/JARVIS-MEMORY.md` with:

```markdown
## Delivery Patterns That Worked
- [date] [task type]: [what worked] — [why it was fast/good]

## Patterns to Avoid
- [date] [task type]: [what slowed us down] — [root cause]

## User Preferences Discovered
- [preference]: [context where it applies]
```

This is the **learning loop**. Each session, JARVIS reads this memory and applies accumulated wisdom.

---

## SPEED PRINCIPLES (in order of impact)

1. **Right model for the task** — Haiku for quick, Sonnet for build, Opus for think
2. **Parallel > sequential** — always decompose into parallel subtasks
3. **Pre-flight > re-work** — 30s of planning saves 30min of fixing
4. **Deliver incrementally** — working prototype first, perfect later
5. **Compress output** — deliver dense, precise results, not verbose explanations
6. **Reuse before rebuild** — check if a skill, pattern, or component already exists

---

## ANTI-PATTERNS — What Kills Speed and Quality

| Anti-pattern | Cost | Fix |
|-------------|------|-----|
| Building without pre-flight | Rework loops | Always answer the 4 questions |
| Sequential when parallel possible | 3–5x slower | Identify independent subtasks |
| Over-explaining instead of doing | Time waste | Code first, explain on request |
| Skipping @qa on "small" changes | Silent regressions | Always spot-check |
| Solving wrong problem | Total waste | Confirm deliverable before executing |
| Building for hypothetical future | Premature complexity | Build for what's needed NOW |

---

## DELIVERY DECLARATION (end every significant task with this)

```
✅ DELIVERED: [what was built]
📊 QUALITY:   [what was validated]
⏱️ NEXT:      [logical next step if any]
🧠 LEARNED:   [what to remember for next time]
```
