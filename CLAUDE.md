# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Figma plugin that extracts design tokens (variables and styles) from Figma files and converts them to Tailwind v4 CSS `@theme` blocks. Works without requiring Dev Mode or paid Figma plans.

## Build Commands

- `npm run build` — Compile TypeScript then bundle with Webpack (`tsc && webpack`)
- `npm run watch` — Watch mode for development (`webpack --watch`)
- No test or lint commands are configured

## Architecture

This is a Figma plugin using the standard **two-process model**:

- **`src/code.ts`** — Plugin main process running in Figma's sandbox. Handles all Figma API calls (variable extraction, style extraction, CSS generation). Communicates with UI via `figma.ui.postMessage()`.
- **`src/ui.ts`** — UI script running in a sandboxed iframe. Manages DOM, displays extraction stats and CSS preview, handles copy-to-clipboard and refresh actions.
- **`src/ui.html`** — HTML template for the plugin UI with embedded styles.

Data flows: Plugin load → auto-extract variables/styles → generate `@theme` CSS → send to UI via postMessage → display preview.

### Key interfaces in code.ts

- `VariableData` — Represents a single extracted variable with name, value, type, collection, and mode
- `CollectionData` — Groups variables by collection with their modes

### Conversion logic

- Colors: RGBA → hex (with optional alpha)
- Spacing: px values (1–1000) → rem (value/16)
- Typography: font sizes to rem, font families quoted if containing spaces
- Variable names: Figma paths converted to CSS custom property format (`Primary/Blue` → `--primary-blue`)

## Build Configuration

- **TypeScript**: Target ES2020, strict mode OFF, output to `./dist`
- **Webpack**: Dual entry points (`code` and `ui`), uses ts-loader and html-webpack-plugin to inline UI script into `ui.html`
- **manifest.json**: Figma plugin manifest pointing to `dist/code.js` and `dist/ui.html`, no network access required
- **No runtime dependencies** — all packages are devDependencies (TypeScript, Webpack, Figma plugin typings)
