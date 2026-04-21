# FRONTEND MASTER SKILL — World-Class UI Engineering (2026)

> Activate when building, reviewing, or improving any frontend interface.
> Reference: researched from top industry sources April 2026.

---

## 1. DESIGN PHILOSOPHY — The Non-Negotiables

Apply these principles before writing a single line of code:

| Principle | Rule |
|-----------|------|
| **Purposeful motion** | Every animation must confirm, guide, explain, or smooth — never decorate |
| **Perceived performance** | Feel fast before you are fast (instant ACK, optimistic UI, skeleton screens) |
| **Craftsmanship aesthetic** | Linear, Vercel, Stripe, Apple — precision in spacing, type, color |
| **Reduced motion respect** | Always honor `prefers-reduced-motion` |
| **Dark mode first** | Design in dark, then adapt to light — not the reverse |

---

## 2. CSS ARCHITECTURE — Modern Stack (2026)

### Design Tokens (always use, never hardcode values)
```css
:root {
  /* Color primitives */
  --color-cyan-500: #06b6d4;
  --color-amber-400: #fbbf24;

  /* Semantic tokens */
  --surface-primary: rgba(255,255,255,0.03);
  --surface-glass: rgba(255,255,255,0.06);
  --border-subtle: rgba(255,255,255,0.08);
  --text-primary: #f0f0f0;
  --text-dim: #6b7280;

  /* Motion tokens */
  --ease-spring: cubic-bezier(0.34, 1.56, 0.64, 1);
  --ease-out: cubic-bezier(0.16, 1, 0.3, 1);
  --ease-in: cubic-bezier(0.4, 0, 1, 1);
  --duration-fast: 120ms;
  --duration-base: 200ms;
  --duration-slow: 350ms;

  /* Spacing scale (4px base) */
  --space-1: 4px; --space-2: 8px; --space-3: 12px;
  --space-4: 16px; --space-6: 24px; --space-8: 32px;
}
```

### Glassmorphism (2026 standard — GPU-accelerated, accessible)
```css
.glass-card {
  background: rgba(255, 255, 255, 0.06);
  backdrop-filter: blur(20px) saturate(180%);
  -webkit-backdrop-filter: blur(20px) saturate(180%);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 16px;
  box-shadow:
    0 4px 24px rgba(0, 0, 0, 0.3),
    inset 0 1px 0 rgba(255, 255, 255, 0.08);
}
/* RULE: max 3-4 glassmorphic elements per view — GPU intensive */
/* RULE: always test contrast ratio ≥ 4.5:1 on blurred bg */
```

### Scroll-Driven Animations (native, zero JS)
```css
@keyframes fade-in-up {
  from { opacity: 0; transform: translateY(20px); }
  to   { opacity: 1; transform: translateY(0); }
}

.card {
  animation: fade-in-up linear both;
  animation-timeline: view();
  animation-range: entry 0% entry 30%;
}
```

### CSS Containment (critical for performance)
```css
.widget {
  contain: layout style paint; /* browser skips recalculation of siblings */
}
.feed-item {
  contain: content; /* layout + style + paint combined */
  content-visibility: auto; /* skip off-screen rendering */
}
```

### Container Queries (component-driven responsive)
```css
.card-wrapper { container-type: inline-size; container-name: card; }

@container card (min-width: 400px) {
  .card-content { flex-direction: row; }
}
```

---

## 3. ANIMATION — Timing & Easing Bible

| Use case | Duration | Easing |
|----------|----------|--------|
| Button press / hover | 120–150ms | ease-out |
| Modal open | 200–250ms | spring (0.34, 1.56, 0.64, 1) |
| Modal close | 150ms | ease-in |
| Page transition | 300–350ms | ease-out |
| Tooltip / popover | 150ms | ease-out |
| Loading skeleton | 1500ms | ease-in-out (loop) |
| Drag & drop | 0ms start, 200ms drop | spring |

