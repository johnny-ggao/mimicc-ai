#!/usr/bin/env bash
#
# 把当前仓库打成一份带版本号的产物，装到全局 PATH 上；再跑一次就是更新。
#
# 装完的样子：
#   ~/.local/bin/mimicc                  启动壳，本脚本生成，别手改
#   ~/.mimicc/versions/<版本>/main.js    每次安装一份，旧的留着能回滚
#   ~/.mimicc/current -> versions/<版本> 启动壳只认这个软链
#   ~/.mimicc/.env                       全局配置（API key）；只在缺失时按 .env.example 建
#
# 产物是 bun 打包出的单个 JS，不是独立二进制——运行时仍要机器上有 bun。
# 换来的是几 MB 的体积和秒级的安装，多留几个版本也不心疼。
#
# 用法见 usage()。

set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)

# 装到哪。两个都能用环境变量或参数改。
HOME_DIR=${MIMICC_HOME:-$HOME/.mimicc}
BIN_DIR=${MIMICC_BIN_DIR:-$HOME/.local/bin}

KEEP=5          # 保留几个历史版本（当前版本永远不算在内、也永远不删）
DO_DEPS=1       # 装之前跑 bun install
DO_CHECK=0      # 装之前跑 bun run check（慢，默认关）
FORCE=0         # 覆盖一个不是本脚本装的 mimicc

# 启动壳的身份证。uninstall 只删带这行的文件，免得误删别人的同名命令。
LAUNCHER_MARKER='# mimicc-launcher v1'

usage() {
  cat <<'USAGE_EOF'
用法: scripts/install.sh [命令] [选项]

命令:
  install            构建当前仓库并全局安装（默认）
  update             同 install，但要求已经装过，并打印 旧版本 → 新版本
  list               列出已装版本，标出当前用的是哪个
  use <版本>         切到某个已装版本（回滚用，不重新构建）
  uninstall          删掉启动壳和所有已装版本；不动 .env、记忆、会话历史

选项:
  --bin-dir <目录>   启动壳装到哪（默认 ~/.local/bin，或 $MIMICC_BIN_DIR）
  --home <目录>      产物装到哪（默认 ~/.mimicc，或 $MIMICC_HOME）
  --keep <个数>      保留几个历史版本（默认 5）
  --check            装之前跑一遍 bun run check（typecheck + lint + format + test）
  --no-deps          跳过 bun install
  --force            即使 bin 目录下已有一个不是本脚本装的 mimicc 也覆盖
  -h, --help         这段话
USAGE_EOF
}

say()  { printf '==> %s\n' "$*"; }
note() { printf '    %s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die()  { printf 'error: %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------- 参数

CMD=""
USE_TARGET=""

while [ $# -gt 0 ]; do
  case "$1" in
    install|update|list|uninstall) [ -z "$CMD" ] || die "只能给一个命令：已经有 $CMD"; CMD=$1 ;;
    use)
      [ -z "$CMD" ] || die "只能给一个命令：已经有 $CMD"
      CMD=use
      shift
      [ $# -gt 0 ] || die "use 要跟一个版本号；scripts/install.sh list 看有哪些"
      USE_TARGET=$1
      ;;
    --bin-dir) shift; [ $# -gt 0 ] || die "--bin-dir 要跟一个目录"; BIN_DIR=$1 ;;
    --home)    shift; [ $# -gt 0 ] || die "--home 要跟一个目录"; HOME_DIR=$1 ;;
    --keep)    shift; [ $# -gt 0 ] || die "--keep 要跟一个数字"; KEEP=$1 ;;
    --check)   DO_CHECK=1 ;;
    --no-deps) DO_DEPS=0 ;;
    --force)   FORCE=1 ;;
    -h|--help) usage; exit 0 ;;
    *) die "不认识的参数：$1（-h 看用法）" ;;
  esac
  shift
done

CMD=${CMD:-install}

case "$KEEP" in
  ''|*[!0-9]*) die "--keep 要是个非负整数，收到 $KEEP" ;;
esac

