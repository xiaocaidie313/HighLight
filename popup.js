// Popup 脚本：控制精读模式开关

const HL_CONFIG_KEY_POPUP = "config:v1";

function getConfigPopup(callback) {
  chrome.storage.local.get(HL_CONFIG_KEY_POPUP, result => {
    const config = result[HL_CONFIG_KEY_POPUP] || {
      theme: "default",
      highlightEnabled: true,
      readingModeEnabled: false
    };
    // 拿到 config 之后怎么办
    if (callback) callback(config);
  });
}

// 更新设置配置 
function setConfigPopup(partial, callback){
  getConfigPopup(res =>{
    const newConfig = { ...res, ...partial };
    chrome.storage.local.set({[HL_CONFIG_KEY_POPUP]: newConfig}, () => {
      // 应用新配置 如果有callback的话
      if (callback) callback(newConfig);
    });
  })
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

function initPopup() {
  const enableToggle = document.getElementById("enable-toggle");
  const readingToggle = document.getElementById("reading-toggle");
  
  if (!enableToggle || !readingToggle) return;

  // 初始化时从 storage 读取状态
  getConfigPopup(config => {
    enableToggle.checked = Boolean(config.highlightEnabled);
    readingToggle.checked = !!config.readingModeEnabled;
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
}

document.addEventListener("DOMContentLoaded", initPopup);

