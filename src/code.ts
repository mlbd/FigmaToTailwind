// Main plugin code - runs in Figma's sandbox
console.log('Plugin code started');
figma.showUI(__html__, { width: 420, height: 700 });
console.log('UI shown');

interface VariableData {
  name: string;
  variableValue: any;
  variableType: string;
  resolvedDataType: VariableResolvedDataType;
  collection: string;
  mode: string;
}

interface CollectionData {
  name: string;
  modes: { modeId: string; name: string }[];
  variables: VariableData[];
}

// Scanned token interfaces
interface ScannedTokens {
  colors: { hex: string; count: number; usedAs: ('fill' | 'stroke' | 'text')[] }[];
  typography: {
    fontSize: number;
    fontFamily: string;
    fontStyle: string;
    lineHeight: number | null;
  }[];
  spacing: number[];
  radii: number[];
  shadows: { type: string; offsetX: number; offsetY: number; blur: number; spread: number; color: string }[];
  gradients: { type: 'linear' | 'radial'; angle: number; stops: { color: string; position: number }[] }[];
  animations: { duration: number; easing: string }[];
}

// Options for CSS generation — toggled by the UI checkboxes
interface GenerateOptions {
  colors: boolean;
  fontFamilies: boolean;
  fontSizes: boolean;
  lineHeights: boolean;
  fontWeights: boolean;
  spacing: boolean;
  borderRadius: boolean;
  shadows: boolean;
  gradients: boolean;
  scalableFontSize: boolean;
  defaultClasses: boolean;
  animations: boolean;
}

const DEFAULT_OPTIONS: GenerateOptions = {
  colors: true,
  fontFamilies: true,
  fontSizes: true,
  lineHeights: true,
  fontWeights: true,
  spacing: true,
  borderRadius: true,
  shadows: true,
  gradients: true,
  scalableFontSize: false,
  defaultClasses: false,
  animations: true,
};

// ─── CSS Section interface for per-section copy ───

interface CSSSection {
  label: string;
  css: string;
}

interface CSSOutput {
  full: string;
  sections: CSSSection[];
}

// ─── Lint interfaces ───

interface LintWarning {
  category: string;
  message: string;
  severity: 'warning' | 'info';
  suggestion: string;
}

// ─── Asset export interfaces ───

interface AssetEntry {
  base64: string;
  mimeType: string;
  fileName: string;
}
type AssetMap = Record<string, AssetEntry>;

let assetCounter = 0;
function nextAssetId(): string {
  return `asset-${++assetCounter}`;
}

function uint8ToBase64(bytes: Uint8Array): string {
  const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let result = '';
  const len = bytes.length;
  for (let i = 0; i < len; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < len ? bytes[i + 1] : 0;
    const b2 = i + 2 < len ? bytes[i + 2] : 0;
    result += CHARS[b0 >> 2];
    result += CHARS[((b0 & 3) << 4) | (b1 >> 4)];
    result += i + 1 < len ? CHARS[((b1 & 15) << 2) | (b2 >> 6)] : '=';
    result += i + 2 < len ? CHARS[b2 & 63] : '=';
  }
  return result;
}

function toAssetFileName(name: string, ext: string, usedNames: Set<string>): string {
  let base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
  if (!base) base = 'asset';
  let fileName = `${base}.${ext}`;
  if (usedNames.has(fileName)) {
    let counter = 2;
    while (usedNames.has(`${base}-${counter}.${ext}`)) counter++;
    fileName = `${base}-${counter}.${ext}`;
  }
  usedNames.add(fileName);
  return fileName;
}

// Convert RGBA to hex
function rgbaToHex(r: number, g: number, b: number, a: number = 1): string {
  const toHex = (n: number) => {
    const hex = Math.round(n * 255).toString(16);
    return hex.length === 1 ? '0' + hex : hex;
  };

  const hex = `#${toHex(r)}${toHex(g)}${toHex(b)}`;

  if (a < 1) {
    return `${hex}${toHex(a)}`;
  }

  return hex;
}

// Words that are noise per category — they repeat what the prefix already says
const CATEGORY_NOISE: Record<string, Set<string>> = {
  'color':       new Set(['color', 'colors', 'colour', 'colours']),
  'text':        new Set(['font', 'size', 'text', 'typography', 'type']),
  'leading':     new Set(['font', 'size', 'text', 'typography', 'type', 'line', 'height', 'leading']),
  'font-weight': new Set(['font', 'size', 'text', 'typography', 'type', 'weight']),
  'space':       new Set(['spacing', 'space']),
  'radius':      new Set(['radius', 'radii', 'border', 'corner']),
  'shadow':      new Set(['shadow', 'shadows', 'effect', 'effects']),
};

// High-level grouping names from Figma that don't add token meaning
const GROUP_NOISE = new Set([
  'primitives', 'primitive', 'semantic', 'tokens', 'token',
  'base', 'core', 'palette', 'foundation', 'foundations',
  'neutrals', 'neutral',
]);

// Convert Figma variable name to a clean CSS variable name
// category controls the prefix (color, text, leading, shadow ...)
function toCSSVariableName(name: string, _collection: string, _mode: string, category?: string): string {
  let cleaned = name.toLowerCase();

  // Replace slashes and spaces with hyphens
  cleaned = cleaned.replace(/[\/\s]+/g, '-');
  cleaned = cleaned.replace(/[^a-z0-9-]/g, '');
  cleaned = cleaned.replace(/-+/g, '-');
  cleaned = cleaned.replace(/^-|-$/g, '');

  let segments = cleaned.split('-');

  // 1. Strip words that are synonymous with the category prefix
  if (category && CATEGORY_NOISE[category]) {
    const noise = CATEGORY_NOISE[category];
    segments = segments.filter(s => !noise.has(s));
  }

  // 2. Strip leading grouping-only words (e.g. "neutrals", "primitives")
  while (segments.length > 1 && GROUP_NOISE.has(segments[0])) {
    segments.shift();
  }

  // 3. Deduplicate adjacent identical segments ("primary-primary" -> "primary")
  segments = segments.filter((s, i) => i === 0 || s !== segments[i - 1]);

  // 4. For --leading-*, strip a trailing font-weight number (e.g. "h4-500" -> "h4")
  if (category === 'leading' && segments.length > 1) {
    const last = segments[segments.length - 1];
    if (/^[1-9]00$/.test(last)) {
      segments.pop();
    }
  }

  if (segments.length === 0) segments = ['default'];

  const prefix = category ? `${category}-` : '';
  return `--${prefix}${segments.join('-')}`;
}

// Resolve variable value (handles aliases)
async function resolveVariableValue(
  variable: Variable,
  modeId: string,
  variablesMap: Map<string, Variable>
): Promise<any> {
  const valueByMode = variable.valuesByMode[modeId];

  if (!valueByMode) {
    return null;
  }

  // If it's an alias, resolve it
  if (typeof valueByMode === 'object' && 'type' in valueByMode && valueByMode.type === 'VARIABLE_ALIAS') {
    const aliasedVariable = variablesMap.get(valueByMode.id);
    if (aliasedVariable) {
      return await resolveVariableValue(aliasedVariable, modeId, variablesMap);
    }
  }

  return valueByMode;
}

// Format value for CSS
function formatValueForCSS(value: any, resolvedType: VariableResolvedDataType): string {
  switch (resolvedType) {
    case 'COLOR':
      if (value && typeof value === 'object' && 'r' in value) {
        return rgbaToHex(value.r, value.g, value.b, value.a);
      }
      return String(value);

    case 'FLOAT':
      if (typeof value === 'number') {
        if (value >= 1 && value <= 1000) {
          return `${(value / 16).toFixed(3)}rem`;
        }
        return String(value);
      }
      return String(value);

    case 'STRING':
      if (typeof value === 'string' && value.includes(' ')) {
        return `'${value}'`;
      }
      return String(value);

    case 'BOOLEAN':
      return String(value);

    default:
      return String(value);
  }
}

// Map Figma font style name to numeric weight
function fontStyleToWeight(style: string): number {
  const s = style.toLowerCase().replace(/\s+/g, '');
  if (s.includes('thin') || s.includes('hairline')) return 100;
  if (s.includes('extralight') || s.includes('ultralight')) return 200;
  if (s.includes('light')) return 300;
  if (s.includes('medium')) return 500;
  if (s.includes('semibold') || s.includes('demibold')) return 600;
  if (s.includes('extrabold') || s.includes('ultrabold')) return 800;
  if (s.includes('black') || s.includes('heavy')) return 900;
  if (s.includes('bold')) return 700;
  // "Regular", "Normal", "Book", or anything else
  return 400;
}

