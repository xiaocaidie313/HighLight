// Highlight 插件 MVP 版本内容脚本
// 负责：
// 1. 监听用户选区并用 <mark> 包裹高亮
// 2. 将高亮信息持久化到 chrome.storage.local
// 3. 在页面加载时恢复历史高亮
// 4. 响应精读模式开关，控制页面展示样式

const HL_CONFIG_KEY = "config:v1";

// 标记扩展上下文是否有效
let extensionContextValid = true;

// 检查扩展上下文是否有效（失效时 runtime.id 不可用，比反复 getManifest 更轻量）
function checkExtensionContext() {
  try {
    if (!chrome?.runtime?.id) {
      extensionContextValid = false;
      return false;
    }
    return true;
  } catch (e) {
    extensionContextValid = false;
    console.log("[Highlight] 扩展上下文已失效，停止执行");
    return false;
  }
}

// 在所有关键操作前检查上下文
function isExtensionValid() {
  if (!extensionContextValid) return false;
  return checkExtensionContext();
}

const DEFAULT_CONFIG = {
  theme: "default",
  highlightEnabled: true,
  readingModeEnabled: false,
  highlightColor: "yellow"
};

/** 与 popup、CSS 修饰符 hl-ext-mark--* 一致 */
const HL_MARK_COLOR_KEYS = ["yellow", "green", "blue", "pink", "orange", "purple"];
const HL_MARK_COLOR_CLASS_PREFIX = "hl-ext-mark--";

function normalizeHighlightColorKey(key) {
  const k = typeof key === "string" ? key.trim().toLowerCase() : "";
  return HL_MARK_COLOR_KEYS.includes(k) ? k : "yellow";
}

function applyHighlightColorToMark(mark, colorKey) {
  const k = normalizeHighlightColorKey(colorKey);
  mark.dataset.hlColor = k;
  HL_MARK_COLOR_KEYS.forEach((c) => {
    if (c === "yellow") return;
    mark.classList.remove(HL_MARK_COLOR_CLASS_PREFIX + c);
  });
  if (k !== "yellow") {
    mark.classList.add(HL_MARK_COLOR_CLASS_PREFIX + k);
  }
}

function noteRuntimeLastError(label) {
  const err = chrome.runtime.lastError;
  if (!err) return false;
  const msg = err.message || "";
  if (/context invalidated|message port closed/i.test(msg)) {
    extensionContextValid = false;
  }
  console.log(`[Highlight] ${label}:`, err);
  return true;
}

let currentConfig = {
  highlightEnabled: true,
  readingModeEnabled: false,
  highlightColor: "yellow"
};

console.log("[Highlight] 插件已加载！");

// 使用简单的 URL 规范化，MVP 版本仅移除 hash，保留 query
function normalizeUrl(url) {
  try {
    const u = new URL(url);
    u.hash = "";
    return u.toString();
  } catch (e) {
    return url;
  }
}

function getPageHighlightsKey(url) {
  return "highlights:" + normalizeUrl(url);
}

/** 页面内高亮列表面板根节点 id，选区在此区域内时不创建高亮 */
const HL_EXT_PANEL_SHELL_ID = "hl-ext-highlight-shell";

function isNodeInsideHighlightPanelUi(node) {
  try {
    if (!node || node.nodeType === undefined) return false;
    const el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    return !!(
      el &&
      typeof el.closest === "function" &&
      el.closest(`#${HL_EXT_PANEL_SHELL_ID}`)
    );
  } catch (_) {
    return false;
  }
}

function isSelectionAnchoredInHighlightPanel(selection) {
  if (!selection || selection.rangeCount === 0) return false;
  const range = selection.getRangeAt(0);
  return (
    isNodeInsideHighlightPanelUi(range.startContainer) ||
    isNodeInsideHighlightPanelUi(range.endContainer) ||
    isNodeInsideHighlightPanelUi(range.commonAncestorContainer)
  );
}

function createUuid() {
  // 简单 UUID v4 实现，每个十六进制位独立随机
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map(b => b.toString(16).padStart(2, "0")).join("");
  return (
    hex.slice(0, 8) +
    "-" +
    hex.slice(8, 12) +
    "-" +
    hex.slice(12, 16) +
    "-" +
    hex.slice(16, 20) +
    "-" +
    hex.slice(20)
  );
}

function nowIso() {
  return new Date().toISOString();
}

// ------- 高亮 DOM 操作 -------

/**
 * 检查一个 Range 内是否已经包含高亮
 * 在整个选区内搜索所有高亮标记
 */
