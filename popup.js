// Popup 脚本：控制精读模式开关

const HL_CONFIG_KEY_POPUP = "config:v1";
const HL_HIGHLIGHT_KEY_PREFIX = "highlights:";

const HL_POPUP_DEFAULT_CONFIG = {
  theme: "default",
  highlightEnabled: true,
  readingModeEnabled: false,
  highlightColor: "yellow"
};

function getConfigPopup(callback) {
  chrome.storage.local.get(HL_CONFIG_KEY_POPUP, result => {
    if (chrome.runtime.lastError) {
      console.warn("[Highlight popup] 读取配置失败:", chrome.runtime.lastError.message);
      if (callback) {
        callback({ ...HL_POPUP_DEFAULT_CONFIG });
      }
      return;
    }
    const stored = result[HL_CONFIG_KEY_POPUP];
    const config = {
      ...HL_POPUP_DEFAULT_CONFIG,
      ...(stored && typeof stored === "object" ? stored : {})
    };
    if (callback) callback(config);
  });
}

function setConfigPopup(partial, callback) {
  getConfigPopup(res => {
    const newConfig = { ...res, ...partial };
    chrome.storage.local.set({ [HL_CONFIG_KEY_POPUP]: newConfig }, () => {
      if (chrome.runtime.lastError) {
        console.warn("[Highlight popup] 保存配置失败:", chrome.runtime.lastError.message);
        return;
      }
      if (callback) callback(newConfig);
    });
  });
}

// 注入配置到当前标签页
/** 与 content 内 getPageHighlightsKey 一致：去 hash */
function normalizeUrlForStorage(url) {
  try {
    const u = new URL(url);
    u.hash = "";
    return u.toString();
  } catch (e) {
    return url;
  }
}

function pageHighlightsStorageKey(tabUrl) {
  return HL_HIGHLIGHT_KEY_PREFIX + normalizeUrlForStorage(tabUrl);
}

function isoStampForFilename() {
  return new Date().toISOString().slice(0, 19).replace(/:/g, "-");
}

function slugFromUrl(url) {
  try {
    const u = new URL(url);
    const base = (u.hostname + u.pathname).replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
    return (base.slice(0, 48) || "page").replace(/_+$/, "");
  } catch (e) {
    return "page";
  }
}

function setExportHint(message, kind) {
  const hint = document.getElementById("export-hint");
  if (!hint) return;
  hint.classList.remove("hl-ext-popup__hint--ok", "hl-ext-popup__hint--err");
  hint.textContent = message || "";
  if (kind === "ok") hint.classList.add("hl-ext-popup__hint--ok");
  if (kind === "err") hint.classList.add("hl-ext-popup__hint--err");
}

function downloadJson(filename, data) {
  const json = JSON.stringify(data, null, 2);
  const blob = new Blob([json], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function exportCurrentPageHighlights() {
  chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
    const tab = tabs && tabs[0];
    if (!tab || tab.id == null) {
      setExportHint("没有可用的当前标签页。", "err");
      return;
    }
    const tabUrl = tab.url || "";
    if (!/^https?:/i.test(tabUrl)) {
      setExportHint("当前页不是 http(s) 网页，无法按 URL 导出高亮。", "err");
      return;
    }

    const key = pageHighlightsStorageKey(tabUrl);
    chrome.storage.local.get(key, result => {
      if (chrome.runtime.lastError) {
        setExportHint("读取存储失败：" + chrome.runtime.lastError.message, "err");
        return;
      }
      const record = result[key] || { version: "1.0", highlights: [] };
      const n = (record.highlights && record.highlights.length) || 0;
      const payload = {
        format: "highlight-page-v1",
        exportedAt: new Date().toISOString(),
        pageUrl: tabUrl,
        storageKey: key,
        record
      };
      const name = `highlight-page_${slugFromUrl(tabUrl)}_${isoStampForFilename()}.json`;
      downloadJson(name, payload);
      setExportHint(`已下载 JSON（当前页 ${n} 条高亮）。`, "ok");
    });
  });
}

function exportAllHighlights() {
  chrome.storage.local.get(null, items => {
    if (chrome.runtime.lastError) {
      setExportHint("读取存储失败：" + chrome.runtime.lastError.message, "err");
      return;
    }
    const pages = {};
    let total = 0;
    for (const k of Object.keys(items || {})) {
      if (k.startsWith(HL_HIGHLIGHT_KEY_PREFIX)) {
        pages[k] = items[k];
        const arr = items[k] && items[k].highlights;
        total += Array.isArray(arr) ? arr.length : 0;
      }
    }
    const payload = {
      format: "highlight-backup-v1",
      exportedAt: new Date().toISOString(),
      app: "Highlight (MV3)",
      config: items[HL_CONFIG_KEY_POPUP] || null,
      pages
    };
    const pageCount = Object.keys(pages).length;
    const name = `highlight-backup_${isoStampForFilename()}.json`;
    downloadJson(name, payload);
    setExportHint(`已下载 JSON（${pageCount} 个页面，共 ${total} 条高亮）。`, "ok");
  });
}