// Get luminance of a hex color (for sorting)
function hexLuminance(hex: string): number {
  const raw = hex.replace('#', '').substring(0, 6);
  const r = parseInt(raw.substring(0, 2), 16) / 255;
  const g = parseInt(raw.substring(2, 4), 16) / 255;
  const b = parseInt(raw.substring(4, 6), 16) / 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// Get hue of a hex color (for grouping)
function hexHue(hex: string): number {
  const raw = hex.replace('#', '').substring(0, 6);
  const r = parseInt(raw.substring(0, 2), 16) / 255;
  const g = parseInt(raw.substring(2, 4), 16) / 255;
  const b = parseInt(raw.substring(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d === 0) return 0;
  let h = 0;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h = Math.round(h * 60);
  if (h < 0) h += 360;
  return h;
}

// Classify a hue into a named color family
function hueToColorName(hue: number, saturation: number, luminance: number): string {
  // Grays / near-grays
  if (saturation < 0.08) {
    if (luminance > 0.9) return 'white';
    if (luminance < 0.1) return 'black';
    return 'gray';
  }
  if (hue < 15) return 'red';
  if (hue < 45) return 'orange';
  if (hue < 70) return 'yellow';
  if (hue < 160) return 'green';
  if (hue < 200) return 'teal';
  if (hue < 260) return 'blue';
  if (hue < 290) return 'purple';
  if (hue < 340) return 'pink';
  return 'red';
}

// Get saturation of a hex color
function hexSaturation(hex: string): number {
  const raw = hex.replace('#', '').substring(0, 6);
  const r = parseInt(raw.substring(0, 2), 16) / 255;
  const g = parseInt(raw.substring(2, 4), 16) / 255;
  const b = parseInt(raw.substring(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === 0) return 0;
  return (max - min) / max;
}

// Size label generators (kept for variables path)
const SIZE_LABELS_SHORT = ['sm', 'md', 'lg'];
const SIZE_LABELS_MEDIUM = ['xs', 'sm', 'md', 'lg', 'xl'];
const SIZE_LABELS_LONG = ['xs', 'sm', 'md', 'lg', 'xl', '2xl', '3xl', '4xl', '5xl'];

function getSizeLabels(count: number): string[] {
  if (count <= 3) return SIZE_LABELS_SHORT.slice(0, count);
  if (count <= 5) return SIZE_LABELS_MEDIUM.slice(0, count);
  const labels: string[] = [];
  for (let i = 0; i < count; i++) {
    if (i < SIZE_LABELS_LONG.length) {
      labels.push(SIZE_LABELS_LONG[i]);
    } else {
      labels.push(`${i - SIZE_LABELS_LONG.length + 6}xl`);
    }
  }
  return labels;
}

// Typography role names based on size ranking (kept for variables path)
const TYPO_ROLES = ['h1', 'h2', 'h3', 'h4', 'body', 'caption', 'small'];

function getTypoRoles(count: number): string[] {
  if (count <= TYPO_ROLES.length) return TYPO_ROLES.slice(0, count);
  const roles = [...TYPO_ROLES];
  for (let i = TYPO_ROLES.length; i < count; i++) {
    roles.push(`style-${i + 1}`);
  }
  return roles;
}

// ─── Tailwind v4 native scale constants ───

const TW_TEXT_SCALE = [
  { name: 'xs', rem: 0.75 },
  { name: 'sm', rem: 0.875 },
  { name: 'base', rem: 1 },
  { name: 'lg', rem: 1.125 },
  { name: 'xl', rem: 1.25 },
  { name: '2xl', rem: 1.5 },
  { name: '3xl', rem: 1.875 },
  { name: '4xl', rem: 2.25 },
  { name: '5xl', rem: 3 },
  { name: '6xl', rem: 3.75 },
  { name: '7xl', rem: 4.5 },
  { name: '8xl', rem: 6 },
  { name: '9xl', rem: 8 },
];

const TW_LEADING_SCALE = [
  { name: 'none', val: 1 },
  { name: 'tight', val: 1.25 },
  { name: 'snug', val: 1.375 },
  { name: 'normal', val: 1.5 },
  { name: 'relaxed', val: 1.625 },
  { name: 'loose', val: 2 },
];

const TW_WEIGHT_MAP: Record<number, string> = {
  100: 'thin',
  200: 'extralight',
  300: 'light',
  400: 'normal',
  500: 'medium',
  600: 'semibold',
  700: 'bold',
  800: 'extrabold',
  900: 'black',
};

const TW_RADIUS_SCALE = [
  { name: 'xs', px: 2 },
  { name: 'sm', px: 4 },
  { name: 'md', px: 6 },
  { name: 'lg', px: 8 },
  { name: 'xl', px: 12 },
  { name: '2xl', px: 16 },
  { name: '3xl', px: 24 },
  { name: 'full', px: 9999 },
];

const TW_SHADOW_NAMES = ['xs', 'sm', 'md', 'lg', 'xl', '2xl'];

// ─── Tailwind v4 snap helpers ───

function snapFontSizeToTailwind(rem: number, usedNames: Set<string>): string {
  let best = TW_TEXT_SCALE[0];
  let bestDist = Infinity;
  for (const step of TW_TEXT_SCALE) {
    if (usedNames.has(step.name)) continue;
    const dist = Math.abs(step.rem - rem);
    if (dist < bestDist) {
      bestDist = dist;
      best = step;
    }
  }
  usedNames.add(best.name);
  return best.name;
}

function snapLineHeightToTailwind(lh: number): string {
  let best = TW_LEADING_SCALE[0];
  let bestDist = Infinity;
  for (const step of TW_LEADING_SCALE) {
    const dist = Math.abs(step.val - lh);
    if (dist < bestDist) {
      bestDist = dist;
      best = step;
    }
  }
  return best.name;
}

function snapRadiusToTailwind(px: number, usedNames: Set<string>): string {
  if (px >= 500) {
    usedNames.add('full');
    return 'full';
  }
  let best = TW_RADIUS_SCALE[0];
  let bestDist = Infinity;
  for (const step of TW_RADIUS_SCALE) {
    if (step.name === 'full') continue; // handled above
    if (usedNames.has(step.name)) continue;
    const dist = Math.abs(step.px - px);
    if (dist < bestDist) {
      bestDist = dist;
      best = step;
    }
  }
  usedNames.add(best.name);
  return best.name;
}

function gcd(a: number, b: number): number {
  a = Math.round(a);
  b = Math.round(b);
  while (b) {
    var t = b;
    b = a % b;
    a = t;
  }
  return a;
}

function findGCD(numbers: number[]): number {
  if (numbers.length === 0) return 0;
  if (numbers.length === 1) return numbers[0];
  let result = numbers[0];
  for (let i = 1; i < numbers.length; i++) {
    result = gcd(result, numbers[i]);
    if (result === 1) return 1;
  }
  return result;
}

function classifyFontFamily(family: string): 'sans' | 'serif' | 'mono' {
  const lower = family.toLowerCase();
  if (/mono|consolas|courier|fira\s*code|jetbrains|source\s*code|menlo/i.test(lower)) return 'mono';
  if (/serif|garamond|georgia|times|palatino|baskerville|merriweather|playfair|lora/i.test(lower)) {
    // "sans-serif" should NOT match serif
    if (/sans[-\s]?serif/i.test(lower)) return 'sans';
    return 'serif';
  }
  return 'sans';
}

interface ClassifiedColor {
  name: string;
  hex: string;
}

function classifyColorsForTailwind(
  colors: { hex: string; count: number; usedAs: ('fill' | 'stroke' | 'text')[] }[]
): { semantic: ClassifiedColor[]; palette: ClassifiedColor[] } {
  if (colors.length === 0) return { semantic: [], palette: [] };

  const assigned = new Set<string>();
  const semantic: ClassifiedColor[] = [];

  const fillColors = colors.filter(c => c.usedAs.includes('fill'));
  const textColors = colors.filter(c => c.usedAs.includes('text'));
  const strokeColors = colors.filter(c => c.usedAs.includes('stroke'));

  // Helper: pick from a filtered list, unassigned only
  const pick = (list: typeof colors, sortFn?: (a: typeof colors[0], b: typeof colors[0]) => number) => {
    const candidates = list.filter(c => !assigned.has(c.hex));
    if (sortFn) candidates.sort(sortFn);
    return candidates.length > 0 ? candidates[0] : null;
  };

  // 1. background -- lightest fill
  const bg = pick(fillColors, (a, b) => hexLuminance(b.hex) - hexLuminance(a.hex));
  if (bg) { semantic.push({ name: 'background', hex: bg.hex }); assigned.add(bg.hex); }

  // 2. foreground -- darkest text
  const fg = pick(textColors, (a, b) => hexLuminance(a.hex) - hexLuminance(b.hex));
  if (fg) { semantic.push({ name: 'foreground', hex: fg.hex }); assigned.add(fg.hex); }

  // 3. primary -- most-used saturated color
  const primary = pick(
    colors.filter(c => hexSaturation(c.hex) > 0.3),
    (a, b) => b.count - a.count
  );
  if (primary) { semantic.push({ name: 'primary', hex: primary.hex }); assigned.add(primary.hex); }

  // 4. border -- most-used stroke
  const border = pick(strokeColors, (a, b) => b.count - a.count);
  if (border) { semantic.push({ name: 'border', hex: border.hex }); assigned.add(border.hex); }

  // 5. muted -- light low-saturation fill
  const muted = pick(
    fillColors.filter(c => hexLuminance(c.hex) > 0.85 && hexSaturation(c.hex) < 0.15)
  );
  if (muted) { semantic.push({ name: 'muted', hex: muted.hex }); assigned.add(muted.hex); }

  // 6. muted-foreground -- lighter text color
  const mutedFg = pick(
    textColors.filter(c => hexLuminance(c.hex) > 0.4),
    (a, b) => b.count - a.count
  );
  if (mutedFg) { semantic.push({ name: 'muted-foreground', hex: mutedFg.hex }); assigned.add(mutedFg.hex); }

  // 7. secondary -- next saturated color
  const secondary = pick(
    colors.filter(c => hexSaturation(c.hex) > 0.25),
    (a, b) => b.count - a.count
  );
  if (secondary) { semantic.push({ name: 'secondary', hex: secondary.hex }); assigned.add(secondary.hex); }

  // 8. destructive -- red-ish hue
  const destructive = pick(
    colors.filter(c => {
      const hue = hexHue(c.hex);
      return (hue < 20 || hue > 340) && hexSaturation(c.hex) > 0.3;
    }),
    (a, b) => b.count - a.count
  );
  if (destructive) { semantic.push({ name: 'destructive', hex: destructive.hex }); assigned.add(destructive.hex); }

  // 9. accent -- remaining vibrant
  const accent = pick(
    colors.filter(c => hexSaturation(c.hex) > 0.2),
    (a, b) => b.count - a.count
  );
  if (accent) { semantic.push({ name: 'accent', hex: accent.hex }); assigned.add(accent.hex); }

  // 10. Palette -- leftover colors grouped by hue family
  const palette: ClassifiedColor[] = [];
  const remaining = colors.filter(c => !assigned.has(c.hex));
  if (remaining.length > 0) {
    const grouped = new Map<string, { hex: string; luminance: number }[]>();
    for (const c of remaining) {
      const hue = hexHue(c.hex);
      const sat = hexSaturation(c.hex);
      const lum = hexLuminance(c.hex);
      const family = hueToColorName(hue, sat, lum);
      if (!grouped.has(family)) grouped.set(family, []);
      grouped.get(family)!.push({ hex: c.hex, luminance: lum });
    }
    for (const [family, shades] of grouped) {
      shades.sort((a, b) => b.luminance - a.luminance);
      if (shades.length === 1) {
        palette.push({ name: `${family}-500`, hex: shades[0].hex });
      } else {
        const steps = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900];
        const pickSteps = shades.length <= steps.length
          ? steps.filter((_, i) => i % Math.ceil(steps.length / shades.length) === 0).slice(0, shades.length)
          : steps;
        for (let i = 0; i < shades.length && i < pickSteps.length; i++) {
          palette.push({ name: `${family}-${pickSteps[i]}`, hex: shades[i].hex });
        }
      }
    }
  }

  return { semantic, palette };
}

// ─── Scalable (fluid) font size with clamp() ───

function generateClampFontSize(remValue: number): string {
  const minRem = remValue * 0.75;
  const maxRem = remValue;
  const minVw = 20;  // 320px
  const maxVw = 90;  // 1440px
  const slope = (maxRem - minRem) / (maxVw - minVw);
  const intercept = minRem - slope * minVw;
  const vwCoeff = slope * 100;
  return `clamp(${minRem.toFixed(3)}rem, ${intercept.toFixed(3)}rem + ${vwCoeff.toFixed(2)}vw, ${maxRem.toFixed(3)}rem)`;
}

// ─── Gradient angle helper ───

function getGradientAngle(transform: number[][]): number {
  if (!transform || transform.length < 2) return 180;
  const angle = Math.atan2(transform[1][0], transform[0][0]) * (180 / Math.PI);
  return Math.round((angle + 90 + 360) % 360);
}

// Scan all nodes on the current page and extract design tokens
function scanNodesForTokens(): ScannedTokens {
  const colorMap = new Map<string, { count: number; usedAs: Set<string> }>();
  const typographySet = new Map<string, { fontSize: number; fontFamily: string; fontStyle: string; lineHeight: number | null }>();
  const spacingSet = new Set<number>();
  const radiiSet = new Set<number>();
  const shadowMap = new Map<string, { type: string; offsetX: number; offsetY: number; blur: number; spread: number; color: string }>();
  const gradientMap = new Map<string, { type: 'linear' | 'radial'; angle: number; stops: { color: string; position: number }[] }>();
  const animationMap = new Map<string, { duration: number; easing: string }>();

  const allNodes = figma.currentPage.findAll();

  for (const node of allNodes) {
    // --- Colors from fills and strokes ---
    if ('fills' in node && Array.isArray(node.fills)) {
      for (const paint of node.fills as ReadonlyArray<Paint>) {
        if (paint.type === 'SOLID' && paint.visible !== false) {
          const hex = rgbaToHex(paint.color.r, paint.color.g, paint.color.b, paint.opacity !== undefined ? paint.opacity : 1);
          const entry = colorMap.get(hex) || { count: 0, usedAs: new Set<string>() };
          entry.count++;
          entry.usedAs.add(node.type === 'TEXT' ? 'text' : 'fill');
          colorMap.set(hex, entry);
        }
      }
    }
    if ('strokes' in node && Array.isArray(node.strokes)) {
      for (const paint of node.strokes as ReadonlyArray<Paint>) {
        if (paint.type === 'SOLID' && paint.visible !== false) {
          const hex = rgbaToHex(paint.color.r, paint.color.g, paint.color.b, paint.opacity !== undefined ? paint.opacity : 1);
          const entry = colorMap.get(hex) || { count: 0, usedAs: new Set<string>() };
          entry.count++;
          entry.usedAs.add('stroke');
          colorMap.set(hex, entry);
        }
      }
    }

    // --- Typography from text nodes ---
    if (node.type === 'TEXT') {
      const textNode = node as TextNode;
      const fontSize = typeof textNode.fontSize === 'number' ? textNode.fontSize : null;
      const fontFamily = typeof textNode.fontName === 'object' && 'family' in textNode.fontName ? textNode.fontName.family : null;
      const fontStyle = typeof textNode.fontName === 'object' && 'style' in textNode.fontName ? textNode.fontName.style : null;

      if (fontSize && fontFamily && fontStyle) {
        let lh: number | null = null;
        if (typeof textNode.lineHeight === 'object' && 'value' in textNode.lineHeight) {
          const lhObj = textNode.lineHeight as { value: number; unit: string };
          if (lhObj.unit === 'PIXELS') {
            lh = parseFloat((lhObj.value / fontSize).toFixed(2));
          } else if (lhObj.unit === 'PERCENT') {
            lh = parseFloat((lhObj.value / 100).toFixed(2));
          }
        }
        const key = `${fontSize}-${fontFamily}-${fontStyle}`;
        if (!typographySet.has(key)) {
          typographySet.set(key, { fontSize, fontFamily, fontStyle, lineHeight: lh });
        }
      }
    }

    // --- Spacing from auto-layout ---
    if ('layoutMode' in node) {
      const frame = node as FrameNode;
      if (frame.layoutMode && frame.layoutMode !== 'NONE') {
        if (typeof frame.itemSpacing === 'number' && frame.itemSpacing > 0) spacingSet.add(frame.itemSpacing);
        if (typeof frame.paddingTop === 'number' && frame.paddingTop > 0) spacingSet.add(frame.paddingTop);
        if (typeof frame.paddingRight === 'number' && frame.paddingRight > 0) spacingSet.add(frame.paddingRight);
        if (typeof frame.paddingBottom === 'number' && frame.paddingBottom > 0) spacingSet.add(frame.paddingBottom);
        if (typeof frame.paddingLeft === 'number' && frame.paddingLeft > 0) spacingSet.add(frame.paddingLeft);
      }
    }

    // --- Border radius ---
    if ('cornerRadius' in node) {
      const r = (node as any).cornerRadius;
      if (typeof r === 'number' && r > 0) {
        radiiSet.add(r);
      }
    }

    // --- Shadows from effects ---
    if ('effects' in node && Array.isArray(node.effects)) {
      for (const effect of node.effects as ReadonlyArray<Effect>) {
        if ((effect.type === 'DROP_SHADOW' || effect.type === 'INNER_SHADOW') && effect.visible !== false) {
          const shadow = effect as DropShadowEffect | InnerShadowEffect;
          const hex = rgbaToHex(shadow.color.r, shadow.color.g, shadow.color.b, shadow.color.a);
          const key = `${effect.type}-${shadow.offset.x}-${shadow.offset.y}-${shadow.radius}-${shadow.spread || 0}-${hex}`;
          if (!shadowMap.has(key)) {
            shadowMap.set(key, {
              type: effect.type === 'INNER_SHADOW' ? 'inset' : '',
              offsetX: shadow.offset.x,
              offsetY: shadow.offset.y,
              blur: shadow.radius,
              spread: shadow.spread || 0,
              color: hex
            });
          }
        }
      }
    }

    // --- Gradients from fills ---
    if ('fills' in node && Array.isArray(node.fills)) {
      for (const paint of node.fills as ReadonlyArray<Paint>) {
        if ((paint.type === 'GRADIENT_LINEAR' || paint.type === 'GRADIENT_RADIAL') && paint.visible !== false) {
          const gPaint = paint as GradientPaint;
          const stops = gPaint.gradientStops.map(s => ({
            color: rgbaToHex(s.color.r, s.color.g, s.color.b, s.color.a),
            position: Math.round(s.position * 100),
          }));
          const angle = paint.type === 'GRADIENT_LINEAR'
            ? getGradientAngle(gPaint.gradientTransform as unknown as number[][])
            : 0;
          const key = stops.map(s => `${s.color}-${s.position}`).join('|') + `|${angle}`;
          if (!gradientMap.has(key)) {
            gradientMap.set(key, {
              type: paint.type === 'GRADIENT_LINEAR' ? 'linear' : 'radial',
              angle,
              stops,
            });
          }
        }
      }
    }

    // --- Animation tokens from reactions ---
    if ('reactions' in node) {
      const reactions = (node as any).reactions as any[] | undefined;
      if (reactions && Array.isArray(reactions)) {
        for (const reaction of reactions) {
          if (reaction.action && reaction.action.transition) {
            const t = reaction.action.transition;
            const duration = typeof t.duration === 'number' ? Math.round(t.duration * 1000) : 0;
            const easingType = t.easing && t.easing.type ? t.easing.type : 'EASE_IN_AND_OUT';
            if (duration > 0) {
              const key = `${duration}-${easingType}`;
              if (!animationMap.has(key)) {
                animationMap.set(key, { duration, easing: easingType });
              }
            }
          }
        }
      }
    }
  }

  // Convert maps/sets to sorted arrays
  const colors = Array.from(colorMap.entries()).map(([hex, data]) => ({
    hex,
    count: data.count,
    usedAs: Array.from(data.usedAs) as ('fill' | 'stroke' | 'text')[]
  }));

  const typography = Array.from(typographySet.values());
  // Sort by fontSize descending
  typography.sort((a, b) => b.fontSize - a.fontSize);

  const spacing = Array.from(spacingSet).sort((a, b) => a - b);
  const radii = Array.from(radiiSet).sort((a, b) => a - b);
  const shadows = Array.from(shadowMap.values()).sort((a, b) => a.blur - b.blur);
  const gradients = Array.from(gradientMap.values());
  const animations = Array.from(animationMap.values()).sort((a, b) => a.duration - b.duration);

  return { colors, typography, spacing, radii, shadows, gradients, animations };
}

// Map Figma easing type to CSS timing function
function easingToCSS(easing: string): string {
  switch (easing) {
    case 'EASE_IN': return 'ease-in';
    case 'EASE_OUT': return 'ease-out';
    case 'EASE_IN_AND_OUT': return 'ease-in-out';
    case 'LINEAR': return 'linear';
    default: return 'ease-in-out';
  }
}

// Snap duration to standard scale
function snapDuration(ms: number): number {
  const scale = [75, 100, 150, 200, 300, 500, 700, 1000];
  let best = scale[0];
  let bestDist = Infinity;
  for (const s of scale) {
    const dist = Math.abs(s - ms);
    if (dist < bestDist) {
      bestDist = dist;
      best = s;
    }
  }
  return best;
}

// Generate CSS from scanned tokens using Tailwind v4 native variable names
function generateScannedCSS(tokens: ScannedTokens, opts: GenerateOptions = DEFAULT_OPTIONS): CSSOutput {
  const sections: CSSSection[] = [];
  const useTW = opts.defaultClasses;

  // --- Colors ---
  if (opts.colors && tokens.colors.length > 0) {
    let sectionCSS = '';
    if (useTW) {
      const { semantic, palette } = classifyColorsForTailwind(tokens.colors);
      if (semantic.length > 0) {
        sectionCSS += '\n  /* Colors */\n';
        for (const c of semantic) {
          sectionCSS += `  --color-${c.name}: ${c.hex};\n`;
        }
      }
      if (palette.length > 0) {
        sectionCSS += '\n  /* Color Palette */\n';
        for (const c of palette) {
          sectionCSS += `  --color-${c.name}: ${c.hex};\n`;
        }
      }
    } else {
      sectionCSS += '\n  /* Colors */\n';
      const sorted = [...tokens.colors].sort((a, b) => b.count - a.count);
      const grouped = new Map<string, { hex: string; luminance: number }[]>();
      for (const c of sorted) {
        const hue = hexHue(c.hex);
        const sat = hexSaturation(c.hex);
        const lum = hexLuminance(c.hex);
        const family = hueToColorName(hue, sat, lum);
        if (!grouped.has(family)) grouped.set(family, []);
        grouped.get(family)!.push({ hex: c.hex, luminance: lum });
      }
      for (const [family, shades] of grouped) {
        shades.sort((a, b) => b.luminance - a.luminance);
        if (shades.length === 1) {
          sectionCSS += `  --color-${family}-500: ${shades[0].hex};\n`;
        } else {
          const steps = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900];
          const pick = shades.length <= steps.length
            ? steps.filter((_, i) => i % Math.ceil(steps.length / shades.length) === 0).slice(0, shades.length)
            : steps;
          for (let i = 0; i < shades.length && i < pick.length; i++) {
            sectionCSS += `  --color-${family}-${pick[i]}: ${shades[i].hex};\n`;
          }
        }
      }
    }
    if (sectionCSS) sections.push({ label: 'Colors', css: sectionCSS });
  }

  // --- Font Families ---
  const uniqueFamilies = new Set(tokens.typography.map(t => t.fontFamily));
  if (opts.fontFamilies && uniqueFamilies.size > 0) {
    let sectionCSS = '\n  /* Font Families */\n';
    if (useTW) {
      const SYSTEM_FALLBACKS: Record<string, string> = {
        sans: 'ui-sans-serif, system-ui, sans-serif',
        serif: 'ui-serif, Georgia, serif',
        mono: 'ui-monospace, SFMono-Regular, monospace',
      };
      for (const family of uniqueFamilies) {
        const kind = classifyFontFamily(family);
        const quoted = family.includes(' ') ? `"${family}"` : family;
        sectionCSS += `  --font-${kind}: ${quoted}, ${SYSTEM_FALLBACKS[kind]};\n`;
      }
    } else {
      for (const family of uniqueFamilies) {
        const slug = family.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
        const quoted = family.includes(' ') ? `"${family}"` : family;
        sectionCSS += `  --font-family-${slug}: ${quoted};\n`;
      }
    }
    sections.push({ label: 'Font Families', css: sectionCSS });
  }

  // --- Font Sizes ---
  if (opts.fontSizes && tokens.typography.length > 0) {
    const fontSizes = [...new Set(tokens.typography.map(t => t.fontSize))].sort((a, b) => a - b);
    let sectionCSS = '\n  /* Font Sizes */\n';
    if (useTW) {
      const usedTextNames = new Set<string>();
      for (const px of fontSizes) {
        const rem = px / 16;
        const name = snapFontSizeToTailwind(rem, usedTextNames);
        const value = opts.scalableFontSize ? generateClampFontSize(rem) : `${rem.toFixed(3)}rem`;
        sectionCSS += `  --text-${name}: ${value};\n`;
      }
    } else {
      const roles = getTypoRoles(fontSizes.length);
      const reversedRoles = [...roles].reverse();
      for (let i = 0; i < fontSizes.length; i++) {
        const rem = fontSizes[i] / 16;
        const value = opts.scalableFontSize ? generateClampFontSize(rem) : `${rem.toFixed(3)}rem`;
        sectionCSS += `  --text-${reversedRoles[i]}: ${value};\n`;
      }
    }
    sections.push({ label: 'Font Sizes', css: sectionCSS });
  }

  // --- Line Heights ---
  if (opts.lineHeights && tokens.typography.length > 0) {
    const lineHeights = [...new Set(
      tokens.typography.filter(t => t.lineHeight !== null).map(t => t.lineHeight!)
    )];
    if (lineHeights.length > 0) {
      let sectionCSS = '\n  /* Line Heights */\n';
      if (useTW) {
        const usedLeadingNames = new Set<string>();
        for (const lh of lineHeights) {
          const name = snapLineHeightToTailwind(lh);
          if (usedLeadingNames.has(name)) continue;
          usedLeadingNames.add(name);
          sectionCSS += `  --leading-${name}: ${lh};\n`;
        }
      } else {
        const labels = getSizeLabels(lineHeights.length);
        for (let i = 0; i < lineHeights.length; i++) {
          sectionCSS += `  --leading-${labels[i]}: ${lineHeights[i]};\n`;
        }
      }
      sections.push({ label: 'Line Heights', css: sectionCSS });
    }
  }

  // --- Font Weights ---
  if (opts.fontWeights && tokens.typography.length > 0) {
    const weights = [...new Set(tokens.typography.map(t => fontStyleToWeight(t.fontStyle)))].sort((a, b) => a - b);
    if (weights.length > 0) {
      let sectionCSS = '\n  /* Font Weights */\n';
      for (const w of weights) {
        const name = useTW ? (TW_WEIGHT_MAP[w] || `${w}`) : `${w}`;
        sectionCSS += `  --font-weight-${name}: ${w};\n`;
      }
      sections.push({ label: 'Font Weights', css: sectionCSS });
    }
  }

  // --- Spacing ---
  if (opts.spacing && tokens.spacing.length > 0) {
    let sectionCSS = '\n  /* Spacing */\n';
    if (useTW) {
      const base = findGCD(tokens.spacing);
      sectionCSS += `  --spacing: ${(base / 16).toFixed(3)}rem;\n`;
    } else {
      const labels = getSizeLabels(tokens.spacing.length);
      for (let i = 0; i < tokens.spacing.length; i++) {
        sectionCSS += `  --space-${labels[i]}: ${(tokens.spacing[i] / 16).toFixed(3)}rem;\n`;
      }
    }
    sections.push({ label: 'Spacing', css: sectionCSS });
  }

  // --- Border Radius ---
  if (opts.borderRadius && tokens.radii.length > 0) {
    let sectionCSS = '\n  /* Border Radius */\n';
    if (useTW) {
      const usedRadiusNames = new Set<string>();
      const sortedRadii = [...tokens.radii].sort((a, b) => a - b);
      for (const px of sortedRadii) {
        const name = snapRadiusToTailwind(px, usedRadiusNames);
        const value = name === 'full' ? '9999px' : `${(px / 16).toFixed(3)}rem`;
        sectionCSS += `  --radius-${name}: ${value};\n`;
      }
    } else {
      const labels = getSizeLabels(tokens.radii.length);
      for (let i = 0; i < tokens.radii.length; i++) {
        sectionCSS += `  --radius-${labels[i]}: ${tokens.radii[i]}px;\n`;
      }
    }
    sections.push({ label: 'Border Radius', css: sectionCSS });
  }

  // --- Shadows ---
  if (opts.shadows && tokens.shadows.length > 0) {
    let sectionCSS = '\n  /* Shadows */\n';
    const sortedShadows = [...tokens.shadows].sort((a, b) => a.blur - b.blur);
    for (let i = 0; i < sortedShadows.length; i++) {
      const s = sortedShadows[i];
      const name = useTW
        ? (i < TW_SHADOW_NAMES.length ? TW_SHADOW_NAMES[i] : `${i + 1}`)
        : getSizeLabels(sortedShadows.length)[i];
      const inset = s.type ? `${s.type} ` : '';
      sectionCSS += `  --shadow-${name}: ${inset}${s.offsetX}px ${s.offsetY}px ${s.blur}px ${s.spread}px ${s.color};\n`;
    }
    sections.push({ label: 'Shadows', css: sectionCSS });
  }

  // --- Gradients ---
  if (opts.gradients && tokens.gradients.length > 0) {
    let sectionCSS = '\n  /* Gradients */\n';
    for (let i = 0; i < tokens.gradients.length; i++) {
      const g = tokens.gradients[i];
      const stopsStr = g.stops.map(s => `${s.color} ${s.position}%`).join(', ');
      if (g.type === 'linear') {
        sectionCSS += `  --gradient-${i + 1}: linear-gradient(${g.angle}deg, ${stopsStr});\n`;
      } else {
        sectionCSS += `  --gradient-${i + 1}: radial-gradient(circle, ${stopsStr});\n`;
      }
    }
    sections.push({ label: 'Gradients', css: sectionCSS });
  }

  // --- Animations ---
  if (opts.animations && tokens.animations.length > 0) {
    let sectionCSS = '\n  /* Animations */\n';
    const seenDurations = new Set<number>();
    const seenEasings = new Set<string>();
    for (const anim of tokens.animations) {
      const snapped = snapDuration(anim.duration);
      if (!seenDurations.has(snapped)) {
        seenDurations.add(snapped);
        sectionCSS += `  --duration-${snapped}: ${snapped}ms;\n`;
      }
      const cssEasing = easingToCSS(anim.easing);
      if (!seenEasings.has(cssEasing)) {
        seenEasings.add(cssEasing);
        sectionCSS += `  --ease-${cssEasing}: ${cssEasing};\n`;
      }
    }
    sections.push({ label: 'Animations', css: sectionCSS });
  }

  // Build full CSS
  let full = '/* Generated by Figma to Tailwind v4 Plugin */\n';
  full += '/* Tokens extracted from design scan */\n\n';
  full += '@theme {\n';
  for (const section of sections) {
    full += section.css;
  }
  full += '}\n';

  return { full, sections };
}

// Generate Tailwind v4 CSS from variables/styles
function generateTailwindCSS(collectionsData: CollectionData[], stylesData: any, opts: GenerateOptions = DEFAULT_OPTIONS): CSSOutput {
  const sections: CSSSection[] = [];

  // Process variables by collection
  for (const collection of collectionsData) {
    const modeGroups = new Map<string, VariableData[]>();
    collection.variables.forEach(function(v) {
      if (!modeGroups.has(v.mode)) {
        modeGroups.set(v.mode, []);
      }
      modeGroups.get(v.mode)!.push(v);
    });

    let collectionCSS = '';

    for (const [modeName, variables] of modeGroups) {
      const uniqueVars = new Map<string, VariableData>();
      variables.forEach(function(v) {
        const key = v.name + '-' + v.mode;
        if (!uniqueVars.has(key)) {
          uniqueVars.set(key, v);
        }
      });

      var modeLines = '';
      for (const variable of uniqueVars.values()) {
        if (variable.resolvedDataType === 'COLOR' && !opts.colors) continue;
        if (variable.resolvedDataType === 'FLOAT' && !opts.spacing) continue;
        if (variable.resolvedDataType === 'STRING' && !opts.fontFamilies) continue;

        let category: string | undefined;
        if (variable.resolvedDataType === 'COLOR') {
          category = 'color';
        } else if (variable.resolvedDataType === 'FLOAT') {
          category = 'space';
        }
        const cssVarName = toCSSVariableName(variable.name, collection.name, modeName, category);
        const cssValue = formatValueForCSS(variable.variableValue, variable.resolvedDataType);
        modeLines += '  ' + cssVarName + ': ' + cssValue + ';\n';
      }

      if (modeLines) {
        collectionCSS += '\n  /* ' + collection.name + (collection.modes.length > 1 ? ' - ' + modeName : '') + ' */\n';
        collectionCSS += modeLines;
      }
    }

    if (collectionCSS) {
      sections.push({ label: collection.name, css: collectionCSS });
    }
  }

  // Add color styles
  if (opts.colors && stylesData.colors.length > 0) {
    let sectionCSS = '\n  /* Color Styles */\n';
    if (opts.defaultClasses) {
      var colorEntries: { hex: string; count: number; usedAs: ('fill' | 'stroke' | 'text')[] }[] = [];
      for (const style of stylesData.colors) {
        const paint = style.paints[0];
        if (paint && paint.type === 'SOLID' && paint.color) {
          const hex = rgbaToHex(paint.color.r, paint.color.g, paint.color.b, paint.opacity || 1);
          colorEntries.push({ hex: hex, count: 1, usedAs: ['fill'] });
        }
      }
      var classified = classifyColorsForTailwind(colorEntries);
      for (var ci = 0; ci < classified.semantic.length; ci++) {
        sectionCSS += '  --color-' + classified.semantic[ci].name + ': ' + classified.semantic[ci].hex + ';\n';
      }
      for (var pi = 0; pi < classified.palette.length; pi++) {
        sectionCSS += '  --color-' + classified.palette[pi].name + ': ' + classified.palette[pi].hex + ';\n';
      }
    } else {
      for (const style of stylesData.colors) {
        const paint = style.paints[0];
        if (paint && paint.type === 'SOLID' && paint.color) {
          const name = toCSSVariableName(style.name, '', '', 'color');
          const hex = rgbaToHex(paint.color.r, paint.color.g, paint.color.b, paint.opacity || 1);
          sectionCSS += '  ' + name + ': ' + hex + ';\n';
        }
      }
    }
    sections.push({ label: 'Color Styles', css: sectionCSS });
  }

  // Add text styles
  if (stylesData.textStyles.length > 0) {
    var textLines = '';

    if (opts.fontFamilies) {
      const families = new Set<string>();
      for (const style of stylesData.textStyles) {
        if (style.fontFamily) families.add(style.fontFamily);
      }
      if (opts.defaultClasses) {
        var SYSTEM_FALLBACKS: Record<string, string> = {
          sans: 'ui-sans-serif, system-ui, sans-serif',
          serif: 'ui-serif, Georgia, serif',
          mono: 'ui-monospace, SFMono-Regular, monospace',
        };
        for (const family of families) {
          const kind = classifyFontFamily(family);
          const quoted = family.includes(' ') ? '"' + family + '"' : family;
          textLines += '  --font-' + kind + ': ' + quoted + ', ' + SYSTEM_FALLBACKS[kind] + ';\n';
        }
      } else {
        for (const family of families) {
          const slug = family.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
          const quoted = family.includes(' ') ? '"' + family + '"' : family;
          textLines += '  --font-family-' + slug + ': ' + quoted + ';\n';
        }
      }
    }

    if (opts.fontSizes) {
      if (opts.defaultClasses) {
        var fontSizesSorted: { rem: number; style: any }[] = [];
        for (const style of stylesData.textStyles) {
          if (style.fontSize) {
            fontSizesSorted.push({ rem: style.fontSize / 16, style: style });
          }
        }
        fontSizesSorted.sort(function(a, b) { return a.rem - b.rem; });
        var seenRem = new Set<number>();
        var dedupedSizes: { rem: number }[] = [];
        for (var fi = 0; fi < fontSizesSorted.length; fi++) {
          if (!seenRem.has(fontSizesSorted[fi].rem)) {
            seenRem.add(fontSizesSorted[fi].rem);
            dedupedSizes.push({ rem: fontSizesSorted[fi].rem });
          }
        }
        var usedTextNames = new Set<string>();
        for (var di = 0; di < dedupedSizes.length; di++) {
          var twName = snapFontSizeToTailwind(dedupedSizes[di].rem, usedTextNames);
          var val = opts.scalableFontSize
            ? generateClampFontSize(dedupedSizes[di].rem)
            : dedupedSizes[di].rem.toFixed(3) + 'rem';
          textLines += '  --text-' + twName + ': ' + val + ';\n';
        }
      } else {
        for (const style of stylesData.textStyles) {
          if (style.fontSize) {
            const textName = toCSSVariableName(style.name, '', '', 'text');
            const rem = style.fontSize / 16;
            var sizeVal = opts.scalableFontSize ? generateClampFontSize(rem) : rem.toFixed(3) + 'rem';
            textLines += '  ' + textName + ': ' + sizeVal + ';\n';
          }
        }
      }
    }

    if (opts.fontWeights) {
      if (opts.defaultClasses) {
        var weightSet = new Set<number>();
        for (const style of stylesData.textStyles) {
          if (style.fontWeight) weightSet.add(fontStyleToWeight(style.fontWeight));
        }
        var weightsArr = Array.from(weightSet).sort(function(a, b) { return a - b; });
        for (var wi = 0; wi < weightsArr.length; wi++) {
          var wName = TW_WEIGHT_MAP[weightsArr[wi]] || String(weightsArr[wi]);
          textLines += '  --font-weight-' + wName + ': ' + weightsArr[wi] + ';\n';
        }
      } else {
        for (const style of stylesData.textStyles) {
          if (style.fontWeight) {
            const weightName = toCSSVariableName(style.name, '', '', 'font-weight');
            const numericWeight = fontStyleToWeight(style.fontWeight);
            textLines += '  ' + weightName + ': ' + numericWeight + ';\n';
          }
        }
      }
    }

    if (opts.lineHeights) {
      if (opts.defaultClasses) {
        var lhValues: number[] = [];
        for (const style of stylesData.textStyles) {
          if (style.lineHeight && typeof style.lineHeight === 'object' && 'value' in style.lineHeight) {
            const lhObj = style.lineHeight as { value: number; unit: string };
            var lhNum: number;
            if (lhObj.unit === 'PIXELS' && style.fontSize) {
              lhNum = parseFloat((lhObj.value / style.fontSize).toFixed(2));
            } else if (lhObj.unit === 'PERCENT') {
              lhNum = parseFloat((lhObj.value / 100).toFixed(2));
            } else {
              lhNum = lhObj.value;
            }
            if (lhValues.indexOf(lhNum) === -1) lhValues.push(lhNum);
          }
        }
        var usedLeadingNames = new Set<string>();
        for (var li = 0; li < lhValues.length; li++) {
          var leadName = snapLineHeightToTailwind(lhValues[li]);
          if (usedLeadingNames.has(leadName)) continue;
          usedLeadingNames.add(leadName);
          textLines += '  --leading-' + leadName + ': ' + lhValues[li] + ';\n';
        }
      } else {
        for (const style of stylesData.textStyles) {
          if (style.lineHeight && typeof style.lineHeight === 'object' && 'value' in style.lineHeight) {
            const leadingName = toCSSVariableName(style.name, '', '', 'leading');
            const lhObj = style.lineHeight as { value: number; unit: string };
            let lhValue: string;
            if (lhObj.unit === 'PIXELS' && style.fontSize) {
              lhValue = (lhObj.value / style.fontSize).toFixed(2);
            } else if (lhObj.unit === 'PERCENT') {
              lhValue = (lhObj.value / 100).toFixed(2);
            } else {
              lhValue = String(lhObj.value);
            }
            textLines += '  ' + leadingName + ': ' + lhValue + ';\n';
          }
        }
      }
    }

    if (textLines) {
      sections.push({ label: 'Text Styles', css: '\n  /* Text Styles */\n' + textLines });
    }
  }

  // Add effect styles
  if (opts.shadows && stylesData.effects && stylesData.effects.length > 0) {
    let sectionCSS = '\n  /* Effect Styles */\n';
    if (opts.defaultClasses) {
      var effectList: { style: any; effect: any; blur: number }[] = [];
      for (const style of stylesData.effects) {
        if (style.effects && style.effects.length > 0) {
          const effect = style.effects[0];
          if (effect.type === 'DROP_SHADOW' || effect.type === 'INNER_SHADOW') {
            effectList.push({ style: style, effect: effect, blur: effect.radius });
          }
        }
      }
      effectList.sort(function(a, b) { return a.blur - b.blur; });
      for (var si = 0; si < effectList.length; si++) {
        var shadowName = si < TW_SHADOW_NAMES.length ? TW_SHADOW_NAMES[si] : String(si + 1);
        var eff = effectList[si].effect;
        var insetStr = eff.type === 'INNER_SHADOW' ? 'inset ' : '';
        var hexStr = rgbaToHex(eff.color.r, eff.color.g, eff.color.b, eff.color.a);
        sectionCSS += '  --shadow-' + shadowName + ': ' + insetStr + eff.offset.x + 'px ' + eff.offset.y + 'px ' + eff.radius + 'px ' + (eff.spread || 0) + 'px ' + hexStr + ';\n';
      }
    } else {
      for (const style of stylesData.effects) {
        if (style.effects && style.effects.length > 0) {
          const effect = style.effects[0];
          if (effect.type === 'DROP_SHADOW' || effect.type === 'INNER_SHADOW') {
            const name = toCSSVariableName(style.name, '', '', 'shadow');
            const inset = effect.type === 'INNER_SHADOW' ? 'inset ' : '';
            const hex = rgbaToHex(effect.color.r, effect.color.g, effect.color.b, effect.color.a);
            sectionCSS += '  ' + name + ': ' + inset + effect.offset.x + 'px ' + effect.offset.y + 'px ' + effect.radius + 'px ' + (effect.spread || 0) + 'px ' + hex + ';\n';
          }
        }
      }
    }
    sections.push({ label: 'Effect Styles', css: sectionCSS });
  }

  // Build full CSS
  let full = '/* Generated by Figma to Tailwind v4 Plugin */\n';
  full += '/* No Dev Mode required! */\n\n';
  full += '@theme {\n';
  for (const section of sections) {
    full += section.css;
  }
  full += '}\n';

  return { full, sections };
}

// ─── Layer to Tailwind ───

// Tailwind spacing scale map (px -> class value)
const TW_SPACING_MAP: Record<number, string> = {
  0: '0', 1: 'px', 2: '0.5', 4: '1', 6: '1.5', 8: '2', 10: '2.5', 12: '3',
  14: '3.5', 16: '4', 20: '5', 24: '6', 28: '7', 32: '8', 36: '9', 40: '10',
  44: '11', 48: '12', 56: '14', 64: '16', 80: '20', 96: '24', 112: '28',
  128: '32', 144: '36', 160: '40', 176: '44', 192: '48', 208: '52', 224: '56',
  240: '60', 256: '64', 288: '72', 320: '80', 384: '96',
};

function pxToTailwindSpacing(px: number): string {
  if (px === 0) return '0';
  // Exact match
  if (TW_SPACING_MAP[px] !== undefined) return TW_SPACING_MAP[px];
  // Close match (within 1px)
  for (const [key, val] of Object.entries(TW_SPACING_MAP)) {
    if (Math.abs(Number(key) - px) <= 1) return val;
  }
  // Arbitrary value
  return `[${px}px]`;
}

// Tailwind default color palette for matching
const TW_COLORS: Record<string, string> = {
  '#000000': 'black', '#ffffff': 'white',
  '#f8fafc': 'slate-50', '#f1f5f9': 'slate-100', '#e2e8f0': 'slate-200', '#cbd5e1': 'slate-300',
  '#94a3b8': 'slate-400', '#64748b': 'slate-500', '#475569': 'slate-600', '#334155': 'slate-700',
  '#1e293b': 'slate-800', '#0f172a': 'slate-900', '#020617': 'slate-950',
  '#fef2f2': 'red-50', '#fee2e2': 'red-100', '#fecaca': 'red-200', '#fca5a5': 'red-300',
  '#f87171': 'red-400', '#ef4444': 'red-500', '#dc2626': 'red-600', '#b91c1c': 'red-700',
  '#991b1b': 'red-800', '#7f1d1d': 'red-900',
  '#eff6ff': 'blue-50', '#dbeafe': 'blue-100', '#bfdbfe': 'blue-200', '#93c5fd': 'blue-300',
  '#60a5fa': 'blue-400', '#3b82f6': 'blue-500', '#2563eb': 'blue-600', '#1d4ed8': 'blue-700',
  '#1e40af': 'blue-800', '#1e3a8a': 'blue-900',
  '#f0fdf4': 'green-50', '#dcfce7': 'green-100', '#bbf7d0': 'green-200', '#86efac': 'green-300',
  '#4ade80': 'green-400', '#22c55e': 'green-500', '#16a34a': 'green-600', '#15803d': 'green-700',
  '#166534': 'green-800', '#14532d': 'green-900',
  '#fefce8': 'yellow-50', '#fef9c3': 'yellow-100', '#fef08a': 'yellow-200', '#fde047': 'yellow-300',
  '#facc15': 'yellow-400', '#eab308': 'yellow-500', '#ca8a04': 'yellow-600', '#a16207': 'yellow-700',
  '#854d0e': 'yellow-800', '#713f12': 'yellow-900',
  '#f5f3ff': 'violet-50', '#ede9fe': 'violet-100', '#ddd6fe': 'violet-200', '#c4b5fd': 'violet-300',
  '#a78bfa': 'violet-400', '#8b5cf6': 'violet-500', '#7c3aed': 'violet-600', '#6d28d9': 'violet-700',
  '#5b21b6': 'violet-800', '#4c1d95': 'violet-900',
};

function hexToTailwindColor(hex: string, extractedColors?: Map<string, string>): string {
  const lower = hex.toLowerCase();
  // Check extracted theme colors first
  if (extractedColors && extractedColors.has(lower)) {
    return extractedColors.get(lower)!;
  }
  // Check TW defaults
  if (TW_COLORS[lower]) return TW_COLORS[lower];
  // Arbitrary
  return `[${hex}]`;
}

// ─── TokenRegistry for CSS variable mode ───

interface TokenRegistry {
  colors: Map<string, string>;      // hex -> var name (e.g. "primary")
  fontSizes: Map<number, string>;   // px -> var name (e.g. "lg")
  spacing: Map<number, string>;     // px -> var name (e.g. "4")
  radii: Map<number, string>;       // px -> var name (e.g. "md")
  shadows: Map<string, string>;     // shadow-key -> var name
}

function createTokenRegistry(): TokenRegistry {
  return {
    colors: new Map(),
    fontSizes: new Map(),
    spacing: new Map(),
    radii: new Map(),
    shadows: new Map(),
  };
}

// Register a color, returns the Tailwind-friendly name (without prefix)
function registerColor(registry: TokenRegistry, hex: string, extractedColors?: Map<string, string>): string {
  const lower = hex.toLowerCase();
  if (registry.colors.has(lower)) return registry.colors.get(lower)!;

  // 1. Match against extracted theme variables
  if (extractedColors && extractedColors.has(lower)) {
    const name = extractedColors.get(lower)!;
    registry.colors.set(lower, name);
    return name;
  }
  // 2. Match Tailwind defaults
  if (TW_COLORS[lower]) {
    const name = TW_COLORS[lower];
    registry.colors.set(lower, name);
    return name;
  }
  // 3. Auto-name by hue family
  const hue = hexHue(lower);
  const sat = hexSaturation(lower);
  const lum = hexLuminance(lower);
  const family = hueToColorName(hue, sat, lum);
  // Find unique suffix
  const existingInFamily = Array.from(registry.colors.values()).filter(n => n.startsWith(family));
  const step = existingInFamily.length === 0 ? 500 : (existingInFamily.length + 1) * 100;
  const name = `${family}-${step}`;
  registry.colors.set(lower, name);
  return name;
}

function registerFontSize(registry: TokenRegistry, px: number): string {
  if (registry.fontSizes.has(px)) return registry.fontSizes.get(px)!;
  const rem = px / 16;
  const closest = TW_TEXT_SCALE.reduce((best, s) => Math.abs(s.rem - rem) < Math.abs(best.rem - rem) ? s : best);
  // Check if name already used
  const usedNames = new Set(registry.fontSizes.values());
  let name = closest.name;
  if (usedNames.has(name)) {
    name = `${closest.name}-${px}`;
  }
  registry.fontSizes.set(px, name);
  return name;
}

function registerSpacing(registry: TokenRegistry, px: number): string {
  if (registry.spacing.has(px)) return registry.spacing.get(px)!;
  // Use Tailwind spacing name if available
  const twName = pxToTailwindSpacing(px);
  if (!twName.startsWith('[')) {
    registry.spacing.set(px, twName);
    return twName;
  }
  // Use px value as name
  const name = `${px}`;
  registry.spacing.set(px, name);
  return name;
}

function registerRadius(registry: TokenRegistry, px: number): string {
  if (registry.radii.has(px)) return registry.radii.get(px)!;
  if (px >= 500) {
    registry.radii.set(px, 'full');
    return 'full';
  }
  const closest = TW_RADIUS_SCALE.filter(s => s.name !== 'full')
    .reduce((best, s) => Math.abs(s.px - px) < Math.abs(best.px - px) ? s : best);
  const usedNames = new Set(registry.radii.values());
  let name = closest.name;
  if (usedNames.has(name)) {
    name = `${closest.name}-${px}`;
  }
  registry.radii.set(px, name);
  return name;
}

function buildThemeCSS(registry: TokenRegistry): string {
  const lines: string[] = ['@theme {'];

  if (registry.colors.size > 0) {
    lines.push('  /* Colors */');
    for (const [hex, name] of registry.colors) {
      lines.push(`  --color-${name}: ${hex};`);
    }
  }

  if (registry.fontSizes.size > 0) {
    lines.push('');
    lines.push('  /* Font Sizes */');
    for (const [px, name] of registry.fontSizes) {
      const rem = px / 16;
      lines.push(`  --text-${name}: ${rem.toFixed(3)}rem;`);
    }
  }

  if (registry.spacing.size > 0) {
    lines.push('');
    lines.push('  /* Spacing */');
    for (const [px, name] of registry.spacing) {
      const rem = px / 16;
      lines.push(`  --spacing-${name}: ${rem.toFixed(3)}rem;`);
    }
  }

  if (registry.radii.size > 0) {
    lines.push('');
    lines.push('  /* Border Radius */');
    for (const [px, name] of registry.radii) {
      lines.push(`  --radius-${name}: ${px}px;`);
    }
  }

  lines.push('}');
  return lines.join('\n');
}

// Modified nodeToClasses that uses a registry when provided
function nodeToClassesWithRegistry(node: SceneNode, parentIsAutoLayout: boolean, registry: TokenRegistry): string[] {
  const classes: string[] = [];
  if (node.visible === false) return classes;

  const isFrame = node.type === 'FRAME' || node.type === 'COMPONENT' || node.type === 'INSTANCE';

  if (isFrame) {
    const frame = node as FrameNode;
    if (frame.layoutMode && frame.layoutMode !== 'NONE') {
      classes.push('flex');
      if (frame.layoutMode === 'VERTICAL') classes.push('flex-col');
      switch (frame.primaryAxisAlignItems) {
        case 'CENTER': classes.push('justify-center'); break;
        case 'MAX': classes.push('justify-end'); break;
        case 'SPACE_BETWEEN': classes.push('justify-between'); break;
      }
      switch (frame.counterAxisAlignItems) {
        case 'CENTER': classes.push('items-center'); break;
        case 'MAX': classes.push('items-end'); break;
      }
      if (typeof frame.itemSpacing === 'number' && frame.itemSpacing > 0) {
        const name = registerSpacing(registry, frame.itemSpacing);
        classes.push(`gap-${name}`);
      }
      if ((frame as any).layoutWrap === 'WRAP') classes.push('flex-wrap');
    } else {
      if (frame.children && frame.children.length > 0) {
        const layout = inferLayoutFromChildren(frame);
        if (layout === 'row') classes.push('flex');
        else if (layout === 'col') classes.push('flex', 'flex-col');
        else classes.push('relative');
      }
    }
    // Padding
    const pt = typeof frame.paddingTop === 'number' ? frame.paddingTop : 0;
    const pr = typeof frame.paddingRight === 'number' ? frame.paddingRight : 0;
    const pb = typeof frame.paddingBottom === 'number' ? frame.paddingBottom : 0;
    const pl = typeof frame.paddingLeft === 'number' ? frame.paddingLeft : 0;
    if (pt === pr && pr === pb && pb === pl && pt > 0) {
      classes.push(`p-${registerSpacing(registry, pt)}`);
    } else {
      if (pt === pb && pt > 0 && pl === pr && pl > 0) {
        classes.push(`px-${registerSpacing(registry, pl)}`);
        classes.push(`py-${registerSpacing(registry, pt)}`);
      } else {
        if (pt > 0) classes.push(`pt-${registerSpacing(registry, pt)}`);
        if (pr > 0) classes.push(`pr-${registerSpacing(registry, pr)}`);
        if (pb > 0) classes.push(`pb-${registerSpacing(registry, pb)}`);
        if (pl > 0) classes.push(`pl-${registerSpacing(registry, pl)}`);
      }
    }
    if (frame.clipsContent) classes.push('overflow-hidden');
  }

  // Size
  if (!parentIsAutoLayout) {
    if (node.width > 0) {
      const name = registerSpacing(registry, Math.round(node.width));
      classes.push(`w-${name}`);
    }
    if (node.height > 0) {
      const name = registerSpacing(registry, Math.round(node.height));
      classes.push(`h-${name}`);
    }
  } else {
    if (isFrame) {
      const frame = node as FrameNode;
      if ((frame as any).layoutGrow === 1) classes.push('flex-1');
      if ((frame as any).layoutAlign === 'STRETCH') classes.push('self-stretch');
    }
  }

  // Background / text color
  if ('fills' in node && Array.isArray(node.fills)) {
    for (const paint of node.fills as ReadonlyArray<Paint>) {
      if (paint.type === 'SOLID' && paint.visible !== false) {
        const hex = rgbaToHex(paint.color.r, paint.color.g, paint.color.b, paint.opacity !== undefined ? paint.opacity : 1);
        const colorName = registerColor(registry, hex);
        if (node.type === 'TEXT') {
          classes.push(`text-${colorName}`);
        } else {
          classes.push(`bg-${colorName}`);
        }
        break;
      }
    }
  }

  // Border
  if ('strokes' in node && Array.isArray(node.strokes) && node.strokes.length > 0) {
    const stroke = (node.strokes as ReadonlyArray<Paint>)[0];
    if (stroke && stroke.type === 'SOLID' && stroke.visible !== false) {
      const sw = typeof (node as any).strokeWeight === 'number' ? (node as any).strokeWeight : 1;
      if (sw === 1) classes.push('border');
      else classes.push(`border-${sw}`);
      const hex = rgbaToHex(stroke.color.r, stroke.color.g, stroke.color.b, stroke.opacity !== undefined ? stroke.opacity : 1);
      classes.push(`border-${registerColor(registry, hex)}`);
    }
  }

  // Border radius
  if ('cornerRadius' in node) {
    const r = (node as any).cornerRadius;
    if (typeof r === 'number' && r > 0) {
      const name = registerRadius(registry, r);
      classes.push(`rounded-${name}`);
    }
  }

  // Typography
  if (node.type === 'TEXT') {
    const textNode = node as TextNode;
    const fontSize = typeof textNode.fontSize === 'number' ? textNode.fontSize : null;
    if (fontSize) {
      const name = registerFontSize(registry, fontSize);
      classes.push(`text-${name}`);
    }
    if (typeof textNode.fontName === 'object' && 'style' in textNode.fontName) {
      const weight = fontStyleToWeight(textNode.fontName.style);
      if (weight !== 400) {
        const wName = TW_WEIGHT_MAP[weight] || `[${weight}]`;
        classes.push(`font-${wName}`);
      }
    }
    if (typeof textNode.lineHeight === 'object' && 'value' in textNode.lineHeight) {
      const lhObj = textNode.lineHeight as { value: number; unit: string };
      if (lhObj.unit === 'PIXELS' && fontSize) {
        const ratio = lhObj.value / fontSize;
        const closest = TW_LEADING_SCALE.reduce((best, s) => Math.abs(s.val - ratio) < Math.abs(best.val - ratio) ? s : best);
        if (Math.abs(closest.val - ratio) < 0.1) classes.push(`leading-${closest.name}`);
      }
    }
    if (typeof textNode.letterSpacing === 'object' && 'value' in textNode.letterSpacing) {
      const ls = (textNode.letterSpacing as any).value;
      if (typeof ls === 'number' && Math.abs(ls) > 0.1) {
        if (ls < -0.3) classes.push('tracking-tighter');
        else if (ls < 0) classes.push('tracking-tight');
        else if (ls > 0.5) classes.push('tracking-wider');
        else if (ls > 0.2) classes.push('tracking-wide');
      }
    }
    if (textNode.textAlignHorizontal === 'CENTER') classes.push('text-center');
    else if (textNode.textAlignHorizontal === 'RIGHT') classes.push('text-right');
  }

  // Opacity
  if ('opacity' in node && typeof (node as any).opacity === 'number' && (node as any).opacity < 1) {
    const op = Math.round((node as any).opacity * 100);
    classes.push(`opacity-${op}`);
  }

  // Shadow
  if ('effects' in node && Array.isArray(node.effects)) {
    for (const effect of node.effects as ReadonlyArray<Effect>) {
      if (effect.type === 'DROP_SHADOW' && effect.visible !== false) {
        const shadow = effect as DropShadowEffect;
        if (shadow.radius <= 3) classes.push('shadow-sm');
        else if (shadow.radius <= 8) classes.push('shadow');
        else if (shadow.radius <= 16) classes.push('shadow-md');
        else if (shadow.radius <= 25) classes.push('shadow-lg');
        else classes.push('shadow-xl');
        break;
      }
    }
  }

  return classes;
}

// Generate layer HTML with registry (CSS variable mode)
async function generateLayerHTMLWithRegistry(node: SceneNode, indent: number, isTopLevel: boolean, parentIsAutoLayout: boolean, registry: TokenRegistry, assets: AssetMap, usedFileNames: Set<string>): Promise<string> {
  if (indent > 10) return '';
  if (node.visible === false) return '';

  const pad = '  '.repeat(indent);
  const classes = nodeToClassesWithRegistry(node, parentIsAutoLayout, registry);
  const classStr = classes.length > 0 ? ` class="${classes.join(' ')}"` : '';

  if (hasImageFill(node)) {
    const name = node.name || 'image';
    const id = nextAssetId();
    try {
      const bytes = await (node as any).exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: 2 } });
      assets[id] = {
        base64: uint8ToBase64(bytes),
        mimeType: 'image/png',
        fileName: toAssetFileName(name, 'png', usedFileNames),
      };
    } catch (e) {
      // Fallback if export fails
      return `${pad}<img${classStr} src="/placeholder.svg" alt="${name.replace(/"/g, '&quot;')}" />\n`;
    }
    return `${pad}<img${classStr} src="{{asset:${id}}}" alt="${name.replace(/"/g, '&quot;')}" />\n`;
  }

  if (node.type === 'TEXT') {
    const tag = chooseHTMLTag(node, false);
    const text = getTextContent(node as TextNode);
    return `${pad}<${tag}${classStr}>${text}</${tag}>\n`;
  }

  if (node.type === 'VECTOR' || node.type === 'ELLIPSE' || node.type === 'LINE' || node.type === 'STAR' || node.type === 'POLYGON') {
    const name = node.name || 'icon';
    const id = nextAssetId();
    try {
      const bytes = await (node as any).exportAsync({ format: 'SVG' });
      assets[id] = {
        base64: uint8ToBase64(bytes),
        mimeType: 'image/svg+xml',
        fileName: toAssetFileName(name, 'svg', usedFileNames),
      };
      const w = Math.round(node.width);
      const h = Math.round(node.height);
      return `${pad}<img${classStr} src="{{asset:${id}}}" alt="${name.replace(/"/g, '&quot;')}" width="${w}" height="${h}" />\n`;
    } catch (e) {
      return `${pad}<!-- ${name} -->\n`;
    }
  }

  if (node.type === 'RECTANGLE') {
    return `${pad}<div${classStr}></div>\n`;
  }

  if (node.type === 'GROUP') {
    const group = node as GroupNode;
    let html = '';
    for (const child of group.children) {
      html += await generateLayerHTMLWithRegistry(child, indent, false, false, registry, assets, usedFileNames);
    }
    return html;
  }

  if (node.type === 'FRAME' || node.type === 'COMPONENT' || node.type === 'INSTANCE') {
    const frame = node as FrameNode;
    const tag = chooseHTMLTag(node, isTopLevel);
    const isAutoLayout = frame.layoutMode && frame.layoutMode !== 'NONE';
    const isOverlap = !isAutoLayout && frame.children.length > 0 && inferLayoutFromChildren(frame) === 'overlap';

    let html = '';
    if (node.type === 'COMPONENT' || node.type === 'INSTANCE') {
      html += `${pad}<!-- ${node.name} -->\n`;
    }
    html += `${pad}<${tag}${classStr}>\n`;

    for (const child of frame.children) {
      if (child.visible === false) continue;
      if (isOverlap) {
        const childClasses = nodeToClassesWithRegistry(child, false, registry);
        childClasses.push('absolute');
        const top = Math.round(child.y);
        const left = Math.round(child.x);
        if (top > 0) childClasses.push(`top-${registerSpacing(registry, top)}`);
        if (left > 0) childClasses.push(`left-${registerSpacing(registry, left)}`);
        if (child.type === 'TEXT') {
          const childTag = chooseHTMLTag(child, false);
          const text = getTextContent(child as TextNode);
          html += `${pad}  <${childTag} class="${childClasses.join(' ')}">${text}</${childTag}>\n`;
        } else {
          html += await generateLayerHTMLWithRegistry(child, indent + 1, false, false, registry, assets, usedFileNames);
        }
      } else {
        html += await generateLayerHTMLWithRegistry(child, indent + 1, false, !!isAutoLayout, registry, assets, usedFileNames);
      }
    }

    html += `${pad}</${tag}>\n`;
    return html;
  }

  return `${pad}<div${classStr}></div>\n`;
}

