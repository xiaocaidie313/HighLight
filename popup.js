// Popup 脚本：控制精读模式开关

const HL_CONFIG_KEY_POPUP = "config:v1";

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
            "无法打开：请切换到已支持站点（如 ChatGPT、豆包）的标签页后再试。";
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
}

document.addEventListener("DOMContentLoaded", initPopup);