function rangeContainsExistingHighlight(range) {
  try {
    // 检查 1：选区的起始或结束节点是否在某个 mark 内部
    const startInMark = isNodeInsideMark(range.startContainer);
    const endInMark = isNodeInsideMark(range.endContainer);
    
    if (startInMark || endInMark) {
      console.log("[Highlight] 检测到选区在已有 mark 内部，跳过");
      return true;
    }

    // 检查 2：获取整个文档中所有的高亮标记，检查是否有交集
    const allMarks = document.querySelectorAll("mark.hl-ext-mark");

    for (const mark of allMarks) {
      if (mark.closest(`#${HL_EXT_PANEL_SHELL_ID}`)) continue;
      const markRange = document.createRange();
      markRange.selectNode(mark);
      
      // 检查当前 range 是否与已有高亮有交集
      if (rangesIntersect(range, markRange)) {
        console.log("[Highlight] 检测到选区与已有 mark 有交集，跳过");
        return true;
      }
    }
    
    return false;
  } catch (e) {
    console.log("[Highlight] 检测已有高亮时出错:", e);
    return false;
  }
}

/**
 * 检查节点是否在一个 mark.hl-ext-mark 元素内部
 */
function isNodeInsideMark(node) {
  let current = node;
  while (current) {
    if (current.nodeType === Node.ELEMENT_NODE && 
        current.classList && 
        current.classList.contains('hl-ext-mark')) {
      return true;
    }
    current = current.parentNode;
  }
  return false;
}

/**
 * 判断两个 Range 是否有交集
 */
function rangesIntersect(range1, range2) {
  // range1 的结束在 range2 的开始之前 → 不相交
  if (range1.compareBoundaryPoints(Range.END_TO_START, range2) >= 0) {
    return false;
  }
  // range1 的开始在 range2 的结束之后 → 不相交
  if (range1.compareBoundaryPoints(Range.START_TO_END, range2) <= 0) {
    return false;
  }
  // 其他情况都是相交的
  return true;
}

/**
 * 在给定的 Range 周围创建 <mark> 元素。
 * 首先尝试使用 surroundContents，如果失败则使用更安全的方法。
 */
function wrapRangeWithMark(range, highlightId, colorKey) {
  const mark = document.createElement("mark");
  mark.className = "hl-ext-mark";
  mark.dataset.highlightId = highlightId;
  applyHighlightColorToMark(mark, colorKey);
  mark.setAttribute("role", "mark");
  mark.setAttribute("aria-label", "Highlight");

  try {
    range.surroundContents(mark);
    return mark;
  } catch (e) {
    console.log("[Highlight] surroundContents 失败，使用备选方案", e);
    return safeWrapRange(range, mark);
  }
}

/**
 * 更安全的 Range 包裹方法，处理复杂的 DOM 结构
 * 使用 TreeWalker 提取范围内的所有纯文本节点，逐个套上 <mark> 标签
 */
function safeWrapRange(range, mark) {
  const startContainer = range.startContainer;
  const endContainer = range.endContainer;
  const startOffset = range.startOffset;
  const endOffset = range.endOffset;

  // 单个文本节点的情况，直接处理
  if (startContainer === endContainer && startContainer.nodeType === Node.TEXT_NODE) {
    return wrapTextNode(startContainer, startOffset, endOffset, mark);
  }

  // 使用 TreeWalker 提取范围内的所有纯文本节点
  const textNodes = getTextNodesInRange(range);

  // 跨节点时 surroundContents 会为每段文本各建一个 mark；须返回实际插入的第一个 mark
  let firstInserted = null;

  // 逐个处理每个文本节点
  textNodes.forEach((textNode) => {
    let nodeStart = 0;
    let nodeEnd = textNode.length;

    // 调整第一个和最后一个节点的范围
    if (textNode === startContainer) {
      nodeStart = startOffset;
    }
    if (textNode === endContainer) {
      nodeEnd = endOffset;
    }

    // 如果没有选中任何内容，跳过
    if (nodeStart >= nodeEnd) return;

    // 为每个文本节点创建新的 mark 元素
    const nodeMark = document.createElement("mark");
    nodeMark.className = mark.className;
    nodeMark.dataset.highlightId = mark.dataset.highlightId;
    if (mark.dataset.hlColor) {
      nodeMark.dataset.hlColor = mark.dataset.hlColor;
    }
    nodeMark.setAttribute("role", mark.getAttribute("role"));
    nodeMark.setAttribute("aria-label", mark.getAttribute("aria-label"));

    const inserted = wrapTextNode(textNode, nodeStart, nodeEnd, nodeMark);
    if (inserted && !firstInserted) {
      firstInserted = inserted;
    }
  });

  return firstInserted || mark;
}

/**
 * 使用 TreeWalker 获取 Range 内的所有纯文本节点
 * 过滤掉纯空白/换行符的节点
 */
function getTextNodesInRange(range) {
  const textNodes = [];
  const walker = document.createTreeWalker(
    range.commonAncestorContainer,
    NodeFilter.SHOW_TEXT,
    null
  );

  let node;
  while ((node = walker.nextNode())) {
    // 过滤只包含空白字符的节点
    if (!hasVisibleText(node)) {
      continue;
    }
    
    if (isNodeInRange(node, range)) {
      textNodes.push(node);
    }
  }

  return textNodes;
}

/**
 * 检查文本节点是否包含可见内容（非纯空白）
 */
function hasVisibleText(textNode) {
  const text = textNode.nodeValue || "";
  // 检查是否只包含空白字符（空格、制表符、换行符、回车符等）
  return text.trim().length > 0;
}