function inferLayoutFromChildren(frame: FrameNode): 'row' | 'col' | 'overlap' {
  const children = frame.children.filter((c: SceneNode) => c.visible !== false);
  if (children.length <= 1) return 'col';

  // Check for overlapping
  let overlapCount = 0;
  for (let i = 0; i < children.length; i++) {
    for (let j = i + 1; j < children.length; j++) {
      const a = children[i];
      const b = children[j];
      const ax1 = a.x, ay1 = a.y, ax2 = a.x + a.width, ay2 = a.y + a.height;
      const bx1 = b.x, by1 = b.y, bx2 = b.x + b.width, by2 = b.y + b.height;
      if (ax1 < bx2 && ax2 > bx1 && ay1 < by2 && ay2 > by1) {
        overlapCount++;
      }
    }
  }
  if (overlapCount > children.length * 0.3) return 'overlap';

  // Check if children are roughly in a row (similar Y)
  const yPositions = children.map((c: SceneNode) => c.y);
  const yRange = Math.max(...yPositions) - Math.min(...yPositions);
  const avgHeight = children.reduce((sum: number, c: SceneNode) => sum + c.height, 0) / children.length;

  if (yRange < avgHeight * 0.5) return 'row';
  return 'col';
}

function nodeToClasses(node: SceneNode, parentIsAutoLayout: boolean): string[] {
  const classes: string[] = [];

  // Skip invisible
  if (node.visible === false) return classes;

  const isFrame = node.type === 'FRAME' || node.type === 'COMPONENT' || node.type === 'INSTANCE';

  if (isFrame) {
    const frame = node as FrameNode;

    // Auto-layout -> flexbox
    if (frame.layoutMode && frame.layoutMode !== 'NONE') {
      classes.push('flex');
      if (frame.layoutMode === 'VERTICAL') classes.push('flex-col');

      // Primary axis alignment
      switch (frame.primaryAxisAlignItems) {
        case 'CENTER': classes.push('justify-center'); break;
        case 'MAX': classes.push('justify-end'); break;
        case 'SPACE_BETWEEN': classes.push('justify-between'); break;
      }

      // Counter axis alignment
      switch (frame.counterAxisAlignItems) {
        case 'CENTER': classes.push('items-center'); break;
        case 'MAX': classes.push('items-end'); break;
      }

      // Gap
      if (typeof frame.itemSpacing === 'number' && frame.itemSpacing > 0) {
        classes.push(`gap-${pxToTailwindSpacing(frame.itemSpacing)}`);
      }

      // Wrap
      if ((frame as any).layoutWrap === 'WRAP') {
        classes.push('flex-wrap');
      }
    } else {
      // Non-auto-layout frame: infer layout
      if (frame.children && frame.children.length > 0) {
        const layout = inferLayoutFromChildren(frame);
        if (layout === 'row') {
          classes.push('flex');
        } else if (layout === 'col') {
          classes.push('flex', 'flex-col');
        } else {
          classes.push('relative');
        }
      }
    }

    // Padding
    const pt = typeof frame.paddingTop === 'number' ? frame.paddingTop : 0;
    const pr = typeof frame.paddingRight === 'number' ? frame.paddingRight : 0;
    const pb = typeof frame.paddingBottom === 'number' ? frame.paddingBottom : 0;
    const pl = typeof frame.paddingLeft === 'number' ? frame.paddingLeft : 0;
    if (pt === pr && pr === pb && pb === pl && pt > 0) {
      classes.push(`p-${pxToTailwindSpacing(pt)}`);
    } else {
      if (pt === pb && pt > 0 && pl === pr && pl > 0) {
        classes.push(`px-${pxToTailwindSpacing(pl)}`);
        classes.push(`py-${pxToTailwindSpacing(pt)}`);
      } else {
        if (pt > 0) classes.push(`pt-${pxToTailwindSpacing(pt)}`);
        if (pr > 0) classes.push(`pr-${pxToTailwindSpacing(pr)}`);
        if (pb > 0) classes.push(`pb-${pxToTailwindSpacing(pb)}`);
        if (pl > 0) classes.push(`pl-${pxToTailwindSpacing(pl)}`);
      }
    }

    // Clip content
    if (frame.clipsContent) {
      classes.push('overflow-hidden');
    }
  }

  // Size
  if (!parentIsAutoLayout) {
    if (node.width > 0) classes.push(`w-${pxToTailwindSpacing(Math.round(node.width))}`);
    if (node.height > 0) classes.push(`h-${pxToTailwindSpacing(Math.round(node.height))}`);
  } else {
    // In auto-layout: check if child stretches or grows
    if (isFrame) {
      const frame = node as FrameNode;
      if ((frame as any).layoutGrow === 1) {
        classes.push('flex-1');
      }
      if ((frame as any).layoutAlign === 'STRETCH') {
        classes.push('self-stretch');
      }
    }
  }

  // Background color
  if ('fills' in node && Array.isArray(node.fills)) {
    for (const paint of node.fills as ReadonlyArray<Paint>) {
      if (paint.type === 'SOLID' && paint.visible !== false) {
        const hex = rgbaToHex(paint.color.r, paint.color.g, paint.color.b, paint.opacity !== undefined ? paint.opacity : 1);
        if (node.type === 'TEXT') {
          classes.push(`text-${hexToTailwindColor(hex)}`);
        } else {
          classes.push(`bg-${hexToTailwindColor(hex)}`);
        }
        break;
      }
    }
  }

  // Border
  if ('strokes' in node && Array.isArray(node.strokes) && node.strokes.length > 0) {
    const stroke = (node.strokes as ReadonlyArray<Paint>)[0];
    if (stroke && stroke.type === 'SOLID' && stroke.visible !== false) {
      const sw = typeof (node as any).strokeWeight === 'number' ? (node as any).strokeWeight : 1;
      if (sw === 1) {
        classes.push('border');
      } else {
        classes.push(`border-${sw}`);
      }
      const hex = rgbaToHex(stroke.color.r, stroke.color.g, stroke.color.b, stroke.opacity !== undefined ? stroke.opacity : 1);
      classes.push(`border-${hexToTailwindColor(hex)}`);
    }
  }

  // Border radius
  if ('cornerRadius' in node) {
    const r = (node as any).cornerRadius;
    if (typeof r === 'number' && r > 0) {
      if (r >= 500) {
        classes.push('rounded-full');
      } else {
        const closest = TW_RADIUS_SCALE.filter(s => s.name !== 'full')
          .reduce((best, s) => Math.abs(s.px - r) < Math.abs(best.px - r) ? s : best);
        if (Math.abs(closest.px - r) <= 1) {
          classes.push(`rounded-${closest.name}`);
        } else {
          classes.push(`rounded-[${r}px]`);
        }
      }
    }
  }

  // Typography
  if (node.type === 'TEXT') {
    const textNode = node as TextNode;
    const fontSize = typeof textNode.fontSize === 'number' ? textNode.fontSize : null;
    if (fontSize) {
      const rem = fontSize / 16;
      const closest = TW_TEXT_SCALE.reduce((best, s) => Math.abs(s.rem - rem) < Math.abs(best.rem - rem) ? s : best);
      if (Math.abs(closest.rem - rem) < 0.05) {
        classes.push(`text-${closest.name}`);
      } else {
        classes.push(`text-[${fontSize}px]`);
      }
    }

    // Font weight
    if (typeof textNode.fontName === 'object' && 'style' in textNode.fontName) {
      const weight = fontStyleToWeight(textNode.fontName.style);
      if (weight !== 400) {
        const wName = TW_WEIGHT_MAP[weight] || `[${weight}]`;
        classes.push(`font-${wName}`);
      }
    }

    // Line height
    if (typeof textNode.lineHeight === 'object' && 'value' in textNode.lineHeight) {
      const lhObj = textNode.lineHeight as { value: number; unit: string };
      if (lhObj.unit === 'PIXELS' && fontSize) {
        const ratio = lhObj.value / fontSize;
        const closest = TW_LEADING_SCALE.reduce((best, s) => Math.abs(s.val - ratio) < Math.abs(best.val - ratio) ? s : best);
        if (Math.abs(closest.val - ratio) < 0.1) {
          classes.push(`leading-${closest.name}`);
        }
      }
    }

    // Letter spacing
    if (typeof textNode.letterSpacing === 'object' && 'value' in textNode.letterSpacing) {
      const ls = (textNode.letterSpacing as any).value;
      if (typeof ls === 'number' && Math.abs(ls) > 0.1) {
        if (ls < -0.3) classes.push('tracking-tighter');
        else if (ls < 0) classes.push('tracking-tight');
        else if (ls > 0.5) classes.push('tracking-wider');
        else if (ls > 0.2) classes.push('tracking-wide');
      }
    }

    // Text alignment
    if (textNode.textAlignHorizontal === 'CENTER') classes.push('text-center');
    else if (textNode.textAlignHorizontal === 'RIGHT') classes.push('text-right');
  }

  // Opacity
  if ('opacity' in node && typeof (node as any).opacity === 'number' && (node as any).opacity < 1) {
    const op = Math.round((node as any).opacity * 100);
    classes.push(`opacity-${op}`);
  }

  // Shadow
  if ('effects' in node && Array.isArray(node.effects)) {
    for (const effect of node.effects as ReadonlyArray<Effect>) {
      if (effect.type === 'DROP_SHADOW' && effect.visible !== false) {
        const shadow = effect as DropShadowEffect;
        if (shadow.radius <= 3) classes.push('shadow-sm');
        else if (shadow.radius <= 8) classes.push('shadow');
        else if (shadow.radius <= 16) classes.push('shadow-md');
        else if (shadow.radius <= 25) classes.push('shadow-lg');
        else classes.push('shadow-xl');
        break;
      }
    }
  }

  return classes;
}