function sendConfigToActiveTab(config) {
  chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
    const tab = tabs && tabs[0];
    if (!tab || tab.id == null) return;

    chrome.tabs.sendMessage(
      tab.id,
      { type: "SET_CONFIG", config },
      () => {
        // 忽略错误：目标标签页可能没有注入 content script
        void chrome.runtime.lastError;
      }
    );
  });
}

function resetOpenPanelHint(hint) {
  if (!hint) return;
  hint.classList.remove("hl-ext-popup__hint--ok", "hl-ext-popup__hint--err");
  hint.textContent =
    "面板出现在当前网页右下角；若已关闭，可点网页上的黄色「高亮」按钮，或再次点击上方按钮。";
}

function sendOpenHighlightsPanelToActiveTab() {
  const hint = document.getElementById("open-panel-hint");
  resetOpenPanelHint(hint);

  chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
    const tab = tabs && tabs[0];
    if (!tab || tab.id == null) {
      if (hint) {
        hint.textContent = "没有可用的当前标签页。";
        hint.classList.remove("hl-ext-popup__hint--ok");
        hint.classList.add("hl-ext-popup__hint--err");
      }
      return;
    }

    chrome.tabs.sendMessage(tab.id, { type: "OPEN_HIGHLIGHTS_PANEL" }, () => {
      if (chrome.runtime.lastError) {
        if (hint) {
          hint.textContent =
            "无法打开：请在本页刷新后重试，或确认当前为可注入脚本的普通网页（部分内置页、PDF 等不支持）。";
          hint.classList.remove("hl-ext-popup__hint--ok");
          hint.classList.add("hl-ext-popup__hint--err");
        }
        return;
      }
      if (hint) {
        hint.textContent = "已在当前页面打开高亮面板。";
        hint.classList.remove("hl-ext-popup__hint--err");
        hint.classList.add("hl-ext-popup__hint--ok");
      }
    });
  });
}

function initPopup() {
  const enableToggle = document.getElementById("enable-toggle");
  const readingToggle = document.getElementById("reading-toggle");
  const openPanelBtn = document.getElementById("open-panel-btn");
  const exportPageBtn = document.getElementById("export-page-btn");
  const exportAllBtn = document.getElementById("export-all-btn");
  const colorRadios = document.querySelectorAll('input[name="hl-highlight-color"]');

  if (!enableToggle || !readingToggle) return;

  // 初始化时从 storage 读取状态
  getConfigPopup(config => {
    enableToggle.checked = Boolean(config.highlightEnabled);
    readingToggle.checked = !!config.readingModeEnabled;
    const c = typeof config.highlightColor === "string" ? config.highlightColor.trim().toLowerCase() : "yellow";
    colorRadios.forEach(r => {
      r.checked = r.value === c;
    });
    if (![...colorRadios].some(r => r.checked) && colorRadios[0]) {
      colorRadios[0].checked = true;
    }
  });

  enableToggle.addEventListener("change", () => {
    const enabled = enableToggle.checked;
    setConfigPopup({ highlightEnabled: enabled }, (newConfig) => {
      sendConfigToActiveTab(newConfig);
    });
  });

  readingToggle.addEventListener("change", () => {
    const enabled = readingToggle.checked;
    setConfigPopup({ readingModeEnabled: enabled }, (newConfig) => {
      sendConfigToActiveTab(newConfig);
    });
  });

  colorRadios.forEach(radio => {
    radio.addEventListener("change", () => {
      if (!radio.checked) return;
      setConfigPopup({ highlightColor: radio.value }, newConfig => {
        sendConfigToActiveTab(newConfig);
      });
    });
  });

  if (openPanelBtn) {
    openPanelBtn.addEventListener("click", () => {
      sendOpenHighlightsPanelToActiveTab();
    });
  }

  if (exportPageBtn) {
    exportPageBtn.addEventListener("click", () => exportCurrentPageHighlights());
  }
  if (exportAllBtn) {
    exportAllBtn.addEventListener("click", () => exportAllHighlights());
  }
}

document.addEventListener("DOMContentLoaded", initPopup);

