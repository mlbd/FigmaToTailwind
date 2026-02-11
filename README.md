# Figma to Tailwind v4 Plugin

Extract Figma variables and styles, convert them to Tailwind v4 CSS format. **No Dev Mode or paid plan required!**

## ✨ Features

- ✅ **Free for everyone** - Uses Plugin API, no Dev Mode needed
- 🎨 **Extracts Figma Variables** - Colors, spacing, typography, etc.
- 🎭 **Supports Multiple Modes** - Light/dark themes, responsive scales
- 📐 **Extracts Local Styles** - Color styles, text styles, effects
- 🔄 **Resolves Aliases** - Automatically resolves variable references
- 📋 **One-click Copy** - Copy generated CSS to clipboard
- 🎯 **Tailwind v4 Ready** - Outputs `@theme` CSS format

## 🚀 Installation

### Prerequisites

- Node.js (v16 or higher)
- npm or yarn

### Build Steps

1. **Clone or download this project**

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Build the plugin:**
   ```bash
   npm run build
   ```

   This creates a `dist/` folder with the compiled plugin.

4. **Load in Figma:**
   - Open Figma Desktop app
   - Go to Menu → Plugins → Development → Import plugin from manifest
   - Select the `manifest.json` file from this project
   - The plugin will appear in your Plugins menu

### Development Mode

To develop and watch for changes:

```bash
npm run watch
```

This rebuilds automatically when you edit source files.

## 📖 How to Use

1. **Open your Figma file** with variables or styles defined
2. **Run the plugin** from Plugins menu → Figma to Tailwind v4
3. **Review the extracted variables** in the preview
4. **Click "Copy CSS"** to copy to clipboard
5. **Paste into your Tailwind v4 project**

## 📂 Output Format

The plugin generates Tailwind v4 compatible CSS:

```css
@theme {
  /* Colors */
  --color-primary: #3b82f6;
  --color-secondary: #8b5cf6;
  
  /* Spacing */
  --spacing-xs: 0.5rem;
  --spacing-sm: 1rem;
  --spacing-md: 1.5rem;
  
  /* Typography */
  --font-size-base: 1rem;
  --font-size-lg: 1.125rem;
  --font-family-sans: 'Inter';
  
  /* Custom variables */
  --border-radius: 0.5rem;
  --shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.05);
}
```

## 🎯 What Gets Extracted

### From Variables:
- ✅ Color variables
- ✅ Number variables (spacing, sizing, etc.)
- ✅ String variables (font families, etc.)
- ✅ Boolean variables
- ✅ Variable aliases (automatic resolution)
- ✅ All modes (light/dark, etc.)

### From Styles:
- ✅ Color styles
- ✅ Text styles (font size, family, weight, line height)
- ✅ Effect styles (shadows, blurs)

## 🔧 Using in Your Project

### With Tailwind v4:

1. **Install Tailwind v4:**
   ```bash
   npm install tailwindcss@next
   ```

2. **Create/update your CSS file:**
   ```css
   @import "tailwindcss";
   
   @theme {
     /* Paste generated CSS here */
     --color-primary: #3b82f6;
     /* ... more variables ... */
   }
   ```

3. **Use in your HTML/JSX:**
   ```html
   <div class="bg-[--color-primary] p-[--spacing-md]">
     Hello Tailwind v4!
   </div>
   ```

## 🎨 Variable Naming

The plugin automatically converts Figma variable names to CSS-friendly format:

| Figma Name | CSS Variable |
|------------|--------------|
| `Primary/Blue` | `--primary-blue` |
| `Spacing/Large` | `--spacing-large` |
| `Font Size/Heading 1` | `--font-size-heading-1` |

## 📝 Tips

1. **Organize your variables** in Figma collections for better structure
2. **Use descriptive names** for better CSS variable names
3. **Group related variables** (e.g., all colors in one collection)
4. **Use modes** for theme variants (light/dark)
5. **Refresh** if you make changes to your variables

## 🔌 No Dev Mode Required!

This plugin uses the **Figma Plugin API** (`figma.variables`) which is available to all users, regardless of plan. You don't need:

- ❌ Dev Mode
- ❌ Paid Figma plan
- ❌ Enterprise account
- ❌ REST API access

Just install and use! 🎉

## 🛠️ Troubleshooting

**No variables found:**
- Make sure you have local variables defined in your Figma file
- Try creating a test variable to verify

**Plugin won't load:**
- Ensure you built the plugin (`npm run build`)
- Check that `dist/code.js` and `dist/ui.html` exist
- Try restarting Figma

**CSS looks wrong:**
- Check the preview in the plugin UI
- Verify your variable types in Figma
- Report issues if something seems off

## 🤝 Contributing

Feel free to submit issues or pull requests!

## 📄 License

MIT

## 🙏 Credits

Created to help designers and developers bridge Figma and Tailwind v4 without requiring expensive plans.

---

**Enjoy building with Figma and Tailwind! 🎨✨**