function chooseHTMLTag(node: SceneNode, isTopLevel: boolean): string {
  if (node.type === 'TEXT') {
    const textNode = node as TextNode;
    const fontSize = typeof textNode.fontSize === 'number' ? textNode.fontSize : 16;
    if (fontSize >= 32) return 'h1';
    if (fontSize >= 24) return 'h2';
    if (fontSize >= 20) return 'h3';
    if (fontSize >= 18) return 'h4';
    return 'p';
  }
  if (isTopLevel) return 'section';
  return 'div';
}

function getTextContent(node: TextNode): string {
  const chars = node.characters || '';
  // Escape HTML entities
  return chars.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function hasImageFill(node: SceneNode): boolean {
  if ('fills' in node && Array.isArray(node.fills)) {
    for (const paint of node.fills as ReadonlyArray<Paint>) {
      if (paint.type === 'IMAGE' && paint.visible !== false) return true;
    }
  }
  return false;
}

async function generateLayerHTML(node: SceneNode, indent: number, isTopLevel: boolean, parentIsAutoLayout: boolean, assets: AssetMap, usedFileNames: Set<string>): Promise<string> {
  // Max depth limit
  if (indent > 10) return '';
  // Skip invisible/hidden nodes
  if (node.visible === false) return '';

  const pad = '  '.repeat(indent);
  const classes = nodeToClasses(node, parentIsAutoLayout);
  const classStr = classes.length > 0 ? ` class="${classes.join(' ')}"` : '';

  // Image fills -> <img> with exported asset
  if (hasImageFill(node)) {
    const name = node.name || 'image';
    const id = nextAssetId();
    try {
      const bytes = await (node as any).exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: 2 } });
      assets[id] = {
        base64: uint8ToBase64(bytes),
        mimeType: 'image/png',
        fileName: toAssetFileName(name, 'png', usedFileNames),
      };
    } catch (e) {
      return `${pad}<img${classStr} src="/placeholder.svg" alt="${name.replace(/"/g, '&quot;')}" />\n`;
    }
    return `${pad}<img${classStr} src="{{asset:${id}}}" alt="${name.replace(/"/g, '&quot;')}" />\n`;
  }

  // Text node
  if (node.type === 'TEXT') {
    const tag = chooseHTMLTag(node, false);
    const text = getTextContent(node as TextNode);
    return `${pad}<${tag}${classStr}>${text}</${tag}>\n`;
  }

  // Vector/ellipse/line -> export as SVG
  if (node.type === 'VECTOR' || node.type === 'ELLIPSE' || node.type === 'LINE' || node.type === 'STAR' || node.type === 'POLYGON') {
    const name = node.name || 'icon';
    const id = nextAssetId();
    try {
      const bytes = await (node as any).exportAsync({ format: 'SVG' });
      assets[id] = {
        base64: uint8ToBase64(bytes),
        mimeType: 'image/svg+xml',
        fileName: toAssetFileName(name, 'svg', usedFileNames),
      };
      const w = Math.round(node.width);
      const h = Math.round(node.height);
      return `${pad}<img${classStr} src="{{asset:${id}}}" alt="${name.replace(/"/g, '&quot;')}" width="${w}" height="${h}" />\n`;
    } catch (e) {
      return `${pad}<!-- ${name} -->\n`;
    }
  }

  // Rectangle without children -> div
  if (node.type === 'RECTANGLE') {
    return `${pad}<div${classStr}></div>\n`;
  }

  // GROUP -> unwrap children
  if (node.type === 'GROUP') {
    const group = node as GroupNode;
    let html = '';
    for (const child of group.children) {
      html += await generateLayerHTML(child, indent, false, false, assets, usedFileNames);
    }
    return html;
  }

  // Frame/Component/Instance -> container
  if (node.type === 'FRAME' || node.type === 'COMPONENT' || node.type === 'INSTANCE') {
    const frame = node as FrameNode;
    const tag = chooseHTMLTag(node, isTopLevel);
    const isAutoLayout = frame.layoutMode && frame.layoutMode !== 'NONE';
    const isOverlap = !isAutoLayout && frame.children.length > 0 && inferLayoutFromChildren(frame) === 'overlap';

    let html = '';
    // Component comment
    if (node.type === 'COMPONENT' || node.type === 'INSTANCE') {
      html += `${pad}<!-- ${node.name} -->\n`;
    }

    html += `${pad}<${tag}${classStr}>\n`;

    for (const child of frame.children) {
      if (child.visible === false) continue;
      // For overlap layout, add absolute positioning to children
      if (isOverlap) {
        const childClasses = nodeToClasses(child, false);
        childClasses.push('absolute');
        // Position based on x/y relative to frame
        const top = Math.round(child.y);
        const left = Math.round(child.x);
        if (top > 0) childClasses.push(`top-${pxToTailwindSpacing(top)}`);
        if (left > 0) childClasses.push(`left-${pxToTailwindSpacing(left)}`);
        // Special handling: render with overridden classes
        if (child.type === 'TEXT') {
          const childTag = chooseHTMLTag(child, false);
          const text = getTextContent(child as TextNode);
          html += `${pad}  <${childTag} class="${childClasses.join(' ')}">${text}</${childTag}>\n`;
        } else {
          html += await generateLayerHTML(child, indent + 1, false, false, assets, usedFileNames);
        }
      } else {
        html += await generateLayerHTML(child, indent + 1, false, !!isAutoLayout, assets, usedFileNames);
      }
    }

    html += `${pad}</${tag}>\n`;
    return html;
  }

  // Fallback
  return `${pad}<div${classStr}></div>\n`;
}