### Micro-interaction patterns (pure CSS, no JS)
```css
/* Magnetic button effect */
.btn {
  transition: transform var(--duration-base) var(--ease-spring),
              box-shadow var(--duration-base) var(--ease-out);
}
.btn:hover {
  transform: translateY(-2px) scale(1.02);
  box-shadow: 0 8px 32px rgba(0, 212, 255, 0.25);
}
.btn:active {
  transform: translateY(0) scale(0.98);
  transition-duration: 80ms;
}

/* Glow pulse for status indicators */
@keyframes glow-pulse {
  0%, 100% { box-shadow: 0 0 4px currentColor; }
  50%       { box-shadow: 0 0 16px currentColor; }
}
.status-dot { animation: glow-pulse 2s ease-in-out infinite; }

/* Shimmer skeleton */
@keyframes shimmer {
  from { background-position: -200% 0; }
  to   { background-position:  200% 0; }
}
.skeleton {
  background: linear-gradient(90deg,
    rgba(255,255,255,0.03) 25%,
    rgba(255,255,255,0.08) 50%,
    rgba(255,255,255,0.03) 75%);
  background-size: 200% 100%;
  animation: shimmer 1.5s ease-in-out infinite;
}
```

---

## 4. TYPOGRAPHY — Precision System

```css
/* Type scale — 1.250 Major Third ratio */
:root {
  --text-xs:   11px;
  --text-sm:   13px;
  --text-base: 15px;
  --text-lg:   18px;
  --text-xl:   22px;
  --text-2xl:  28px;
  --text-3xl:  36px;

  --font-sans: 'Inter', system-ui, -apple-system, sans-serif;
  --font-mono: 'JetBrains Mono', 'Fira Code', monospace;

  --leading-tight:  1.2;
  --leading-base:   1.5;
  --leading-loose:  1.7;
  --tracking-tight: -0.02em;
  --tracking-wide:  0.08em;
}

/* Fluid typography (clamp — no breakpoints needed) */
h1 { font-size: clamp(28px, 4vw, 56px); }
p  { font-size: clamp(14px, 1.5vw, 16px); }
```

---

## 5. LAYOUT — Grid-First Approach

```css
/* Holy grail layout, zero media queries */
.app-layout {
  display: grid;
  grid-template:
    "header" auto
    "main"   1fr
    "footer" auto
    / 1fr;
  min-height: 100dvh; /* dvh: accounts for mobile browser chrome */
}

/* Auto-responsive card grid */
.card-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: var(--space-6);
}

/* Centering — the 2026 way */
.centered { display: grid; place-items: center; }
```

---

## 6. PERFORMANCE — Core Web Vitals Checklist

### LCP (Largest Contentful Paint) — target < 2.5s
- `fetchpriority="high"` on hero images
- `loading="eager"` on above-fold, `loading="lazy"` below
- Use WebP/AVIF, serve via `srcset`
- Prefer SSR/SSG over CSR for initial HTML
- Inline critical CSS (< 14KB) — never block render

### INP (Interaction to Next Paint) — target < 200ms
- Break long tasks (> 50ms) with `scheduler.yield()` or `setTimeout(0)`
- Debounce inputs: 150ms for search, 300ms for resize
- Use `content-visibility: auto` for off-screen content
- Never do layout work in scroll/mousemove handlers
- `will-change: transform` only on actively animating elements

### CLS (Cumulative Layout Shift) — target < 0.1
- Always set `width` + `height` on `<img>` and `<video>`
- Use `aspect-ratio` for dynamic content containers
- Reserve space for ads/embeds with fixed dimensions
- `font-display: optional` for non-critical fonts

```javascript
// Break long tasks — the right way
async function processLargeList(items) {
  for (let i = 0; i < items.length; i++) {
    processItem(items[i]);
    // Yield to browser every 50 items
    if (i % 50 === 0) await scheduler.yield?.() ?? new Promise(r => setTimeout(r, 0));
  }
}
```

---

## 7. JAVASCRIPT PATTERNS — ES2025 Best Practices

