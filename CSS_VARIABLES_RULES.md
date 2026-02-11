# CSS Variables Generation Rules (Design Tokens) — for AI Assistants

This document defines how to generate and maintain CSS variables (design tokens) in this codebase.

**Goal:** tokens that are consistent, Tailwind-friendly, easy to use in components, and practical for developers.

## 1) Principles

### 1.1 Be consistent, not clever

- Use one naming scheme everywhere.
- Avoid repeating words (e.g., `primary-color-primary-600` is redundant).

### 1.2 Prefer semantic tokens for UI usage

- Components should use **role-based tokens** (semantic), not raw palette colors.
- Palette tokens can exist, but semantic tokens should be the default for app UI.

### 1.3 Stay pragmatic

Rules are guidance, not a trap. If a rule conflicts with:

- pixel-perfect requirements
- performance or readability
- existing code constraints
  …then choose the best compromise and document the reason briefly.

> You must be smart: you cannot always follow every rule perfectly.

## 2) Naming Conventions

### 2.1 Format

- Use **kebab-case**.
- Prefix all tokens with a category:
  - `--color-*`
  - `--text-*`
  - `--space-*`
  - `--radius-*`
  - `--shadow-*`
  - `--z-*`

### 2.2 Colors

#### Palette tokens (optional but allowed)

Use Tailwind-like scales:

- `--color-primary-50 ... --color-primary-900`
- `--color-gray-50 ... --color-gray-900`

Example:

- `--color-primary-600: #0d0071;`
- `--color-gray-500: #4c4c4c;`

#### Semantic tokens (preferred for components)

Semantic tokens describe meaning:

- `--color-bg`
- `--color-surface`
- `--color-text`
- `--color-text-muted`
- `--color-border`
- `--color-brand`
- `--color-danger`
- `--color-success`

Example:

- `--color-bg: #ffffff;`
- `--color-text: #111111;`
- `--color-brand: var(--color-primary-600);`

✅ Recommended: semantic tokens can reference palette tokens.

## 3) Typography Tokens

### 3.1 Use numeric weights

Use numeric `font-weight` values:

- Regular: `400`
- Medium: `500`
- SemiBold: `600`
- Bold: `700`

### 3.2 Use unitless line-height

- Prefer `line-height` as a unitless multiplier:
  - `1.1`, `1.2`, `1.4`
- Avoid huge values like `110` unless it is intentionally 110× (it usually isn’t).

### 3.3 Bundle typography per style (avoid per-attribute explosion)

Instead of generating separate variables for every property like:

- `--font-size-h1-700-size`, `--font-size-h1-700-line-height`, etc.

Prefer a compact set per style:

- `--text-h1-size`
- `--text-h1-line`
- `--text-h1-weight`

Example:

```css
:root {
  --font-family-sans: "Figtree", system-ui, sans-serif;

  --text-h1-size: 4rem;
  --text-h1-line: 1.1;
  --text-h1-weight: 700;

  --text-body-size: 1.25rem;
  --text-body-line: 1.4;
  --text-body-weight: 400;
}
```

## 4) Responsive Typography (Desktop/Tablet/Mobile)

---

### 4.1 Don’t duplicate tokens per device unless necessary

Creating separate variables like:

- `--desktop-text-h1-size
- `--tablet-text-h1-size
- `--mobile-text-h1-size

…often becomes maintenance-heavy and slows development.

✅ Preferred approaches:

1.  **Use one token name and change its value via media queries**

2.  **Use fluid typography (clamp) when it can stay pixel-perfect enough**

### 4.2 Pixel-perfect strategy (recommended)

If you must match exact sizes at breakpoints, do this:

```
:root {
  --text-h1-size: 64px;
  --text-h1-line: 1.1;
  --text-h1-weight: 700;
}

@media (max-width: 1024px) {
  :root { --text-h1-size: 48px; }
}

@media (max-width: 640px) {
  :root { --text-h1-size: 32px; }
}
```

Benefits:

- One token name used everywhere (--text-h1-size)

- Breakpoint values can be pixel-perfect

- No “token explosion”

### 4.3 Fluid strategy (optional, use carefully)

Fluid scaling can reduce breakpoint maintenance. Use clamp():

```
:root {
  --text-h1-size: clamp(32px, 4vw, 64px);
}
```

Rules for fluid type:

- Use fluid type only when design allows continuous scaling.

- Verify it matches expected sizes at key widths (mobile/tablet/desktop).

- If it fails pixel-perfect needs, use media-query overrides instead.

Hybrid approach (often best):

- Use clamp() plus breakpoint overrides if needed.

## 5) Tailwind Compatibility Rules

### 5.1 Tokens should map cleanly to Tailwind theme keys

- Colors map to colors

- Typography map to fontFamily, fontSize (with lineHeight + weight)

- Spacing map to spacing, borderRadius, etc.

### 5.2 Prefer semantic Tailwind class usage

In components, aim for:

- text-text / bg-bg / border-border

- text-brand / bg-brand

Not:

- text-gray-500 everywhere (palette-only usage makes redesign harder)

## 6) Validation Checklist (must pass)

Before committing new/updated tokens:

- No duplicated words in token names

- Consistent category prefix (--color-\*, --text-\*, etc.)

- Line-heights are correct (unitless like 1.1, 1.4 or valid units)

- Font weights are numeric (400–700)

- No unnecessary device-specific token namespaces

- Breakpoints or clamp strategy chosen intentionally

- Tokens are easy to use in Tailwind utilities

## 7) When Rules Conflict

If pixel-perfect design conflicts with “best practice”:

- prioritize correctness first (visual + UX)

- then refactor toward maintainability

- document the exception briefly in code comments

- **Be smart. Rules guide you, but the real goal is a maintainable, correct UI.**:
