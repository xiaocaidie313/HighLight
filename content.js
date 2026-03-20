// Highlight 插件 MVP 版本内容脚本
// 负责：
// 1. 监听用户选区并用 <mark> 包裹高亮
// 2. 将高亮信息持久化到 chrome.storage.local
// 3. 在页面加载时恢复历史高亮
// 4. 响应精读模式开关，控制页面展示样式

const HL_CONFIG_KEY = "config:v1";

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
 */
function rangeContainsExistingHighlight(range) {
  try {
    const ancestor = range.commonAncestorContainer;
    const parent = ancestor.nodeType === Node.TEXT_NODE ? ancestor.parentElement : ancestor;
    
    if (!parent) return false;
    
    const marksInRange = parent.querySelectorAll('mark.hl-ext-mark');
    for (const mark of marksInRange) {
      const markRange = document.createRange();
      markRange.selectNodeContents(mark);
      
      if (range.isPointInRange(mark, 0) || range.intersectsNode(mark)) {
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
 * 在给定的 Range 周围创建 <mark> 元素。
 * 首先尝试使用 surroundContents，如果失败则使用更安全的方法。
 */
function wrapRangeWithMark(range, highlightId) {
  const mark = document.createElement("mark");
  mark.className = "hl-ext-mark";
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
 */
function safeWrapRange(range, mark) {
  const startContainer = range.startContainer;
  const endContainer = range.endContainer;
  const startOffset = range.startOffset;
  const endOffset = range.endOffset;

  if (startContainer === endContainer && startContainer.nodeType === Node.TEXT_NODE) {
    const textNode = startContainer;
    const text = textNode.nodeValue;
    
    const beforeText = text.substring(0, startOffset);
    const middleText = text.substring(startOffset, endOffset);
    const afterText = text.substring(endOffset);
    
    const beforeNode = document.createTextNode(beforeText);
    const afterNode = document.createTextNode(afterText);
    
    mark.textContent = middleText;
    
    const parent = textNode.parentNode;
    parent.insertBefore(beforeNode, textNode);
    parent.insertBefore(mark, textNode);
    parent.insertBefore(afterNode, textNode);
    parent.removeChild(textNode);
    
    return mark;
  }

  const fragment = range.cloneContents();
  range.deleteContents();
  mark.appendChild(fragment);
  range.insertNode(mark);
  
  return mark;
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
  chrome.storage.local.get(HL_CONFIG_KEY, result => {
    const config = result[HL_CONFIG_KEY] || {
      theme: "default",
      highlightEnabled: true,
      readingModeEnabled: false
    };
    callback(config);
  });
}

function setConfig(partial, callback) {
  getConfig(current => {
    const next = { ...current, ...partial };
    chrome.storage.local.set({ [HL_CONFIG_KEY]: next }, () => {
      if (callback) callback(next);
    });
  });
}

function getPageHighlights(callback) {
  const key = getPageHighlightsKey(location.href);
  chrome.storage.local.get(key, result => {
    const record = result[key] || { version: "1.0", highlights: [] };
    callback(key, record);
  });
}

function savePageHighlights(key, record, callback) {
  chrome.storage.local.set({ [key]: record }, () => {
    if (callback) callback();
  });
}

// ------- 精读模式 -------

function applyReadingModeClass(enabled) {
  document.documentElement.classList.toggle("hl-ext-reading-mode-on", enabled);
}

function initReadingMode() {
  getConfig(config => {
    currentConfig = config;
    applyReadingModeClass(!!config.readingModeEnabled);
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
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
  console.log("[Highlight] 开始恢复高亮...");
  
  const restore = () => {
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