/**
 * 判断节点是否在 Range 范围内
 */
function isNodeInRange(node, range) {
  const nodeRange = document.createRange();
  nodeRange.selectNodeContents(node);
  
  // 检查是否有交集
  return !(range.compareBoundaryPoints(Range.END_TO_START, nodeRange) > 0 ||
           range.compareBoundaryPoints(Range.START_TO_END, nodeRange) < 0);
}

/**
 * 包裹单个文本节点的指定范围
 * 优化空白字符处理
 */
function wrapTextNode(textNode, startOffset, endOffset, markElement) {
  const fullText = textNode.nodeValue;
  const beforeText = fullText.substring(0, startOffset);
  const middleText = fullText.substring(startOffset, endOffset);
  const afterText = fullText.substring(endOffset);

  // 检查选中的文本是否只包含空白字符
  const middleTextTrimmed = middleText.trim();
  if (middleTextTrimmed.length === 0) {
    return null;
  }

  markElement.textContent = middleText;

  const parent = textNode.parentNode;
  let currentNode = textNode;

  if (beforeText) {
    const beforeNode = document.createTextNode(beforeText);
    parent.insertBefore(beforeNode, currentNode);
    currentNode = beforeNode.nextSibling;
  }

  parent.insertBefore(markElement, currentNode);

  if (afterText) {
    const afterNode = document.createTextNode(afterText);
    parent.insertBefore(afterNode, markElement.nextSibling);
  }

  parent.removeChild(textNode);

  return markElement;
}

/**
 * 检查文本是否已经被高亮过
 */
function isTextAlreadyHighlighted(text) {
  const marks = document.querySelectorAll("mark.hl-ext-mark");
  for (const mark of marks) {
    if (mark.closest(`#${HL_EXT_PANEL_SHELL_ID}`)) continue;
    if (mark.textContent.trim() === text.trim()) {
      return true;
    }
  }
  return false;
}

/**
 * 在文档中查找包含指定文本的第一个文本节点，并用 <mark> 包裹。
 * 该函数用于页面加载后的高亮恢复。
 */
function applyHighlightByText(text, highlightId, colorKey) {
  if (!text) return;
  
  if (isTextAlreadyHighlighted(text)) {
    console.log("[Highlight] 文本已高亮，跳过恢复:", text.substring(0, 30) + "...");
    return;
  }

  const walker = document.createTreeWalker(
    document.body,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        
        const parent = node.parentElement;
        if (parent && parent.closest("mark.hl-ext-mark")) {
          return NodeFilter.FILTER_REJECT;
        }
        if (parent && parent.closest(`#${HL_EXT_PANEL_SHELL_ID}`)) {
          return NodeFilter.FILTER_REJECT;
        }

        return node.nodeValue.includes(text)
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_SKIP;
      }
    }
  );

  let node = walker.nextNode();
  if (!node) return;

  const index = node.nodeValue.indexOf(text);
  if (index === -1) return;

  const range = document.createRange();
  range.setStart(node, index);
  range.setEnd(node, index + text.length);

  console.log("[Highlight] 恢复高亮:", text.substring(0, 30) + "...");
  wrapRangeWithMark(range, highlightId, colorKey);
}

// ------- 存储操作 (直接使用 chrome.storage.local) -------

function getConfig(callback) {
  try {
    if (!isExtensionValid()) {
      if (callback) callback({ ...DEFAULT_CONFIG });
      return;
    }

    chrome.storage.local.get(HL_CONFIG_KEY, result => {
      if (noteRuntimeLastError("配置读取失败")) {
        if (callback) callback({ ...DEFAULT_CONFIG });
        return;
      }
      const stored = result[HL_CONFIG_KEY];
      const config = {
        ...DEFAULT_CONFIG,
        ...(stored && typeof stored === "object" ? stored : {})
      };
      if (callback) callback(config);
    });
  } catch (e) {
    console.log("[Highlight] getConfig 出错:", e);
    if (callback) callback({ ...DEFAULT_CONFIG });
  }
}

function setConfig(partial, callback) {
  try {
    if (!isExtensionValid()) {
      const next = { ...currentConfig, ...partial };
      currentConfig = next;
      applyReadingModeClass(!!next.readingModeEnabled);
      if (callback) callback(next);
      return;
    }

    getConfig(current => {
      const next = { ...current, ...partial };
      chrome.storage.local.set({ [HL_CONFIG_KEY]: next }, () => {
        if (noteRuntimeLastError("配置保存失败")) {
          return;
        }
        if (callback) callback(next);
      });
    });
  } catch (e) {
    console.log("[Highlight] setConfig 出错:", e);
  }
}

