// Highlight 插件 MVP 版本内容脚本
// 负责：
// 1. 监听用户选区并用 <mark> 包裹高亮
// 2. 将高亮信息持久化到 chrome.storage.local
// 3. 在页面加载时恢复历史高亮
// 4. 响应精读模式开关，控制页面展示样式
// import { getCurrentConfig } from "./popup.js";

const HL_CONFIG_KEY = "config:v1";

// 标记扩展上下文是否有效
let extensionContextValid = true;

// 检查扩展上下文是否有效
function checkExtensionContext() {
  try {
    // 尝试访问 chrome.runtime，如果失败说明上下文已失效
    if (!chrome || !chrome.runtime) {
      extensionContextValid = false;
      return false;
    }
    // 尝试一个简单的 API 调用
    chrome.runtime.getManifest();
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

let currentConfig = {
  highlightEnabled: true,
  readingModeEnabled: false
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

function createUuid() {
  // 简单 UUID v4 实现，足够满足本地唯一性需求
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
    const r = (crypto.getRandomValues(new Uint8Array(1))[0] & 0xf) >> 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
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
    const allMarks = document.querySelectorAll('mark.hl-ext-mark');
    
    for (const mark of allMarks) {
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
function wrapRangeWithMark(range, highlightId) {
  const mark = document.createElement("mark");
  mark.className = "hl-ext-mark";
  // 特性 属性
  mark.dataset.highlightId = highlightId;
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
    nodeMark.setAttribute("role", mark.getAttribute("role"));
    nodeMark.setAttribute("aria-label", mark.getAttribute("aria-label"));

    // 如果 wrapTextNode 返回 null（只选中了空白），就不处理
    wrapTextNode(textNode, nodeStart, nodeEnd, nodeMark);
  });

  return mark;
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
  const marks = document.querySelectorAll('mark.hl-ext-mark');
  for (const mark of marks) {
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
function applyHighlightByText(text, highlightId) {
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
        if (parent && parent.closest('mark.hl-ext-mark')) {
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
  wrapRangeWithMark(range, highlightId);
}

// ------- 存储操作 (直接使用 chrome.storage.local) -------

function getConfig(callback) {
  try {
    if (!isExtensionValid()) {
      return;
    }

    chrome.storage.local.get(HL_CONFIG_KEY, result => {
      if (chrome.runtime.lastError) {
        console.log("[Highlight] 配置读取失败:", chrome.runtime.lastError);
        return;
      }
      const config = result[HL_CONFIG_KEY] || {
        theme: "default",
        highlightEnabled: true,
        readingModeEnabled: false
      };
      callback(config);
    });
  } catch (e) {
    console.log("[Highlight] getConfig 出错:", e);
  }
}

function setConfig(partial, callback) {
  try {
    if (!isExtensionValid()) {
      return;
    }

    getConfig(current => {
      const next = { ...current, ...partial };
      chrome.storage.local.set({ [HL_CONFIG_KEY]: next }, () => {
        if (chrome.runtime.lastError) {
          console.log("[Highlight] 配置保存失败:", chrome.runtime.lastError);
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
    if (!isExtensionValid()) {
      return;
    }

    const key = getPageHighlightsKey(location.href);
    chrome.storage.local.get(key, result => {
      if (chrome.runtime.lastError) {
        console.log("[Highlight] 存储读取失败:", chrome.runtime.lastError);
        return;
      }
      const record = result[key] || { version: "1.0", highlights: [] };
      callback(key, record);
    });
  } catch (e) {
    console.log("[Highlight] getPageHighlights 出错:", e);
  }
}

function savePageHighlights(key, record, callback) {
  try {
    if (!isExtensionValid()) {
      return;
    }

    chrome.storage.local.set({ [key]: record }, () => {
      if (chrome.runtime.lastError) {
        console.log("[Highlight] 存储保存失败:", chrome.runtime.lastError);
        return;
      }
      if (callback) callback();
    });
  } catch (e) {
    console.log("[Highlight] savePageHighlights 出错:", e);
  }
}

// ------- 精读模式 -------

function applyReadingModeClass(enabled) {
  document.documentElement.classList.toggle("hl-ext-reading-mode-on", enabled);
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

    const highlight = buildHighlightFromSelection(selection);
    if (!highlight) {
      console.log("[Highlight] 无法构建 highlight 对象");
      return;
    }

    console.log("[Highlight] 创建高亮:", highlight.text);

    // 先在页面上渲染高亮
    wrapRangeWithMark(range, highlight.id);
    selection.removeAllRanges();

    // 再持久化存储
    getPageHighlights((key, record) => {
      record.highlights.push(highlight);
      savePageHighlights(key, record);
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
          applyHighlightByText(text, h.id);
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

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // 检查扩展上下文是否有效
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
    // 表示 sendResponse 将在异步调用后执行
    return true;
  }

  if (message.type === "SET_READING_MODE") {
    const enabled = !!message.enabled;
    setConfig({ readingModeEnabled: enabled }, newConfig => {
      currentConfig = newConfig;
      applyReadingModeClass(enabled);
      sendResponse && sendResponse({ ok: true, config: newConfig });
    });
    // 表示 sendResponse 将在异步调用后执行
    return true;
  }
});

// ------- 初始化 -------

function init() {
  initReadingMode();
  restoreHighlights();
  initSelectionListener();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}