// ─── Design Lint ───

function lintTokens(tokens: ScannedTokens): LintWarning[] {
  const warnings: LintWarning[] = [];

  // Check font sizes against TW scale
  if (tokens.typography.length > 0) {
    const fontSizes = [...new Set(tokens.typography.map(t => t.fontSize))];
    for (const px of fontSizes) {
      const rem = px / 16;
      const closest = TW_TEXT_SCALE.reduce((best, s) => Math.abs(s.rem - rem) < Math.abs(best.rem - rem) ? s : best);
      const distPx = Math.abs(closest.rem * 16 - px);
      if (distPx > 1) {
        warnings.push({
          category: 'Typography',
          message: `Font size ${px}px doesn't match any Tailwind text scale`,
          severity: 'warning',
          suggestion: `Closest: text-${closest.name} (${closest.rem * 16}px)`,
        });
      }
    }
  }

  // Check spacing against 4px grid
  for (const px of tokens.spacing) {
    if (px % 4 !== 0) {
      const nearest = Math.round(px / 4) * 4;
      warnings.push({
        category: 'Spacing',
        message: `Spacing ${px}px is not on the 4px grid`,
        severity: 'warning',
        suggestion: `Nearest: ${nearest}px`,
      });
    }
  }

  // Check border radius against TW scale
  for (const px of tokens.radii) {
    const closest = TW_RADIUS_SCALE.filter(s => s.name !== 'full')
      .reduce((best, s) => Math.abs(s.px - px) < Math.abs(best.px - px) ? s : best);
    if (Math.abs(closest.px - px) > 1) {
      warnings.push({
        category: 'Border Radius',
        message: `Border radius ${px}px doesn't match any Tailwind radius`,
        severity: 'warning',
        suggestion: `Closest: rounded-${closest.name} (${closest.px}px)`,
      });
    }
  }

  // Check font weights against standard scale
  if (tokens.typography.length > 0) {
    const weights = [...new Set(tokens.typography.map(t => fontStyleToWeight(t.fontStyle)))];
    for (const w of weights) {
      if (w % 100 !== 0 || w < 100 || w > 900) {
        warnings.push({
          category: 'Typography',
          message: `Font weight ${w} is non-standard`,
          severity: 'info',
          suggestion: `Standard weights: 100-900 in increments of 100`,
        });
      }
    }
  }

  // Check line heights against TW leading scale
  if (tokens.typography.length > 0) {
    const lineHeights = [...new Set(
      tokens.typography.filter(t => t.lineHeight !== null).map(t => t.lineHeight!)
    )];
    for (const lh of lineHeights) {
      const closest = TW_LEADING_SCALE.reduce((best, s) => Math.abs(s.val - lh) < Math.abs(best.val - lh) ? s : best);
      if (Math.abs(closest.val - lh) > 0.1) {
        warnings.push({
          category: 'Typography',
          message: `Line height ${lh} doesn't match any Tailwind leading scale`,
          severity: 'info',
          suggestion: `Closest: leading-${closest.name} (${closest.val})`,
        });
      }
    }
  }

  return warnings;
}

