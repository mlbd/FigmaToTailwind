import JSZip from 'jszip';

// Asset types matching code.ts
interface AssetEntry {
  base64: string;
  mimeType: string;
  fileName: string;
}
type AssetMap = Record<string, AssetEntry>;

// UI script - handles the plugin interface
document.addEventListener("DOMContentLoaded", () => {
  const content = document.getElementById("content")!;
  const app = document.getElementById("app")!;
  const footer = document.getElementById("footer")!;
  const copyBtn = document.getElementById("copy-btn") as HTMLButtonElement;
  const refreshBtn = document.getElementById("refresh-btn") as HTMLButtonElement;
  const copyText = document.getElementById("copy-text")!;
  const copyIcon = document.getElementById("copy-icon")!;

  if (!copyBtn || !refreshBtn) return;

  let currentCSS = '';
  let currentSections: { label: string; css: string }[] = [];
  let currentLayerHTML = '';
  let currentLayerCSS = '';
  let currentAssets: AssetMap = {};
  let currentFontFamilies: string[] = [];
  let previousCSS = '';
  let lintAborted = false;

  const varCount = document.getElementById('var-count') as HTMLDivElement;
  const collectionCount = document.getElementById('collection-count') as HTMLDivElement;
  const cssPreview = document.getElementById('css-preview') as HTMLElement;
  const sourceBadge = document.getElementById('source-badge') as HTMLDivElement;
  const varCountLabel = document.getElementById('var-count-label') as HTMLDivElement;
  const collectionCountLabel = document.getElementById('collection-count-label') as HTMLDivElement;
  const toast = document.getElementById('toast') as HTMLDivElement;
  const optionsPanel = document.getElementById('options-panel') as HTMLDivElement;
  const optionsToggle = document.getElementById('options-toggle') as HTMLDivElement;
  const optionsCountEl = document.getElementById('options-count') as HTMLSpanElement;

  // Tab elements
  const tabBar = document.getElementById('tab-bar') as HTMLDivElement;
  const tabBtns = document.querySelectorAll('.tab-btn') as NodeListOf<HTMLButtonElement>;
  const tabTokens = document.getElementById('tab-tokens') as HTMLDivElement;
  const tabLayer = document.getElementById('tab-layer') as HTMLDivElement;
  const tabLint = document.getElementById('tab-lint') as HTMLDivElement;
  const footerTokens = document.getElementById('footer-tokens') as HTMLDivElement;
  const footerLayer = document.getElementById('footer-layer') as HTMLDivElement;
  const footerLint = document.getElementById('footer-lint') as HTMLDivElement;

  // Layer tab elements
  const layerNoSelection = document.getElementById('layer-no-selection') as HTMLDivElement;
  const layerSelected = document.getElementById('layer-selected') as HTMLDivElement;
  const layerNodeName = document.getElementById('layer-node-name') as HTMLDivElement;
  const layerNodeSize = document.getElementById('layer-node-size') as HTMLDivElement;
  const layerPreview = document.getElementById('layer-preview') as HTMLElement;
  const generateLayerBtn = document.getElementById('generate-layer-btn') as HTMLButtonElement;
  const copyLayerBtn = document.getElementById('copy-layer-btn') as HTMLButtonElement;

  // Lint tab elements
  const lintLoading = document.getElementById('lint-loading') as HTMLDivElement;
  const lintResults = document.getElementById('lint-results') as HTMLDivElement;
  const lintBadge = document.getElementById('lint-badge') as HTMLSpanElement;
  const runLintBtn = document.getElementById('run-lint-btn') as HTMLButtonElement;
  const lintStopBtn = document.getElementById('lint-stop-btn') as HTMLButtonElement;

  // Layer CSS elements
  const layerJSXToggle = document.getElementById('layer-jsx-mode') as HTMLInputElement;
  const layerCSSToggle = document.getElementById('layer-css-toggle') as HTMLInputElement;
  const layerCSSSection = document.getElementById('layer-css-section') as HTMLDivElement;
  const layerCSSPreview = document.getElementById('layer-css-preview') as HTMLElement;
  const copyLayerCSSBtn = document.getElementById('copy-layer-css-btn') as HTMLButtonElement;
  const generateLayerText = document.getElementById('generate-layer-text') as HTMLSpanElement;
  const generateLayerIcon = document.getElementById('generate-layer-icon') as HTMLSpanElement;
  const previewLayerBtn = document.getElementById('preview-layer-btn') as HTMLButtonElement;
  const downloadZipBtn = document.getElementById('download-zip-btn') as HTMLButtonElement;
  const layerSecondaryActions = document.getElementById('layer-secondary-actions') as HTMLDivElement;

  // Live preview modal elements
  const livePreviewBackdrop = document.getElementById('live-preview-backdrop') as HTMLDivElement;
  const livePreviewTitle = document.getElementById('live-preview-title') as HTMLSpanElement;
  const livePreviewClose = document.getElementById('live-preview-close') as HTMLButtonElement;
  const livePreviewFrame = document.getElementById('live-preview-frame') as HTMLIFrameElement;
  const livePreviewZoomOut = document.getElementById('live-preview-zoom-out') as HTMLButtonElement;
  const livePreviewZoomIn = document.getElementById('live-preview-zoom-in') as HTMLButtonElement;
  const livePreviewZoomValue = document.getElementById('live-preview-zoom-value') as HTMLSpanElement;

  // Diff/output toggle elements
  const previewToggle = document.getElementById('preview-toggle') as HTMLDivElement;
  const previewOutput = document.getElementById('preview-output') as HTMLDivElement;
  const previewDiff = document.getElementById('preview-diff') as HTMLDivElement;
  const diffPreview = document.getElementById('diff-preview') as HTMLElement;

  // Sections container
  const sectionsContainer = document.getElementById('sections-container') as HTMLDivElement;

  // ─── Options state ───

  const CATEGORY_KEYS = ['colors', 'fontFamilies', 'fontSizes', 'lineHeights', 'fontWeights', 'spacing', 'borderRadius', 'shadows', 'gradients', 'animations'];
  const ALL_KEYS = [...CATEGORY_KEYS, 'scalableFontSize', 'defaultClasses'];

  function getOptions(): Record<string, boolean> {
    const opts: Record<string, boolean> = {};
    for (const key of ALL_KEYS) {
      const input = document.querySelector(`[data-opt="${key}"]`) as HTMLInputElement | null;
      opts[key] = input ? input.checked : true;
    }
    return opts;
  }

  function updateOptionsCount() {
    const checked = CATEGORY_KEYS.filter(key => {
      const input = document.querySelector(`[data-opt="${key}"]`) as HTMLInputElement | null;
      return input && input.checked;
    }).length;
    optionsCountEl.textContent = `${checked}/${CATEGORY_KEYS.length}`;
  }

  // Toggle panel open/close
  optionsToggle.addEventListener('click', () => {
    optionsPanel.classList.toggle('open');
  });

  // Listen for any option change → regenerate CSS
  const allCheckboxes = document.querySelectorAll('[data-opt]');
  allCheckboxes.forEach(cb => {
    cb.addEventListener('change', () => {
      updateOptionsCount();
      sendOptionsUpdate();
    });
  });

  function sendOptionsUpdate() {
    const opts = getOptions();
    parent.postMessage({
      pluginMessage: { type: 'update-options', options: opts }
    }, '*');
  }

  // ─── Tab switching ───

  let activeTab = 'tokens';

  function switchTab(tabName: string) {
    activeTab = tabName;

    // Update tab buttons
    tabBtns.forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tab === tabName);
    });

    // Update tab content visibility
    tabTokens.classList.toggle('active', tabName === 'tokens');
    tabLayer.classList.toggle('active', tabName === 'layer');
    tabLint.classList.toggle('active', tabName === 'lint');

    // Update footer visibility
    footerTokens.style.display = tabName === 'tokens' ? '' : 'none';
    footerLayer.style.display = tabName === 'layer' ? '' : 'none';
    footerLint.style.display = tabName === 'lint' ? '' : 'none';
  }

  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;
      if (tab) switchTab(tab);
    });
  });

  // ─── Syntax highlighting ───

  function highlightCSS(raw: string): string {
    return raw
      .split('\n')
      .map(line => {
        if (/^\s*\/\*/.test(line)) {
          return `<span class="syn-comment">${escapeHtml(line)}</span>`;
        }
        if (/^\s*@theme/.test(line)) {
          return line.replace(/@theme/, '<span class="syn-at">@theme</span>')
                     .replace(/\{/, '<span class="syn-brace">{</span>');
        }
        if (/^\s*\}/.test(line)) {
          return `<span class="syn-brace">${escapeHtml(line)}</span>`;
        }
        const match = line.match(/^(\s*)(--[\w-]+)(:)(\s*)(.+)(;)$/);
        if (match) {
          const [, indent, prop, colon, space, value, semi] = match;
          return `${indent}<span class="syn-prop">${escapeHtml(prop)}</span><span class="syn-punct">${colon}</span>${space}<span class="syn-value">${highlightValue(value)}</span><span class="syn-punct">${semi}</span>`;
        }
        return escapeHtml(line);
      })
      .join('\n');
  }

  function highlightHTML(raw: string): string {
    return raw
      .split('\n')
      .map(line => {
        let result = escapeHtml(line);
        // Highlight HTML tags
        result = result.replace(/(&lt;\/?)([\w-]+)/g, '$1<span class="syn-tag">$2</span>');
        // Highlight attributes
        result = result.replace(/([\w-]+)(=)(&quot;)(.*?)(&quot;)/g,
          '<span class="syn-attr">$1</span>$2$3<span class="syn-attr-value">$4</span>$5');
        // Highlight comments
        result = result.replace(/(&lt;!--)(.*?)(--&gt;)/g,
          '<span class="syn-comment">$1$2$3</span>');
        return result;
      })
      .join('\n');
  }

  function highlightJSX(raw: string): string {
    return raw
      .split('\n')
      .map(line => {
        let result = escapeHtml(line);
        // Highlight import statements
        if (/^\s*import\s/.test(line)) {
          result = result.replace(/^(\s*)(import)/, '$1<span class="syn-at">$2</span>');
          result = result.replace(/(from\s+)(&quot;.*?&quot;)/g, '<span class="syn-at">$1</span><span class="syn-value">$2</span>');
          return result;
        }
        // Highlight JSX tags (including PascalCase components)
        result = result.replace(/(&lt;\/?)([\w]+)/g, '$1<span class="syn-tag">$2</span>');
        // Highlight className and other attributes
        result = result.replace(/([\w]+)(=)(&quot;)(.*?)(&quot;)/g,
          '<span class="syn-attr">$1</span>$2$3<span class="syn-attr-value">$4</span>$5');
        // Highlight JSX expression attributes like width={100}
        result = result.replace(/([\w]+)(=)(\{)(.*?)(\})/g,
          '<span class="syn-attr">$1</span>$2$3<span class="syn-value">$4</span>$5');
        // Highlight JSX comments
        result = result.replace(/(\{\/\*)(.*?)(\*\/\})/g,
          '<span class="syn-comment">$1$2$3</span>');
        return result;
      })
      .join('\n');
  }

  function highlightValue(val: string): string {
    return escapeHtml(val).replace(
      /(\d+(?:\.\d+)?)(rem|px|%|vw)/g,
      '$1<span class="syn-unit">$2</span>'
    );
  }

  function escapeHtml(str: string): string {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function showApp() {
    content.style.display = 'none';
    app.style.display = 'block';
    footer.style.display = 'block';
  }

  function updatePreview(css: string) {
    previousCSS = currentCSS;
    currentCSS = css;
    cssPreview.innerHTML = highlightCSS(css);
  }

  // ─── Per-section copy buttons ───

  function renderSections(sections: { label: string; css: string }[]) {
    currentSections = sections;
    if (!sectionsContainer) return;

    sectionsContainer.innerHTML = '';

    sections.forEach((section, index) => {
      const header = document.createElement('div');
      header.className = 'section-header';
      header.innerHTML = `
        <span class="section-label">${escapeHtml(section.label)}</span>
        <button class="section-copy-btn" data-section-index="${index}" title="Copy ${escapeHtml(section.label)} section">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <rect x="5" y="5" width="9" height="9" rx="1.5"/>
            <path d="M5 11H3.5A1.5 1.5 0 0 1 2 9.5V3.5A1.5 1.5 0 0 1 3.5 2h6A1.5 1.5 0 0 1 11 3.5V5"/>
          </svg>
        </button>
      `;
      sectionsContainer.appendChild(header);
    });

    // Add click handlers for section copy buttons
    sectionsContainer.querySelectorAll('.section-copy-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const idx = parseInt((btn as HTMLElement).dataset.sectionIndex || '0');
        const section = currentSections[idx];
        if (section) {
          copyToClipboard(section.css);
          showToast(`Copied ${section.label} section`);
        }
      });
    });
  }

  // ─── Diff computation ───

  function computeDiff(oldStr: string, newStr: string): string {
    const oldLines = oldStr.split('\n');
    const newLines = newStr.split('\n');
    const result: string[] = [];

    // Simple line-based diff using LCS approach
    const lcs = buildLCS(oldLines, newLines);
    let oi = 0, ni = 0, li = 0;

    while (oi < oldLines.length || ni < newLines.length) {
      if (li < lcs.length && oi < oldLines.length && oldLines[oi] === lcs[li]) {
        if (ni < newLines.length && newLines[ni] === lcs[li]) {
          // Unchanged line
          result.push(`<span class="diff-unchanged">${escapeHtml(newLines[ni])}</span>`);
          oi++; ni++; li++;
        } else if (ni < newLines.length) {
          // Added line
          result.push(`<span class="diff-added">${escapeHtml(newLines[ni])}</span>`);
          ni++;
        }
      } else if (oi < oldLines.length && (li >= lcs.length || oldLines[oi] !== lcs[li])) {
        // Removed line
        result.push(`<span class="diff-removed">${escapeHtml(oldLines[oi])}</span>`);
        oi++;
      } else if (ni < newLines.length) {
        // Added line
        result.push(`<span class="diff-added">${escapeHtml(newLines[ni])}</span>`);
        ni++;
      } else {
        break;
      }
    }

    return result.join('\n');
  }

  function buildLCS(a: string[], b: string[]): string[] {
    const m = a.length;
    const n = b.length;

    // For large diffs, use simplified approach to avoid memory issues
    if (m * n > 100000) {
      return simpleDiff(a, b);
    }

    const dp: number[][] = [];
    for (let i = 0; i <= m; i++) {
      dp[i] = [];
      for (let j = 0; j <= n; j++) {
        if (i === 0 || j === 0) {
          dp[i][j] = 0;
        } else if (a[i - 1] === b[j - 1]) {
          dp[i][j] = dp[i - 1][j - 1] + 1;
        } else {
          dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
        }
      }
    }

    // Backtrack to find LCS
    const result: string[] = [];
    let i = m, j = n;
    while (i > 0 && j > 0) {
      if (a[i - 1] === b[j - 1]) {
        result.unshift(a[i - 1]);
        i--; j--;
      } else if (dp[i - 1][j] > dp[i][j - 1]) {
        i--;
      } else {
        j--;
      }
    }
    return result;
  }

  function simpleDiff(a: string[], b: string[]): string[] {
    // For large files, just find matching lines in order
    const result: string[] = [];
    let j = 0;
    for (let i = 0; i < a.length && j < b.length; i++) {
      if (a[i] === b[j]) {
        result.push(a[i]);
        j++;
      }
    }
    return result;
  }

  // ─── Preview toggle (output vs diff) ───

  if (previewToggle) {
    previewToggle.querySelectorAll('.preview-toggle-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const view = (btn as HTMLElement).dataset.view;
        previewToggle.querySelectorAll('.preview-toggle-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');

        if (view === 'diff') {
          previewOutput.style.display = 'none';
          previewDiff.style.display = 'block';
          if (previousCSS && currentCSS) {
            diffPreview.innerHTML = computeDiff(previousCSS, currentCSS);
          } else {
            diffPreview.innerHTML = '<span class="diff-unchanged">No previous version to compare</span>';
          }
        } else {
          previewOutput.style.display = 'block';
          previewDiff.style.display = 'none';
        }
      });
    });
  }

  // ─── Lint rendering ───

  function renderLintResults(warnings: { category: string; message: string; severity: string; suggestion: string }[]) {
    if (!lintResults) return;

    if (warnings.length === 0) {
      lintResults.innerHTML = `
        <div class="empty">
          <div class="empty-icon">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--green)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
              <polyline points="22 4 12 14.01 9 11.01"/>
            </svg>
          </div>
          <h3>All clear!</h3>
          <p>All tokens align with Tailwind scales.</p>
        </div>
      `;
      if (lintBadge) lintBadge.textContent = '';
      return;
    }

    // Update badge
    if (lintBadge) lintBadge.textContent = warnings.length.toString();

    // Group by category
    const groups: Record<string, typeof warnings> = {};
    for (const w of warnings) {
      if (!groups[w.category]) groups[w.category] = [];
      groups[w.category].push(w);
    }

    let html = '';
    for (const [category, items] of Object.entries(groups)) {
      html += `<div class="lint-group">`;
      html += `<div class="lint-group-header">${escapeHtml(category)} <span class="lint-group-count">${items.length}</span></div>`;
      for (const item of items) {
        const iconClass = item.severity === 'warning' ? 'lint-icon-warning' : 'lint-icon-info';
        html += `<div class="lint-item">`;
        html += `<div class="${iconClass}">`;
        if (item.severity === 'warning') {
          html += `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`;
        } else {
          html += `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>`;
        }
        html += `</div>`;
        html += `<div class="lint-item-content">`;
        html += `<div class="lint-message">${escapeHtml(item.message)}</div>`;
        if (item.suggestion) {
          html += `<div class="lint-suggestion">${escapeHtml(item.suggestion)}</div>`;
        }
        html += `</div></div>`;
      }
      html += `</div>`;
    }

    lintResults.innerHTML = html;
  }

  // ─── Clipboard helper ───

  function copyToClipboard(text: string) {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    document.body.removeChild(textarea);
  }

  function showToast(message: string) {
    toast.textContent = message;
    toast.classList.add('show');
    setTimeout(() => {
      toast.classList.remove('show');
    }, 2000);
  }

  // ─── Message handler ───

  window.onmessage = async (event) => {
    const msg = event.data.pluginMessage;
    if (!msg) return;

    if (msg.type === 'variables-extracted') {
      const source: string = msg.source || 'variables';

      if (sourceBadge) {
        if (source === 'scan') {
          sourceBadge.textContent = 'Design Scan';
          sourceBadge.className = 'source-badge source-scan';
        } else {
          sourceBadge.textContent = 'Variables';
          sourceBadge.className = 'source-badge source-variables';
        }
        sourceBadge.style.display = 'inline-block';
      }

      if (source === 'scan') {
        const tokenCount = msg.data.tokenCount || 0;

        if (tokenCount === 0) {
          content.innerHTML = `
            <div class="empty">
              <div class="empty-icon">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/>
                  <polyline points="3.27 6.96 12 12.01 20.73 6.96"/>
                  <line x1="12" y1="22.08" x2="12" y2="12"/>
                </svg>
              </div>
              <h3>No tokens found</h3>
              <p>This file has no variables, styles, or<br>design layers to extract.</p>
            </div>
          `;
          footer.style.display = 'block';
          return;
        }

        varCount.textContent = tokenCount.toString();
        if (varCountLabel) varCountLabel.textContent = 'Tokens';
        collectionCount.textContent = countScannedCategories(msg.data.scannedTokens).toString();
        if (collectionCountLabel) collectionCountLabel.textContent = 'Categories';

        updatePreview(msg.data.css);
        if (msg.data.sections) renderSections(msg.data.sections);
        if (msg.data.lintWarnings) renderLintResults(msg.data.lintWarnings);
        showApp();
        return;
      }

      // Variables/styles path
      let totalVars = 0;
      msg.data.collections.forEach((col: any) => { totalVars += col.variables.length; });

      if (totalVars === 0 && msg.data.styles.colors.length === 0 && msg.data.styles.textStyles.length === 0) {
        content.innerHTML = `
          <div class="empty">
            <div class="empty-icon">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/>
                <polyline points="3.27 6.96 12 12.01 20.73 6.96"/>
                <line x1="12" y1="22.08" x2="12" y2="12"/>
              </svg>
            </div>
            <h3>No variables found</h3>
            <p>Create some variables in Figma<br>and click Refresh.</p>
          </div>
        `;
        footer.style.display = 'block';
        return;
      }

      varCount.textContent = totalVars.toString();
      if (varCountLabel) varCountLabel.textContent = 'Variables';
      collectionCount.textContent = msg.data.collections.length.toString();
      if (collectionCountLabel) collectionCountLabel.textContent = 'Collections';

      parent.postMessage({ pluginMessage: { type: 'generate-css', data: msg.data } }, '*');

    } else if (msg.type === 'css-generated') {
      updatePreview(msg.css);
      if (msg.sections) renderSections(msg.sections);
      showApp();

    } else if (msg.type === 'css-regenerated') {
      updatePreview(msg.css);
      if (msg.sections) renderSections(msg.sections);

    } else if (msg.type === 'selection-changed') {
      // Update layer tab UI based on selection
      if (msg.hasSelection && msg.nodeInfo) {
        layerNoSelection.style.display = 'none';
        layerSelected.style.display = 'block';
        layerNodeName.textContent = msg.nodeInfo.name;
        layerNodeSize.textContent = `${msg.nodeInfo.width} x ${msg.nodeInfo.height}`;
      } else {
        layerNoSelection.style.display = '';
        layerSelected.style.display = 'none';
        layerPreview.innerHTML = '';
        currentLayerHTML = '';
      }

    } else if (msg.type === 'layer-generated') {
      // Remove loading state
      generateLayerBtn.classList.remove('btn-loading');
      generateLayerBtn.disabled = false;
      generateLayerText.textContent = 'Generate';

      if (msg.error) {
        layerPreview.innerHTML = `<span class="syn-comment">/* ${escapeHtml(msg.error)} */</span>`;
        currentLayerHTML = '';
        currentLayerCSS = '';
        currentAssets = {};
        downloadZipBtn.style.display = 'none';
        return;
      }
      currentLayerHTML = msg.html;
      currentAssets = msg.assets || {};
      currentFontFamilies = msg.fontFamilies || [];
      layerPreview.innerHTML = msg.jsxMode ? highlightJSX(msg.html) : highlightHTML(msg.html);
      if (msg.nodeInfo) {
        layerNodeName.textContent = msg.nodeInfo.name;
        layerNodeSize.textContent = `${msg.nodeInfo.width} x ${msg.nodeInfo.height}`;
      }

      // Handle CSS output
      if (msg.css) {
        currentLayerCSS = msg.css;
        layerCSSSection.style.display = 'block';
        layerCSSPreview.innerHTML = highlightCSS(msg.css);
        copyLayerCSSBtn.style.display = '';
      } else {
        currentLayerCSS = '';
        layerCSSSection.style.display = 'none';
        copyLayerCSSBtn.style.display = 'none';
      }

      // Show preview button now that we have generated code
      previewLayerBtn.style.display = '';

      // Show secondary actions row (copy HTML, copy CSS, ZIP)
      layerSecondaryActions.style.display = '';

      // Show ZIP download button
      downloadZipBtn.style.display = '';

      // Auto-open live preview
      // Use layer-specific @theme CSS if generated, otherwise fall back to tokens @theme CSS
      const themeForPreview = currentLayerCSS || currentCSS;
      if (themeForPreview) {
        openLivePreview(
          msg.nodeInfo?.name || layerNodeName.textContent || 'Preview',
          currentLayerHTML,
          themeForPreview
        );
      }

    } else if (msg.type === 'lint-results') {
      lintLoading.style.display = 'none';
      if (lintAborted) {
        lintAborted = false;
        return;
      }
      renderLintResults(msg.warnings);

    } else if (msg.type === 'error') {
      content.innerHTML = `
        <div class="error">
          <div class="error-icon">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#f87171" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="10"/>
              <line x1="15" y1="9" x2="9" y2="15"/>
              <line x1="9" y1="9" x2="15" y2="15"/>
            </svg>
          </div>
          <h3>Something went wrong</h3>
          <p>${escapeHtml(msg.message)}</p>
          <button class="btn-retry" id="retry-btn">Try Again</button>
        </div>
      `;
      const retryBtn = document.getElementById('retry-btn');
      if (retryBtn) {
        retryBtn.addEventListener('click', () => {
          parent.postMessage({ pluginMessage: { type: 'extract' } }, '*');
          content.innerHTML = `
            <div class="loading">
              <div class="loader"></div>
              <div class="loading-text">Scanning your file...</div>
            </div>
          `;
        });
      }
    }
  };

  function countScannedCategories(tokens: any): number {
    if (!tokens) return 0;
    let count = 0;
    if (tokens.colors && tokens.colors.length > 0) count++;
    if (tokens.typography && tokens.typography.length > 0) count++;
    if (tokens.spacing && tokens.spacing.length > 0) count++;
    if (tokens.radii && tokens.radii.length > 0) count++;
    if (tokens.shadows && tokens.shadows.length > 0) count++;
    if (tokens.gradients && tokens.gradients.length > 0) count++;
    if (tokens.animations && tokens.animations.length > 0) count++;
    return count;
  }

  // ─── Asset resolution ───

  function resolveAssetPlaceholders(html: string, assets: AssetMap, mode: 'preview' | 'export'): string {
    return html.replace(/\{\{asset:([\w-]+)\}\}/g, (_match, id) => {
      const asset = assets[id];
      if (!asset) return _match;
      if (mode === 'preview') {
        return `data:${asset.mimeType};base64,${asset.base64}`;
      } else {
        return `./assets/${asset.fileName}`;
      }
    });
  }

  function slugify(name: string): string {
    return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'component';
  }

  function wrapInFullHTML(bodyHTML: string, css: string): string {
    // Build Google Fonts link for exports too
    let fontLink = '';
    if (currentFontFamilies.length > 0) {
      const fontParams = currentFontFamilies
        .map(f => 'family=' + encodeURIComponent(f) + ':wght@100;200;300;400;500;600;700;800;900')
        .join('&');
      fontLink = `\n  <link rel="preconnect" href="https://fonts.googleapis.com">\n  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n  <link href="https://fonts.googleapis.com/css2?${fontParams}&display=swap" rel="stylesheet">`;
    }
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Component</title>${fontLink}
  <script src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4"><\/script>
  <style type="text/tailwindcss">
@import "tailwindcss";

${css}
  </style>
</head>
<body>
${bodyHTML}
</body>
</html>`;
  }

  async function downloadZIP(html: string, css: string, assets: AssetMap, name: string) {
    const zip = new JSZip();

    // HTML with file-path asset references
    const resolvedHTML = resolveAssetPlaceholders(html, assets, 'export');
    zip.file('index.html', wrapInFullHTML(resolvedHTML, css));

    // Assets folder
    for (const [, asset] of Object.entries(assets)) {
      const binary = atob(asset.base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      zip.file(`assets/${asset.fileName}`, bytes);
    }

    const blob = await zip.generateAsync({ type: 'blob' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${slugify(name)}.zip`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(a.href);
  }

  // ─── Live Preview Modal ───

  let livePreviewZoom = 1;

  function applyLivePreviewZoom() {
    const zoomPct = `${Math.round(livePreviewZoom * 100)}%`;
    if (livePreviewZoomValue) livePreviewZoomValue.textContent = zoomPct;

    const doc = livePreviewFrame.contentDocument;
    if (doc) {
      const root = doc.getElementById('preview-root') as HTMLDivElement | null;
      if (root) {
        root.style.transform = `scale(${livePreviewZoom})`;
        root.style.transformOrigin = 'top left';
        root.style.width = `${100 / livePreviewZoom}%`;
      }
    }
  }

  function openLivePreview(title: string, html: string, themeCSS: string) {
    livePreviewTitle.textContent = title;
    livePreviewZoom = 1;
    applyLivePreviewZoom();

    // Ask code.ts to resize plugin window for larger preview
    parent.postMessage({ pluginMessage: { type: 'resize-for-preview' } }, '*');

    // Resolve asset placeholders with data URIs for inline preview
    const resolvedHTML = resolveAssetPlaceholders(html, currentAssets, 'preview');

    // Build Google Fonts link for any custom fonts used
    let fontLink = '';
    if (currentFontFamilies.length > 0) {
      const fontParams = currentFontFamilies
        .map(f => 'family=' + encodeURIComponent(f) + ':wght@100;200;300;400;500;600;700;800;900')
        .join('&');
      fontLink = `<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?${fontParams}&display=swap" rel="stylesheet">`;
    }

    // Build the srcdoc: full HTML page with Tailwind v4 browser + @theme CSS + generated HTML
    // @tailwindcss/browser is a global script that auto-processes <style type="text/tailwindcss">
    const srcdoc = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${fontLink}
<style type="text/tailwindcss">
@import "tailwindcss";

${escapeStyleContent(themeCSS)}
</style>
<script src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4"><\/script>
<style>
  body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
  #preview-root {
    transform-origin: top left;
    width: 100%;
    min-height: 100vh;
  }
  #loading {
    display: flex; align-items: center; justify-content: center;
    height: 100vh; color: #888; font-size: 14px;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  }
</style>
</head>
<body>
<div id="loading">Loading Tailwind preview...</div>
<div id="preview-root">${resolvedHTML}</div>
<script>
  // Hide loading once Tailwind has processed styles
  var observer = new MutationObserver(function(mutations) {
    for (var m of mutations) {
      for (var node of m.addedNodes) {
        if (node.tagName === 'STYLE' && !node.hasAttribute('type')) {
          document.getElementById('loading').style.display = 'none';
          observer.disconnect();
          return;
        }
      }
    }
  });
  observer.observe(document.head, { childList: true });
  // Fallback: hide loading after 5s regardless
  setTimeout(function() {
    var el = document.getElementById('loading');
    if (el) el.style.display = 'none';
  }, 5000);
<\/script>
</body>
</html>`;

    livePreviewFrame.srcdoc = srcdoc;
    livePreviewBackdrop.classList.add('open');
  }

  function closeLivePreview() {
    livePreviewBackdrop.classList.remove('open');
    livePreviewFrame.srcdoc = '';
    // Restore plugin window size
    parent.postMessage({ pluginMessage: { type: 'resize-restore' } }, '*');
  }

  function escapeStyleContent(str: string): string {
    // Prevent </style> in CSS content from breaking the HTML structure
    return str.replace(/<\/style/gi, '<\\/style');
  }

  // Close button
  livePreviewClose.addEventListener('click', closeLivePreview);

  // Zoom controls
  if (livePreviewZoomOut) {
    livePreviewZoomOut.addEventListener('click', () => {
      livePreviewZoom = Math.max(0.25, Math.round((livePreviewZoom - 0.1) * 100) / 100);
      applyLivePreviewZoom();
    });
  }

  if (livePreviewZoomIn) {
    livePreviewZoomIn.addEventListener('click', () => {
      livePreviewZoom = Math.min(3, Math.round((livePreviewZoom + 0.1) * 100) / 100);
      applyLivePreviewZoom();
    });
  }

  livePreviewFrame.addEventListener('load', () => {
    applyLivePreviewZoom();
  });

  // Escape key
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && livePreviewBackdrop.classList.contains('open')) {
      closeLivePreview();
    }
  });

  // ─── Copy CSS (full) ───

  copyBtn.addEventListener('click', () => {
    if (!currentCSS) return;

    copyToClipboard(currentCSS);

    copyBtn.classList.add('copied');
    copyIcon.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="3.5 8.5 6.5 11.5 12.5 4.5"/>
      </svg>
    `;
    copyText.textContent = 'Copied!';
    showToast('Copied to clipboard');

    setTimeout(() => {
      copyBtn.classList.remove('copied');
      copyIcon.innerHTML = `
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <rect x="5" y="5" width="9" height="9" rx="1.5"/>
          <path d="M5 11H3.5A1.5 1.5 0 0 1 2 9.5V3.5A1.5 1.5 0 0 1 3.5 2h6A1.5 1.5 0 0 1 11 3.5V5"/>
        </svg>
      `;
      copyText.textContent = 'Copy CSS';
    }, 2000);
  });

  // ─── Generate Layer HTML ───

  if (generateLayerBtn) {
    generateLayerBtn.addEventListener('click', () => {
      // Loading state
      generateLayerBtn.classList.add('btn-loading');
      generateLayerBtn.disabled = true;
      generateLayerText.textContent = 'Generating...';

      const generateCSS = layerCSSToggle ? layerCSSToggle.checked : false;
      const jsxMode = layerJSXToggle ? layerJSXToggle.checked : false;
      parent.postMessage({ pluginMessage: { type: 'generate-layer', generateCSS, jsxMode } }, '*');
    });
  }

  // ─── Copy Layer HTML ───

  if (copyLayerBtn) {
    copyLayerBtn.addEventListener('click', () => {
      if (!currentLayerHTML) return;
      const resolved = Object.keys(currentAssets).length > 0
        ? resolveAssetPlaceholders(currentLayerHTML, currentAssets, 'export')
        : currentLayerHTML;
      copyToClipboard(resolved);
      const isJSX = layerJSXToggle && layerJSXToggle.checked;
      showToast(isJSX ? 'Copied JSX to clipboard' : 'Copied HTML to clipboard');
    });
  }

  // ─── Copy Layer CSS ───

  if (copyLayerCSSBtn) {
    copyLayerCSSBtn.addEventListener('click', () => {
      if (!currentLayerCSS) return;
      copyToClipboard(currentLayerCSS);
      showToast('Copied CSS to clipboard');
    });
  }

  // ─── Re-open Live Preview ───

  if (previewLayerBtn) {
    previewLayerBtn.addEventListener('click', () => {
      if (!currentLayerHTML) return;
      const themeForPreview = currentLayerCSS || currentCSS;
      if (themeForPreview) {
        openLivePreview(
          layerNodeName.textContent || 'Preview',
          currentLayerHTML,
          themeForPreview
        );
      }
    });
  }

  // ─── Download ZIP ───

  if (downloadZipBtn) {
    downloadZipBtn.addEventListener('click', async () => {
      if (!currentLayerHTML) return;
      const themeCSS = currentLayerCSS || currentCSS;
      const name = layerNodeName.textContent || 'component';
      try {
        await downloadZIP(currentLayerHTML, themeCSS, currentAssets, name);
        showToast('ZIP downloaded');
      } catch (e) {
        showToast('ZIP download failed');
      }
    });
  }

  // ─── Run Lint ───

  if (runLintBtn) {
    runLintBtn.addEventListener('click', () => {
      lintAborted = false;
      lintLoading.style.display = 'block';
      lintResults.innerHTML = '';
      parent.postMessage({ pluginMessage: { type: 'run-lint' } }, '*');
    });
  }

  // ─── Stop Lint ───

  if (lintStopBtn) {
    lintStopBtn.addEventListener('click', () => {
      lintAborted = true;
      lintLoading.style.display = 'none';
      lintResults.innerHTML = `
        <div class="empty">
          <h3>Lint cancelled</h3>
          <p>Click "Run Lint" to try again.</p>
        </div>
      `;
    });
  }

  // ─── Refresh ───

  refreshBtn.addEventListener('click', () => {
    content.style.display = 'block';
    app.style.display = 'none';
    footer.style.display = 'none';
    if (sourceBadge) sourceBadge.style.display = 'none';
    content.innerHTML = `
      <div class="loading">
        <div class="loader"></div>
        <div class="loading-text">Scanning your file...</div>
      </div>
    `;

    parent.postMessage({ pluginMessage: { type: 'extract' } }, '*');
  });

  // Initialize options count
  updateOptionsCount();
});
