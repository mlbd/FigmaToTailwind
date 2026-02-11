# Quick Start Guide

Get your Figma design tokens into Tailwind v4 in 5 minutes!

## Step 1: Set Up Your Figma File

1. **Create Variables in Figma** (if you haven't already):
   - Click the Variables icon (🎨) in the right panel
   - Create a new collection (e.g., "Design Tokens")
   - Add variables:
     - Colors: `Primary`, `Secondary`, `Accent`
     - Spacing: `xs`, `sm`, `md`, `lg`, `xl`
     - Font Sizes: `sm`, `base`, `lg`, `xl`

2. **Or use existing variables/styles** - the plugin will extract them!

## Step 2: Install the Plugin

```bash
# Clone/download this project
cd figma-to-tailwind-v4

# Install dependencies
npm install

# Build the plugin
npm run build
```

## Step 3: Load in Figma

1. Open **Figma Desktop App**
2. Go to **Menu → Plugins → Development → Import plugin from manifest**
3. Select the `manifest.json` file
4. Done! ✅

## Step 4: Use the Plugin

1. Open your Figma file
2. **Plugins → Figma to Tailwind v4**
3. Review extracted variables
4. Click **"Copy CSS"**
5. Paste into your project!

## Step 5: Use in Your Project

Create a CSS file (e.g., `app.css`):

```css
@import "tailwindcss";

@theme {
  /* Paste your copied CSS here */
  --color-primary: #3b82f6;
  --spacing-md: 1rem;
  /* ... etc */
}
```

Use in HTML/JSX:

```html
<div class="bg-[--color-primary] p-[--spacing-md]">
  Hello Tailwind v4!
</div>
```

## 🎉 That's it!

Your Figma design tokens are now in Tailwind v4!

### Next Steps:

- Organize your Figma variables by collection
- Use modes for light/dark themes
- Create text styles in Figma for typography
- Re-run the plugin when you update variables

### Need Help?

- Check the [full README](README.md)
- See [example-usage.css](example-usage.css) for more examples
- Report issues on GitHub

---

**Pro Tip:** Create a collection called "Tailwind Tokens" in Figma and organize all your design tokens there for easy extraction!