// Cache for re-generation when options change
let cachedSource: 'scan' | 'variables' = 'variables';
let cachedScannedTokens: ScannedTokens | null = null;
let cachedCollections: CollectionData[] = [];
let cachedStyles: any = null;
let cachedOptions: GenerateOptions = Object.assign({}, DEFAULT_OPTIONS);

// Main extraction function
async function extractVariables() {
  try {
    const collections = await figma.variables.getLocalVariableCollectionsAsync();
    const allVariables = await figma.variables.getLocalVariablesAsync();

    const variablesMap = new Map<string, Variable>();
    allVariables.forEach(v => variablesMap.set(v.id, v));

    const collectionsData: CollectionData[] = [];

    for (const collection of collections) {
      const collectionVariables: VariableData[] = [];
      const collectionVars = allVariables.filter(v => v.variableCollectionId === collection.id);

      for (const variable of collectionVars) {
        for (const mode of collection.modes) {
          const resolvedValue = await resolveVariableValue(variable, mode.modeId, variablesMap);

          if (resolvedValue !== null) {
            collectionVariables.push({
              name: variable.name,
              variableValue: resolvedValue,
              variableType: variable.resolvedType,
              resolvedDataType: variable.resolvedType,
              collection: collection.name,
              mode: mode.name
            });
          }
        }
      }

      collectionsData.push({
        name: collection.name,
        modes: collection.modes.map(m => ({ modeId: m.modeId, name: m.name })),
        variables: collectionVariables
      });
    }

    // Extract local styles
    const localPaintStyles = await figma.getLocalPaintStylesAsync();
    const localTextStyles = await figma.getLocalTextStylesAsync();
    const localEffectStyles = await figma.getLocalEffectStylesAsync();

    const stylesData = {
      colors: localPaintStyles.map(style => ({
        name: style.name,
        paints: style.paints
      })),
      textStyles: localTextStyles.map(style => ({
        name: style.name,
        fontSize: style.fontSize,
        fontFamily: style.fontName.family,
        fontWeight: style.fontName.style,
        lineHeight: style.lineHeight,
        letterSpacing: style.letterSpacing
      })),
      effects: localEffectStyles.map(style => ({
        name: style.name,
        effects: style.effects
      }))
    };

    // Count totals
    const totalVars = collectionsData.reduce((sum, col) => sum + col.variables.length, 0);
    const totalStyles = stylesData.colors.length + stylesData.textStyles.length + stylesData.effects.length;

    console.log('Extraction complete:', {
      collections: collectionsData.length,
      totalVariables: totalVars,
      colorStyles: stylesData.colors.length,
      textStyles: stylesData.textStyles.length
    });

    // If no variables or styles found, fall back to node scanning
    if (totalVars === 0 && totalStyles === 0) {
      console.log('No variables or styles found, falling back to node scan...');
      const scannedTokens = scanNodesForTokens();
      cachedScannedTokens = scannedTokens;
      cachedSource = 'scan';
      const tokenCount = scannedTokens.colors.length + scannedTokens.typography.length +
        scannedTokens.spacing.length + scannedTokens.radii.length +
        scannedTokens.shadows.length + scannedTokens.gradients.length +
        scannedTokens.animations.length;

      console.log('Node scan complete:', {
        colors: scannedTokens.colors.length,
        typography: scannedTokens.typography.length,
        spacing: scannedTokens.spacing.length,
        radii: scannedTokens.radii.length,
        shadows: scannedTokens.shadows.length,
        gradients: scannedTokens.gradients.length,
        animations: scannedTokens.animations.length
      });

      const output = generateScannedCSS(scannedTokens);
      const lintWarnings = lintTokens(scannedTokens);

      figma.ui.postMessage({
        type: 'variables-extracted',
        source: 'scan',
        data: {
          collections: [],
          styles: { colors: [], textStyles: [], effects: [] },
          scannedTokens,
          tokenCount,
          css: output.full,
          sections: output.sections,
          lintWarnings,
        }
      });
      return;
    }

    cachedCollections = collectionsData;
    cachedStyles = stylesData;
    cachedSource = 'variables';

    figma.ui.postMessage({
      type: 'variables-extracted',
      source: 'variables',
      data: {
        collections: collectionsData,
        styles: stylesData
      }
    });

    console.log('Message sent to UI');

  } catch (error) {
    console.error('Error extracting variables:', error);
    figma.ui.postMessage({
      type: 'error',
      message: error instanceof Error ? error.message : 'Unknown error occurred'
    });
  }
}

