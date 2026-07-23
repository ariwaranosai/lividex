#!/bin/zsh
set -euo pipefail

readonly LABEL="com.ariwaranosai.livis-codex"
readonly SCRIPT_DIR="${0:A:h}"
readonly PROJECT_ROOT="${SCRIPT_DIR:h}"
readonly SOURCE="${PROJECT_ROOT}/macos/LivisCodexMenuBar.swift"
readonly INSTALL_ROOT="${LIVIS_CODEX_INSTALL_DIR:-${HOME}/.local/lib/livis-codex}"
readonly BINARY="${INSTALL_ROOT}/LivisCodexMenuBar"
readonly PLIST="${HOME}/Library/LaunchAgents/${LABEL}.plist"
readonly STATE_DIR="${LIVIS_CODEX_HOME:-${HOME}/.livis-codex}"
readonly LOG_DIR="${STATE_DIR}/logs"
readonly DOMAIN="gui/$(id -u)"

find_node() {
  if [[ -n "${LIVIS_CODEX_NODE:-}" && -x "${LIVIS_CODEX_NODE}" ]]; then
    print -r -- "${LIVIS_CODEX_NODE}"
    return
  fi
  local candidate
  for candidate in "$(command -v node 2>/dev/null || true)" /opt/homebrew/bin/node /usr/local/bin/node; do
    if [[ -n "${candidate}" && -x "${candidate}" ]]; then
      print -r -- "${candidate}"
      return
    fi
  done
  print -u2 "找不到 Node.js。请先安装 Node.js 22+，或通过 LIVIS_CODEX_NODE 指定路径。"
  return 1
}

validate_node() {
  local node_binary="$1"
  local major
  major="$("${node_binary}" -p 'process.versions.node.split(".")[0]')"
  if (( major < 22 )); then
    print -u2 "需要 Node.js 22+，当前为 $("${node_binary}" --version)。"
    return 1
  fi
}

dashboard_url() {
  local node_binary="$1"
  "${node_binary}" -e '
    const fs = require("node:fs");
    let dashboard = {};
    try {
      dashboard = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).dashboard || {};
    } catch {}
    const configuredHost = dashboard.host || "127.0.0.1";
    const host = ["0.0.0.0", "::", "[::]"].includes(configuredHost) ? "127.0.0.1" : configuredHost;
    console.log(`http://${host}:${dashboard.port || 8765}`);
  ' "${STATE_DIR}/config.json"
}

build_binary() {
  local output="$1"
  local output_dir="${output:h}"
  local module_cache="${PROJECT_ROOT}/.build/macos/module-cache"
  mkdir -p "${output_dir}" "${module_cache}"
  xcrun --find swiftc >/dev/null
  CLANG_MODULE_CACHE_PATH="${module_cache}" \
    SWIFT_MODULE_CACHE_PATH="${module_cache}" \
    xcrun swiftc \
    -swift-version 5 \
    -O \
    -framework AppKit \
    "${SOURCE}" \
    -o "${output}"
  chmod 755 "${output}"
}

