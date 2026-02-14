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
  gradients: { type: 'linear' | 'radial'; angle: number; stops: { color: string; position: number }[]; ellipseX?: number; ellipseY?: number; centerX?: number; centerY?: number }[];
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
          let angle = 0;
          let ellipseX: number | undefined;
          let ellipseY: number | undefined;
          let centerX: number | undefined;
          let centerY: number | undefined;
          
          if (paint.type === 'GRADIENT_LINEAR') {
            const handles = (gPaint as any).gradientHandlePositions as ReadonlyArray<{ x: number; y: number }> | undefined;
            if (handles && handles.length >= 2) {
              const start = handles[0];
              const end = handles[1];
              const dx = end.x - start.x;
              const dy = end.y - start.y;
              let rawAngle = Math.atan2(dy, dx) * (180 / Math.PI);
              rawAngle = (rawAngle + 360) % 360;
              angle = Math.round(((rawAngle + 90) % 360) * 100) / 100;
            } else {
              angle = getGradientAngle(gPaint.gradientTransform as unknown as number[][]);
            }
          } else {
            const handles = (gPaint as any).gradientHandlePositions as ReadonlyArray<{ x: number; y: number }> | undefined;
            if (handles && handles.length >= 3) {
              const center = handles[0];
              const h1 = handles[1];
              const h2 = handles[2];
              centerX = Math.round(center.x * 10000) / 100;
              centerY = Math.round(center.y * 10000) / 100;
              ellipseX = Math.round(Math.sqrt((h1.x - center.x) * (h1.x - center.x) + (h1.y - center.y) * (h1.y - center.y)) * 10000) / 100;
              ellipseY = Math.round(Math.sqrt((h2.x - center.x) * (h2.x - center.x) + (h2.y - center.y) * (h2.y - center.y)) * 10000) / 100;
            } else {
              const params = extractRadialGradientParams(gPaint.gradientTransform as unknown as number[][]);
              ellipseX = params.ellipseX;
              ellipseY = params.ellipseY;
              centerX = params.centerX;
              centerY = params.centerY;
            }
          }
          
          const key = stops.map(s => `${s.color}-${s.position}`).join('|') + `|${angle}|${ellipseX || ''}|${ellipseY || ''}`;
          if (!gradientMap.has(key)) {
            const gradientEntry: any = {
              type: paint.type === 'GRADIENT_LINEAR' ? 'linear' : 'radial',
              angle,
              stops
            };
            if (paint.type === 'GRADIENT_RADIAL') {
              gradientEntry.ellipseX = ellipseX;
              gradientEntry.ellipseY = ellipseY;
              gradientEntry.centerX = centerX;
              gradientEntry.centerY = centerY;
            }
            gradientMap.set(key, gradientEntry);
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
        // Use ellipse with proper dimensions and positioning
        const ex = g.ellipseX != null ? g.ellipseX : 100;
        const ey = g.ellipseY != null ? g.ellipseY : 100;
        const cx = g.centerX != null ? g.centerX : 50;
        const cy = g.centerY != null ? g.centerY : 50;
        sectionCSS += `  --gradient-${i + 1}: radial-gradient(ellipse ${ex}% ${ey}% at ${cx}% ${cy}%, ${stopsStr});\n`;
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

interface GradientData {
  type: 'linear' | 'radial';
  angle: number;
  stops: { color: string; position: number }[];
  // For radial gradients
  ellipseX?: number;  // Width percentage (e.g., 87.20)
  ellipseY?: number;  // Height percentage (e.g., 86.02)
  centerX?: number;   // Center X percentage (e.g., 50.00)
  centerY?: number;   // Center Y percentage (e.g., 41.34)
}

interface TokenRegistry {
  colors: Map<string, string>;      // hex -> var name (e.g. "primary")
  fontSizes: Map<number, string>;   // px -> var name (e.g. "lg")
  spacing: Map<number, string>;     // px -> var name (e.g. "4")
  radii: Map<number, string>;       // px -> var name (e.g. "md")
  shadows: Map<string, string>;     // shadow-key -> var name
  gradients: Map<string, GradientData>; // gradient-key -> gradient data
}

function createTokenRegistry(): TokenRegistry {
  return {
    colors: new Map(),
    fontSizes: new Map(),
    spacing: new Map(),
    radii: new Map(),
    shadows: new Map(),
    gradients: new Map(),
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

// Extract radial gradient parameters from transform matrix
// Based on Figma's gradientTransform which maps gradient space to element space
function extractRadialGradientParams(transform: number[][]): { ellipseX: number; ellipseY: number; centerX: number; centerY: number } {
  if (!transform || transform.length < 2) {
    return { ellipseX: 100, ellipseY: 100, centerX: 50, centerY: 50 };
  }
  
  // Figma gradientTransform is a 2x3 affine matrix [[a, b, tx], [c, d, ty]]
  const a = transform[0][0];
  const b = transform[0][1];
  const tx = transform[0][2];
  const c = transform[1][0];
  const d = transform[1][1];
  const ty = transform[1][2];
  
  // Calculate determinant
  const det = a * d - b * c;
  if (Math.abs(det) < 0.0001) {
    return { ellipseX: 100, ellipseY: 100, centerX: 50, centerY: 50 };
  }
  
  // Invert the matrix to map from element space back to gradient space
  const invA = d / det;
  const invB = -b / det;
  const invC = -c / det;
  const invD = a / det;
  const invTx = (b * ty - d * tx) / det;
  const invTy = (c * tx - a * ty) / det;
  
  // The gradient center in CSS is where (0, 0) in gradient space maps to in element space
  // Actually, Figma's radial gradient center is at (0.5, 0.5) in normalized space
  // We need to find where (0.5, 0.5) maps to using the INVERSE transform
  const centerX = Math.round((invA * 0.5 + invB * 0.5 + invTx) * 10000) / 100;
  const centerY = Math.round((invC * 0.5 + invD * 0.5 + invTy) * 10000) / 100;
  
  // For ellipse size, calculate how much the unit circle is scaled
  // The gradient radius in Figma is 0.5 (half the normalized space)
  // We look at how vectors (0.5, 0) and (0, 0.5) transform
  const vecX_x = invA * 0.5;
  const vecX_y = invC * 0.5;
  const vecY_x = invB * 0.5;
  const vecY_y = invD * 0.5;
  
  // Calculate the actual lengths of these vectors in element space
  const scaleX = Math.sqrt(vecX_x * vecX_x + vecX_y * vecX_y) * 2;
  const scaleY = Math.sqrt(vecY_x * vecY_x + vecY_y * vecY_y) * 2;
  
  // Convert to percentages (these represent the ellipse dimensions relative to element size)
  const ellipseX = Math.min(200, Math.round(scaleX * 10000) / 100);
  const ellipseY = Math.min(200, Math.round(scaleY * 10000) / 100);
  
  return { ellipseX, ellipseY, centerX, centerY };
}

// Register a gradient and return its CSS variable name
function registerGradient(
  registry: TokenRegistry,
  type: 'linear' | 'radial',
  angle: number,
  stops: { color: string; position: number }[],
  ellipseX?: number,
  ellipseY?: number,
  centerX?: number,
  centerY?: number
): string {
  // Create a unique key for this gradient
  const stopsKey = stops.map(s => `${s.color}-${s.position}`).join('|');
  const ellipseKey = type === 'radial' && ellipseX !== undefined ? `|${ellipseX}|${ellipseY}|${centerX}|${centerY}` : '';
  const key = `${type}|${angle}|${stopsKey}${ellipseKey}`;
  
  if (registry.gradients.has(key)) {
    // Return the name of the existing gradient
    const index = Array.from(registry.gradients.keys()).indexOf(key) + 1;
    return `gradient-${index}`;
  }
  
  // Generate a unique name
  const index = registry.gradients.size + 1;
  const name = `gradient-${index}`;
  
  const gradientData: any = {
    type,
    angle,
    stops
  };
  if (type === 'radial' && ellipseX !== undefined) {
    gradientData.ellipseX = ellipseX;
    gradientData.ellipseY = ellipseY;
    gradientData.centerX = centerX;
    gradientData.centerY = centerY;
  }
  
  registry.gradients.set(key, gradientData);
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

  if (registry.gradients.size > 0) {
    lines.push('');
    lines.push('  /* Gradients */');
    let gradientIndex = 0;
    for (const [key, data] of registry.gradients) {
      gradientIndex++;
      const name = `gradient-${gradientIndex}`;
      const stopsStr = data.stops.map(s => `${s.color} ${s.position}%`).join(', ');
      if (data.type === 'linear') {
        lines.push(`  --${name}: linear-gradient(${data.angle}deg, ${stopsStr});`);
      } else {
        // For radial gradients, use ellipse with proper dimensions and positioning
        const ex = data.ellipseX != null ? data.ellipseX : 100;
        const ey = data.ellipseY != null ? data.ellipseY : 100;
        const cx = data.centerX != null ? data.centerX : 50;
        const cy = data.centerY != null ? data.centerY : 50;
        lines.push(`  --${name}: radial-gradient(ellipse ${ex}% ${ey}% at ${cx}% ${cy}%, ${stopsStr});`);
      }
    }
  }

  lines.push('}');
  return lines.join('\n');
}

// ─── Shared helpers for style extraction ───

// Extract angle from Figma gradientTransform matrix and map to closest Tailwind direction
function gradientAngleToDirection(transform: ReadonlyArray<ReadonlyArray<number>>): string {
  // Figma gradientTransform is a 2x3 affine matrix [[a, b, tx], [c, d, ty]]
  const angle = Math.round(Math.atan2(transform[0][1], transform[0][0]) * (180 / Math.PI));
  // Normalize to 0-360
  const normalized = ((angle % 360) + 360) % 360;
  // Map to closest Tailwind direction
  if (normalized >= 337 || normalized < 23) return 'r';
  if (normalized >= 23 && normalized < 68) return 'br';
  if (normalized >= 68 && normalized < 113) return 'b';
  if (normalized >= 113 && normalized < 158) return 'bl';
  if (normalized >= 158 && normalized < 203) return 'l';
  if (normalized >= 203 && normalized < 248) return 'tl';
  if (normalized >= 248 && normalized < 293) return 't';
  return 'tr';
}

// Extract gradient stop colors - use rgba format for better CSS compatibility
function gradientStopHex(stop: ColorStop): string {
  const a = stop.color.a !== undefined ? stop.color.a : 1;
  if (a < 1) {
    // Use rgba format for colors with transparency
    const r = Math.round(stop.color.r * 255);
    const g = Math.round(stop.color.g * 255);
    const b = Math.round(stop.color.b * 255);
    return `rgba(${r}, ${g}, ${b}, ${a.toFixed(2)})`;
  }
  // Use hex for solid colors
  return rgbaToHex(stop.color.r, stop.color.g, stop.color.b, 1);
}

function formatNumberForCss(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  if (Math.round(rounded) === rounded) return String(rounded);
  return rounded.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}

function gradientStopsToCss(stops: ReadonlyArray<ColorStop>): string {
  return stops
    .map((s: ColorStop) => `${gradientStopHex(s)} ${formatNumberForCss(s.position * 100)}%`)
    .join(', ');
}

function linearGradientCssFromPaint(grad: GradientPaint): string {
  const stopsStr = gradientStopsToCss(grad.gradientStops);
  let cssAngle = getGradientAngle(grad.gradientTransform as unknown as number[][]);
  const handles = (grad as any).gradientHandlePositions as ReadonlyArray<{ x: number; y: number }> | undefined;
  if (handles && handles.length >= 2) {
    const start = handles[0];
    const end = handles[1];
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    let angle = Math.atan2(dy, dx) * (180 / Math.PI);
    angle = (angle + 360) % 360;
    cssAngle = (angle + 90) % 360;
  }
  return `linear-gradient(${formatNumberForCss(cssAngle)}deg, ${stopsStr})`;
}

function radialGradientCssFromPaint(grad: GradientPaint): string {
  const stopsStr = gradientStopsToCss(grad.gradientStops);
  const handles = (grad as any).gradientHandlePositions as ReadonlyArray<{ x: number; y: number }> | undefined;
  if (handles && handles.length >= 3) {
    const center = handles[0];
    const h1 = handles[1];
    const h2 = handles[2];
    const cx = center.x * 100;
    const cy = center.y * 100;
    const rx = Math.sqrt((h1.x - center.x) * (h1.x - center.x) + (h1.y - center.y) * (h1.y - center.y)) * 100;
    const ry = Math.sqrt((h2.x - center.x) * (h2.x - center.x) + (h2.y - center.y) * (h2.y - center.y)) * 100;
    return `radial-gradient(ellipse ${formatNumberForCss(rx)}% ${formatNumberForCss(ry)}% at ${formatNumberForCss(cx)}% ${formatNumberForCss(cy)}%, ${stopsStr})`;
  }
  return `radial-gradient(circle, ${stopsStr})`;
}

function gradientPaintToTailwindBgClass(grad: GradientPaint): string {
  let css = '';
  if (grad.type === 'GRADIENT_LINEAR') {
    css = linearGradientCssFromPaint(grad);
  } else if (grad.type === 'GRADIENT_RADIAL') {
    css = radialGradientCssFromPaint(grad);
  } else {
    css = linearGradientCssFromPaint(grad);
  }
  return `bg-[${css.replace(/\s+/g, '_')}]`;
}

// Blend mode to Tailwind class mapping
const BLEND_MODE_MAP: Record<string, string> = {
  'MULTIPLY': 'mix-blend-multiply',
  'SCREEN': 'mix-blend-screen',
  'OVERLAY': 'mix-blend-overlay',
  'DARKEN': 'mix-blend-darken',
  'LIGHTEN': 'mix-blend-lighten',
  'COLOR_DODGE': 'mix-blend-color-dodge',
  'COLOR_BURN': 'mix-blend-color-burn',
  'HARD_LIGHT': 'mix-blend-hard-light',
  'SOFT_LIGHT': 'mix-blend-soft-light',
  'DIFFERENCE': 'mix-blend-difference',
  'EXCLUSION': 'mix-blend-exclusion',
  'HUE': 'mix-blend-hue',
  'SATURATION': 'mix-blend-saturation',
  'COLOR': 'mix-blend-color',
  'LUMINOSITY': 'mix-blend-luminosity',
};

// Modified nodeToClasses that uses a registry when provided
function nodeToClassesWithRegistry(node: SceneNode, parentIsAutoLayout: boolean, registry: TokenRegistry, parentIsWrap?: boolean, parentWidth?: number, parentGap?: number, isTopLevel?: boolean): string[] {
  const classes: string[] = [];
  if (node.visible === false) return classes;

  const isFrame = node.type === 'FRAME' || node.type === 'COMPONENT' || node.type === 'INSTANCE';

  if (isFrame) {
    const frame = node as FrameNode;
    const layoutMode = (frame as any).layoutMode as string;
    if (layoutMode && layoutMode !== 'NONE') {
      if (layoutMode === 'GRID') {
        classes.push('grid');
        const gridCols = (frame as any).gridColumnCount;
        const gridRows = (frame as any).gridRowCount;
        if (typeof gridCols === 'number' && gridCols > 0) {
          if (gridCols <= 12) classes.push(`grid-cols-${gridCols}`);
          else classes.push(`grid-cols-[repeat(${gridCols},minmax(0,1fr))]`);
        }
        if (typeof gridRows === 'number' && gridRows > 0) {
          if (gridRows <= 12) classes.push(`grid-rows-${gridRows}`);
          else classes.push(`grid-rows-[repeat(${gridRows},minmax(0,1fr))]`);
        }
      } else {
        classes.push('flex');
        if (layoutMode === 'VERTICAL') classes.push('flex-col');
        switch (frame.primaryAxisAlignItems) {
          case 'CENTER': classes.push('justify-center'); break;
          case 'MAX': classes.push('justify-end'); break;
          case 'SPACE_BETWEEN': classes.push('justify-between'); break;
        }
        switch (frame.counterAxisAlignItems) {
          case 'CENTER': classes.push('items-center'); break;
          case 'MAX': classes.push('items-end'); break;
        }
        if ((frame as any).layoutWrap === 'WRAP') classes.push('flex-wrap');
      }
      if (typeof frame.itemSpacing === 'number' && frame.itemSpacing > 0) {
        const name = registerSpacing(registry, frame.itemSpacing);
        classes.push(`gap-${name}`);
      }
      if (layoutMode === 'GRID') {
        const counterSpacing = (frame as any).counterAxisSpacing;
        if (typeof counterSpacing === 'number' && counterSpacing > 0 && typeof frame.itemSpacing === 'number' && frame.itemSpacing > 0 && counterSpacing !== frame.itemSpacing) {
          classes.push(`gap-y-${registerSpacing(registry, counterSpacing)}`);
        }
      }
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
    if (frame.clipsContent && !isTopLevel) classes.push('overflow-hidden');
  }

  // Size
  if (isTopLevel) {
    // Top-level element: use w-full, no fixed height — let content determine height
    classes.push('w-full');
  } else if (!parentIsAutoLayout) {
    if (node.width > 0) {
      const name = registerSpacing(registry, Math.round(node.width));
      classes.push(`w-${name}`);
    }
    if (node.height > 0) {
      const name = registerSpacing(registry, Math.round(node.height));
      classes.push(`h-${name}`);
    }
  } else {
    const nodeAny = node as any;
    const sizingH = typeof nodeAny.layoutSizingHorizontal === 'string' ? nodeAny.layoutSizingHorizontal : null;
    const sizingV = typeof nodeAny.layoutSizingVertical === 'string' ? nodeAny.layoutSizingVertical : null;

    if (isFrame) {
      const frame = node as FrameNode;
      if ((frame as any).layoutGrow === 1) classes.push('flex-1');
      if ((frame as any).layoutAlign === 'STRETCH') classes.push('self-stretch');
    }

    // FIXED-sized children get explicit dimensions (but not in wrap containers — use percentage there)
    // For unknown sizing (null), emit width for non-text nodes only (text defaults to HUG/auto)
    var emitFixedW = sizingH === 'FIXED' || (sizingH === null && node.type !== 'TEXT');
    var emitFixedH = sizingV === 'FIXED';
    if (emitFixedW && node.width > 0 && !parentIsWrap) {
      classes.push(`w-[${Math.round(node.width)}px]`);
    }
    if (emitFixedH && node.height > 0) {
      classes.push(`h-[${Math.round(node.height)}px]`);
    }

    // In wrap containers, children (both FIXED and FILL) need fractional widths based on column count
    if (parentIsWrap && node.width > 0 && parentWidth && parentWidth > 0) {
      var _gap = parentGap || 0;
      var _childW = Math.round(node.width);
      var _cols = Math.max(1, Math.round((parentWidth + _gap) / (_childW + _gap)));
      if (_cols >= 2) {
        if (_cols === 2) classes.push('w-[calc(50%-' + Math.round(_gap / 2) + 'px)]');
        else if (_cols === 3) classes.push('w-[calc(33.333%-' + Math.round(_gap * 2 / 3) + 'px)]');
        else if (_cols === 4) classes.push('w-[calc(25%-' + Math.round(_gap * 3 / 4) + 'px)]');
        else classes.push('w-[calc(' + (100 / _cols).toFixed(3) + '%-' + Math.round(_gap * (_cols - 1) / _cols) + 'px)]');
      } else {
        classes.push('w-full');
      }
    }

  }

  // Background / text color + gradients
  if ('fills' in node && Array.isArray(node.fills)) {
    let fillHandled = false;
    for (const paint of node.fills as ReadonlyArray<Paint>) {
      if (paint.visible === false) continue;
      if (paint.type === 'SOLID') {
        const hex = rgbaToHex(paint.color.r, paint.color.g, paint.color.b, paint.opacity !== undefined ? paint.opacity : 1);
        const colorName = registerColor(registry, hex);
        if (node.type === 'TEXT') {
          classes.push(`text-${colorName}`);
        } else {
          classes.push(`bg-${colorName}`);
        }
        fillHandled = true;
        break;
      }
      if (!fillHandled && paint.type === 'GRADIENT_LINEAR' && (paint as any).gradientStops) {
        const grad = paint as GradientPaint;
        classes.push(gradientPaintToTailwindBgClass(grad));
        fillHandled = true;
        break;
      }
      if (!fillHandled && paint.type === 'GRADIENT_RADIAL' && (paint as any).gradientStops) {
        const grad = paint as GradientPaint;
        classes.push(gradientPaintToTailwindBgClass(grad));
        fillHandled = true;
        break;
      }
    }
  }

  // Border
  if ('strokes' in node && Array.isArray(node.strokes) && node.strokes.length > 0) {
    const stroke = (node.strokes as ReadonlyArray<Paint>)[0];
    if (stroke && stroke.type === 'SOLID' && stroke.visible !== false) {
      // Check for individual stroke weights
      const nodeAny = node as any;
      const hasIndividualStrokes = typeof nodeAny.strokeTopWeight === 'number' &&
        (nodeAny.strokeTopWeight !== nodeAny.strokeBottomWeight ||
         nodeAny.strokeTopWeight !== nodeAny.strokeLeftWeight ||
         nodeAny.strokeTopWeight !== nodeAny.strokeRightWeight);
      if (hasIndividualStrokes) {
        if (nodeAny.strokeTopWeight > 0) classes.push(nodeAny.strokeTopWeight === 1 ? 'border-t' : `border-t-${nodeAny.strokeTopWeight}`);
        if (nodeAny.strokeRightWeight > 0) classes.push(nodeAny.strokeRightWeight === 1 ? 'border-r' : `border-r-${nodeAny.strokeRightWeight}`);
        if (nodeAny.strokeBottomWeight > 0) classes.push(nodeAny.strokeBottomWeight === 1 ? 'border-b' : `border-b-${nodeAny.strokeBottomWeight}`);
        if (nodeAny.strokeLeftWeight > 0) classes.push(nodeAny.strokeLeftWeight === 1 ? 'border-l' : `border-l-${nodeAny.strokeLeftWeight}`);
      } else {
        const sw = typeof nodeAny.strokeWeight === 'number' ? nodeAny.strokeWeight : 1;
        if (sw === 1) classes.push('border');
        else classes.push(`border-${sw}`);
      }
      const hex = rgbaToHex(stroke.color.r, stroke.color.g, stroke.color.b, stroke.opacity !== undefined ? stroke.opacity : 1);
      classes.push(`border-${registerColor(registry, hex)}`);
    }
  }

  // Dash pattern (border style)
  if ('dashPattern' in node) {
    const dp = (node as any).dashPattern;
    if (Array.isArray(dp) && dp.length > 0) {
      classes.push('border-dashed');
    }
  }

  // Border radius (with individual corner support)
  if ('cornerRadius' in node) {
    const r = (node as any).cornerRadius;
    if (r === figma.mixed) {
      const nodeAny = node as any;
      const tl = typeof nodeAny.topLeftRadius === 'number' ? nodeAny.topLeftRadius : 0;
      const tr = typeof nodeAny.topRightRadius === 'number' ? nodeAny.topRightRadius : 0;
      const br = typeof nodeAny.bottomRightRadius === 'number' ? nodeAny.bottomRightRadius : 0;
      const bl = typeof nodeAny.bottomLeftRadius === 'number' ? nodeAny.bottomLeftRadius : 0;
      if (tl > 0) classes.push(`rounded-tl-${registerRadius(registry, tl)}`);
      if (tr > 0) classes.push(`rounded-tr-${registerRadius(registry, tr)}`);
      if (br > 0) classes.push(`rounded-br-${registerRadius(registry, br)}`);
      if (bl > 0) classes.push(`rounded-bl-${registerRadius(registry, bl)}`);
    } else if (typeof r === 'number' && r > 0) {
      const name = registerRadius(registry, r);
      classes.push(`rounded-${name}`);
    }
  }

  // Typography
  if (node.type === 'TEXT') {
    const textNode = node as TextNode;
    // Resolve fontSize — may be figma.mixed for multi-style text
    var resolvedFontSize: number | null = null;
    if (typeof textNode.fontSize === 'number') {
      resolvedFontSize = textNode.fontSize;
    } else if (textNode.characters.length > 0) {
      try { resolvedFontSize = textNode.getRangeFontSize(0, 1) as number; } catch (e) {}
    }
    if (resolvedFontSize) {
      const name = registerFontSize(registry, resolvedFontSize);
      classes.push(`text-${name}`);
    }
    // Resolve fontName — may be figma.mixed
    var resolvedFontName: FontName | null = null;
    if (typeof textNode.fontName === 'object' && 'family' in textNode.fontName) {
      resolvedFontName = textNode.fontName as FontName;
    } else if (textNode.characters.length > 0) {
      try { resolvedFontName = textNode.getRangeFontName(0, 1) as FontName; } catch (e) {}
    }
    // Font family
    if (resolvedFontName) {
      const family = resolvedFontName.family;
      classes.push(`font-['${family.replace(/'/g, "\\'").replace(/\s+/g, '_')}']`);
    }
    // Font weight
    if (resolvedFontName) {
      const weight = fontStyleToWeight(resolvedFontName.style);
      if (weight !== 400) {
        const wName = TW_WEIGHT_MAP[weight] || `[${weight}]`;
        classes.push(`font-${wName}`);
      }
    }
    // Line height — may be figma.mixed
    var resolvedLineHeight: { value: number; unit: string } | null = null;
    if (typeof textNode.lineHeight === 'object' && 'value' in textNode.lineHeight) {
      resolvedLineHeight = textNode.lineHeight as { value: number; unit: string };
    } else if (textNode.characters.length > 0) {
      try {
        var lhRange = textNode.getRangeLineHeight(0, 1) as any;
        if (lhRange && typeof lhRange === 'object' && 'value' in lhRange) resolvedLineHeight = lhRange;
      } catch (e) {}
    }
    if (resolvedLineHeight && resolvedLineHeight.unit === 'PIXELS' && resolvedFontSize) {
      const ratio = resolvedLineHeight.value / resolvedFontSize;
      const closest = TW_LEADING_SCALE.reduce((best, s) => Math.abs(s.val - ratio) < Math.abs(best.val - ratio) ? s : best);
      if (Math.abs(closest.val - ratio) < 0.1) classes.push(`leading-${closest.name}`);
    }
    // Letter spacing — may be figma.mixed
    var resolvedLetterSpacing: { value: number } | null = null;
    if (typeof textNode.letterSpacing === 'object' && 'value' in textNode.letterSpacing) {
      resolvedLetterSpacing = textNode.letterSpacing as { value: number };
    } else if (textNode.characters.length > 0) {
      try {
        var lsRange = textNode.getRangeLetterSpacing(0, 1) as any;
        if (lsRange && typeof lsRange === 'object' && 'value' in lsRange) resolvedLetterSpacing = lsRange;
      } catch (e) {}
    }
    if (resolvedLetterSpacing && typeof resolvedLetterSpacing.value === 'number' && Math.abs(resolvedLetterSpacing.value) > 0.1) {
      const ls = resolvedLetterSpacing.value;
      if (ls < -0.3) classes.push('tracking-tighter');
      else if (ls < 0) classes.push('tracking-tight');
      else if (ls > 0.5) classes.push('tracking-wider');
      else if (ls > 0.2) classes.push('tracking-wide');
    }
    // Text decoration — may be figma.mixed
    var resolvedDecoration: string | null = null;
    var rawDec = (textNode as any).textDecoration;
    if (typeof rawDec === 'string') {
      resolvedDecoration = rawDec;
    } else if (textNode.characters.length > 0) {
      try { resolvedDecoration = (textNode as any).getRangeTextDecoration(0, 1) as string; } catch (e) {}
    }
    if (resolvedDecoration === 'UNDERLINE') classes.push('underline');
    else if (resolvedDecoration === 'STRIKETHROUGH') classes.push('line-through');
    // Text case — may be figma.mixed
    var resolvedCase: string | null = null;
    var rawCase = (textNode as any).textCase;
    if (typeof rawCase === 'string') {
      resolvedCase = rawCase;
    } else if (textNode.characters.length > 0) {
      try { resolvedCase = (textNode as any).getRangeTextCase(0, 1) as string; } catch (e) {}
    }
    if (resolvedCase === 'UPPER') classes.push('uppercase');
    else if (resolvedCase === 'LOWER') classes.push('lowercase');
    else if (resolvedCase === 'TITLE') classes.push('capitalize');
    // Text alignment
    if (textNode.textAlignHorizontal === 'CENTER') classes.push('text-center');
    else if (textNode.textAlignHorizontal === 'RIGHT') classes.push('text-right');
  }

  // Opacity
  if ('opacity' in node && typeof (node as any).opacity === 'number' && (node as any).opacity < 1) {
    const op = Math.round((node as any).opacity * 100);
    classes.push(`opacity-${op}`);
  }

  // Rotation
  if ('rotation' in node && typeof (node as any).rotation === 'number' && Math.abs((node as any).rotation) > 0.1) {
    const deg = Math.round(-(node as any).rotation); // Negate: Figma uses counter-clockwise
    classes.push(`rotate-[${deg}deg]`);
  }

  // Blend mode
  if ('blendMode' in node && typeof (node as any).blendMode === 'string') {
    const blendClass = BLEND_MODE_MAP[(node as any).blendMode];
    if (blendClass) classes.push(blendClass);
  }

  // Min/Max constraints
  if (isFrame) {
    const nodeAny = node as any;
    if (typeof nodeAny.minWidth === 'number' && nodeAny.minWidth > 0) classes.push(`min-w-[${Math.round(nodeAny.minWidth)}px]`);
    if (typeof nodeAny.maxWidth === 'number' && nodeAny.maxWidth > 0 && nodeAny.maxWidth < 10000) classes.push(`max-w-[${Math.round(nodeAny.maxWidth)}px]`);
    if (typeof nodeAny.minHeight === 'number' && nodeAny.minHeight > 0) classes.push(`min-h-[${Math.round(nodeAny.minHeight)}px]`);
    if (typeof nodeAny.maxHeight === 'number' && nodeAny.maxHeight > 0 && nodeAny.maxHeight < 10000) classes.push(`max-h-[${Math.round(nodeAny.maxHeight)}px]`);
  }

  // Auto-layout child sizing (FILL → w-full/h-full, skip horizontal in wrap containers)
  if (parentIsAutoLayout) {
    var _szAny = node as any;
    if (typeof _szAny.layoutSizingHorizontal === 'string' && _szAny.layoutSizingHorizontal === 'FILL') {
      if (!parentIsWrap && !classes.includes('flex-1') && !classes.includes('self-stretch')) classes.push('w-full');
    }
    if (typeof _szAny.layoutSizingVertical === 'string' && _szAny.layoutSizingVertical === 'FILL') {
      if (!classes.includes('flex-1')) classes.push('h-full');
    }
  }

  // Effects: Shadow, Inner Shadow, Blur
  if ('effects' in node && Array.isArray(node.effects)) {
    let dropShadowHandled = false;
    for (const effect of node.effects as ReadonlyArray<Effect>) {
      if (effect.visible === false) continue;
      if (effect.type === 'DROP_SHADOW' && !dropShadowHandled) {
        const shadow = effect as DropShadowEffect;
        if (shadow.radius <= 3) classes.push('shadow-sm');
        else if (shadow.radius <= 8) classes.push('shadow');
        else if (shadow.radius <= 16) classes.push('shadow-md');
        else if (shadow.radius <= 25) classes.push('shadow-lg');
        else classes.push('shadow-xl');
        // Shadow color (if not default black)
        const sc = shadow.color;
        if (sc && (sc.r > 0.05 || sc.g > 0.05 || sc.b > 0.05)) {
          const shadowHex = rgbaToHex(sc.r, sc.g, sc.b, sc.a !== undefined ? sc.a : 1);
          classes.push(`shadow-[${shadowHex}]`);
        }
        dropShadowHandled = true;
      }
      if (effect.type === 'INNER_SHADOW') {
        const inner = effect as any;
        const x = Math.round(inner.offset && inner.offset.x || 0);
        const y = Math.round(inner.offset && inner.offset.y || 0);
        const blur = Math.round(inner.radius || 0);
        const col = inner.color ? rgbaToHex(inner.color.r, inner.color.g, inner.color.b, inner.color.a !== undefined ? inner.color.a : 1) : '#00000040';
        classes.push(`shadow-[inset_${x}px_${y}px_${blur}px_${col}]`);
      }
      if (effect.type === 'LAYER_BLUR') {
        const blur = Math.round((effect as any).radius || 0);
        if (blur > 0) classes.push(`blur-[${blur}px]`);
      }
      if (effect.type === 'BACKGROUND_BLUR') {
        const blur = Math.round((effect as any).radius || 0);
        if (blur > 0) classes.push(`backdrop-blur-[${blur}px]`);
      }
    }
  }

  // Counter axis spacing (wrap gap)
  if (isFrame) {
    const frame = node as FrameNode;
    if ((frame as any).layoutWrap === 'WRAP') {
      const counterSpacing = (frame as any).counterAxisSpacing;
      if (typeof counterSpacing === 'number' && counterSpacing > 0 && typeof frame.itemSpacing === 'number' && frame.itemSpacing > 0) {
        // If counter axis spacing differs from item spacing, use gap-x/gap-y instead
        if (counterSpacing !== frame.itemSpacing) {
          // Remove the generic gap class that was already added
          const gapIdx = classes.findIndex(c => c.startsWith('gap-') && !c.startsWith('gap-x-') && !c.startsWith('gap-y-'));
          if (gapIdx !== -1) {
            classes.splice(gapIdx, 1);
            // Determine axes based on layout direction
            if (frame.layoutMode === 'HORIZONTAL') {
              classes.push(`gap-x-${registerSpacing(registry, frame.itemSpacing)}`);
              classes.push(`gap-y-${registerSpacing(registry, counterSpacing)}`);
            } else {
              classes.push(`gap-y-${registerSpacing(registry, frame.itemSpacing)}`);
              classes.push(`gap-x-${registerSpacing(registry, counterSpacing)}`);
            }
          }
        }
      }
    }
  }

  return classes;
}

// Generate layer HTML with registry (CSS variable mode)
async function generateLayerHTMLWithRegistry(node: SceneNode, indent: number, isTopLevel: boolean, parentIsAutoLayout: boolean, registry: TokenRegistry, assets: AssetMap, usedFileNames: Set<string>, parentIsWrap?: boolean, parentWidth?: number, parentGap?: number): Promise<string> {
  if (node.visible === false) return '';

  const pad = '  '.repeat(indent);
  const classes = nodeToClassesWithRegistry(node, parentIsAutoLayout, registry, parentIsWrap, parentWidth, parentGap, isTopLevel);
  let backgroundImageAttr = '';

  if (hasImageFill(node)) {
    const imageUsage = classifyImageFillUsage(node, parentIsAutoLayout);
    const exported = await exportImageFillToAsset(node, assets, usedFileNames);
    if (imageUsage === 'image') {
      const imgClasses = [...classes, ...getImageClasses(node, parentIsAutoLayout)];
      const imgClassStr = imgClasses.length > 0 ? ` class="${imgClasses.join(' ')}"` : '';
      if (!exported) {
        const alt = (node.name || 'image').replace(/"/g, '&quot;');
        return `${pad}<img${imgClassStr} src="/placeholder.svg" alt="${alt}" />\n`;
      }
      return `${pad}<img${imgClassStr} src="{{asset:${exported.id}}}" alt="${exported.alt}" />\n`;
    }
    if (exported) {
      classes.push(...getBackgroundImageClasses(node));
      backgroundImageAttr = ` style="background-image: url('{{asset:${exported.id}}}');"`;
    }
  }

  // Detect semantic element
  const semantic = detectSemanticElement(node, isTopLevel);
  const allClasses = [...classes, ...semantic.extraClasses];

  if (node.type === 'TEXT') {
    const tag = semantic.tag;
    const text = getTextContent(node as TextNode);
    const finalClassStr = allClasses.length > 0 ? ` class="${allClasses.join(' ')}"` : '';
    return `${pad}<${tag}${finalClassStr}>${text}</${tag}>\n`;
  }

  if (node.type === 'VECTOR' || node.type === 'ELLIPSE' || node.type === 'LINE' || node.type === 'STAR' || node.type === 'POLYGON') {
    const vecClasses = [...allClasses, ...getVectorImgClasses()];
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
      const vecClassStr = vecClasses.length > 0 ? ` class="${vecClasses.join(' ')}"` : '';
      return `${pad}<img${vecClassStr} src="{{asset:${id}}}" alt="${name.replace(/"/g, '&quot;')}" width="${w}" height="${h}" />\n`;
    } catch (e) {
      return `${pad}<!-- ${name} -->\n`;
    }
  }

  if (node.type === 'RECTANGLE') {
    if (semantic.selfClosing) {
      const hrClassStr = allClasses.length > 0 ? ` class="${allClasses.join(' ')}"` : '';
      return `${pad}<${semantic.tag}${hrClassStr}${backgroundImageAttr} />\n`;
    }
    const finalClassStr = allClasses.length > 0 ? ` class="${allClasses.join(' ')}"` : '';
    return `${pad}<div${finalClassStr}${backgroundImageAttr}></div>\n`;
  }

  if (node.type === 'GROUP') {
    if (shouldExportAsCompositeImage(node)) {
      return await exportCompositeImage(node, indent, pad, [], assets, usedFileNames, false);
    }
    const group = node as GroupNode;
    const groupClassStr = allClasses.length > 0 ? ` class="${allClasses.join(' ')}"` : '';
    let html = `${pad}<div${groupClassStr}>\n`;
    for (const child of group.children) {
      html += await generateLayerHTMLWithRegistry(child, indent + 1, false, false, registry, assets, usedFileNames);
    }
    html += `${pad}</div>\n`;
    return html;
  }

  if (node.type === 'FRAME' || node.type === 'COMPONENT' || node.type === 'INSTANCE') {
    if (shouldExportAsCompositeImage(node)) {
      return await exportCompositeImage(node, indent, pad, allClasses, assets, usedFileNames, false);
    }
    const frame = node as FrameNode;
    const tag = semantic.tag;
    const isAutoLayout = frame.layoutMode && frame.layoutMode !== 'NONE';
    const isOverlap = !isAutoLayout && frame.children.length > 0 && inferLayoutFromChildren(frame) === 'overlap';
    const isWrap = isAutoLayout && (frame as any).layoutWrap === 'WRAP';
    const frameGap = typeof frame.itemSpacing === 'number' ? frame.itemSpacing : 0;
    // Inner width = outer width minus horizontal padding (for accurate column calculation)
    const framePl = typeof frame.paddingLeft === 'number' ? frame.paddingLeft : 0;
    const framePr = typeof frame.paddingRight === 'number' ? frame.paddingRight : 0;
    const frameInnerWidth = Math.round(frame.width) - framePl - framePr;

    const canSelfClose = semantic.selfClosing && frame.children.length === 0;
    if (canSelfClose) {
      const scClassStr = allClasses.length > 0 ? ` class="${allClasses.join(' ')}"` : '';
      const attrStr = semantic.attrs ? ` ${semantic.attrs}` : '';
      return `${pad}<${tag}${scClassStr}${backgroundImageAttr}${attrStr} />\n`;
    }

    let html = '';
    if (node.type === 'COMPONENT' || node.type === 'INSTANCE') {
      html += `${pad}<!-- ${node.name} -->\n`;
    }
    const finalClassStr = allClasses.length > 0 ? ` class="${allClasses.join(' ')}"` : '';
    const attrStr = semantic.attrs ? ` ${semantic.attrs}` : '';
    html += `${pad}<${tag}${finalClassStr}${backgroundImageAttr}${attrStr}>\n`;

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
          const childSemantic = detectSemanticElement(child, false);
          const text = getTextContent(child as TextNode);
          html += `${pad}  <${childSemantic.tag} class="${childClasses.join(' ')}">${text}</${childSemantic.tag}>\n`;
        } else {
          const overlayClassStr = childClasses.length > 0 ? ` class="${childClasses.join(' ')}"` : '';
          html += `${pad}  <div${overlayClassStr}>\n`;
          html += await generateLayerHTMLWithRegistry(child, indent + 2, false, false, registry, assets, usedFileNames);
          html += `${pad}  </div>\n`;
        }
      } else {
        if (semantic.wrapChildren) {
          html += `${pad}  <${semantic.wrapChildren}>\n`;
          html += await generateLayerHTMLWithRegistry(child, indent + 2, false, !!isAutoLayout, registry, assets, usedFileNames, isWrap, frameInnerWidth, frameGap);
          html += `${pad}  </${semantic.wrapChildren}>\n`;
        } else {
          html += await generateLayerHTMLWithRegistry(child, indent + 1, false, !!isAutoLayout, registry, assets, usedFileNames, isWrap, frameInnerWidth, frameGap);
        }
      }
    }

    html += `${pad}</${tag}>\n`;
    return html;
  }

  const fallbackClassStr = allClasses.length > 0 ? ` class="${allClasses.join(' ')}"` : '';
  return `${pad}<div${fallbackClassStr}${backgroundImageAttr}></div>\n`;
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

function nodeToClasses(node: SceneNode, parentIsAutoLayout: boolean, parentIsWrap?: boolean, parentWidth?: number, parentGap?: number, isTopLevel?: boolean): string[] {
  const classes: string[] = [];

  // Skip invisible
  if (node.visible === false) return classes;

  const isFrame = node.type === 'FRAME' || node.type === 'COMPONENT' || node.type === 'INSTANCE';

  if (isFrame) {
    const frame = node as FrameNode;

    // Auto-layout -> flexbox
    const layoutMode = (frame as any).layoutMode as string;
    if (layoutMode && layoutMode !== 'NONE') {
      if (layoutMode === 'GRID') {
        classes.push('grid');
        const gridCols = (frame as any).gridColumnCount;
        const gridRows = (frame as any).gridRowCount;
        if (typeof gridCols === 'number' && gridCols > 0) {
          if (gridCols <= 12) classes.push(`grid-cols-${gridCols}`);
          else classes.push(`grid-cols-[repeat(${gridCols},minmax(0,1fr))]`);
        }
        if (typeof gridRows === 'number' && gridRows > 0) {
          if (gridRows <= 12) classes.push(`grid-rows-${gridRows}`);
          else classes.push(`grid-rows-[repeat(${gridRows},minmax(0,1fr))]`);
        }
      } else {
        classes.push('flex');
        if (layoutMode === 'VERTICAL') classes.push('flex-col');

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

        // Wrap
        if ((frame as any).layoutWrap === 'WRAP') {
          classes.push('flex-wrap');
        }
      }

      // Gap
      if (typeof frame.itemSpacing === 'number' && frame.itemSpacing > 0) {
        classes.push(`gap-${pxToTailwindSpacing(frame.itemSpacing)}`);
      }
      if (layoutMode === 'GRID') {
        const counterSpacing = (frame as any).counterAxisSpacing;
        if (typeof counterSpacing === 'number' && counterSpacing > 0 && typeof frame.itemSpacing === 'number' && frame.itemSpacing > 0 && counterSpacing !== frame.itemSpacing) {
          classes.push(`gap-y-${pxToTailwindSpacing(counterSpacing)}`);
        }
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
    if (frame.clipsContent && !isTopLevel) {
      classes.push('overflow-hidden');
    }
  }

  // Size
  if (isTopLevel) {
    // Top-level element: use w-full, no fixed height — let content determine height
    classes.push('w-full');
  } else if (!parentIsAutoLayout) {
    if (node.width > 0) classes.push(`w-${pxToTailwindSpacing(Math.round(node.width))}`);
    if (node.height > 0) classes.push(`h-${pxToTailwindSpacing(Math.round(node.height))}`);
  } else {
    const nodeAny = node as any;
    const sizingH = typeof nodeAny.layoutSizingHorizontal === 'string' ? nodeAny.layoutSizingHorizontal : null;
    const sizingV = typeof nodeAny.layoutSizingVertical === 'string' ? nodeAny.layoutSizingVertical : null;

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

    // FIXED-sized children get explicit dimensions (but not in wrap containers — use percentage there)
    // For unknown sizing (null), emit width for non-text nodes only (text defaults to HUG/auto)
    var emitFixedW = sizingH === 'FIXED' || (sizingH === null && node.type !== 'TEXT');
    var emitFixedH = sizingV === 'FIXED';
    if (emitFixedW && node.width > 0 && !parentIsWrap) {
      classes.push(`w-[${Math.round(node.width)}px]`);
    }
    if (emitFixedH && node.height > 0) {
      classes.push(`h-[${Math.round(node.height)}px]`);
    }

    // In wrap containers, children (both FIXED and FILL) need fractional widths based on column count
    if (parentIsWrap && node.width > 0 && parentWidth && parentWidth > 0) {
      var gap = parentGap || 0;
      var childW = Math.round(node.width);
      var cols = Math.max(1, Math.round((parentWidth + gap) / (childW + gap)));
      if (cols >= 2) {
        if (cols === 2) classes.push('w-[calc(50%-' + Math.round(gap / 2) + 'px)]');
        else if (cols === 3) classes.push('w-[calc(33.333%-' + Math.round(gap * 2 / 3) + 'px)]');
        else if (cols === 4) classes.push('w-[calc(25%-' + Math.round(gap * 3 / 4) + 'px)]');
        else classes.push('w-[calc(' + (100 / cols).toFixed(3) + '%-' + Math.round(gap * (cols - 1) / cols) + 'px)]');
      } else {
        classes.push('w-full');
      }
    }
  }

  // Background color + gradients
  if ('fills' in node && Array.isArray(node.fills)) {
    let fillHandled = false;
    for (const paint of node.fills as ReadonlyArray<Paint>) {
      if (paint.visible === false) continue;
      if (paint.type === 'SOLID') {
        const hex = rgbaToHex(paint.color.r, paint.color.g, paint.color.b, paint.opacity !== undefined ? paint.opacity : 1);
        if (node.type === 'TEXT') {
          classes.push(`text-${hexToTailwindColor(hex)}`);
        } else {
          classes.push(`bg-${hexToTailwindColor(hex)}`);
        }
        fillHandled = true;
        break;
      }
      if (!fillHandled && paint.type === 'GRADIENT_LINEAR' && (paint as any).gradientStops) {
        const grad = paint as GradientPaint;
        classes.push(gradientPaintToTailwindBgClass(grad));
        fillHandled = true;
        break;
      }
      if (!fillHandled && paint.type === 'GRADIENT_RADIAL' && (paint as any).gradientStops) {
        const grad = paint as GradientPaint;
        classes.push(gradientPaintToTailwindBgClass(grad));
        fillHandled = true;
        break;
      }
    }
  }

  // Border
  if ('strokes' in node && Array.isArray(node.strokes) && node.strokes.length > 0) {
    const stroke = (node.strokes as ReadonlyArray<Paint>)[0];
    if (stroke && stroke.type === 'SOLID' && stroke.visible !== false) {
      // Check for individual stroke weights
      const nodeAny = node as any;
      const hasIndividualStrokes = typeof nodeAny.strokeTopWeight === 'number' &&
        (nodeAny.strokeTopWeight !== nodeAny.strokeBottomWeight ||
         nodeAny.strokeTopWeight !== nodeAny.strokeLeftWeight ||
         nodeAny.strokeTopWeight !== nodeAny.strokeRightWeight);
      if (hasIndividualStrokes) {
        if (nodeAny.strokeTopWeight > 0) classes.push(nodeAny.strokeTopWeight === 1 ? 'border-t' : `border-t-${nodeAny.strokeTopWeight}`);
        if (nodeAny.strokeRightWeight > 0) classes.push(nodeAny.strokeRightWeight === 1 ? 'border-r' : `border-r-${nodeAny.strokeRightWeight}`);
        if (nodeAny.strokeBottomWeight > 0) classes.push(nodeAny.strokeBottomWeight === 1 ? 'border-b' : `border-b-${nodeAny.strokeBottomWeight}`);
        if (nodeAny.strokeLeftWeight > 0) classes.push(nodeAny.strokeLeftWeight === 1 ? 'border-l' : `border-l-${nodeAny.strokeLeftWeight}`);
      } else {
        const sw = typeof nodeAny.strokeWeight === 'number' ? nodeAny.strokeWeight : 1;
        if (sw === 1) classes.push('border');
        else classes.push(`border-${sw}`);
      }
      const hex = rgbaToHex(stroke.color.r, stroke.color.g, stroke.color.b, stroke.opacity !== undefined ? stroke.opacity : 1);
      classes.push(`border-${hexToTailwindColor(hex)}`);
    }
  }

  // Dash pattern (border style)
  if ('dashPattern' in node) {
    const dp = (node as any).dashPattern;
    if (Array.isArray(dp) && dp.length > 0) {
      classes.push('border-dashed');
    }
  }

  // Border radius (with individual corner support)
  if ('cornerRadius' in node) {
    const r = (node as any).cornerRadius;
    if (r === figma.mixed) {
      const nodeAny = node as any;
      const tl = typeof nodeAny.topLeftRadius === 'number' ? nodeAny.topLeftRadius : 0;
      const tr = typeof nodeAny.topRightRadius === 'number' ? nodeAny.topRightRadius : 0;
      const br = typeof nodeAny.bottomRightRadius === 'number' ? nodeAny.bottomRightRadius : 0;
      const bl = typeof nodeAny.bottomLeftRadius === 'number' ? nodeAny.bottomLeftRadius : 0;
      const radiusToClass = (px: number): string => {
        if (px >= 500) return 'full';
        const closest = TW_RADIUS_SCALE.filter(s => s.name !== 'full')
          .reduce((best, s) => Math.abs(s.px - px) < Math.abs(best.px - px) ? s : best);
        return Math.abs(closest.px - px) <= 1 ? closest.name : `[${px}px]`;
      };
      if (tl > 0) classes.push(`rounded-tl-${radiusToClass(tl)}`);
      if (tr > 0) classes.push(`rounded-tr-${radiusToClass(tr)}`);
      if (br > 0) classes.push(`rounded-br-${radiusToClass(br)}`);
      if (bl > 0) classes.push(`rounded-bl-${radiusToClass(bl)}`);
    } else if (typeof r === 'number' && r > 0) {
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
    // Resolve fontSize — may be figma.mixed for multi-style text
    var resolvedFontSize: number | null = null;
    if (typeof textNode.fontSize === 'number') {
      resolvedFontSize = textNode.fontSize;
    } else if (textNode.characters.length > 0) {
      try { resolvedFontSize = textNode.getRangeFontSize(0, 1) as number; } catch (e) {}
    }
    if (resolvedFontSize) {
      const rem = resolvedFontSize / 16;
      const closest = TW_TEXT_SCALE.reduce((best, s) => Math.abs(s.rem - rem) < Math.abs(best.rem - rem) ? s : best);
      if (Math.abs(closest.rem - rem) < 0.05) {
        classes.push(`text-${closest.name}`);
      } else {
        classes.push(`text-[${resolvedFontSize}px]`);
      }
    }

    // Resolve fontName — may be figma.mixed
    var resolvedFontName: FontName | null = null;
    if (typeof textNode.fontName === 'object' && 'family' in textNode.fontName) {
      resolvedFontName = textNode.fontName as FontName;
    } else if (textNode.characters.length > 0) {
      try { resolvedFontName = textNode.getRangeFontName(0, 1) as FontName; } catch (e) {}
    }

    // Font family
    if (resolvedFontName) {
      const family = resolvedFontName.family;
      classes.push(`font-['${family.replace(/'/g, "\\'").replace(/\s+/g, '_')}']`);
    }

    // Font weight
    if (resolvedFontName) {
      const weight = fontStyleToWeight(resolvedFontName.style);
      if (weight !== 400) {
        const wName = TW_WEIGHT_MAP[weight] || `[${weight}]`;
        classes.push(`font-${wName}`);
      }
    }

    // Line height — may be figma.mixed
    var resolvedLineHeight: { value: number; unit: string } | null = null;
    if (typeof textNode.lineHeight === 'object' && 'value' in textNode.lineHeight) {
      resolvedLineHeight = textNode.lineHeight as { value: number; unit: string };
    } else if (textNode.characters.length > 0) {
      try {
        var lhRange = textNode.getRangeLineHeight(0, 1) as any;
        if (lhRange && typeof lhRange === 'object' && 'value' in lhRange) resolvedLineHeight = lhRange;
      } catch (e) {}
    }
    if (resolvedLineHeight && resolvedLineHeight.unit === 'PIXELS' && resolvedFontSize) {
      const ratio = resolvedLineHeight.value / resolvedFontSize;
      const closest = TW_LEADING_SCALE.reduce((best, s) => Math.abs(s.val - ratio) < Math.abs(best.val - ratio) ? s : best);
      if (Math.abs(closest.val - ratio) < 0.1) {
        classes.push(`leading-${closest.name}`);
      }
    }

    // Letter spacing — may be figma.mixed
    var resolvedLetterSpacing: { value: number } | null = null;
    if (typeof textNode.letterSpacing === 'object' && 'value' in textNode.letterSpacing) {
      resolvedLetterSpacing = textNode.letterSpacing as { value: number };
    } else if (textNode.characters.length > 0) {
      try {
        var lsRange = textNode.getRangeLetterSpacing(0, 1) as any;
        if (lsRange && typeof lsRange === 'object' && 'value' in lsRange) resolvedLetterSpacing = lsRange;
      } catch (e) {}
    }
    if (resolvedLetterSpacing && typeof resolvedLetterSpacing.value === 'number' && Math.abs(resolvedLetterSpacing.value) > 0.1) {
      const ls = resolvedLetterSpacing.value;
      if (ls < -0.3) classes.push('tracking-tighter');
      else if (ls < 0) classes.push('tracking-tight');
      else if (ls > 0.5) classes.push('tracking-wider');
      else if (ls > 0.2) classes.push('tracking-wide');
    }

    // Text decoration — may be figma.mixed
    var resolvedDecoration: string | null = null;
    var rawDec = (textNode as any).textDecoration;
    if (typeof rawDec === 'string') {
      resolvedDecoration = rawDec;
    } else if (textNode.characters.length > 0) {
      try { resolvedDecoration = (textNode as any).getRangeTextDecoration(0, 1) as string; } catch (e) {}
    }
    if (resolvedDecoration === 'UNDERLINE') classes.push('underline');
    else if (resolvedDecoration === 'STRIKETHROUGH') classes.push('line-through');

    // Text case — may be figma.mixed
    var resolvedCase: string | null = null;
    var rawCase = (textNode as any).textCase;
    if (typeof rawCase === 'string') {
      resolvedCase = rawCase;
    } else if (textNode.characters.length > 0) {
      try { resolvedCase = (textNode as any).getRangeTextCase(0, 1) as string; } catch (e) {}
    }
    if (resolvedCase === 'UPPER') classes.push('uppercase');
    else if (resolvedCase === 'LOWER') classes.push('lowercase');
    else if (resolvedCase === 'TITLE') classes.push('capitalize');

    // Text alignment
    if (textNode.textAlignHorizontal === 'CENTER') classes.push('text-center');
    else if (textNode.textAlignHorizontal === 'RIGHT') classes.push('text-right');
  }

  // Opacity
  if ('opacity' in node && typeof (node as any).opacity === 'number' && (node as any).opacity < 1) {
    const op = Math.round((node as any).opacity * 100);
    classes.push(`opacity-${op}`);
  }

  // Rotation
  if ('rotation' in node && typeof (node as any).rotation === 'number' && Math.abs((node as any).rotation) > 0.1) {
    const deg = Math.round(-(node as any).rotation); // Negate: Figma uses counter-clockwise
    classes.push(`rotate-[${deg}deg]`);
  }

  // Blend mode
  if ('blendMode' in node && typeof (node as any).blendMode === 'string') {
    const blendClass = BLEND_MODE_MAP[(node as any).blendMode];
    if (blendClass) classes.push(blendClass);
  }

  // Min/Max constraints
  if (isFrame) {
    const nodeAny = node as any;
    if (typeof nodeAny.minWidth === 'number' && nodeAny.minWidth > 0) classes.push(`min-w-[${Math.round(nodeAny.minWidth)}px]`);
    if (typeof nodeAny.maxWidth === 'number' && nodeAny.maxWidth > 0 && nodeAny.maxWidth < 10000) classes.push(`max-w-[${Math.round(nodeAny.maxWidth)}px]`);
    if (typeof nodeAny.minHeight === 'number' && nodeAny.minHeight > 0) classes.push(`min-h-[${Math.round(nodeAny.minHeight)}px]`);
    if (typeof nodeAny.maxHeight === 'number' && nodeAny.maxHeight > 0 && nodeAny.maxHeight < 10000) classes.push(`max-h-[${Math.round(nodeAny.maxHeight)}px]`);
  }

  // Auto-layout child sizing (FILL → w-full/h-full, skip horizontal in wrap containers)
  if (parentIsAutoLayout) {
    var _szAny = node as any;
    if (typeof _szAny.layoutSizingHorizontal === 'string' && _szAny.layoutSizingHorizontal === 'FILL') {
      if (!parentIsWrap && !classes.includes('flex-1') && !classes.includes('self-stretch')) classes.push('w-full');
    }
    if (typeof _szAny.layoutSizingVertical === 'string' && _szAny.layoutSizingVertical === 'FILL') {
      if (!classes.includes('flex-1')) classes.push('h-full');
    }
  }

  // Effects: Shadow, Inner Shadow, Blur
  if ('effects' in node && Array.isArray(node.effects)) {
    let dropShadowHandled = false;
    for (const effect of node.effects as ReadonlyArray<Effect>) {
      if (effect.visible === false) continue;
      if (effect.type === 'DROP_SHADOW' && !dropShadowHandled) {
        const shadow = effect as DropShadowEffect;
        if (shadow.radius <= 3) classes.push('shadow-sm');
        else if (shadow.radius <= 8) classes.push('shadow');
        else if (shadow.radius <= 16) classes.push('shadow-md');
        else if (shadow.radius <= 25) classes.push('shadow-lg');
        else classes.push('shadow-xl');
        // Shadow color (if not default black)
        const sc = shadow.color;
        if (sc && (sc.r > 0.05 || sc.g > 0.05 || sc.b > 0.05)) {
          const shadowHex = rgbaToHex(sc.r, sc.g, sc.b, sc.a !== undefined ? sc.a : 1);
          classes.push(`shadow-[${shadowHex}]`);
        }
        dropShadowHandled = true;
      }
      if (effect.type === 'INNER_SHADOW') {
        const inner = effect as any;
        const x = Math.round(inner.offset && inner.offset.x || 0);
        const y = Math.round(inner.offset && inner.offset.y || 0);
        const blur = Math.round(inner.radius || 0);
        const col = inner.color ? rgbaToHex(inner.color.r, inner.color.g, inner.color.b, inner.color.a !== undefined ? inner.color.a : 1) : '#00000040';
        classes.push(`shadow-[inset_${x}px_${y}px_${blur}px_${col}]`);
      }
      if (effect.type === 'LAYER_BLUR') {
        const blur = Math.round((effect as any).radius || 0);
        if (blur > 0) classes.push(`blur-[${blur}px]`);
      }
      if (effect.type === 'BACKGROUND_BLUR') {
        const blur = Math.round((effect as any).radius || 0);
        if (blur > 0) classes.push(`backdrop-blur-[${blur}px]`);
      }
    }
  }

  // Counter axis spacing (wrap gap)
  if (isFrame) {
    const frame = node as FrameNode;
    if ((frame as any).layoutWrap === 'WRAP') {
      const counterSpacing = (frame as any).counterAxisSpacing;
      if (typeof counterSpacing === 'number' && counterSpacing > 0 && typeof frame.itemSpacing === 'number' && frame.itemSpacing > 0) {
        if (counterSpacing !== frame.itemSpacing) {
          const gapIdx = classes.findIndex(c => c.startsWith('gap-') && !c.startsWith('gap-x-') && !c.startsWith('gap-y-'));
          if (gapIdx !== -1) {
            classes.splice(gapIdx, 1);
            if (frame.layoutMode === 'HORIZONTAL') {
              classes.push(`gap-x-${pxToTailwindSpacing(frame.itemSpacing)}`);
              classes.push(`gap-y-${pxToTailwindSpacing(counterSpacing)}`);
            } else {
              classes.push(`gap-y-${pxToTailwindSpacing(frame.itemSpacing)}`);
              classes.push(`gap-x-${pxToTailwindSpacing(counterSpacing)}`);
            }
          }
        }
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

// ─── Semantic HTML5 Detection ───

interface SemanticResult {
  tag: string;
  extraClasses: string[];
  selfClosing: boolean;
  attrs: string;       // extra attributes like href="#"
  wrapChildren: string | null;  // if set, wrap each child in this tag (e.g. 'li')
}

const SEMANTIC_NAME_RULES: { pattern: RegExp; tag: string; extraClasses: string[]; selfClosing?: boolean; attrs?: string }[] = [
  { pattern: /\b(button|btn|cta)\b/i, tag: 'button', extraClasses: ['cursor-pointer'] },
  { pattern: /\b(link|anchor)\b/i, tag: 'a', extraClasses: [], attrs: 'href="#"' },
  { pattern: /\b(nav|navbar|navigation|menu)\b/i, tag: 'nav', extraClasses: [] },
  { pattern: /\b(header|topbar|app-bar)\b/i, tag: 'header', extraClasses: [] },
  { pattern: /\b(footer|bottom-bar)\b/i, tag: 'footer', extraClasses: [] },
  { pattern: /^main\b/i, tag: 'main', extraClasses: [] },
  { pattern: /\b(sidebar|aside|drawer)\b/i, tag: 'aside', extraClasses: [] },
  { pattern: /\b(input|text-field|textfield|search-bar)\b/i, tag: 'input', extraClasses: ['outline-none'], selfClosing: true },
  { pattern: /\blabel\b/i, tag: 'label', extraClasses: [] },
  { pattern: /\b(divider|separator)\b/i, tag: 'hr', extraClasses: [], selfClosing: true },
  { pattern: /\b(badge|tag|chip)\b/i, tag: 'span', extraClasses: [] },
  { pattern: /\bradio\b/i, tag: 'input', extraClasses: [], selfClosing: true, attrs: 'type="radio"' },
  { pattern: /\b(checkbox|check)\b/i, tag: 'input', extraClasses: [], selfClosing: true, attrs: 'type="checkbox"' },
];

function detectSemanticElement(node: SceneNode, isTopLevel: boolean): SemanticResult {
  const name = (node.name || '').toLowerCase();
  const defaultResult: SemanticResult = { tag: 'div', extraClasses: [], selfClosing: false, attrs: '', wrapChildren: null };

  // TEXT nodes: use font-size based heading detection
  if (node.type === 'TEXT') {
    const textNode = node as TextNode;
    const fontSize = typeof textNode.fontSize === 'number' ? textNode.fontSize : 16;
    let tag = 'p';
    if (fontSize >= 32) tag = 'h1';
    else if (fontSize >= 24) tag = 'h2';
    else if (fontSize >= 20) tag = 'h3';
    else if (fontSize >= 18) tag = 'h4';
    return { tag, extraClasses: [], selfClosing: false, attrs: '', wrapChildren: null };
  }

  // 1. Name-based detection
  for (const rule of SEMANTIC_NAME_RULES) {
    if (rule.pattern.test(name)) {
      return {
        tag: rule.tag,
        extraClasses: [...rule.extraClasses],
        selfClosing: !!rule.selfClosing,
        attrs: rule.attrs || '',
        wrapChildren: null,
      };
    }
  }

  // 2. Structural heuristics (frames only)
  const isFrame = node.type === 'FRAME' || node.type === 'COMPONENT' || node.type === 'INSTANCE';
  if (isFrame) {
    const frame = node as FrameNode;
    const children = frame.children ? frame.children.filter((c: SceneNode) => c.visible !== false) : [];

    // Button-like: small frame with ≤2 children, has text child, has background fill,
    // must not be an auto-layout container with mixed content (e.g. product card sub-sections)
    if (children.length <= 2 && children.length >= 1 && node.width < 300 && node.height <= 60) {
      const hasText = children.some((c: SceneNode) => c.type === 'TEXT');
      const hasBgFill = 'fills' in node && Array.isArray(node.fills) &&
        (node.fills as ReadonlyArray<Paint>).some(p => p.type === 'SOLID' && p.visible !== false);
      // Exclude auto-layout containers with non-text children (price rows, info sections, etc.)
      var hasNonTextChild = children.some(function(c: SceneNode) {
        return c.type !== 'TEXT' && c.type !== 'VECTOR' && c.type !== 'ELLIPSE';
      });
      if (hasText && hasBgFill && !hasNonTextChild) {
        return { tag: 'button', extraClasses: ['cursor-pointer'], selfClosing: false, attrs: '', wrapChildren: null };
      }
    }

    // List-like: auto-layout with ≥3 children of similar type/size
    if (frame.layoutMode && frame.layoutMode !== 'NONE' && children.length >= 3) {
      const types = children.map((c: SceneNode) => c.type);
      const allSameType = types.every(t => t === types[0]);
      if (allSameType) {
        const heights = children.map((c: SceneNode) => Math.round(c.height));
        const avgH = heights.reduce((s, h) => s + h, 0) / heights.length;
        const similar = heights.every(h => Math.abs(h - avgH) < avgH * 0.3);
        if (similar) {
          return { tag: 'ul', extraClasses: ['list-none'], selfClosing: false, attrs: '', wrapChildren: 'li' };
        }
      }
    }
  }

  // Separator-like: rectangle/line with one thin dimension
  if (node.type === 'RECTANGLE') {
    const w = node.width;
    const h = node.height;
    if ((h < 3 && w > 30) || (w < 3 && h > 30)) {
      return { tag: 'hr', extraClasses: [], selfClosing: true, attrs: '', wrapChildren: null };
    }
  }

  // Fallback
  if (isTopLevel) defaultResult.tag = 'section';
  return defaultResult;
}

function getTextContent(node: TextNode): string {
  const chars = node.characters || '';
  // Escape HTML entities
  return chars.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ─── Composite image helpers ───

function isVectorLike(node: SceneNode): boolean {
  return node.type === 'VECTOR' || node.type === 'ELLIPSE'
      || node.type === 'LINE' || node.type === 'STAR'
      || node.type === 'POLYGON' || node.type === 'BOOLEAN_OPERATION';
}

const COMPOSITE_NAME_RE = /\b(logo|icon|symbol|glyph|emblem|crest|insignia|mark)\b/i;

function shouldExportAsCompositeImage(node: SceneNode): boolean {
  if (!('children' in node)) return false;
  const children = (node as any).children as readonly SceneNode[];
  if (!children || children.length === 0) return false;

  const visibleChildren = children.filter((c: SceneNode) => c.visible !== false);
  if (visibleChildren.length === 0) return false;

  // Size guard: large containers with many small children (like color swatch rows)
  // should NOT be flattened into a composite image — render each child individually.
  const isLargeContainer = node.width > 100 && visibleChildren.length > 2;
  // Check if this looks like a layout container (auto-layout frame) rather than a compound icon
  var isLayoutContainer = false;
  if (node.type === 'FRAME' || node.type === 'COMPONENT' || node.type === 'INSTANCE') {
    var layoutMode = (node as any).layoutMode;
    if (layoutMode && layoutMode !== 'NONE') isLayoutContainer = true;
  }
  if (isLargeContainer && isLayoutContainer) return false;

  // Criteria 1: name matches common icon/logo keywords
  const nameMatch = COMPOSITE_NAME_RE.test(node.name);

  // Criteria 2: all visible children are vector-like
  const allVector = visibleChildren.every((c: SceneNode) => isVectorLike(c));

  // For non-name-matched nodes, require small size to composite (icons are typically small)
  if (allVector) {
    if (isLargeContainer) return false;
    return true;
  }
  if (nameMatch && visibleChildren.every((c: SceneNode) => isVectorLike(c) || isVectorContainer(c))) return true;

  // Criteria 3: nested vector group — children are vector-like or containers of vectors (one level)
  if (node.type === 'GROUP') {
    if (isLargeContainer) return false;
    const allVectorOrContainers = visibleChildren.every((c: SceneNode) => {
      if (isVectorLike(c)) return true;
      return isVectorContainer(c);
    });
    if (allVectorOrContainers && !allVector) return true;
  }

  return false;
}

function isVectorContainer(node: SceneNode): boolean {
  if (!('children' in node)) return false;
  const children = (node as any).children as readonly SceneNode[];
  if (!children || children.length === 0) return false;
  const visible = children.filter((c: SceneNode) => c.visible !== false);
  return visible.length > 0 && visible.every((c: SceneNode) => isVectorLike(c));
}

async function exportCompositeImage(
  node: SceneNode,
  indent: number,
  pad: string,
  extraClasses: string[],
  assets: AssetMap,
  usedFileNames: Set<string>,
  isJSX: boolean
): Promise<string> {
  const name = node.name || 'icon';
  const w = Math.round(node.width);
  const h = Math.round(node.height);
  const classes = ['shrink-0', `w-[${w}px]`, `h-[${h}px]`, ...extraClasses];
  const classAttr = isJSX ? 'className' : 'class';
  const classStr = classes.length > 0 ? ` ${classAttr}="${classes.join(' ')}"` : '';
  const altText = name.replace(/"/g, '&quot;');
  const id = nextAssetId();

  // Try SVG first, fall back to PNG
  try {
    const bytes = await (node as any).exportAsync({ format: 'SVG' });
    assets[id] = {
      base64: uint8ToBase64(bytes),
      mimeType: 'image/svg+xml',
      fileName: toAssetFileName(name, 'svg', usedFileNames),
    };
  } catch (e) {
    try {
      const bytes = await (node as any).exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: 2 } });
      assets[id] = {
        base64: uint8ToBase64(bytes),
        mimeType: 'image/png',
        fileName: toAssetFileName(name, 'png', usedFileNames),
      };
    } catch (e2) {
      return `${pad}<!-- ${name} -->\n`;
    }
  }

  if (isJSX) {
    return `${pad}<img${classStr} src="{{asset:${id}}}" alt="${altText}" width={${w}} height={${h}} />\n`;
  }
  return `${pad}<img${classStr} src="{{asset:${id}}}" alt="${altText}" width="${w}" height="${h}" />\n`;
}

function hasImageFill(node: SceneNode): boolean {
  if ('fills' in node && Array.isArray(node.fills)) {
    for (const paint of node.fills as ReadonlyArray<Paint>) {
      if (paint.type === 'IMAGE' && paint.visible !== false) return true;
    }
  }
  return false;
}

function getImageFillScaleMode(node: SceneNode): string | null {
  if ('fills' in node && Array.isArray(node.fills)) {
    for (const paint of node.fills as ReadonlyArray<Paint>) {
      if (paint.type === 'IMAGE' && paint.visible !== false) {
        return (paint as any).scaleMode || null;
      }
    }
  }
  return null;
}

function hasVisibleChildren(node: SceneNode): boolean {
  if (!('children' in node)) return false;
  const children = (node as any).children as readonly SceneNode[];
  return Array.isArray(children) && children.some((c: SceneNode) => c.visible !== false);
}

function classifyImageFillUsage(node: SceneNode, parentIsAutoLayout: boolean): 'background' | 'image' {
  const hasChildren = hasVisibleChildren(node);
  const scaleMode = getImageFillScaleMode(node);
  const name = (node.name || '').toLowerCase();

  // Hard safety rule: if a node has children, treat image fill as background
  // so we never collapse the subtree into a single <img> and lose content.
  if (hasChildren) return 'background';

  let bgScore = 0;
  let imageScore = 0;

  if (/\b(bg|background|hero|cover|banner|backdrop)\b/.test(name)) bgScore += 2;
  if (/\b(img|image|photo|avatar|logo|icon|thumb|thumbnail)\b/.test(name)) imageScore += 2;

  if (scaleMode === 'FILL' || scaleMode === 'CROP') bgScore += 1;
  if (scaleMode === 'FIT' || scaleMode === 'TILE') imageScore += 1;

  const parent = (node as any).parent as SceneNode | undefined;
  if (parent && typeof parent.width === 'number' && typeof parent.height === 'number' && parent.width > 0 && parent.height > 0) {
    const parentArea = parent.width * parent.height;
    const nodeArea = node.width * node.height;
    const coverage = parentArea > 0 ? nodeArea / parentArea : 0;
    if (coverage >= 0.7) bgScore += 1;
    if (coverage <= 0.2) imageScore += 1;
  }

  if (node.width <= 96 && node.height <= 96) imageScore += 1;
  if (parentIsAutoLayout && !hasChildren) imageScore += 1;

  if (hasChildren && bgScore >= imageScore) return 'background';
  return bgScore > imageScore ? 'background' : 'image';
}

function getBackgroundImageClasses(node: SceneNode): string[] {
  const scaleMode = getImageFillScaleMode(node);
  if (scaleMode === 'TILE') return ['bg-repeat'];
  if (scaleMode === 'FIT') return ['bg-contain', 'bg-center', 'bg-no-repeat'];
  return ['bg-cover', 'bg-center', 'bg-no-repeat'];
}

async function exportImageFillToAsset(node: SceneNode, assets: AssetMap, usedFileNames: Set<string>): Promise<{ id: string; alt: string } | null> {
  const name = node.name || 'image';
  const id = nextAssetId();
  try {
    const bytes = await (node as any).exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: 2 } });
    assets[id] = {
      base64: uint8ToBase64(bytes),
      mimeType: 'image/png',
      fileName: toAssetFileName(name, 'png', usedFileNames),
    };
    return { id, alt: name.replace(/"/g, '&quot;') };
  } catch (e) {
    return null;
  }
}

function getImageClasses(node: SceneNode, parentIsAutoLayout: boolean): string[] {
  const cls: string[] = ['max-w-full'];
  const scaleMode = getImageFillScaleMode(node);
  if (scaleMode === 'FILL' || scaleMode === 'CROP') {
    cls.push('object-cover');
  } else if (scaleMode === 'FIT') {
    cls.push('object-contain');
  }
  // Height: auto unless fixed constraints
  const hasFixedHeight = !parentIsAutoLayout && node.height > 0;
  if (!hasFixedHeight) {
    cls.push('h-auto');
  }
  // Width in auto-layout
  if (parentIsAutoLayout) {
    const parent = (node as any).parent;
    if (parent && Math.abs(node.width - parent.width) < 2) {
      cls.push('w-full');
    } else {
      cls.push('shrink-0', `w-[${Math.round(node.width)}px]`);
    }
  }
  return cls;
}

function getVectorImgClasses(): string[] {
  return ['shrink-0'];
}

async function generateLayerHTML(node: SceneNode, indent: number, isTopLevel: boolean, parentIsAutoLayout: boolean, assets: AssetMap, usedFileNames: Set<string>, parentIsWrap?: boolean, parentWidth?: number, parentGap?: number): Promise<string> {
  // Skip invisible/hidden nodes
  if (node.visible === false) return '';

  const pad = '  '.repeat(indent);
  const classes = nodeToClasses(node, parentIsAutoLayout, parentIsWrap, parentWidth, parentGap, isTopLevel);
  let backgroundImageAttr = '';

  // Image fills -> <img> with exported asset
  if (hasImageFill(node)) {
    const imageUsage = classifyImageFillUsage(node, parentIsAutoLayout);
    const exported = await exportImageFillToAsset(node, assets, usedFileNames);
    if (imageUsage === 'image') {
      const imgClasses = [...classes, ...getImageClasses(node, parentIsAutoLayout)];
      const imgClassStr = imgClasses.length > 0 ? ` class="${imgClasses.join(' ')}"` : '';
      if (!exported) {
        const alt = (node.name || 'image').replace(/"/g, '&quot;');
        return `${pad}<img${imgClassStr} src="/placeholder.svg" alt="${alt}" />\n`;
      }
      return `${pad}<img${imgClassStr} src="{{asset:${exported.id}}}" alt="${exported.alt}" />\n`;
    }
    if (exported) {
      classes.push(...getBackgroundImageClasses(node));
      backgroundImageAttr = ` style="background-image: url('{{asset:${exported.id}}}');"`;
    }
  }

  // Detect semantic element for the current node
  const semantic = detectSemanticElement(node, isTopLevel);
  const allClasses = [...classes, ...semantic.extraClasses];

  // Text node
  if (node.type === 'TEXT') {
    const tag = semantic.tag;
    const text = getTextContent(node as TextNode);
    const finalClassStr = allClasses.length > 0 ? ` class="${allClasses.join(' ')}"` : '';
    return `${pad}<${tag}${finalClassStr}>${text}</${tag}>\n`;
  }

  // Vector/ellipse/line -> export as SVG
  if (node.type === 'VECTOR' || node.type === 'ELLIPSE' || node.type === 'LINE' || node.type === 'STAR' || node.type === 'POLYGON') {
    const vecClasses = [...allClasses, ...getVectorImgClasses()];
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
      const vecClassStr = vecClasses.length > 0 ? ` class="${vecClasses.join(' ')}"` : '';
      return `${pad}<img${vecClassStr} src="{{asset:${id}}}" alt="${name.replace(/"/g, '&quot;')}" width="${w}" height="${h}" />\n`;
    } catch (e) {
      return `${pad}<!-- ${name} -->\n`;
    }
  }

  // Rectangle/LINE -> check for separator, otherwise div
  if (node.type === 'RECTANGLE') {
    if (semantic.selfClosing) {
      const hrClassStr = allClasses.length > 0 ? ` class="${allClasses.join(' ')}"` : '';
      return `${pad}<${semantic.tag}${hrClassStr}${backgroundImageAttr} />\n`;
    }
    const finalClassStr = allClasses.length > 0 ? ` class="${allClasses.join(' ')}"` : '';
    return `${pad}<div${finalClassStr}${backgroundImageAttr}></div>\n`;
  }

  // GROUP -> unwrap children
  if (node.type === 'GROUP') {
    if (shouldExportAsCompositeImage(node)) {
      return await exportCompositeImage(node, indent, pad, [], assets, usedFileNames, false);
    }
    const group = node as GroupNode;
    const groupClassStr = allClasses.length > 0 ? ` class="${allClasses.join(' ')}"` : '';
    let html = `${pad}<div${groupClassStr}>\n`;
    for (const child of group.children) {
      html += await generateLayerHTML(child, indent + 1, false, false, assets, usedFileNames);
    }
    html += `${pad}</div>\n`;
    return html;
  }

  // Frame/Component/Instance -> container with semantic tag
  if (node.type === 'FRAME' || node.type === 'COMPONENT' || node.type === 'INSTANCE') {
    if (shouldExportAsCompositeImage(node)) {
      return await exportCompositeImage(node, indent, pad, allClasses, assets, usedFileNames, false);
    }
    const frame = node as FrameNode;
    const tag = semantic.tag;
    const isAutoLayout = frame.layoutMode && frame.layoutMode !== 'NONE';
    const isOverlap = !isAutoLayout && frame.children.length > 0 && inferLayoutFromChildren(frame) === 'overlap';
    const isWrap = isAutoLayout && (frame as any).layoutWrap === 'WRAP';
    const frameGap = typeof frame.itemSpacing === 'number' ? frame.itemSpacing : 0;
    // Inner width = outer width minus horizontal padding (for accurate column calculation)
    const framePl = typeof frame.paddingLeft === 'number' ? frame.paddingLeft : 0;
    const framePr = typeof frame.paddingRight === 'number' ? frame.paddingRight : 0;
    const frameInnerWidth = Math.round(frame.width) - framePl - framePr;

    // Self-closing semantic tags (input, hr)
    const canSelfClose = semantic.selfClosing && frame.children.length === 0;
    if (canSelfClose) {
      const scClassStr = allClasses.length > 0 ? ` class="${allClasses.join(' ')}"` : '';
      const attrStr = semantic.attrs ? ` ${semantic.attrs}` : '';
      return `${pad}<${tag}${scClassStr}${backgroundImageAttr}${attrStr} />\n`;
    }

    let html = '';
    if (node.type === 'COMPONENT' || node.type === 'INSTANCE') {
      html += `${pad}<!-- ${node.name} -->\n`;
    }

    const finalClassStr = allClasses.length > 0 ? ` class="${allClasses.join(' ')}"` : '';
    const attrStr = semantic.attrs ? ` ${semantic.attrs}` : '';
    html += `${pad}<${tag}${finalClassStr}${backgroundImageAttr}${attrStr}>\n`;

    for (const child of frame.children) {
      if (child.visible === false) continue;
      if (isOverlap) {
        const childClasses = nodeToClasses(child, false);
        childClasses.push('absolute');
        const top = Math.round(child.y);
        const left = Math.round(child.x);
        if (top > 0) childClasses.push(`top-${pxToTailwindSpacing(top)}`);
        if (left > 0) childClasses.push(`left-${pxToTailwindSpacing(left)}`);
        if (child.type === 'TEXT') {
          const childSemantic = detectSemanticElement(child, false);
          const text = getTextContent(child as TextNode);
          html += `${pad}  <${childSemantic.tag} class="${childClasses.join(' ')}">${text}</${childSemantic.tag}>\n`;
        } else {
          const overlayClassStr = childClasses.length > 0 ? ` class="${childClasses.join(' ')}"` : '';
          html += `${pad}  <div${overlayClassStr}>\n`;
          html += await generateLayerHTML(child, indent + 2, false, false, assets, usedFileNames);
          html += `${pad}  </div>\n`;
        }
      } else {
        // Wrap children in <li> if parent is <ul>
        if (semantic.wrapChildren) {
          html += `${pad}  <${semantic.wrapChildren}>\n`;
          html += await generateLayerHTML(child, indent + 2, false, !!isAutoLayout, assets, usedFileNames, isWrap, frameInnerWidth, frameGap);
          html += `${pad}  </${semantic.wrapChildren}>\n`;
        } else {
          html += await generateLayerHTML(child, indent + 1, false, !!isAutoLayout, assets, usedFileNames, isWrap, frameInnerWidth, frameGap);
        }
      }
    }

    html += `${pad}</${tag}>\n`;
    return html;
  }

  // Fallback
  const fallbackClassStr = allClasses.length > 0 ? ` class="${allClasses.join(' ')}"` : '';
  return `${pad}<div${fallbackClassStr}${backgroundImageAttr}></div>\n`;
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

// ─── React/JSX + shadcn/ui Support ───

interface ShadcnComponent {
  name: string;
  importPath: string;
  subComponents?: string[];
}

const SHADCN_NAME_RULES: { pattern: RegExp; component: ShadcnComponent }[] = [
  { pattern: /\b(button|btn|cta)\b/i, component: { name: 'Button', importPath: '@/components/ui/button' } },
  { pattern: /\bcard\b/i, component: { name: 'Card', importPath: '@/components/ui/card', subComponents: ['CardHeader', 'CardContent', 'CardFooter'] } },
  { pattern: /\b(input|text-field|textfield|search-bar)\b/i, component: { name: 'Input', importPath: '@/components/ui/input' } },
  { pattern: /\b(badge|tag|chip)\b/i, component: { name: 'Badge', importPath: '@/components/ui/badge' } },
  { pattern: /\bavatar\b/i, component: { name: 'Avatar', importPath: '@/components/ui/avatar', subComponents: ['AvatarImage', 'AvatarFallback'] } },
  { pattern: /\b(divider|separator)\b/i, component: { name: 'Separator', importPath: '@/components/ui/separator' } },
  { pattern: /\b(switch|toggle)\b/i, component: { name: 'Switch', importPath: '@/components/ui/switch' } },
  { pattern: /\b(checkbox|check)\b/i, component: { name: 'Checkbox', importPath: '@/components/ui/checkbox' } },
  { pattern: /\bradio\b/i, component: { name: 'RadioGroup', importPath: '@/components/ui/radio-group', subComponents: ['RadioGroupItem'] } },
  { pattern: /\b(select|dropdown)\b/i, component: { name: 'Select', importPath: '@/components/ui/select', subComponents: ['SelectTrigger', 'SelectContent', 'SelectItem'] } },
  { pattern: /\b(dialog|modal)\b/i, component: { name: 'Dialog', importPath: '@/components/ui/dialog', subComponents: ['DialogTrigger', 'DialogContent'] } },
  { pattern: /\btabs\b/i, component: { name: 'Tabs', importPath: '@/components/ui/tabs', subComponents: ['TabsList', 'TabsTrigger', 'TabsContent'] } },
];

function detectShadcnComponent(node: SceneNode, semanticTag: string): ShadcnComponent | null {
  const name = (node.name || '').toLowerCase();
  // Name-based match
  for (const rule of SHADCN_NAME_RULES) {
    if (rule.pattern.test(name)) {
      return rule.component;
    }
  }
  // Tag-based fallback: button or input detected semantically
  if (semanticTag === 'button') {
    return { name: 'Button', importPath: '@/components/ui/button' };
  }
  if (semanticTag === 'input') {
    return { name: 'Input', importPath: '@/components/ui/input' };
  }
  return null;
}

class ImportCollector {
  private imports: Map<string, Set<string>> = new Map(); // path -> set of component names

  add(component: ShadcnComponent) {
    if (!this.imports.has(component.importPath)) {
      this.imports.set(component.importPath, new Set());
    }
    this.imports.get(component.importPath)!.add(component.name);
  }

  generate(): string {
    if (this.imports.size === 0) return '';
    const lines: string[] = [];
    for (const [path, names] of this.imports) {
      const sorted = Array.from(names).sort();
      lines.push(`import { ${sorted.join(', ')} } from "${path}"`);
    }
    return lines.join('\n') + '\n';
  }
}

function htmlToJSX(html: string): string {
  // Convert class= to className=
  return html.replace(/\bclass="/g, 'className="');
}

// JSX-aware layer HTML generation (wraps standard generation + transforms)
async function generateLayerJSX(node: SceneNode, indent: number, isTopLevel: boolean, parentIsAutoLayout: boolean, assets: AssetMap, usedFileNames: Set<string>, importCollector: ImportCollector): Promise<string> {
  if (node.visible === false) return '';

  const pad = '  '.repeat(indent);
  const classes = nodeToClasses(node, parentIsAutoLayout);
  const semantic = detectSemanticElement(node, isTopLevel);
  const allClasses = [...classes, ...semantic.extraClasses];
  let backgroundStyleAttr = '';

  // Check for shadcn component
  const shadcn = detectShadcnComponent(node, semantic.tag);

  // Image fills
  if (hasImageFill(node)) {
    const imageUsage = classifyImageFillUsage(node, parentIsAutoLayout);
    const exported = await exportImageFillToAsset(node, assets, usedFileNames);
    if (imageUsage === 'image') {
      const imgClasses = [...allClasses, ...getImageClasses(node, parentIsAutoLayout)];
      const imgClassStr = imgClasses.length > 0 ? ` className="${imgClasses.join(' ')}"` : '';
      if (!exported) {
        const alt = (node.name || 'image').replace(/"/g, '&quot;');
        return `${pad}<img${imgClassStr} src="/placeholder.svg" alt="${alt}" />\n`;
      }
      return `${pad}<img${imgClassStr} src="{{asset:${exported.id}}}" alt="${exported.alt}" />\n`;
    }
    if (exported) {
      allClasses.push(...getBackgroundImageClasses(node));
      backgroundStyleAttr = ` style={{ backgroundImage: "url('{{asset:${exported.id}}}')" }}`;
    }
  }

  // Text node
  if (node.type === 'TEXT') {
    const tag = semantic.tag;
    const text = getTextContent(node as TextNode);
    const finalClassStr = allClasses.length > 0 ? ` className="${allClasses.join(' ')}"` : '';
    return `${pad}<${tag}${finalClassStr}>${text}</${tag}>\n`;
  }

  // Vector/icon
  if (node.type === 'VECTOR' || node.type === 'ELLIPSE' || node.type === 'LINE' || node.type === 'STAR' || node.type === 'POLYGON') {
    const vecClasses = [...allClasses, ...getVectorImgClasses()];
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
      const vecClassStr = vecClasses.length > 0 ? ` className="${vecClasses.join(' ')}"` : '';
      return `${pad}<img${vecClassStr} src="{{asset:${id}}}" alt="${name.replace(/"/g, '&quot;')}" width={${w}} height={${h}} />\n`;
    } catch (e) {
      return `${pad}{/* ${name} */}\n`;
    }
  }

  // Rectangle/LINE
  if (node.type === 'RECTANGLE') {
    if (shadcn) {
      importCollector.add(shadcn);
      const scClassStr = allClasses.length > 0 ? ` className="${allClasses.join(' ')}"` : '';
      return `${pad}<${shadcn.name}${scClassStr}${backgroundStyleAttr} />\n`;
    }
    if (semantic.selfClosing) {
      const hrClassStr = allClasses.length > 0 ? ` className="${allClasses.join(' ')}"` : '';
      return `${pad}<${semantic.tag}${hrClassStr}${backgroundStyleAttr} />\n`;
    }
    const finalClassStr = allClasses.length > 0 ? ` className="${allClasses.join(' ')}"` : '';
    return `${pad}<div${finalClassStr}${backgroundStyleAttr}></div>\n`;
  }

  // GROUP
  if (node.type === 'GROUP') {
    if (shouldExportAsCompositeImage(node)) {
      return await exportCompositeImage(node, indent, pad, [], assets, usedFileNames, true);
    }
    const group = node as GroupNode;
    const groupClassStr = allClasses.length > 0 ? ` className="${allClasses.join(' ')}"` : '';
    let html = `${pad}<div${groupClassStr}>\n`;
    for (const child of group.children) {
      html += await generateLayerJSX(child, indent + 1, false, false, assets, usedFileNames, importCollector);
    }
    html += `${pad}</div>\n`;
    return html;
  }

  // Frame/Component/Instance
  if (node.type === 'FRAME' || node.type === 'COMPONENT' || node.type === 'INSTANCE') {
    if (shouldExportAsCompositeImage(node)) {
      return await exportCompositeImage(node, indent, pad, allClasses, assets, usedFileNames, true);
    }
    const frame = node as FrameNode;
    const isAutoLayout = frame.layoutMode && frame.layoutMode !== 'NONE';
    const isOverlap = !isAutoLayout && frame.children.length > 0 && inferLayoutFromChildren(frame) === 'overlap';

    // Determine tag: shadcn component name or semantic tag
    let tag = semantic.tag;
    if (shadcn) {
      importCollector.add(shadcn);
      tag = shadcn.name;
    }

    // Self-closing
    const canSelfClose = semantic.selfClosing && frame.children.length === 0;
    if (canSelfClose) {
      const scClassStr = allClasses.length > 0 ? ` className="${allClasses.join(' ')}"` : '';
      const attrStr = semantic.attrs ? ` ${semantic.attrs}` : '';
      return `${pad}<${tag}${scClassStr}${backgroundStyleAttr}${attrStr} />\n`;
    }

    let html = '';
    if (node.type === 'COMPONENT' || node.type === 'INSTANCE') {
      html += `${pad}{/* ${node.name} */}\n`;
    }

    const finalClassStr = allClasses.length > 0 ? ` className="${allClasses.join(' ')}"` : '';
    const attrStr = semantic.attrs ? ` ${semantic.attrs}` : '';
    html += `${pad}<${tag}${finalClassStr}${backgroundStyleAttr}${attrStr}>\n`;

    for (const child of frame.children) {
      if (child.visible === false) continue;
      if (isOverlap) {
        const childClasses = nodeToClasses(child, false);
        childClasses.push('absolute');
        const top = Math.round(child.y);
        const left = Math.round(child.x);
        if (top > 0) childClasses.push(`top-${pxToTailwindSpacing(top)}`);
        if (left > 0) childClasses.push(`left-${pxToTailwindSpacing(left)}`);
        if (child.type === 'TEXT') {
          const childSemantic = detectSemanticElement(child, false);
          const text = getTextContent(child as TextNode);
          html += `${pad}  <${childSemantic.tag} className="${childClasses.join(' ')}">${text}</${childSemantic.tag}>\n`;
        } else {
          const overlayClassStr = childClasses.length > 0 ? ` className="${childClasses.join(' ')}"` : '';
          html += `${pad}  <div${overlayClassStr}>\n`;
          html += await generateLayerJSX(child, indent + 2, false, false, assets, usedFileNames, importCollector);
          html += `${pad}  </div>\n`;
        }
      } else {
        if (semantic.wrapChildren) {
          html += `${pad}  <${semantic.wrapChildren}>\n`;
          html += await generateLayerJSX(child, indent + 2, false, !!isAutoLayout, assets, usedFileNames, importCollector);
          html += `${pad}  </${semantic.wrapChildren}>\n`;
        } else {
          html += await generateLayerJSX(child, indent + 1, false, !!isAutoLayout, assets, usedFileNames, importCollector);
        }
      }
    }

    html += `${pad}</${tag}>\n`;
    return html;
  }

  const fallbackClassStr = allClasses.length > 0 ? ` className="${allClasses.join(' ')}"` : '';
  return `${pad}<div${fallbackClassStr}${backgroundStyleAttr}></div>\n`;
}

// JSX-aware layer HTML generation with registry
async function generateLayerJSXWithRegistry(node: SceneNode, indent: number, isTopLevel: boolean, parentIsAutoLayout: boolean, registry: TokenRegistry, assets: AssetMap, usedFileNames: Set<string>, importCollector: ImportCollector): Promise<string> {
  if (node.visible === false) return '';

  const pad = '  '.repeat(indent);
  const classes = nodeToClassesWithRegistry(node, parentIsAutoLayout, registry);
  const semantic = detectSemanticElement(node, isTopLevel);
  const allClasses = [...classes, ...semantic.extraClasses];
  const shadcn = detectShadcnComponent(node, semantic.tag);
  let backgroundStyleAttr = '';

  // Image fills
  if (hasImageFill(node)) {
    const imageUsage = classifyImageFillUsage(node, parentIsAutoLayout);
    const exported = await exportImageFillToAsset(node, assets, usedFileNames);
    if (imageUsage === 'image') {
      const imgClasses = [...allClasses, ...getImageClasses(node, parentIsAutoLayout)];
      const imgClassStr = imgClasses.length > 0 ? ` className="${imgClasses.join(' ')}"` : '';
      if (!exported) {
        const alt = (node.name || 'image').replace(/"/g, '&quot;');
        return `${pad}<img${imgClassStr} src="/placeholder.svg" alt="${alt}" />\n`;
      }
      return `${pad}<img${imgClassStr} src="{{asset:${exported.id}}}" alt="${exported.alt}" />\n`;
    }
    if (exported) {
      allClasses.push(...getBackgroundImageClasses(node));
      backgroundStyleAttr = ` style={{ backgroundImage: "url('{{asset:${exported.id}}}')" }}`;
    }
  }

  if (node.type === 'TEXT') {
    const tag = semantic.tag;
    const text = getTextContent(node as TextNode);
    const finalClassStr = allClasses.length > 0 ? ` className="${allClasses.join(' ')}"` : '';
    return `${pad}<${tag}${finalClassStr}>${text}</${tag}>\n`;
  }

  if (node.type === 'VECTOR' || node.type === 'ELLIPSE' || node.type === 'LINE' || node.type === 'STAR' || node.type === 'POLYGON') {
    const vecClasses = [...allClasses, ...getVectorImgClasses()];
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
      const vecClassStr = vecClasses.length > 0 ? ` className="${vecClasses.join(' ')}"` : '';
      return `${pad}<img${vecClassStr} src="{{asset:${id}}}" alt="${name.replace(/"/g, '&quot;')}" width={${w}} height={${h}} />\n`;
    } catch (e) {
      return `${pad}{/* ${name} */}\n`;
    }
  }

  if (node.type === 'RECTANGLE') {
    if (shadcn) {
      importCollector.add(shadcn);
      const scClassStr = allClasses.length > 0 ? ` className="${allClasses.join(' ')}"` : '';
      return `${pad}<${shadcn.name}${scClassStr}${backgroundStyleAttr} />\n`;
    }
    if (semantic.selfClosing) {
      const hrClassStr = allClasses.length > 0 ? ` className="${allClasses.join(' ')}"` : '';
      return `${pad}<${semantic.tag}${hrClassStr}${backgroundStyleAttr} />\n`;
    }
    const finalClassStr = allClasses.length > 0 ? ` className="${allClasses.join(' ')}"` : '';
    return `${pad}<div${finalClassStr}${backgroundStyleAttr}></div>\n`;
  }

  if (node.type === 'GROUP') {
    if (shouldExportAsCompositeImage(node)) {
      return await exportCompositeImage(node, indent, pad, [], assets, usedFileNames, true);
    }
    const group = node as GroupNode;
    const groupClassStr = allClasses.length > 0 ? ` className="${allClasses.join(' ')}"` : '';
    let html = `${pad}<div${groupClassStr}>\n`;
    for (const child of group.children) {
      html += await generateLayerJSXWithRegistry(child, indent + 1, false, false, registry, assets, usedFileNames, importCollector);
    }
    html += `${pad}</div>\n`;
    return html;
  }

  if (node.type === 'FRAME' || node.type === 'COMPONENT' || node.type === 'INSTANCE') {
    if (shouldExportAsCompositeImage(node)) {
      return await exportCompositeImage(node, indent, pad, allClasses, assets, usedFileNames, true);
    }
    const frame = node as FrameNode;
    const isAutoLayout = frame.layoutMode && frame.layoutMode !== 'NONE';
    const isOverlap = !isAutoLayout && frame.children.length > 0 && inferLayoutFromChildren(frame) === 'overlap';

    let tag = semantic.tag;
    if (shadcn) {
      importCollector.add(shadcn);
      tag = shadcn.name;
    }

    const canSelfClose = semantic.selfClosing && frame.children.length === 0;
    if (canSelfClose) {
      const scClassStr = allClasses.length > 0 ? ` className="${allClasses.join(' ')}"` : '';
      const attrStr = semantic.attrs ? ` ${semantic.attrs}` : '';
      return `${pad}<${tag}${scClassStr}${backgroundStyleAttr}${attrStr} />\n`;
    }

    let html = '';
    if (node.type === 'COMPONENT' || node.type === 'INSTANCE') {
      html += `${pad}{/* ${node.name} */}\n`;
    }
    const finalClassStr = allClasses.length > 0 ? ` className="${allClasses.join(' ')}"` : '';
    const attrStr = semantic.attrs ? ` ${semantic.attrs}` : '';
    html += `${pad}<${tag}${finalClassStr}${backgroundStyleAttr}${attrStr}>\n`;

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
          const childSemantic = detectSemanticElement(child, false);
          const text = getTextContent(child as TextNode);
          html += `${pad}  <${childSemantic.tag} className="${childClasses.join(' ')}">${text}</${childSemantic.tag}>\n`;
        } else {
          const overlayClassStr = childClasses.length > 0 ? ` className="${childClasses.join(' ')}"` : '';
          html += `${pad}  <div${overlayClassStr}>\n`;
          html += await generateLayerJSXWithRegistry(child, indent + 2, false, false, registry, assets, usedFileNames, importCollector);
          html += `${pad}  </div>\n`;
        }
      } else {
        if (semantic.wrapChildren) {
          html += `${pad}  <${semantic.wrapChildren}>\n`;
          html += await generateLayerJSXWithRegistry(child, indent + 2, false, !!isAutoLayout, registry, assets, usedFileNames, importCollector);
          html += `${pad}  </${semantic.wrapChildren}>\n`;
        } else {
          html += await generateLayerJSXWithRegistry(child, indent + 1, false, !!isAutoLayout, registry, assets, usedFileNames, importCollector);
        }
      }
    }

    html += `${pad}</${tag}>\n`;
    return html;
  }

  const fallbackClassStr = allClasses.length > 0 ? ` className="${allClasses.join(' ')}"` : '';
  return `${pad}<div${fallbackClassStr}${backgroundStyleAttr}></div>\n`;
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
    const jsxMode = msg.jsxMode === true;

    // Reset asset counter for each generation run
    assetCounter = 0;
    const assets: AssetMap = {};
    const usedFileNames = new Set<string>();

    let html: string;
    let css: string | undefined;

    try {
      if (jsxMode) {
        const importCollector = new ImportCollector();
        if (generateCSS) {
          const registry = createTokenRegistry();
          html = await generateLayerJSXWithRegistry(node, 0, true, false, registry, assets, usedFileNames, importCollector);
          css = buildThemeCSS(registry);
        } else {
          html = await generateLayerJSX(node, 0, true, false, assets, usedFileNames, importCollector);
        }
        // Prepend imports
        const imports = importCollector.generate();
        if (imports) {
          html = imports + '\n' + html;
        }
      } else if (generateCSS) {
        const registry = createTokenRegistry();
        html = await generateLayerHTMLWithRegistry(node, 0, true, false, registry, assets, usedFileNames);
        css = buildThemeCSS(registry);
      } else {
        html = await generateLayerHTML(node, 0, true, false, assets, usedFileNames);
      }

      // Extract font families from generated HTML for preview font loading
      var fontFamilies: string[] = [];
      var fontRegex = /font-\['([^']+)'\]/g;
      var fontMatch: RegExpExecArray | null;
      var fontSet = new Set<string>();
      while ((fontMatch = fontRegex.exec(html)) !== null) {
        fontSet.add(fontMatch[1].replace(/_/g, ' '));
      }
      fontFamilies = Array.from(fontSet);

      figma.ui.postMessage({
        type: 'layer-generated',
        html: html,
        css: css,
        jsxMode: jsxMode,
        assets: Object.keys(assets).length > 0 ? assets : undefined,
        nodeInfo: { name: node.name, width: Math.round(node.width), height: Math.round(node.height) },
        fontFamilies: fontFamilies.length > 0 ? fontFamilies : undefined,
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
    const screenW = Math.max(figma.viewport.bounds.width * figma.viewport.zoom, 900);
    const screenH = Math.max(figma.viewport.bounds.height * figma.viewport.zoom, 700);
    figma.ui.resize(Math.min(Math.round(screenW), 2000), Math.min(Math.round(screenH), 1200));
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