// Selection change listener for Layer -> TW tab
figma.on('selectionchange', () => {
  const selection = figma.currentPage.selection;
  if (selection.length > 0) {
    const node = selection[0];
    figma.ui.postMessage({
      type: 'selection-changed',
      hasSelection: true,
      nodeInfo: { name: node.name, type: node.type, width: Math.round(node.width), height: Math.round(node.height) }
    });
  } else {
    figma.ui.postMessage({
      type: 'selection-changed',
      hasSelection: false,
      nodeInfo: null
    });
  }
});

// Message handler
figma.ui.onmessage = async function(msg) {
  if (msg.type === 'extract') {
    await extractVariables();
  } else if (msg.type === 'generate-css') {
    var output = generateTailwindCSS(msg.data.collections, msg.data.styles, cachedOptions);
    figma.ui.postMessage({ type: 'css-generated', css: output.full, sections: output.sections });
  } else if (msg.type === 'update-options') {
    cachedOptions = Object.assign({}, DEFAULT_OPTIONS, msg.options);
    var newOutput: CSSOutput | null = null;
    if (cachedSource === 'scan' && cachedScannedTokens) {
      newOutput = generateScannedCSS(cachedScannedTokens, cachedOptions);
    } else if (cachedSource === 'variables' && (cachedCollections.length > 0 || cachedStyles)) {
      newOutput = generateTailwindCSS(cachedCollections, cachedStyles || { colors: [], textStyles: [], effects: [] }, cachedOptions);
    }
    if (newOutput) {
      figma.ui.postMessage({ type: 'css-regenerated', css: newOutput.full, sections: newOutput.sections });
    }
  } else if (msg.type === 'generate-layer') {
    const selection = figma.currentPage.selection;
    if (selection.length === 0) {
      figma.ui.postMessage({ type: 'layer-generated', html: '', error: 'No layer selected' });
      return;
    }
    const node = selection[0];
    const generateCSS = msg.generateCSS === true;

    // Reset asset counter for each generation run
    assetCounter = 0;
    const assets: AssetMap = {};
    const usedFileNames = new Set<string>();

    let html: string;
    let css: string | undefined;

    try {
      if (generateCSS) {
        const registry = createTokenRegistry();
        html = await generateLayerHTMLWithRegistry(node, 0, true, false, registry, assets, usedFileNames);
        css = buildThemeCSS(registry);
      } else {
        html = await generateLayerHTML(node, 0, true, false, assets, usedFileNames);
      }

      figma.ui.postMessage({
        type: 'layer-generated',
        html: html,
        css: css,
        assets: Object.keys(assets).length > 0 ? assets : undefined,
        nodeInfo: { name: node.name, width: Math.round(node.width), height: Math.round(node.height) }
      });
    } catch (error) {
      figma.ui.postMessage({
        type: 'layer-generated',
        html: '',
        error: error instanceof Error ? error.message : 'Generation failed'
      });
    }
  } else if (msg.type === 'run-lint') {
    try {
      // Run lint on cached tokens or re-scan
      let tokens = cachedScannedTokens;
      if (!tokens) {
        tokens = scanNodesForTokens();
        cachedScannedTokens = tokens;
      }
      const warnings = lintTokens(tokens);
      figma.ui.postMessage({ type: 'lint-results', warnings: warnings });
    } catch (error) {
      console.error('Lint failed:', error);
      figma.ui.postMessage({ type: 'lint-results', warnings: [], error: error instanceof Error ? error.message : 'Lint failed' });
    }
  } else if (msg.type === 'resize-for-preview') {
    figma.ui.resize(900, 700);
  } else if (msg.type === 'resize-restore') {
    figma.ui.resize(420, 700);
  } else if (msg.type === 'close') {
    figma.closePlugin();
  }
};

// Auto-extract on load
console.log('Starting auto-extract...');
(async () => {
  try {
    await extractVariables();
    console.log('Auto-extract completed successfully');
  } catch (error) {
    console.error('Failed to auto-extract:', error);
    figma.ui.postMessage({
      type: 'error',
      message: 'Failed to load variables. Try clicking Refresh.'
    });
  }
})();