function getPageHighlights(callback) {
  try {
    const key = getPageHighlightsKey(location.href);
    if (!isExtensionValid()) {
      if (callback) {
        callback(key, { version: "1.0", highlights: [] });
      }
      return;
    }

    chrome.storage.local.get(key, result => {
      if (noteRuntimeLastError("存储读取失败")) {
        if (callback) {
          callback(key, { version: "1.0", highlights: [] });
        }
        return;
      }
      const record = result[key] || { version: "1.0", highlights: [] };
      if (callback) callback(key, record);
    });
  } catch (e) {
    console.log("[Highlight] getPageHighlights 出错:", e);
    if (callback) {
      callback(getPageHighlightsKey(location.href), { version: "1.0", highlights: [] });
    }
  }
}

function savePageHighlights(key, record, callback) {
  try {
    if (!isExtensionValid()) {
      if (callback) callback();
      return;
    }

    chrome.storage.local.set({ [key]: record }, () => {
      if (noteRuntimeLastError("存储保存失败")) {
        return;
      }
      if (callback) callback();
    });
  } catch (e) {
    console.log("[Highlight] savePageHighlights 出错:", e);
  }
}

// ------- 精读模式 -------

let readingModeMutationObserver = null;
let readingDimDebounceTimer = null;

function clearReadingModeDimming() {
  document.querySelectorAll(".hl-ext-reading-dim").forEach(el => {
    el.classList.remove("hl-ext-reading-dim");
  });
}

/** 高亮元素自身、其内部节点、以及从根到高亮的祖先链都不压暗 */
function buildReadingModeProtectedSet() {
  const protect = new Set();
  document.querySelectorAll("mark.hl-ext-mark").forEach(mark => {
    if (mark.closest(`#${HL_EXT_PANEL_SHELL_ID}`)) return;
    for (let n = mark; n && n.nodeType === Node.ELEMENT_NODE; n = n.parentElement) {
      protect.add(n);
    }
    mark.querySelectorAll("*").forEach(child => protect.add(child));
  });
  return protect;
}

/**
 * 只对「无元素子节点」的节点压暗，且不在保护集内，避免祖先 opacity 叠乘导致高亮发灰。
 */
function updateReadingModeDimming() {
  if (!document.documentElement.classList.contains("hl-ext-reading-mode-on")) {
    return;
  }
  if (!document.body) {
    return;
  }

  clearReadingModeDimming();
  const protect = buildReadingModeProtectedSet();

  const all = document.body.querySelectorAll("*");
  all.forEach(node => {
    if (node.closest && node.closest(`#${HL_EXT_PANEL_SHELL_ID}`)) return;
    if (protect.has(node)) return;
    if (node.children.length > 0) return;
    if (node.matches("script, style, link, meta, noscript, template")) return;
    node.classList.add("hl-ext-reading-dim");
  });
}

function scheduleReadingModeDimmingUpdate() {
  if (!document.documentElement.classList.contains("hl-ext-reading-mode-on")) {
    return;
  }
  if (readingDimDebounceTimer) {
    clearTimeout(readingDimDebounceTimer);
  }
  readingDimDebounceTimer = setTimeout(() => {
    readingDimDebounceTimer = null;
    requestAnimationFrame(updateReadingModeDimming);
  }, 150);
}

function teardownReadingModeDimming() {
  if (readingDimDebounceTimer) {
    clearTimeout(readingDimDebounceTimer);
    readingDimDebounceTimer = null;
  }
  clearReadingModeDimming();
  if (readingModeMutationObserver) {
    readingModeMutationObserver.disconnect();
    readingModeMutationObserver = null;
  }
}

function setupReadingModeMutationObserver() {
  if (readingModeMutationObserver || !document.body) {
    return;
  }
  readingModeMutationObserver = new MutationObserver(() => {
    scheduleReadingModeDimmingUpdate();
  });
  readingModeMutationObserver.observe(document.body, {
    childList: true,
    subtree: true
  });
}

function applyReadingModeClass(enabled) {
  document.documentElement.classList.toggle("hl-ext-reading-mode-on", enabled);
  if (!enabled) {
    teardownReadingModeDimming();
    return;
  }
  scheduleReadingModeDimmingUpdate();
  setupReadingModeMutationObserver();
}

function initReadingMode() {
  if (!isExtensionValid()) {
    return;
  }

  getConfig(config => {
    if (!isExtensionValid()) {
      return;
    }
    currentConfig = config;
    applyReadingModeClass(!!config.readingModeEnabled);
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (!isExtensionValid()) {
      return;
    }
    if (areaName !== "local") return;
    if (changes[HL_CONFIG_KEY]) {
      const newConfig = changes[HL_CONFIG_KEY].newValue;
      if (newConfig) {
        currentConfig = newConfig;
        applyReadingModeClass(!!newConfig.readingModeEnabled);
      }
    }
  });
}

// ------- 高亮列表面板（可拖动、可折叠） -------

const HL_PANEL_STORAGE_KEY = "highlightsPanel:v1";

let highlightsPanelElements = null;
let highlightsPanelDrag = null;
let highlightsPanelRefreshTimer = null;
let highlightsPanelObserver = null;

function getDefaultPanelState() {
  return { open: true, collapsed: false, x: null, y: null };
}