```javascript
// Pipeline operator (ES2025) — compose data transforms elegantly
const result = rawData
  |> normalize(%)
  |> validate(%)
  |> transform(%);

// Signals pattern — fine-grained reactivity without framework
class Signal {
  #value; #subscribers = new Set();
  constructor(v) { this.#value = v; }
  get value() { return this.#value; }
  set value(v) { this.#value = v; this.#subscribers.forEach(fn => fn(v)); }
  subscribe(fn) { this.#subscribers.add(fn); return () => this.#subscribers.delete(fn); }
}

// Optimistic UI pattern
async function optimisticUpdate(item) {
  const previous = store.items;
  store.items = [...store.items, item]; // instant update
  try {
    await api.save(item);
  } catch {
    store.items = previous; // rollback on failure
    showError('Failed to save');
  }
}

// Intersection Observer for lazy loading
const observer = new IntersectionObserver((entries) => {
  entries.forEach(e => { if (e.isIntersecting) loadComponent(e.target); });
}, { rootMargin: '200px' }); // preload 200px before entering viewport
```

---

## 8. ACCESSIBILITY — Non-Negotiable Checklist

```html
<!-- Focus management -->
<button
  aria-label="Close dialog"
  aria-expanded="false"
  aria-controls="menu-id">
  <!-- Never use outline: none without custom focus style -->
</button>

<!-- Reduced motion respect -->
<style>
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    transition-duration: 0.01ms !important;
  }
}
</style>
```

Rules:
- Contrast ratio ≥ 4.5:1 for normal text, ≥ 3:1 for large
- All interactive elements keyboard-navigable
- `aria-live="polite"` for dynamic content updates
- Focus trap in modals (no focus escaping dialog)
- Skip-to-main link as first element

---

## 9. COMPONENT ARCHITECTURE — Composable Patterns

```javascript
// Compound component pattern (React/vanilla)
// Single responsibility, composable, predictable

// State machine pattern for UI (replaces boolean soup)
const states = {
  idle:     { on: { SUBMIT: 'loading' } },
  loading:  { on: { SUCCESS: 'success', ERROR: 'error' } },
  success:  { on: { RESET: 'idle' } },
  error:    { on: { RETRY: 'loading', RESET: 'idle' } }
};
// Never: isLoading && !isError && !isSuccess (boolean hell)
// Always: state === 'loading'

// Render pattern: data fetching separation
// Container (data) → Presenter (UI) — testable, reusable
```

---

## 10. DESIGN REFERENCE — Aesthetic Benchmarks

| Brand | Signature trait | Apply when |
|-------|----------------|------------|
| **Linear** | Ultra-dense info, monospace, muted palette | Dashboards, dev tools |
| **Vercel** | Geist font, high contrast, minimal chrome | SaaS, docs |
| **Stripe** | Gradient depth, animated gradients, precision | Marketing, payment |
| **Apple** | SF Pro, spatial depth, liquid motion | Consumer, premium |
| **Raycast** | Glassmorphism + command palette | Power tools |

**Spacing law:** Every padding/margin must be a multiple of 4px. No exceptions.
**Color law:** Max 3 hues per UI. One dominant, one accent, one for status.
**Shadow law:** Shadows have color (not just black). Use the accent color at 15-25% opacity.

---

## 11. TOOLS & RESOURCES (2026 Stack)

| Category | Tool |
|----------|------|
| Components | shadcn/ui + Radix UI (accessible primitives) |
| Animation | CSS native first → Framer Motion for complex |
| Icons | Lucide / Phosphor (consistent, tree-shakable) |
| Fonts | Inter (UI) + JetBrains Mono (code) |
| Color | oklch() color space (perceptually uniform) |
| Testing | Playwright (E2E) + Vitest (unit) |
| Perf audit | Lighthouse CI + web-vitals library |
| Design ref | Aceternity UI, Magic UI, ui.shadcn.com |

---

## QUICK DECISION MATRIX

| Task | Do this |
|------|---------|
| Simple hover/click | Pure CSS transition |
| Scroll-based animation | CSS scroll-driven animations |
| Complex sequence | Web Animations API |
| Physics/spring | Framer Motion / GSAP |
| State display | CSS `@property` + transition |
| Layout change | CSS grid/flex — never JS |
| Modal/dialog/popover | HTML native elements + CSS |
| Color | oklch() > hsl() > hex |