# 相对路径要在这里就变成绝对路径：启动壳里会写死 HOME_DIR，而它是从别的目录
# 被敲出来的，"./x" 到那时候指的已经不是同一个地方了。
abspath() {
  set -- "${1#./}"
  case "$1" in
    /*) printf '%s\n' "${1%/}" ;;
    *)  printf '%s\n' "${PWD%/}/${1%/}" ;;
  esac
}
HOME_DIR=$(abspath "$HOME_DIR")
BIN_DIR=$(abspath "$BIN_DIR")

VERSIONS_DIR="$HOME_DIR/versions"
CURRENT_LINK="$HOME_DIR/current"
LAUNCHER="$BIN_DIR/mimicc"

# ---------------------------------------------------------------- 小工具

# 当前指向的版本名；没装过就是空串。
current_version() {
  [ -L "$CURRENT_LINK" ] || return 0
  basename "$(readlink "$CURRENT_LINK")"
}

# 版本号 = package.json 的 version + 短 sha。工作区脏就带上 .dirty 和时间戳——
# 脏构建之间没有别的东西能把它们区分开，而回滚时分不清版本比多几个目录糟糕。
version_string() {
  local pkg commit
  pkg=$(sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$ROOT/package.json" | head -1)
  [ -n "$pkg" ] || pkg=0.0.0

  if commit=$(git -C "$ROOT" rev-parse --short=7 HEAD 2>/dev/null); then
    if git -C "$ROOT" diff --quiet HEAD -- 2>/dev/null; then
      printf '%s+g%s\n' "$pkg" "$commit"
    else
      printf '%s+g%s.dirty.%s\n' "$pkg" "$commit" "$(date +%Y%m%d%H%M%S)"
    fi
  else
    printf '%s+%s\n' "$pkg" "$(date +%Y%m%d%H%M%S)"
  fi
}

require_bun() {
  command -v bun >/dev/null 2>&1 || die "找不到 bun；先装 bun（https://bun.sh），版本按 .bun-version 是 $(cat "$ROOT/.bun-version" 2>/dev/null || echo '?')"
}

# ---------------------------------------------------------------- 构建

# 打包到临时目录，再冒烟跑一遍。先验货后换 current，是为了让一次坏构建
# 不至于把一个能用的安装换掉。
build_into() {
  local out=$1

  if [ "$DO_DEPS" = 1 ]; then
    say "装依赖 (bun install)"
    (cd "$ROOT" && bun install) >/dev/null || die "bun install 失败"
  fi

  if [ "$DO_CHECK" = 1 ]; then
    say "跑检查 (bun run check)"
    (cd "$ROOT" && bun run check) || die "check 没过，没装"
  fi

  say "打包 (bun build)"
  (cd "$ROOT" && bun build src/main.ts --target=bun --outdir="$out" --sourcemap=linked) >/dev/null \
    || die "bun build 失败"
  [ -f "$out/main.js" ] || die "打包没产出 main.js"

  say "冒烟 (跑一次产物)"
  smoke_test "$out/main.js"
}

# 冒烟：清空环境跑一次，期望它走到"缺 API key"就停。
# 这证明整包能加载、能跑到 main() 里去，而且没碰任何磁盘状态——
# 缺 key 的报错发生在解析会话目录之前。
smoke_test() {
  local entry=$1 tmp_env tmp_cwd out status
  tmp_env=$(mktemp)
  tmp_cwd=$(mktemp -d)
  : > "$tmp_env"

  set +e
  out=$(cd "$tmp_cwd" && env -i HOME="$HOME" PATH="$PATH" TMPDIR="${TMPDIR:-/tmp}" \
    bun --env-file="$tmp_env" "$entry" </dev/null 2>&1)
  status=$?
  set -e
  rm -rf "$tmp_env" "$tmp_cwd"

  case "$out" in
    *"missing API key"*|*"Invalid environment configuration"*) return 0 ;;
  esac

  die "冒烟没过（退出码 $status），产物没装。它说的是：
$out"
}

# ---------------------------------------------------------------- 安装

install_version() {
  local src=$1 version=$2
  local dest="$VERSIONS_DIR/$version"

  mkdir -p "$dest"
  cp "$src/main.js" "$dest/main.js"
  [ -f "$src/main.js.map" ] && cp "$src/main.js.map" "$dest/main.js.map"

  # 谁、什么时候、从哪个 commit 打的。回头看一个旧版本时就靠它。
  cat > "$dest/manifest.json" <<MANIFEST_EOF
{
  "version": "$version",
  "commit": "$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || echo unknown)",
  "dirty": $(git -C "$ROOT" diff --quiet HEAD -- 2>/dev/null && echo false || echo true),
  "builtAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "bun": "$(bun --version)",
  "source": "$ROOT"
}
MANIFEST_EOF

  # 相对目标：整个 ~/.mimicc 搬走也不会断。
  ln -sfn "versions/$version" "$CURRENT_LINK"
}

# 撞上一个不是本脚本装的同名命令就停手。放在构建之前查，是因为让人白等一趟
# 打包再告诉他装不上，是最没必要的一种浪费。
check_launcher_writable() {
  [ -e "$LAUNCHER" ] || return 0
  [ "$FORCE" = 1 ] && return 0
  grep -q "$LAUNCHER_MARKER" "$LAUNCHER" 2>/dev/null && return 0
  die "$LAUNCHER 已经存在而且不是本脚本装的；确认能覆盖就加 --force"
}

write_launcher() {
  local bun_path tmp
  bun_path=$(command -v bun)
  tmp=$(mktemp)

  cat > "$tmp" <<'LAUNCHER_EOF'
#!/bin/sh
# mimicc-launcher v1
# 由 scripts/install.sh 生成。手改会在下次 install/update 时被覆盖。
set -e

MIMICC_HOME="${MIMICC_HOME:-__MIMICC_HOME__}"
entry="$MIMICC_HOME/current/main.js"

if [ ! -f "$entry" ]; then
  echo "mimicc: 没有已安装的版本（找不到 $entry）。到源码仓库里跑 scripts/install.sh install" >&2
  exit 1
fi

if [ -n "${MIMICC_BUN:-}" ]; then
  bun_bin="$MIMICC_BUN"
elif command -v bun >/dev/null 2>&1; then
  bun_bin=bun
elif [ -x "__BUN_PATH__" ]; then
  bun_bin="__BUN_PATH__"
else
  echo "mimicc: 需要 bun 才能运行（https://bun.sh），或者用 MIMICC_BUN 指一个" >&2
  exit 1
fi

# production 时会话历史落在 ~/.mimicc/<仓库>/，而不是写进你正在干活的项目里
# （见 src/checkpoint/location.ts）。已经导出的 NODE_ENV 优先，留个改回去的口子。
NODE_ENV="${NODE_ENV:-production}"
export NODE_ENV

# 两个 --env-file，后写的赢：全局配置打底，当前项目自己的 .env 覆盖它。
# 真正 export 过的变量还是压过这两者——Bun 不覆盖环境里已有的值。
exec "$bun_bin" --env-file="$MIMICC_HOME/.env" --env-file="$PWD/.env" "$entry" "$@"
LAUNCHER_EOF

  sed -e "s|__MIMICC_HOME__|$HOME_DIR|g" -e "s|__BUN_PATH__|$bun_path|g" "$tmp" > "$tmp.final"
  mkdir -p "$BIN_DIR"
  # 先写临时文件再 mv：正在被别的 shell 跑的启动壳不会读到写了一半的内容。
  mv "$tmp.final" "$LAUNCHER"
  chmod 755 "$LAUNCHER"
  rm -f "$tmp"
}

# 全局配置只在缺失时建，而且是照 .env.example 建空的——
# 把仓库里那份带真 key 的 .env 复制出去是另一回事，不该由安装脚本悄悄替你做。
ensure_global_env() {
  local target="$HOME_DIR/.env"
  [ -f "$target" ] && return 0

  if [ -f "$ROOT/.env.example" ]; then
    cp "$ROOT/.env.example" "$target"
  else
    printf 'LLM_DEEPSEEK_API_KEY=\n' > "$target"
  fi
  chmod 600 "$target"
  NEW_GLOBAL_ENV=1
}

# 只留最近 KEEP 个历史版本，当前那个不算也不删。
prune_versions() {
  local current kept=0 dir
  current=$(current_version)
  [ -d "$VERSIONS_DIR" ] || return 0

  for dir in $(ls -1t "$VERSIONS_DIR" 2>/dev/null); do
    [ "$dir" = "$current" ] && continue
    kept=$((kept + 1))
    if [ "$kept" -gt "$KEEP" ]; then
      rm -rf "${VERSIONS_DIR:?}/$dir"
      note "清掉旧版本 $dir"
    fi
  done
}

check_path() {
  case ":$PATH:" in
    *":$BIN_DIR:"*) ;;
    *)
      warn "$BIN_DIR 不在 PATH 里，装完也敲不到 mimicc。加这一行到 ~/.zshrc："
      printf '\n    export PATH="%s:$PATH"\n\n' "$BIN_DIR"
      return
      ;;
  esac

  local found
  found=$(command -v mimicc 2>/dev/null || true)
  if [ -n "$found" ] && [ "$found" != "$LAUNCHER" ]; then
    warn "PATH 上先撞到的是 $found，不是刚装的 $LAUNCHER"
  fi
}

# ---------------------------------------------------------------- 命令

cmd_install() {
  local mode=$1 before after tmp
  before=$(current_version)

  if [ "$mode" = update ] && [ -z "$before" ]; then
    die "还没装过（$CURRENT_LINK 不存在），先跑 scripts/install.sh install"
  fi

  require_bun
  check_launcher_writable
  mkdir -p "$HOME_DIR" "$VERSIONS_DIR"

  after=$(version_string)
  tmp=$(mktemp -d "${TMPDIR:-/tmp}/mimicc-build.XXXXXX")
  trap 'rm -rf "$tmp"' EXIT

  build_into "$tmp"

  say "安装 $after"
  install_version "$tmp" "$after"
  write_launcher
  NEW_GLOBAL_ENV=0
  ensure_global_env
  prune_versions

  rm -rf "$tmp"
  trap - EXIT

  echo
  if [ -n "$before" ] && [ "$before" != "$after" ]; then
    say "好了：$before → $after"
  else
    say "好了：$after"
  fi
  note "启动壳    $LAUNCHER"
  note "产物      $VERSIONS_DIR/$after/main.js"
  note "全局配置  $HOME_DIR/.env"
  echo
  if [ "${NEW_GLOBAL_ENV:-0}" = 1 ]; then
    warn "$HOME_DIR/.env 是刚照 .env.example 建的空壳，key 还没填——填完才跑得起来："
    printf '\n    $EDITOR %s\n\n' "$HOME_DIR/.env"
  fi
  check_path
}

cmd_list() {
  [ -d "$VERSIONS_DIR" ] || die "还没装过任何版本"
  local current dir built
  current=$(current_version)

  for dir in $(ls -1t "$VERSIONS_DIR" 2>/dev/null); do
    built=$(sed -n 's/.*"builtAt"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$VERSIONS_DIR/$dir/manifest.json" 2>/dev/null | head -1 || true)
    if [ "$dir" = "$current" ]; then
      printf '* %-40s %s\n' "$dir" "${built:-?}"
    else
      printf '  %-40s %s\n' "$dir" "${built:-?}"
    fi
  done
}

cmd_use() {
  local target=$1
  [ -f "$VERSIONS_DIR/$target/main.js" ] || die "没装过 $target；scripts/install.sh list 看有哪些"
  ln -sfn "versions/$target" "$CURRENT_LINK"
  say "切到 $target"
}

cmd_uninstall() {
  if [ -f "$LAUNCHER" ]; then
    if grep -q "$LAUNCHER_MARKER" "$LAUNCHER"; then
      rm -f "$LAUNCHER"
      note "删掉 $LAUNCHER"
    else
      warn "$LAUNCHER 不是本脚本装的，留着没动"
    fi
  fi

  rm -rf "$VERSIONS_DIR"
  rm -f "$CURRENT_LINK"
  note "删掉 $VERSIONS_DIR"

  echo
  say "卸载完成。这些是你的数据，一个都没动："
  note "$HOME_DIR/.env      全局配置"
  note "$HOME_DIR/memory    记忆"
  note "$HOME_DIR/<仓库>/   各项目的会话历史"
  note "都不要了就自己删：rm -rf $HOME_DIR"
}

case "$CMD" in
  install|update) cmd_install "$CMD" ;;
  list)           cmd_list ;;
  use)            cmd_use "$USE_TARGET" ;;
  uninstall)      cmd_uninstall ;;
  *)              die "不认识的命令：$CMD" ;;
esac
