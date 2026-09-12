/**
 * 主题预挂载脚本：在 React 渲染前同步设置 data-theme，避免首屏闪烁。
 * 独立文件而非内联，以符合 CSP 的 script-src 'self'。
 */
(function () {
  try {
    var stored = localStorage.getItem("banyan.theme");
    var theme =
      stored === "dark" || stored === "light" || stored === "system" ? stored : "dark";
    document.documentElement.setAttribute("data-theme", theme);
  } catch (e) {
    document.documentElement.setAttribute("data-theme", "dark");
  }
})();