write_launch_agent() {
  local node_binary="$1"
  mkdir -p "${PLIST:h}" "${LOG_DIR}"
  plutil -create xml1 "${PLIST}"
  plutil -insert Label -string "${LABEL}" "${PLIST}"
  plutil -insert ProgramArguments -array "${PLIST}"
  plutil -insert ProgramArguments.0 -string "${BINARY}" "${PLIST}"
  plutil -insert ProgramArguments.1 -string "--project-root" "${PLIST}"
  plutil -insert ProgramArguments.2 -string "${PROJECT_ROOT}" "${PLIST}"
  plutil -insert ProgramArguments.3 -string "--node" "${PLIST}"
  plutil -insert ProgramArguments.4 -string "${node_binary}" "${PLIST}"
  plutil -insert ProgramArguments.5 -string "--state-dir" "${PLIST}"
  plutil -insert ProgramArguments.6 -string "${STATE_DIR}" "${PLIST}"
  plutil -insert WorkingDirectory -string "${PROJECT_ROOT}" "${PLIST}"
  plutil -insert RunAtLoad -bool true "${PLIST}"
  plutil -insert KeepAlive -dictionary "${PLIST}"
  plutil -insert KeepAlive.SuccessfulExit -bool false "${PLIST}"
  plutil -insert ProcessType -string "Interactive" "${PLIST}"
  plutil -insert StandardOutPath -string "${LOG_DIR}/menubar.log" "${PLIST}"
  plutil -insert StandardErrorPath -string "${LOG_DIR}/menubar.log" "${PLIST}"
  plutil -insert EnvironmentVariables -dictionary "${PLIST}"
  plutil -insert EnvironmentVariables.PATH -string "${node_binary:h}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" "${PLIST}"
  plutil -insert EnvironmentVariables.LIVIS_CODEX_HOME -string "${STATE_DIR}" "${PLIST}"
  plutil -lint "${PLIST}"
}

install_agent() {
  if [[ "$(uname -s)" != "Darwin" ]]; then
    print -u2 "该安装脚本仅支持 macOS。"
    return 1
  fi
  local node_binary
  node_binary="$(find_node)"
  validate_node "${node_binary}"
  if [[ ! -f "${STATE_DIR}/config.json" ]]; then
    print "首次安装，正在初始化 Livis Codex 配置…"
    LIVIS_CODEX_HOME="${STATE_DIR}" "${node_binary}" "${PROJECT_ROOT}/src/cli.js" setup --cwd "${PROJECT_ROOT}"
  fi

  print "正在编译菜单栏程序…"
  build_binary "${BINARY}"
  write_launch_agent "${node_binary}"

  launchctl bootout "${DOMAIN}" "${PLIST}" >/dev/null 2>&1 || true
  launchctl bootstrap "${DOMAIN}" "${PLIST}"
  launchctl kickstart -k "${DOMAIN}/${LABEL}"

  print "安装完成。"
  print "菜单栏程序：${BINARY}"
  print "开机启动项：${PLIST}"
  print "状态页面：$(dashboard_url "${node_binary}")"
  print "日志目录：${LOG_DIR}"
}

uninstall_agent() {
  launchctl bootout "${DOMAIN}" "${PLIST}" >/dev/null 2>&1 || true
  if [[ -f "${PLIST}" ]]; then
    mv "${PLIST}" "${HOME}/.Trash/${LABEL}.$(date +%Y%m%d%H%M%S).plist"
  fi
  if [[ -d "${INSTALL_ROOT}" ]]; then
    mv "${INSTALL_ROOT}" "${HOME}/.Trash/livis-codex-menubar.$(date +%Y%m%d%H%M%S)"
  fi
  print "已卸载菜单栏启动项；文件已移到废纸篓，Livis 配置和登录态未删除。"
}

show_status() {
  local node_binary
  node_binary="$(find_node)"
  local url
  url="$(dashboard_url "${node_binary}")"
  if launchctl print "${DOMAIN}/${LABEL}" >/dev/null 2>&1; then
    print "LaunchAgent：运行中"
  else
    print "LaunchAgent：未运行"
  fi
  if curl --silent --fail --max-time 2 "${url}/api/status" >/dev/null; then
    print "Dashboard：在线（${url}）"
  else
    print "Dashboard：离线（${url}）"
  fi
}

case "${1:-install}" in
  install)
    install_agent
    ;;
  build)
    build_binary "${PROJECT_ROOT}/.build/macos/LivisCodexMenuBar"
    print "编译成功：${PROJECT_ROOT}/.build/macos/LivisCodexMenuBar"
    ;;
  status)
    show_status
    ;;
  uninstall)
    uninstall_agent
    ;;
  *)
    print -u2 "用法：$0 [install|build|status|uninstall]"
    exit 2
    ;;
esac