function readPanelState(callback) {
  if (!isExtensionValid()) {
    callback(getDefaultPanelState());
    return;
  }
  chrome.storage.local.get(HL_PANEL_STORAGE_KEY, result => {
    if (noteRuntimeLastError("高亮面板状态读取")) {
      callback(getDefaultPanelState());
      return;
    }
    callback(result[HL_PANEL_STORAGE_KEY] || getDefaultPanelState());
  });
}

function mergeSavePanelState(partial) {
  if (!isExtensionValid()) return;
  chrome.storage.local.get(HL_PANEL_STORAGE_KEY, result => {
    if (noteRuntimeLastError("高亮面板状态预读")) return;
    const cur = result[HL_PANEL_STORAGE_KEY] || getDefaultPanelState();
    const next = { ...cur, ...partial };
    chrome.storage.local.set({ [HL_PANEL_STORAGE_KEY]: next }, () => {
      void noteRuntimeLastError("高亮面板状态保存");
    });
  });
}

function ensureHighlightsPanelDom() {
  if (highlightsPanelElements) return highlightsPanelElements;
  if (!document.body) return null;

  const shell = document.createElement("div");
  shell.className = "hl-ext-highlight-shell";
  shell.id = "hl-ext-highlight-shell";

  const panel = document.createElement("div");
  panel.className = "hl-ext-highlight-panel";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "本页高亮列表");

  const header = document.createElement("div");
  header.className = "hl-ext-highlight-panel__header";

  const headerBrand = document.createElement("div");
  headerBrand.className = "hl-ext-highlight-panel__header-brand";
  headerBrand.setAttribute("aria-hidden", "true");
  headerBrand.innerHTML =
    '<svg class="hl-ext-highlight-panel__header-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
    '<rect x="2" y="6" width="20" height="5" rx="1.5" fill="currentColor" opacity="0.3"/>' +
    '<rect x="2" y="12" width="15" height="6" rx="1.5" fill="currentColor"/>' +
    "</svg>";

  const headerMain = document.createElement("div");
  headerMain.className = "hl-ext-highlight-panel__header-main";

  const title = document.createElement("h2");
  title.className = "hl-ext-highlight-panel__title";
  title.textContent = "本页高亮";

  const subtitle = document.createElement("p");
  subtitle.className = "hl-ext-highlight-panel__subtitle";
  subtitle.textContent = "点击条目可定位到页面高亮";

  headerMain.append(title, subtitle);

  const countEl = document.createElement("span");
  countEl.className = "hl-ext-highlight-panel__count";
  countEl.textContent = "0";

  const collapseBtn = document.createElement("button");
  collapseBtn.type = "button";
  collapseBtn.className = "hl-ext-highlight-panel__btn";
  collapseBtn.setAttribute("aria-expanded", "true");
  collapseBtn.setAttribute("aria-label", "折叠或展开列表");
  const collapseIcon = document.createElement("span");
  collapseIcon.className = "hl-ext-highlight-panel__collapse-icon";
  collapseIcon.innerHTML =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" width="18" height="18" aria-hidden="true">' +
    '<path fill-rule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" clip-rule="evenodd"/>' +
    "</svg>";
  collapseBtn.appendChild(collapseIcon);

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "hl-ext-highlight-panel__btn hl-ext-highlight-panel__btn--close";
  closeBtn.setAttribute("aria-label", "隐藏面板");
  closeBtn.innerHTML =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" width="16" height="16" aria-hidden="true">' +
    '<path fill-rule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clip-rule="evenodd"/>' +
    "</svg>";

  const headerActions = document.createElement("div");
  headerActions.className = "hl-ext-highlight-panel__header-actions";
  headerActions.append(countEl, collapseBtn, closeBtn);

  header.append(headerBrand, headerMain, headerActions);

  const body = document.createElement("div");
  body.className = "hl-ext-highlight-panel__body";

  const list = document.createElement("ul");
  list.className = "hl-ext-highlight-panel__list";

  const empty = document.createElement("p");
  empty.className = "hl-ext-highlight-panel__empty";
  empty.textContent = "暂无高亮，在页面划选文本即可添加。";

  body.append(list, empty);
  panel.append(header, body);

  const reopen = document.createElement("button");
  reopen.type = "button";
  reopen.className = "hl-ext-highlight-reopen";
  reopen.textContent = "高亮";

  shell.append(panel, reopen);
  document.body.appendChild(shell);

  highlightsPanelElements = {
    shell,
    panel,
    header,
    countEl,
    collapseBtn,
    closeBtn,
    reopen,
    body,
    list,
    empty
  };

  bindHighlightsPanelEvents();
  return highlightsPanelElements;
}

function bindHighlightsPanelDragEnd(e) {
  const els = highlightsPanelElements;
  if (!els || !highlightsPanelDrag) return;
  if (e && e.pointerId !== highlightsPanelDrag.pointerId) return;
  const pid = highlightsPanelDrag.pointerId;
  highlightsPanelDrag = null;
  els.header.style.cursor = "";
  try {
    els.header.releasePointerCapture(pid);
  } catch (_) {
    /* ignore */
  }
  const rect = els.panel.getBoundingClientRect();
  mergeSavePanelState({
    x: Math.round(rect.left),
    y: Math.round(rect.top)
  });
}

function bindHighlightsPanelEvents() {
  const els = highlightsPanelElements;
  if (!els) return;

  els.collapseBtn.addEventListener("click", e => {
    e.stopPropagation();
    const collapsed = els.panel.classList.toggle("hl-ext-highlight-panel--collapsed");
    els.collapseBtn.setAttribute("aria-expanded", collapsed ? "false" : "true");
    mergeSavePanelState({ collapsed });
  });

  els.closeBtn.addEventListener("click", e => {
    e.stopPropagation();
    els.shell.classList.add("hl-ext-highlight-shell--panel-hidden");
    mergeSavePanelState({ open: false });
    scheduleHighlightsPanelRefresh();
  });

  els.reopen.addEventListener("click", () => {
    els.shell.classList.remove("hl-ext-highlight-shell--panel-hidden");
    mergeSavePanelState({ open: true });
  });

  els.header.addEventListener("pointerdown", e => {
    if (e.button !== 0 || e.target.closest("button")) return;
    e.preventDefault();
    const rect = els.panel.getBoundingClientRect();
    highlightsPanelDrag = {
      pointerId: e.pointerId,
      ox: e.clientX - rect.left,
      oy: e.clientY - rect.top,
      w: rect.width,
      h: rect.height
    };
    try {
      els.header.setPointerCapture(e.pointerId);
    } catch (_) {
      /* ignore */
    }
    els.header.style.cursor = "grabbing";
  });

  els.header.addEventListener("pointermove", e => {
    if (!highlightsPanelDrag || highlightsPanelDrag.pointerId !== e.pointerId) return;
    e.preventDefault();
    let left = e.clientX - highlightsPanelDrag.ox;
    let top = e.clientY - highlightsPanelDrag.oy;
    const margin = 8;
    const maxL = window.innerWidth - highlightsPanelDrag.w - margin;
    const maxT = window.innerHeight - highlightsPanelDrag.h - margin;
    left = Math.min(Math.max(margin, left), maxL);
    top = Math.min(Math.max(margin, top), maxT);
    Object.assign(els.panel.style, {
      left: `${left}px`,
      top: `${top}px`,
      right: "auto",
      bottom: "auto"
    });
  });

  els.header.addEventListener("pointerup", bindHighlightsPanelDragEnd);
  els.header.addEventListener("pointercancel", bindHighlightsPanelDragEnd);
  els.header.addEventListener("lostpointercapture", () => {
    if (highlightsPanelDrag) bindHighlightsPanelDragEnd();
  });
}

function applyHighlightsPanelState(state) {
  const els = highlightsPanelElements;
  if (!els) return;

  if (state.open === false) {
    els.shell.classList.add("hl-ext-highlight-shell--panel-hidden");
  } else {
    els.shell.classList.remove("hl-ext-highlight-shell--panel-hidden");
  }

  if (state.collapsed) {
    els.panel.classList.add("hl-ext-highlight-panel--collapsed");
    els.collapseBtn.setAttribute("aria-expanded", "false");
  } else {
    els.panel.classList.remove("hl-ext-highlight-panel--collapsed");
    els.collapseBtn.setAttribute("aria-expanded", "true");
  }

  if (typeof state.x === "number" && typeof state.y === "number") {
    els.panel.style.left = `${state.x}px`;
    els.panel.style.top = `${state.y}px`;
    els.panel.style.right = "auto";
    els.panel.style.bottom = "auto";
  }
}

function scrollToHighlightById(id) {
  const safeId = typeof id === "string" ? id.trim() : "";
  if (!safeId) return;
  const marks = document.querySelectorAll(
    `mark.hl-ext-mark[data-highlight-id="${CSS.escape(safeId)}"]`
  );
  if (!marks.length) return;
  marks[0].scrollIntoView({ behavior: "smooth", block: "center" });
  marks.forEach(m => {
    m.classList.remove("hl-ext-highlight-flash-pulse");
    void m.offsetWidth;
    m.classList.add("hl-ext-highlight-flash-pulse");
    setTimeout(() => m.classList.remove("hl-ext-highlight-flash-pulse"), 800);
  });
}

function refreshHighlightsPanelList() {
  const els = highlightsPanelElements;
  if (!els) return;

  const map = new Map();
  document.querySelectorAll("mark.hl-ext-mark").forEach(mark => {
    if (mark.closest(`#${HL_EXT_PANEL_SHELL_ID}`)) return;
    const rawId = (mark.dataset.highlightId || "").trim();
    const key = rawId || "__noid__";
    if (!map.has(key)) {
      const colorKey = normalizeHighlightColorKey(mark.dataset.hlColor);
      map.set(key, { id: rawId, parts: [], colorKey });
    }
    const t = (mark.textContent || "").trim();
    if (t) map.get(key).parts.push(t);
  });

  els.list.replaceChildren();
  let n = 0;
  map.forEach(({ id, parts, colorKey }) => {
    n += 1;
    const full = parts.join(" ").trim() || "（空）";
    const li = document.createElement("li");
    li.className = "hl-ext-highlight-panel__item";
    li.setAttribute("data-hl-color", colorKey || "yellow");
    li.textContent = full.length > 280 ? `${full.slice(0, 280)}…` : full;
    if (id) {
      li.dataset.highlightId = id;
    }
    li.addEventListener("click", () => {
      if (id) scrollToHighlightById(id);
    });
    els.list.appendChild(li);
  });

  els.countEl.textContent = String(n);
  els.empty.style.display = n === 0 ? "block" : "none";
  els.reopen.textContent = n > 0 ? `高亮 · ${n}` : "高亮";
}

function scheduleHighlightsPanelRefresh() {
  if (highlightsPanelRefreshTimer) {
    clearTimeout(highlightsPanelRefreshTimer);
  }
  highlightsPanelRefreshTimer = setTimeout(() => {
    highlightsPanelRefreshTimer = null;
    refreshHighlightsPanelList();
  }, 80);
}

function highlightPanelMutationsAreExternal(mutations) {
  const shell = document.getElementById("hl-ext-highlight-shell");
  if (!shell) return true;
  for (const m of mutations) {
    const t = m.target;
    if (t instanceof Node && !shell.contains(t)) return true;
  }
  return false;
}

function setupHighlightsPanelObserver() {
  if (highlightsPanelObserver || !document.body) return;
  highlightsPanelObserver = new MutationObserver(mutations => {
    if (!highlightPanelMutationsAreExternal(mutations)) return;
    scheduleHighlightsPanelRefresh();
  });
  highlightsPanelObserver.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true
  });
}

function initHighlightsPanel() {
  const els = ensureHighlightsPanelDom();
  if (!els) return;

  readPanelState(state => {
    applyHighlightsPanelState(state);
    refreshHighlightsPanelList();
  });

  setupHighlightsPanelObserver();
  scheduleHighlightsPanelRefresh();
}

/** 打开高亮列表面板（扩展弹窗或外部消息可调用） */
function showHighlightsPanel() {
  ensureHighlightsPanelDom();
  const els = highlightsPanelElements;
  if (!els) return;
  els.shell.classList.remove("hl-ext-highlight-shell--panel-hidden");
  mergeSavePanelState({ open: true });
  scheduleHighlightsPanelRefresh();
}

// ------- 高亮持久化 -------

function buildHighlightFromSelection(selection) {
  const text = selection.toString().trim();
  if (!text) return null;

  const range = selection.getRangeAt(0).cloneRange();

  // 简单的 TextQuoteAnchor，仅记录 exact 文本以及前后少量上下文
  let prefix = "";
  let suffix = "";
  try {
    const startContainer = range.startContainer;
    if (startContainer && startContainer.nodeType === Node.TEXT_NODE) {
      const fullText = startContainer.nodeValue || "";
      const startOffset = range.startOffset;
      const endOffset = range.endOffset;
      prefix = fullText.slice(Math.max(0, startOffset - 20), startOffset);
      suffix = fullText.slice(endOffset, endOffset + 20);
    }
  } catch (e) {
    // 失败时可忽略，上下文只是辅助信息
  }

  return {
    id: createUuid(),
    version: "1.0",
    createdAt: nowIso(),
    updatedAt: nowIso(),
    text,
    color: normalizeHighlightColorKey(currentConfig.highlightColor),
    context: {},
    anchor: {
      type: "TextQuoteAnchor",
      prefix,
      exact: text,
      suffix
    }
  };
}

function handleSelectionHighlight() {
  try {
    // 首先检查扩展上下文是否有效
    if (!isExtensionValid()) {
      return;
    }

    console.log("[Highlight] handleSelectionHighlight 被调用");
    
    if (!currentConfig.highlightEnabled) {
      console.log("[Highlight] 高亮功能未启用");
      return;
    }
    
    const selection = window.getSelection();
    if (!selection) {
      console.log("[Highlight] 没有 selection 对象");
      return;
    }
    if (selection.isCollapsed) {
      console.log("[Highlight] selection 已折叠（没有选中文本）");
      return;
    }
    if (selection.rangeCount === 0) {
      console.log("[Highlight] 没有 range");
      return;
    }

    const range = selection.getRangeAt(0);
    if (!range || range.collapsed) {
      console.log("[Highlight] range 无效或已折叠");
      return;
    }

    // 最终检查：在创建高亮前再检查一次是否有交集
    if (rangeContainsExistingHighlight(range)) {
      console.log("[Highlight] 选区内已包含高亮，跳过");
      return;
    }

    if (isSelectionAnchoredInHighlightPanel(selection)) {
      console.log("[Highlight] 选区在高亮列表面板内，跳过");
      return;
    }

    const highlight = buildHighlightFromSelection(selection);
    if (!highlight) {
      console.log("[Highlight] 无法构建 highlight 对象");
      return;
    }

    console.log("[Highlight] 创建高亮:", highlight.text);

    // 先在页面上渲染高亮
    wrapRangeWithMark(range, highlight.id, highlight.color);
    selection.removeAllRanges();

    // 再持久化存储
    getPageHighlights((key, record) => {
      record.highlights.push(highlight);
      savePageHighlights(key, record, () => {
        scheduleHighlightsPanelRefresh();
      });
      console.log("[Highlight] 高亮已保存");
    });
  } catch (e) {
    console.log("[Highlight] handleSelectionHighlight 出错:", e);
  }
}

function initSelectionListener() {
  console.log("[Highlight] 开始监听文本选择...");
  
  // 简单 MVP：鼠标抬起时直接高亮当前选区
  // 真实产品可改为弹出工具条后点击按钮再高亮
  document.addEventListener("mouseup", event => {
    console.log("[Highlight] mouseup 事件触发");
    
    // 避免在用户点击链接、按钮等交互元素时误触
    const target = event.target;
    if (target instanceof HTMLElement) {
      if (target.closest(`#${HL_EXT_PANEL_SHELL_ID}`)) {
        return;
      }
      const clickable = target.closest("a, button, input, textarea, select");
      if (clickable) {
        console.log("[Highlight] 点击了交互元素，跳过");
        return;
      }
    }

    // 稍作延迟，确保选区已稳定
    setTimeout(() => {
      handleSelectionHighlight();
    }, 50);
  });
  
  // 也监听 selectionchange 事件作为备选
  document.addEventListener("selectionchange", () => {
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed && selection.toString().trim().length > 0) {
      console.log("[Highlight] 检测到文本选区:", selection.toString().substring(0, 50) + "...");
    }
  });
}

// ------- 高亮恢复 -------

function restoreHighlights() {
  if (!isExtensionValid()) {
    return;
  }

  console.log("[Highlight] 开始恢复高亮...");
  
  const restore = () => {
    if (!isExtensionValid()) {
      return;
    }

    getPageHighlights((key, record) => {
      const list = record.highlights || [];
      console.log(`[Highlight] 找到 ${list.length} 条历史高亮`);
      
      let delay = 0;
      list.forEach((h, index) => {
        setTimeout(() => {
          const text = (h.anchor && h.anchor.exact) || h.text;
          applyHighlightByText(text, h.id, h.color);
        }, delay);
        delay += 100;
      });
    });
  };
  
  setTimeout(restore, 500);
  setTimeout(restore, 1500);
  setTimeout(restore, 3000);
}

// ------- 消息监听 (用于 Popup 控制精读模式) -------

function registerMessageHandlers() {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!isExtensionValid()) {
      return false;
    }

    if (!message || typeof message !== "object") return;

    if (message.type === "SET_CONFIG") {
      const newConfig = message.config;
      setConfig(newConfig, updatedConfig => {
        currentConfig = updatedConfig;
        applyReadingModeClass(!!updatedConfig.readingModeEnabled);
        sendResponse && sendResponse({ ok: true, config: updatedConfig });
      });
      return true;
    }

    if (message.type === "SET_READING_MODE") {
      const enabled = !!message.enabled;
      setConfig({ readingModeEnabled: enabled }, newConfig => {
        currentConfig = newConfig;
        applyReadingModeClass(enabled);
        sendResponse && sendResponse({ ok: true, config: newConfig });
      });
      return true;
    }

    if (message.type === "OPEN_HIGHLIGHTS_PANEL") {
      showHighlightsPanel();
      sendResponse({ ok: true });
      return false;
    }
  });
}

function isDoubaoHost() {
  try {
    const h = window.location.hostname || "";
    return h === "doubao.com" || h.endsWith(".doubao.com");
  } catch (_) {
    return false;
  }
}

/**
 * 豆包对话区常在子域 iframe（如 pc.doubao.com）；仅顶层 matches 时脚本进不去 iframe。
 * manifest 对豆包使用 all_frames:true 后，顶层壳页与 iframe 都会注入：此处跳过「含豆包子域 iframe 的顶层」，
 * 避免双面板、sendMessage 多帧抢答；纯顶层 SPA（无此类 iframe）仍正常执行。
 */
function shouldRunHighlightInThisFrame() {
  try {
    if (!isDoubaoHost()) return true;
    if (window.self !== window.top) return true;
    const frames = document.querySelectorAll("iframe[src]");
    for (let i = 0; i < frames.length; i++) {
      try {
        const u = new URL(frames[i].src, location.href);
        const host = u.hostname || "";
        if (host === "doubao.com" || host.endsWith(".doubao.com")) {
          return false;
        }
      } catch (_) {
        /* ignore */
      }
    }
    return true;
  } catch (_) {
    return true;
  }
}

// ------- 初始化 -------

function init() {
  initReadingMode();
  initHighlightsPanel();
  restoreHighlights();
  initSelectionListener();
}

function bootHighlightExtension() {
  if (!shouldRunHighlightInThisFrame()) {
    return;
  }
  registerMessageHandlers();
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
}

bootHighlightExtension();

