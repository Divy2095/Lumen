#!/usr/bin/env bash
#
# Local development stack launcher for Lumen.
#
# Owns only the processes it starts and the development Compose services it
# starts. Never uses compose.test.yaml, never runs destructive cleanup, and
# never applies migrations.
#
set -euo pipefail
IFS=$'\n\t'

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
ROOT=$(cd -- "$SCRIPT_DIR/.." && pwd -P)
ENV_FILE="$ROOT/.env"
COMPOSE_FILE="$ROOT/compose.yaml"

DEFAULT_WEB_DIR=$(cd -- "$ROOT/.." && pwd -P)/Lumen-web
WEB_DIR=${LUMEN_WEB_DIR:-$DEFAULT_WEB_DIR}
if [[ $WEB_DIR != /* ]]; then
  WEB_DIR="$ROOT/$WEB_DIR"
fi

RUNTIME_DIR="$ROOT/.lumen-dev"
RUN_DIR="$RUNTIME_DIR/run"
LOG_DIR="$RUNTIME_DIR/logs"
STATE_FILE="$RUN_DIR/state.env"

COMPOSE_PROJECT=${LUMEN_COMPOSE_PROJECT:-lumen}
DRY_RUN=${LUMEN_DEV_STACK_DRY_RUN:-0}
START_ACTIVE=0
STATE_LOADED=0

NODE_BEST=""
NODE_BEST_VERSION=""
VERSION_MIN=24.0.0
WEB_NODE_MIN=24.0.0
NPM_BIN=""

COMPOSE_ENGINE=""
COMPOSE_CONTEXT=""
ENGINE_CMD=()
COMPOSE_CMD=()

API_HOST=""
API_PORT=""
API_URL=""
WEB_PORT=""
WEB_ORIGIN=""
WEB_BASE_PATH="/"
WEB_URL=""
OLD_INFRA_POSTGRES_ID=""
OLD_INFRA_POSTGRES_OWNED=0
OLD_INFRA_REDIS_ID=""
OLD_INFRA_REDIS_OWNED=0

STACK_PGHOST=""
STACK_PGPORT=""
STACK_PGDATABASE=""
STACK_PGUSER=""
STACK_REDIS_HOST=""
STACK_REDIS_PORT=""
STACK_REDIS_DB=""

INFRA_ENGINE=""
INFRA_CONTEXT=""
INFRA_PROJECT=""
INFRA_POSTGRES_ID=""
INFRA_POSTGRES_OWNED=0
INFRA_REDIS_ID=""
INFRA_REDIS_OWNED=0

PRE_PG_ID=""
PRE_PG_RUNNING=0
PRE_REDIS_ID=""
PRE_REDIS_RUNNING=0

REC_PID=""
REC_PGID=""
REC_START=""
REC_NAME=""

if [[ -t 1 ]]; then
  C_BOLD=$'\033[1m'
  C_DIM=$'\033[2m'
  C_RED=$'\033[31m'
  C_YELLOW=$'\033[33m'
  C_GREEN=$'\033[32m'
  C_RESET=$'\033[0m'
else
  C_BOLD=""
  C_DIM=""
  C_RED=""
  C_YELLOW=""
  C_GREEN=""
  C_RESET=""
fi

info() { printf '%s\n' "$*"; }
warn() { printf '%swarning:%s %s\n' "$C_YELLOW" "$C_RESET" "$*" >&2; }
err() { printf '%serror:%s %s\n' "$C_RED" "$C_RESET" "$*" >&2; }
section() { printf '\n%s%s%s\n' "$C_BOLD" "$*" "$C_RESET"; }
format_cmd() { local IFS=' '; printf '%s' "$*"; }
die() { err "$*"; exit 1; }

usage() {
  cat <<'EOF'
Usage: ./scripts/dev-stack.sh <command> [options]

Commands:
  start [--dry-run]   Start PostgreSQL, Redis, API, outbox publisher, worker, web
  stop                Stop processes and development containers this launcher started
  restart             Stop, then start
  status              Show readiness and process status
  logs [service]      Follow logs (api, worker, publisher, web, infrastructure, all)
  logs [service] --no-follow
                      Print recent logs without following
  help                Show this help

Environment overrides:
  LUMEN_NODE_BIN             Path to a Node.js >= 24 binary
  LUMEN_CONTAINER_ENGINE     docker or podman (default: auto-detect)
  LUMEN_COMPOSE_CONTEXT      Docker context (default: rootless when available)
  LUMEN_COMPOSE_PROJECT      Compose project name (default: lumen)
  LUMEN_WEB_DIR              Sibling frontend directory (default: ../Lumen-web)
  LUMEN_WEB_PORT             Frontend dev port (default: 5173)
  LUMEN_DEV_STACK_DRY_RUN=1  Same as start --dry-run

The launcher never applies migrations, never uses compose.test.yaml, and never
runs compose down, prune, or volume removal.
EOF
}

env_get() {
  local key=$1 default=${2-} line trimmed value
  if [[ -n ${!key+x} ]]; then
    printf '%s' "${!key}"
    return 0
  fi
  [[ -f $ENV_FILE ]] || { printf '%s' "$default"; return 0; }
  while IFS= read -r line || [[ -n $line ]]; do
    line=${line%$'\r'}
    trimmed=${line#"${line%%[![:space:]]*}"}
    [[ $trimmed == "$key="* ]] || continue
    value=${trimmed#*=}
    if [[ $value == \"*\" && $value == *\" && ${#value} -ge 2 ]]; then
      value=${value:1:${#value}-2}
    elif [[ $value == \'*\' && $value == *\' && ${#value} -ge 2 ]]; then
      value=${value:1:${#value}-2}
    fi
    printf '%s' "$value"
    return 0
  done < "$ENV_FILE"
  printf '%s' "$default"
}

version_ge() {
  [[ $1 == "$2" ]] && return 0
  [[ $(printf '%s\n%s\n' "$2" "$1" | sort -V | head -n1) == "$2" ]]
}

consider_node() {
  local bin=$1 version
  [[ -x $bin ]] || return 0
  version=$("$bin" -v 2>/dev/null) || return 0
  version=${version#v}
  [[ $version =~ ^[0-9]+\.[0-9]+\.[0-9]+ ]] || return 0
  version_ge "$version" "$VERSION_MIN" || return 0
  version_ge "$version" "$WEB_NODE_MIN" || return 0
  if [[ -z $NODE_BEST ]] || version_ge "$version" "$NODE_BEST_VERSION"; then
    NODE_BEST=$bin
    NODE_BEST_VERSION=$version
  fi
}

select_node() {
  local candidate explicit=0 dir

  if [[ -f "$WEB_DIR/.node-version" ]]; then
    candidate=$(tr -d '[:space:]' < "$WEB_DIR/.node-version")
    candidate=${candidate#v}
    if [[ $candidate =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
      WEB_NODE_MIN=$candidate
    fi
  fi

  if [[ -n ${LUMEN_NODE_BIN:-} ]]; then
    explicit=1
    candidate=$LUMEN_NODE_BIN
    if [[ -d $candidate ]]; then
      candidate=$candidate/node
    fi
    consider_node "$candidate"
  else
    candidate=$(command -v node 2>/dev/null || true)
    [[ -n $candidate ]] && consider_node "$candidate"

    for dir in "${NVM_DIR:-$HOME/.nvm}/versions/node" "$HOME/.local/share/fnm/node-versions" "$HOME/.volta"; do
      [[ -d $dir ]] || continue
      while IFS= read -r -d '' candidate; do
        consider_node "$candidate"
      done < <(find "$dir" -maxdepth 4 -type f -name node -perm -u+x -print0 2>/dev/null)
    done
  fi

  if [[ -z $NODE_BEST ]]; then
    if [[ $explicit == 1 ]]; then
      die "LUMEN_NODE_BIN does not point to Node.js >= $WEB_NODE_MIN."
    fi
    die "Node.js >= $WEB_NODE_MIN is required (found $(node -v 2>/dev/null || echo 'none')). Install Node 24, or set LUMEN_NODE_BIN. Lumen Web requires .node-version $WEB_NODE_MIN."
  fi

  export PATH="$(dirname -- "$NODE_BEST"):$PATH"
  if [[ -x "$(dirname -- "$NODE_BEST")/npm" ]]; then
    NPM_BIN="$(dirname -- "$NODE_BEST")/npm"
  else
    NPM_BIN=$(command -v npm 2>/dev/null || true)
  fi
  [[ -n $NPM_BIN && -x $NPM_BIN ]] || die "npm was not found next to Node $NODE_BEST_VERSION."
  "$NODE_BEST" -v >/dev/null 2>&1 || die "Selected Node binary is not executable: $NODE_BEST"
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "Required tool '$1' was not found in PATH."
}

check_media_binary() {
  local variable=$1 default=$2 value
  value=$(env_get "$variable" "$default")
  [[ -n $value ]] || value=$default
  if [[ $value == */* ]]; then
    [[ -x $value ]] || die "$variable points to a missing or non-executable file: $value"
  else
    command -v "$value" >/dev/null 2>&1 || die "$variable='$value' was not found in PATH."
  fi
}

world_readable() {
  local file=$1 mode group other
  mode=$(stat -c '%a' "$file" 2>/dev/null) || return 1
  group=${mode: -2:1}
  other=${mode: -1}
  [[ $group =~ [4-7] || $other =~ [4-7] ]]
}

detect_compose() {
  local requested=${LUMEN_CONTAINER_ENGINE:-} context

  if [[ -z $requested ]]; then
    if command -v docker >/dev/null 2>&1; then
      requested=docker
    elif command -v podman >/dev/null 2>&1; then
      requested=podman
    else
      die "Neither docker nor podman was found. Install Docker Compose or rootless Podman."
    fi
  fi

  case $requested in
    docker)
      COMPOSE_ENGINE=docker
      if [[ -n ${LUMEN_COMPOSE_CONTEXT:-} ]]; then
        context=$LUMEN_COMPOSE_CONTEXT
      elif docker context inspect rootless >/dev/null 2>&1; then
        context=rootless
      else
        context=default
      fi
      COMPOSE_CONTEXT=$context
      ENGINE_CMD=(docker)
      if [[ $context != default ]]; then
        ENGINE_CMD+=(--context "$context")
      fi
      COMPOSE_CMD=("${ENGINE_CMD[@]}" compose)
      ;;
    podman)
      COMPOSE_ENGINE=podman
      COMPOSE_CONTEXT=""
      ENGINE_CMD=(podman)
      COMPOSE_CMD=(podman compose)
      ;;
    *)
      die "LUMEN_CONTAINER_ENGINE must be 'docker' or 'podman'."
      ;;
  esac

  [[ $COMPOSE_PROJECT =~ ^[a-z0-9][a-z0-9_-]*$ ]] || \
    die "LUMEN_COMPOSE_PROJECT must match ^[a-z0-9][a-z0-9_-]*$."

  "${COMPOSE_CMD[@]}" version >/dev/null 2>&1 || \
    die "Compose is not available through $(format_cmd "${COMPOSE_CMD[@]}"). Install the Compose plugin for $COMPOSE_ENGINE."
}

compose() {
  "${COMPOSE_CMD[@]}" \
    --project-name "$COMPOSE_PROJECT" \
    --env-file "$ENV_FILE" \
    -f "$COMPOSE_FILE" \
    "$@"
}

engine_from_state() {
  case ${INFRA_ENGINE:-} in
    docker)
      ENGINE_CMD=(docker)
      if [[ -n ${INFRA_CONTEXT:-} && ${INFRA_CONTEXT:-} != default ]]; then
        ENGINE_CMD+=(--context "$INFRA_CONTEXT")
      fi
      ;;
    podman)
      ENGINE_CMD=(podman)
      ;;
    *)
      return 1
      ;;
  esac
  command -v "${ENGINE_CMD[0]}" >/dev/null 2>&1
}

validate_start_environment() {
  [[ -f $COMPOSE_FILE ]] || die "Missing $COMPOSE_FILE."
  [[ -f $ENV_FILE ]] || die "Missing $ENV_FILE. Copy .env.example to .env and set a strong database password."
  [[ -f "$ROOT/package.json" ]] || die "Missing $ROOT/package.json."
  [[ -d "$ROOT/node_modules" ]] || die "Backend dependencies are missing. Run: (cd \"$ROOT\" && npm ci)"
  [[ -d "$WEB_DIR" && -f "$WEB_DIR/package.json" ]] || \
    die "Lumen Web was not found at $WEB_DIR. Clone it as a sibling directory or set LUMEN_WEB_DIR."
  [[ -d "$WEB_DIR/node_modules" ]] || die "Frontend dependencies are missing. Run: (cd \"$WEB_DIR\" && npm ci)"

  if command -v git >/dev/null 2>&1; then
    if ! git -C "$ROOT" check-ignore -q -- .env; then
      warn ".env is not ignored by Git. Fix .gitignore before adding credentials."
    fi
  fi
  if world_readable "$ENV_FILE"; then
    warn "$ENV_FILE is accessible to other local users. Consider: chmod 600 \"$ENV_FILE\""
  fi

  local postgres_db postgres_user pg_database pg_user pg_password postgres_password
  local pg_host pg_port redis_host redis_port redis_password redis_db host port
  postgres_db=$(env_get POSTGRES_DB lumen)
  postgres_user=$(env_get POSTGRES_USER lumen)
  postgres_password=$(env_get POSTGRES_PASSWORD "")
  pg_database=$(env_get PGDATABASE lumen)
  pg_user=$(env_get PGUSER lumen)
  pg_password=$(env_get PGPASSWORD "")
  pg_host=$(env_get PGHOST 127.0.0.1)
  pg_port=$(env_get PGPORT 5432)
  redis_host=$(env_get REDIS_HOST 127.0.0.1)
  redis_port=$(env_get REDIS_PORT 6379)
  redis_password=$(env_get REDIS_PASSWORD "")
  redis_db=$(env_get REDIS_DB 0)
  host=$(env_get HOST 127.0.0.1)
  port=$(env_get PORT 3000)

  [[ -n $postgres_password ]] || die "POSTGRES_PASSWORD is empty. Set it in $ENV_FILE."
  [[ -n $pg_password ]] || die "PGPASSWORD is empty. It must match POSTGRES_PASSWORD for the managed development database."
  [[ -n $host ]] || host=127.0.0.1
  [[ -n $pg_host ]] || pg_host=127.0.0.1

  [[ $postgres_db == "$pg_database" ]] || \
    die "POSTGRES_DB ($postgres_db) and PGDATABASE ($pg_database) differ. The development Compose container would create a different database."
  [[ $postgres_user == "$pg_user" ]] || \
    die "POSTGRES_USER ($postgres_user) and PGUSER ($pg_user) differ. The development Compose container would create a different role."
  [[ $pg_host == 127.0.0.1 || $pg_host == localhost || $pg_host == ::1 ]] || \
    die "PGHOST=$pg_host is not loopback. This launcher manages only the loopback development Compose database."
  [[ $redis_host == 127.0.0.1 || $redis_host == localhost || $redis_host == ::1 ]] || \
    die "REDIS_HOST=$redis_host is not loopback. This launcher manages only the loopback development Compose Redis."
  [[ $pg_port == 5432 ]] || die "PGPORT=$pg_port does not match compose.yaml's loopback port 5432."
  [[ $redis_port == 6379 ]] || die "REDIS_PORT=$redis_port does not match compose.yaml's loopback port 6379."
  [[ -z ${redis_password//[[:space:]]/} ]] || \
    die "REDIS_PASSWORD is set, but development compose.yaml starts Redis without authentication. Remove it or use a separately managed Redis."
  [[ $redis_db =~ ^[0-9]+$ ]] || die "REDIS_DB must be a non-negative integer."

  [[ $port =~ ^[0-9]+$ ]] && ((port >= 1 && port <= 65535)) || die "PORT must be an integer between 1 and 65535."
  WEB_PORT=${LUMEN_WEB_PORT:-5173}
  [[ $WEB_PORT =~ ^[0-9]+$ ]] && ((WEB_PORT >= 1 && WEB_PORT <= 65535)) || \
    die "LUMEN_WEB_PORT must be an integer between 1 and 65535."

  API_HOST=$host
  API_PORT=$port
  case $API_HOST in
    0.0.0.0|::|'') API_URL="http://127.0.0.1:$API_PORT" ;;
    ::1) API_URL="http://[::1]:$API_PORT" ;;
    *) API_URL="http://$API_HOST:$API_PORT" ;;
  esac
  WEB_ORIGIN="http://127.0.0.1:$WEB_PORT"
  if [[ -f "$WEB_DIR/site.config.ts" ]]; then
    WEB_BASE_PATH=$(sed -n 's/^[[:space:]]*export const basePath[[:space:]]*=[[:space:]]*"\([^"]*\)";.*/\1/p' "$WEB_DIR/site.config.ts" | head -n1)
  fi
  [[ $WEB_BASE_PATH == /* ]] || WEB_BASE_PATH="/"
  [[ $WEB_BASE_PATH == */ ]] || WEB_BASE_PATH="$WEB_BASE_PATH/"
  WEB_URL="$WEB_ORIGIN$WEB_BASE_PATH"

  STACK_PGHOST=$pg_host
  STACK_PGPORT=$pg_port
  STACK_PGDATABASE=$pg_database
  STACK_PGUSER=$pg_user
  STACK_REDIS_HOST=$redis_host
  STACK_REDIS_PORT=$redis_port
  STACK_REDIS_DB=$redis_db

  if [[ $API_HOST != 127.0.0.1 && $API_HOST != localhost && $API_HOST != ::1 ]]; then
    warn "API HOST is $API_HOST, which may be reachable beyond loopback. Use HOST=127.0.0.1 for local-only access."
  fi

  local cors origins entry found=0
  cors=$(env_get CORS_ALLOWED_ORIGINS "")
  IFS=',' read -r -a origins <<< "$cors"
  for entry in "${origins[@]}"; do
    entry=${entry#"${entry%%[![:space:]]*}"}
    entry=${entry%"${entry##*[![:space:]]}"}
    [[ $entry == "$WEB_ORIGIN" ]] && found=1
  done
  if [[ $found == 0 ]]; then
    warn "CORS_ALLOWED_ORIGINS does not include $WEB_ORIGIN. Browser API calls will be rejected until .env includes that exact origin and the API restarts. CLI/curl requests are unaffected."
  fi

  local clerk_issuer clerk_parties
  clerk_issuer=$(env_get CLERK_ISSUER "")
  clerk_parties=$(env_get CLERK_AUTHORIZED_PARTIES "")
  if [[ -n $clerk_issuer && -z $clerk_parties ]]; then
    warn "CLERK_ISSUER is set but CLERK_AUTHORIZED_PARTIES is empty; the API may fail its Clerk configuration check."
  fi
  if [[ -n $clerk_parties && ",$clerk_parties," != *",$WEB_ORIGIN,"* ]]; then
    warn "CLERK_AUTHORIZED_PARTIES does not include $WEB_ORIGIN. Clerk tokens minted for this frontend origin will be rejected."
  fi

  require_command setsid
  require_command flock
  require_command find
  require_command stat
  check_media_binary FFMPEG_PATH ffmpeg
  check_media_binary FFPROBE_PATH ffprobe

  if [[ -n ${STORAGE_BASE_DIR:-} ]]; then
    warn "STORAGE_BASE_DIR is exported in this shell and overrides .env for child processes."
  fi
  local storage
  storage=$(env_get STORAGE_BASE_DIR "$ROOT/storage")
  [[ $storage == /* ]] || storage="$ROOT/$storage"
  if [[ -e $storage && ! -w $storage ]]; then
    die "STORAGE_BASE_DIR is not writable: $storage"
  fi

  require_command timeout
}

ensure_runtime_dirs() {
  mkdir -p "$RUN_DIR" "$LOG_DIR"
  chmod 700 "$RUNTIME_DIR" "$RUN_DIR" "$LOG_DIR"
}

acquire_lock() {
  ensure_runtime_dirs
  exec 9>"$RUN_DIR/lock"
  chmod 600 "$RUN_DIR/lock" 2>/dev/null || true
  if ! flock -n 9; then
    die "Another dev-stack operation is already running. Wait for it or inspect $RUN_DIR."
  fi
}

load_state() {
  STATE_LOADED=0
  STATE_VERSION=""
  INFRA_ENGINE=""
  INFRA_CONTEXT=""
  INFRA_PROJECT=""
  INFRA_POSTGRES_ID=""
  INFRA_POSTGRES_OWNED=0
  INFRA_REDIS_ID=""
  INFRA_REDIS_OWNED=0
  STACK_PGHOST=""
  STACK_PGPORT=""
  STACK_PGDATABASE=""
  STACK_PGUSER=""
  STACK_REDIS_HOST=""
  STACK_REDIS_PORT=""
  STACK_REDIS_DB=""
  API_URL=""
  WEB_ORIGIN=""
  WEB_URL=""

  [[ -f $STATE_FILE ]] || return 1
  # This file is created mode 0600 inside a mode 0700 directory and contains
  # only non-secret launcher state.
  # shellcheck disable=SC1090
  source "$STATE_FILE" || return 1
  [[ ${STATE_VERSION:-} == 1 ]] || { warn "Ignoring unknown launcher state version in $STATE_FILE."; return 1; }
  STATE_LOADED=1
  return 0
}

write_state() {
  local tmp="$STATE_FILE.tmp.$$"
  (
    umask 077
    {
      printf 'STATE_VERSION=1\n'
      printf 'INFRA_ENGINE=%q\n' "${INFRA_ENGINE:-}"
      printf 'INFRA_CONTEXT=%q\n' "${INFRA_CONTEXT:-}"
      printf 'INFRA_PROJECT=%q\n' "${INFRA_PROJECT:-}"
      printf 'INFRA_POSTGRES_ID=%q\n' "${INFRA_POSTGRES_ID:-}"
      printf 'INFRA_POSTGRES_OWNED=%q\n' "${INFRA_POSTGRES_OWNED:-0}"
      printf 'INFRA_REDIS_ID=%q\n' "${INFRA_REDIS_ID:-}"
      printf 'INFRA_REDIS_OWNED=%q\n' "${INFRA_REDIS_OWNED:-0}"
      printf 'STACK_PGHOST=%q\n' "${STACK_PGHOST:-}"
      printf 'STACK_PGPORT=%q\n' "${STACK_PGPORT:-}"
      printf 'STACK_PGDATABASE=%q\n' "${STACK_PGDATABASE:-}"
      printf 'STACK_PGUSER=%q\n' "${STACK_PGUSER:-}"
      printf 'STACK_REDIS_HOST=%q\n' "${STACK_REDIS_HOST:-}"
      printf 'STACK_REDIS_PORT=%q\n' "${STACK_REDIS_PORT:-}"
      printf 'STACK_REDIS_DB=%q\n' "${STACK_REDIS_DB:-}"
      printf 'API_URL=%q\n' "${API_URL:-}"
      printf 'WEB_ORIGIN=%q\n' "${WEB_ORIGIN:-}"
      printf 'WEB_URL=%q\n' "${WEB_URL:-}"
    } > "$tmp"
  )
  mv -f "$tmp" "$STATE_FILE"
  chmod 600 "$STATE_FILE"
}

proc_fields() {
  local pid=$1 stat rest
  local IFS=' '
  [[ -r "/proc/$pid/stat" ]] || return 1
  stat=$(<"/proc/$pid/stat")
  rest=${stat##*) }
  # Fields after comm: 1=state 3=pgrp 20=starttime (proc field 22).
  # shellcheck disable=SC2086
  set -- $rest
  printf '%s %s %s\n' "$1" "$3" "${20}"
}

load_record() {
  local name=$1
  local file="$RUN_DIR/$name.pid"
  local state pgrp starttime marker
  REC_PID=""
  REC_PGID=""
  REC_START=""
  REC_NAME=""
  [[ -f $file ]] || return 1

  IFS=$'\t' read -r REC_PID REC_PGID REC_START REC_NAME < "$file" || return 1
  [[ $REC_NAME == "$name" ]] || return 1
  [[ $REC_PID =~ ^[0-9]+$ && $REC_PGID =~ ^[0-9]+$ && $REC_START =~ ^[0-9]+$ ]] || return 1
  IFS=' ' read -r state pgrp starttime < <(proc_fields "$REC_PID") || return 1
  [[ $state != Z && $pgrp == "$REC_PGID" && $starttime == "$REC_START" ]] || return 1

  marker=$(tr '\0' '\n' < "/proc/$REC_PID/environ" 2>/dev/null | grep -x "LUMEN_DEV_STACK_SERVICE=$name" || true)
  [[ -n $marker ]] || return 1
  return 0
}

group_has_live_members() {
  local pgid=$1 path pid stat rest
  local IFS=' '
  for path in /proc/[0-9]*; do
    pid=${path#/proc/}
    [[ -r $path/stat ]] || continue
    stat=$(<"$path/stat") || continue
    rest=${stat##*) }
    # shellcheck disable=SC2086
    set -- $rest
    [[ $3 == "$pgid" ]] || continue
    [[ $1 == Z ]] && continue
    return 0
  done
  return 1
}

start_tracked() {
  local name=$1 logfile=$2 workdir=$3
  shift 3
  local log="$LOG_DIR/$logfile" pid state pgrp starttime i
  [[ -f $log ]] || : > "$log"
  chmod 600 "$log" 2>/dev/null || true
  printf '\n=== %s started %s ===\n' "$name" "$(date -Is)" >> "$log"

  (
    cd "$workdir"
    # Do not leak the launcher lock (fd 9) into a long-lived service:
    # otherwise the children would keep the flock held after this script exits.
    exec 9>&-
    exec setsid env "LUMEN_DEV_STACK_SERVICE=$name" "$@"
  ) >>"$log" 2>&1 </dev/null &
  pid=$!

  # The forked subshell starts in the launcher's process group and only joins
  # its own group once it has execed setsid. Poll briefly so this observation
  # race cannot reject a healthy service.
  state=""
  pgrp=""
  starttime=""
  for ((i = 0; i < 100; i++)); do
    if ! IFS=' ' read -r state pgrp starttime < <(proc_fields "$pid"); then
      state=""
      break
    fi
    [[ $state == Z ]] && break
    [[ $pgrp == "$pid" ]] && break
    sleep 0.02
  done

  if [[ -z $state || -z $starttime || $state == Z ]]; then
    wait "$pid" 2>/dev/null || true
    err "$name exited during startup. Last log lines:"
    tail -n 20 "$log" >&2 || true
    return 1
  fi
  if [[ $pgrp != "$pid" ]]; then
    kill -TERM "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
    err "$name did not enter its own process group; refusing to signal anything but that PID. Last log lines:"
    tail -n 20 "$log" >&2 || true
    return 1
  fi

  if ! (umask 077; printf '%s\t%s\t%s\t%s\n' "$pid" "$pgrp" "$starttime" "$name" > "$RUN_DIR/$name.pid"); then
    kill -TERM -- "-$pgrp" 2>/dev/null || true
    err "Could not record the $name process identity."
    return 1
  fi

  sleep 0.4
  if ! load_record "$name"; then
    err "$name exited during startup. Last log lines:"
    tail -n 20 "$log" >&2 || true
    return 1
  fi
  info "  $name started (pid $pid)"
}

stop_tracked() {
  local name=$1
  local file="$RUN_DIR/$name.pid"
  local i
  if ! load_record "$name"; then
    if [[ -f $file ]]; then
      rm -f "$file"
      warn "$name PID record is stale; removed it without signalling any process."
    fi
    return 0
  fi

  info "  Stopping $name (pid $REC_PID)..."
  kill -TERM -- "-$REC_PGID" 2>/dev/null || kill -TERM "$REC_PID" 2>/dev/null || true
  for ((i = 0; i < 150; i++)); do
    group_has_live_members "$REC_PGID" || break
    sleep 0.1
  done
  if group_has_live_members "$REC_PGID"; then
    warn "$name did not stop within 15 seconds; sending SIGKILL to its owned process group."
    kill -KILL -- "-$REC_PGID" 2>/dev/null || true
    sleep 0.2
  fi
  if group_has_live_members "$REC_PGID"; then
    err "$name process group $REC_PGID is still alive; keeping its PID record."
    return 1
  fi
  rm -f "$file"
  return 0
}

cleanup_started_apps() {
  local name
  for name in web api publisher worker; do
    stop_tracked "$name" || true
  done
}

on_exit() {
  local code=$?
  trap - EXIT
  if [[ ${START_ACTIVE:-0} == 1 ]]; then
    START_ACTIVE=0
    err "Startup did not complete; stopping application processes started by this launcher."
    cleanup_started_apps
    if [[ -f $STATE_FILE ]]; then
      info "Development infrastructure is still recorded as running. Stop launcher-owned services with: $SCRIPT_DIR/dev-stack.sh stop"
    fi
  fi
  exit "$code"
}

on_interrupt() {
  local signal=$1
  trap - INT TERM
  err "Interrupted by $signal; stopping application processes started by this launcher."
  cleanup_started_apps
  START_ACTIVE=0
  if [[ -f $STATE_FILE ]]; then
    info "Development infrastructure is still recorded as running. Stop launcher-owned services with: $SCRIPT_DIR/dev-stack.sh stop"
  fi
  exit 130
}

container_id() {
  "${ENGINE_CMD[@]}" inspect -f '{{.Id}}' "$1" 2>/dev/null
}

container_running() {
  [[ $("${ENGINE_CMD[@]}" inspect -f '{{.State.Running}}' "$1" 2>/dev/null || true) == true ]]
}

container_owned_labels() {
  local name=$1 service=$2 project=$3 labels p s c
  labels=$("${ENGINE_CMD[@]}" inspect -f '{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "com.docker.compose.service"}}|{{index .Config.Labels "com.docker.compose.project.config_files"}}' "$name" 2>/dev/null) || return 1
  IFS='|' read -r p s c <<< "$labels"
  [[ $p == "$project" && $s == "$service" ]] || return 1
  [[ $c == *compose.test.yaml* ]] && return 1
  [[ -z $c || $c == *compose.yaml* ]] || return 1
  case $service in
    postgres) [[ $name == lumen-postgres ]] ;;
    redis) [[ $name == lumen-redis ]] ;;
    *) return 1 ;;
  esac
}

port_in_use() {
  local port=$1
  (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null
}

check_port_conflict() {
  local port=$1 label=$2
  if port_in_use "$port"; then
    die "Port $port ($label) is already in use by an unrelated process. The launcher will not kill it. Stop that process or change the configured port."
  fi
}

owned_postgres() {
  local current_id=$1 owned=0
  if [[ $PRE_PG_RUNNING != 1 ]]; then owned=1; fi
  if [[ -n $OLD_INFRA_POSTGRES_ID && $OLD_INFRA_POSTGRES_ID == "$current_id" && $OLD_INFRA_POSTGRES_OWNED == 1 ]]; then owned=1; fi
  if [[ -n $PRE_PG_ID && $PRE_PG_ID != "$current_id" ]]; then owned=1; fi
  printf '%s' "$owned"
}

owned_redis() {
  local current_id=$1 owned=0
  if [[ $PRE_REDIS_RUNNING != 1 ]]; then owned=1; fi
  if [[ -n $OLD_INFRA_REDIS_ID && $OLD_INFRA_REDIS_ID == "$current_id" && $OLD_INFRA_REDIS_OWNED == 1 ]]; then owned=1; fi
  if [[ -n $PRE_REDIS_ID && $PRE_REDIS_ID != "$current_id" ]]; then owned=1; fi
  printf '%s' "$owned"
}

record_infra_from_containers() {
  local pg_id redis_id valid=0
  pg_id=$(container_id lumen-postgres 2>/dev/null || true)
  redis_id=$(container_id lumen-redis 2>/dev/null || true)

  INFRA_POSTGRES_ID=""
  INFRA_POSTGRES_OWNED=0
  if [[ -n $pg_id ]] && container_owned_labels lumen-postgres postgres "$COMPOSE_PROJECT"; then
    INFRA_POSTGRES_ID=$pg_id
    INFRA_POSTGRES_OWNED=$(owned_postgres "$pg_id")
    valid=1
  fi
  INFRA_REDIS_ID=""
  INFRA_REDIS_OWNED=0
  if [[ -n $redis_id ]] && container_owned_labels lumen-redis redis "$COMPOSE_PROJECT"; then
    INFRA_REDIS_ID=$redis_id
    INFRA_REDIS_OWNED=$(owned_redis "$redis_id")
    valid=1
  fi
  [[ $valid == 1 ]] || return 1

  INFRA_ENGINE=$COMPOSE_ENGINE
  INFRA_CONTEXT=$COMPOSE_CONTEXT
  INFRA_PROJECT=$COMPOSE_PROJECT
  write_state
  return 0
}

start_infrastructure() {
  local target
  OLD_INFRA_POSTGRES_ID=${INFRA_POSTGRES_ID:-}
  OLD_INFRA_POSTGRES_OWNED=${INFRA_POSTGRES_OWNED:-0}
  OLD_INFRA_REDIS_ID=${INFRA_REDIS_ID:-}
  OLD_INFRA_REDIS_OWNED=${INFRA_REDIS_OWNED:-0}

  section "Starting PostgreSQL and Redis"
  if ! timeout 15 "${ENGINE_CMD[@]}" info >/dev/null 2>>"$LOG_DIR/infrastructure.log"; then
    err "Cannot reach the container engine ($(format_cmd "${ENGINE_CMD[@]}")). Start it or choose another context with LUMEN_COMPOSE_CONTEXT."
    return 1
  fi

  for target in postgres redis; do
    if [[ $target == postgres ]]; then
      if PRE_PG_ID=$(container_id lumen-postgres 2>/dev/null); then
        container_owned_labels lumen-postgres postgres "$COMPOSE_PROJECT" || \
          die "A container named lumen-postgres exists but is not this launcher's development service. Refusing to touch it. Inspect it with: $(format_cmd "${ENGINE_CMD[@]}") inspect lumen-postgres"
        container_running lumen-postgres && PRE_PG_RUNNING=1 || PRE_PG_RUNNING=0
      else
        PRE_PG_ID=""
        PRE_PG_RUNNING=0
      fi
    else
      if PRE_REDIS_ID=$(container_id lumen-redis 2>/dev/null); then
        container_owned_labels lumen-redis redis "$COMPOSE_PROJECT" || \
          die "A container named lumen-redis exists but is not this launcher's development service. Refusing to touch it. Inspect it with: $(format_cmd "${ENGINE_CMD[@]}") inspect lumen-redis"
        container_running lumen-redis && PRE_REDIS_RUNNING=1 || PRE_REDIS_RUNNING=0
      else
        PRE_REDIS_ID=""
        PRE_REDIS_RUNNING=0
      fi
    fi
  done

  [[ $PRE_PG_RUNNING == 1 ]] || check_port_conflict 5432 "PostgreSQL"
  [[ $PRE_REDIS_RUNNING == 1 ]] || check_port_conflict 6379 "Redis"

  if ! compose config --quiet >>"$LOG_DIR/infrastructure.log" 2>&1; then
    err "Compose validation failed. Last log lines:"
    tail -n 20 "$LOG_DIR/infrastructure.log" >&2 || true
    return 1
  fi
  if ! compose up -d --no-recreate postgres redis >>"$LOG_DIR/infrastructure.log" 2>&1; then
    record_infra_from_containers || true
    err "Compose could not start the development database services. Last log lines:"
    tail -n 30 "$LOG_DIR/infrastructure.log" >&2 || true
    return 1
  fi

  INFRA_ENGINE=$COMPOSE_ENGINE
  INFRA_CONTEXT=$COMPOSE_CONTEXT
  INFRA_PROJECT=$COMPOSE_PROJECT
  INFRA_POSTGRES_ID=$(container_id lumen-postgres 2>/dev/null || true)
  INFRA_REDIS_ID=$(container_id lumen-redis 2>/dev/null || true)
  [[ -n $INFRA_POSTGRES_ID && -n $INFRA_REDIS_ID ]] || {
    record_infra_from_containers || true
    err "Compose did not produce both development containers."
    return 1
  }

  INFRA_POSTGRES_OWNED=$(owned_postgres "$INFRA_POSTGRES_ID")
  INFRA_REDIS_OWNED=$(owned_redis "$INFRA_REDIS_ID")

  write_state
  info "  PostgreSQL container: ${INFRA_POSTGRES_ID:0:12}"
  info "  Redis container:      ${INFRA_REDIS_ID:0:12}"
}

pg_check() {
  (
    cd "$ROOT"
    env \
      PGHOST="${CHECK_PGHOST:-127.0.0.1}" \
      PGPORT="${CHECK_PGPORT:-5432}" \
      PGDATABASE="${CHECK_PGDATABASE:-lumen}" \
      PGUSER="${CHECK_PGUSER:-lumen}" \
      "$NODE_BEST" --env-file-if-exists="$ENV_FILE" --input-type=module -e '
        import pg from "pg";
        const pool = new pg.Pool({ max: 1, connectionTimeoutMillis: 2000 });
        try {
          await pool.query("SELECT 1");
        } catch {
          process.exitCode = 1;
        } finally {
          await pool.end().catch(() => {});
        }
      '
  ) >/dev/null 2>>"$LOG_DIR/infrastructure.log"
}

redis_check() {
  (
    cd "$ROOT"
    env \
      REDIS_HOST="${CHECK_REDIS_HOST:-127.0.0.1}" \
      REDIS_PORT="${CHECK_REDIS_PORT:-6379}" \
      REDIS_DB="${CHECK_REDIS_DB:-0}" \
      "$NODE_BEST" --env-file-if-exists="$ENV_FILE" --input-type=module -e '
        import { Redis } from "ioredis";
        const port = Number(process.env.REDIS_PORT ?? "6379");
        const db = process.env.REDIS_DB ? Number(process.env.REDIS_DB) : undefined;
        const password = process.env.REDIS_PASSWORD?.trim() || undefined;
        const client = new Redis({
          host: process.env.REDIS_HOST ?? "127.0.0.1",
          port,
          ...(password ? { password } : {}),
          ...(db !== undefined ? { db } : {}),
          lazyConnect: true,
          connectTimeout: 2000,
          maxRetriesPerRequest: 1,
          enableOfflineQueue: false,
          retryStrategy: () => null,
        });
        client.on("error", () => {});
        try {
          await client.connect();
          const pong = await client.ping();
          if (pong !== "PONG") process.exitCode = 1;
        } catch {
          process.exitCode = 1;
        } finally {
          client.disconnect();
        }
      '
  ) >/dev/null 2>>"$LOG_DIR/infrastructure.log"
}

set_start_checks() {
  CHECK_PGHOST=$STACK_PGHOST
  CHECK_PGPORT=$STACK_PGPORT
  CHECK_PGDATABASE=$STACK_PGDATABASE
  CHECK_PGUSER=$STACK_PGUSER
  CHECK_REDIS_HOST=$STACK_REDIS_HOST
  CHECK_REDIS_PORT=$STACK_REDIS_PORT
  CHECK_REDIS_DB=$STACK_REDIS_DB
}

set_state_checks() {
  CHECK_PGHOST=${STACK_PGHOST:-127.0.0.1}
  CHECK_PGPORT=${STACK_PGPORT:-5432}
  CHECK_PGDATABASE=${STACK_PGDATABASE:-lumen}
  CHECK_PGUSER=${STACK_PGUSER:-lumen}
  CHECK_REDIS_HOST=${STACK_REDIS_HOST:-127.0.0.1}
  CHECK_REDIS_PORT=${STACK_REDIS_PORT:-6379}
  CHECK_REDIS_DB=${STACK_REDIS_DB:-0}
}

wait_for_postgres() {
  local i
  for ((i = 1; i <= 45; i++)); do
    pg_check && return 0
    sleep 1
  done
  return 1
}

wait_for_redis() {
  local i
  for ((i = 1; i <= 30; i++)); do
    redis_check && return 0
    sleep 1
  done
  return 1
}

verify_migrations() {
  local status_file="$RUN_DIR/migrate-status.txt"
  section "Checking database migrations"
  if ! (cd "$ROOT" && timeout 60 "$NPM_BIN" run --silent db:migrate:status) >"$status_file" 2>&1; then
    cat "$status_file" >>"$LOG_DIR/infrastructure.log" 2>/dev/null || true
    err "Could not read migration status. Last output:"
    tail -n 20 "$status_file" >&2 || true
    rm -f "$status_file"
    return 1
  fi
  cat "$status_file" >>"$LOG_DIR/infrastructure.log" 2>/dev/null || true
  if grep -q 'PENDING' "$status_file"; then
    err "Pending database migrations were found. The launcher will not apply them."
    info ""
    info "Review the target and pending list:"
    info "  npm run db:migrate:status"
    info ""
    info "Then apply only the reviewed up migrations explicitly:"
    info "  npm run db:migrate"
    info ""
    info "Migration down/reset commands are destructive and are not part of this workflow."
    rm -f "$status_file"
    return 1
  fi
  rm -f "$status_file"
  info "  All on-disk migrations are applied."
  return 0
}

http_status() {
  local url=$1
  if command -v curl >/dev/null 2>&1; then
    local code
    code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 3 "$url" 2>/dev/null || true)
    printf '%s' "${code:-000}"
  else
    "$NODE_BEST" -e '
      const url = process.argv[1];
      const timer = setTimeout(() => { console.log("000"); process.exit(0); }, 3000);
      fetch(url).then((response) => {
        console.log(String(response.status));
      }).catch(() => {
        console.log("000");
      }).finally(() => {
        clearTimeout(timer);
      });
    ' "$url"
  fi
}

wait_for_api() {
  local i code
  for ((i = 1; i <= 60; i++)); do
    if ! load_record api; then
      err "API exited before becoming ready. Last log lines:"
      tail -n 25 "$LOG_DIR/api.log" >&2 || true
      return 1
    fi
    code=$(http_status "$API_URL/ready")
    [[ $code == 200 ]] && return 0
    sleep 1
  done
  err "API did not become ready at $API_URL/ready within 60 seconds. Last log lines:"
  tail -n 25 "$LOG_DIR/api.log" >&2 || true
  return 1
}

wait_for_web() {
  local i code
  for ((i = 1; i <= 60; i++)); do
    if ! load_record web; then
      err "Frontend exited before becoming ready. Last log lines:"
      tail -n 25 "$LOG_DIR/web.log" >&2 || true
      return 1
    fi
    code=$(http_status "$WEB_URL")
    if [[ ! $code =~ ^[23][0-9][0-9]$ ]]; then
      code=$(http_status "$WEB_ORIGIN/")
    fi
    if [[ $code =~ ^[23][0-9][0-9]$ ]]; then
      return 0
    fi
    sleep 1
  done
  err "Frontend did not respond at $WEB_URL within 60 seconds. Last log lines:"
  tail -n 25 "$LOG_DIR/web.log" >&2 || true
  return 1
}

check_app_process_alive() {
  local name=$1
  if ! load_record "$name"; then
    err "$name exited shortly after starting. Last log lines:"
    tail -n 25 "$LOG_DIR/$name.log" >&2 || true
    return 1
  fi
  return 0
}

rotate_logs() {
  local name file
  for name in api worker publisher web infrastructure; do
    file="$LOG_DIR/$name.log"
    if [[ -f $file ]]; then
      mv -f "$file" "$file.prev"
    fi
    : > "$file"
    chmod 600 "$file"
  done
}

check_existing_state() {
  local name
  local saved_api_url=$API_URL saved_web_origin=$WEB_ORIGIN saved_web_url=$WEB_URL
  local saved_pg_host=$STACK_PGHOST saved_pg_port=$STACK_PGPORT saved_pg_database=$STACK_PGDATABASE saved_pg_user=$STACK_PGUSER
  local saved_redis_host=$STACK_REDIS_HOST saved_redis_port=$STACK_REDIS_PORT saved_redis_db=$STACK_REDIS_DB

  for name in api worker publisher web; do
    if load_record "$name"; then
      die "$name is already running (pid $REC_PID). Use './scripts/dev-stack.sh restart' or './scripts/dev-stack.sh status'."
    fi
    if [[ -f "$RUN_DIR/$name.pid" ]]; then
      rm -f "$RUN_DIR/$name.pid"
    fi
  done

  if load_state; then
    if [[ $INFRA_ENGINE != "$COMPOSE_ENGINE" || $INFRA_CONTEXT != "$COMPOSE_CONTEXT" || $INFRA_PROJECT != "$COMPOSE_PROJECT" ]]; then
      die "The recorded stack uses $INFRA_ENGINE/$INFRA_CONTEXT project '$INFRA_PROJECT', but current settings are $COMPOSE_ENGINE/$COMPOSE_CONTEXT project '$COMPOSE_PROJECT'. Run stop first or match the original settings."
    fi
  fi

  # load_state() exists to restore recorded runtime status; a start must keep
  # the configuration validated from the current environment.
  API_URL=$saved_api_url
  WEB_ORIGIN=$saved_web_origin
  WEB_URL=$saved_web_url
  STACK_PGHOST=$saved_pg_host
  STACK_PGPORT=$saved_pg_port
  STACK_PGDATABASE=$saved_pg_database
  STACK_PGUSER=$saved_pg_user
  STACK_REDIS_HOST=$saved_redis_host
  STACK_REDIS_PORT=$saved_redis_port
  STACK_REDIS_DB=$saved_redis_db
}

dry_run_plan() {
  local engine
  engine=$(format_cmd "${COMPOSE_CMD[@]}")
  section "Dry run: no services, containers, logs, state, or migrations will be changed"
  info "Node:            v$NODE_BEST_VERSION ($NODE_BEST)"
  info "Container setup: $engine"
  info "Compose project: $COMPOSE_PROJECT"
  info "Compose file:    $COMPOSE_FILE"
  info "Environment:     $ENV_FILE (contents not printed)"
  info "Runtime:         $RUNTIME_DIR"
  info "API URL:         $API_URL"
  info "Web URL:         $WEB_URL"
  info ""
  info "Would run:"
  info "  $engine --project-name $COMPOSE_PROJECT --env-file .env -f compose.yaml config --quiet"
  info "  $engine --project-name $COMPOSE_PROJECT --env-file .env -f compose.yaml up -d --no-recreate postgres redis"
  info "  wait for PostgreSQL and Redis with the application clients"
  info "  npm run db:migrate:status    # report pending migrations; never apply them"
  info "  HOST=$API_HOST PORT=$API_PORT npm run dev"
  info "  npm run worker"
  info "  npm run outbox:publisher"
  info "  (cd $WEB_DIR && npm run dev -- --port $WEB_PORT --strictPort)"
  info ""
  info "No migration, container start, process start, or upload was performed."
}

cmd_start() {
  local want_dry_run=$DRY_RUN
  if [[ ${1:-} == "--dry-run" ]]; then
    want_dry_run=1
  elif [[ -n ${1:-} ]]; then
    die "Unknown start option: $1"
  fi

  select_node
  validate_start_environment
  detect_compose

  if [[ $want_dry_run == 1 ]]; then
    dry_run_plan
    return 0
  fi

  acquire_lock
  trap on_exit EXIT
  trap 'on_interrupt INT' INT
  trap 'on_interrupt TERM' TERM

  check_existing_state
  check_port_conflict "$API_PORT" "API"
  check_port_conflict "$WEB_PORT" "frontend"
  rotate_logs
  START_ACTIVE=1
  set_start_checks

  if ! start_infrastructure; then
    die "Infrastructure startup failed. No application processes were started."
  fi

  section "Waiting for infrastructure readiness"
  if ! wait_for_postgres; then
    die "PostgreSQL did not accept connections within 45 seconds. See $LOG_DIR/infrastructure.log."
  fi
  info "  PostgreSQL is ready."
  if ! wait_for_redis; then
    die "Redis did not answer PING within 30 seconds. See $LOG_DIR/infrastructure.log."
  fi
  info "  Redis is ready."

  if ! verify_migrations; then
    die "Startup stopped before application processes were launched. Infrastructure remains running."
  fi

  section "Starting application processes"
  if ! start_tracked api api.log "$ROOT" env HOST="$API_HOST" PORT="$API_PORT" "$NPM_BIN" run --silent dev; then
    die "API failed to start. See $LOG_DIR/api.log."
  fi
  if ! wait_for_api; then
    die "API readiness failed."
  fi
  info "  API is ready at $API_URL/ready"

  if ! start_tracked worker worker.log "$ROOT" "$NPM_BIN" run --silent worker; then
    die "Worker failed to start. See $LOG_DIR/worker.log."
  fi
  if ! start_tracked publisher publisher.log "$ROOT" "$NPM_BIN" run --silent outbox:publisher; then
    die "Outbox publisher failed to start. See $LOG_DIR/publisher.log."
  fi
  sleep 1
  check_app_process_alive worker || die "Worker exited during startup."
  check_app_process_alive publisher || die "Outbox publisher exited during startup."
  info "  Worker and outbox publisher are running."

  if ! start_tracked web web.log "$WEB_DIR" "$NPM_BIN" run --silent dev -- --port "$WEB_PORT" --strictPort; then
    die "Frontend failed to start. See $LOG_DIR/web.log."
  fi
  if ! wait_for_web; then
    die "Frontend readiness failed."
  fi
  info "  Frontend is ready at $WEB_URL"

  START_ACTIVE=0
  trap - EXIT INT TERM

  section "Stack status"
  if ! report_status; then
    err "Startup finished, but the post-start status check found a problem. See logs under $LOG_DIR."
    exit 1
  fi
  info ""
  info "${C_GREEN}Lumen development stack is running.${C_RESET}"
  info "  API:  $API_URL  (health: /health, readiness: /ready)"
  info "  Web:  $WEB_URL"
  info "  Logs: $LOG_DIR"
  info "  Stop: $SCRIPT_DIR/dev-stack.sh stop"
}

report_status() {
  local healthy=0 code pg_ready="not managed" redis_ready="not managed"
  local api_proc="stopped" worker_proc="stopped" publisher_proc="stopped" web_proc="stopped"
  local api_health="not checked" api_ready="not checked" web_http="not checked"
  local pg_container="not recorded" redis_container="not recorded"

  section "Lumen development stack status"
  if ! load_state; then
    info "Launcher state: not present (this stack was not started by the launcher, or it was stopped)."
    warn "Without recorded state, the launcher will not probe or stop containers."
    healthy=1
  else
    set_state_checks
    if engine_from_state; then
      if [[ -n ${INFRA_POSTGRES_ID:-} ]]; then
        if container_running "$INFRA_POSTGRES_ID"; then
          pg_container="running (${INFRA_POSTGRES_ID:0:12})"
        else
          pg_container="stopped (${INFRA_POSTGRES_ID:0:12})"
          healthy=1
        fi
        if pg_check; then pg_ready="ready"; else pg_ready="not ready"; healthy=1; fi
      else
        pg_container="not recorded"
        healthy=1
      fi
      if [[ -n ${INFRA_REDIS_ID:-} ]]; then
        if container_running "$INFRA_REDIS_ID"; then
          redis_container="running (${INFRA_REDIS_ID:0:12})"
        else
          redis_container="stopped (${INFRA_REDIS_ID:0:12})"
          healthy=1
        fi
        if redis_check; then redis_ready="ready"; else redis_ready="not ready"; healthy=1; fi
      else
        redis_container="not recorded"
        healthy=1
      fi
    else
      pg_ready="unknown (container engine unavailable)"
      redis_ready="unknown (container engine unavailable)"
      healthy=1
    fi
  fi

  if load_record api; then
    api_proc="running (pid $REC_PID)"
  else
    healthy=1
  fi
  if load_record worker; then
    worker_proc="running (pid $REC_PID)"
  else
    healthy=1
  fi
  if load_record publisher; then
    publisher_proc="running (pid $REC_PID)"
  else
    healthy=1
  fi
  if load_record web; then
    web_proc="running (pid $REC_PID)"
  else
    healthy=1
  fi

  if [[ $api_proc == running* ]]; then
    code=$(http_status "${API_URL:-http://127.0.0.1:3000}/health")
    [[ $code == 200 ]] && api_health="ok" || { api_health="HTTP $code"; healthy=1; }
    code=$(http_status "${API_URL:-http://127.0.0.1:3000}/ready")
    [[ $code == 200 ]] && api_ready="ok" || { api_ready="HTTP $code"; healthy=1; }
  else
    api_health="not checked"
    api_ready="not checked"
  fi
  if [[ $web_proc == running* ]]; then
    code=$(http_status "${WEB_URL:-${WEB_ORIGIN:-http://127.0.0.1:5173}/}")
    if [[ ! $code =~ ^[23][0-9][0-9]$ ]]; then
      code=$(http_status "${WEB_ORIGIN:-http://127.0.0.1:5173}/")
    fi
    if [[ $code =~ ^[23][0-9][0-9]$ ]]; then web_http="ok"; else web_http="HTTP $code"; healthy=1; fi
  else
    web_http="not checked"
  fi

  info "  PostgreSQL:          container $pg_container; readiness $pg_ready"
  info "  Redis:               container $redis_container; readiness $redis_ready"
  info "  API process:         $api_proc"
  info "  API liveness:        $api_health"
  info "  API readiness:       $api_ready"
  info "  Worker process:      $worker_proc"
  info "  Outbox publisher:    $publisher_proc"
  info "  Frontend process:    $web_proc"
  info "  Frontend HTTP:       $web_http"
  info ""
  info "  API URL:             ${API_URL:-not recorded}"
  if [[ -n ${API_URL:-} ]]; then
    info "  Health URL:          $API_URL/health"
    info "  Readiness URL:       $API_URL/ready"
  else
    info "  Health URL:          not recorded"
    info "  Readiness URL:       not recorded"
  fi
  info "  Web URL:             ${WEB_URL:-not recorded}"
  info "  PostgreSQL/Redis:    loopback only (no public bind)"
  info "  Logs:                $LOG_DIR"

  if [[ $healthy == 0 ]]; then
    info ""
    info "${C_GREEN}All managed services report healthy.${C_RESET}"
    return 0
  fi
  info ""
  warn "One or more managed services are not healthy."
  return 1
}

container_stop() {
  local service=$1 name=$2 expected_id=$3 owned=$4 project=$5 failures=0 running
  if [[ -z $expected_id ]]; then
    return 0
  fi
  if [[ $owned != 1 ]]; then
    info "  $service container was not started by this launcher; leaving it running."
    return 0
  fi
  if ! "${ENGINE_CMD[@]}" inspect -f '{{.Id}}' "$expected_id" >/dev/null 2>&1; then
    info "  $service container is already absent."
    return 0
  fi
  if ! container_owned_labels "$name" "$service" "$project"; then
    warn "Container $name no longer matches the recorded Compose project; refusing to stop it."
    return 1
  fi
  if [[ $(container_id "$name" 2>/dev/null || true) != "$expected_id" ]]; then
    warn "Container $name ID changed since launch; refusing to stop it."
    return 1
  fi
  running=$("${ENGINE_CMD[@]}" inspect -f '{{.State.Running}}' "$expected_id" 2>/dev/null || true)
  if [[ $running != true ]]; then
    info "  $service container is already stopped."
    return 0
  fi
  info "  Stopping $service container (${expected_id:0:12})..."
  if ! "${ENGINE_CMD[@]}" stop --time 10 "$expected_id" >>"$LOG_DIR/infrastructure.log" 2>&1; then
    err "Could not stop the $service container. It was not removed."
    failures=1
  fi
  return "$failures"
}

cmd_stop() {
  local failures=0 name
  if [[ ${1:-} == "--dry-run" ]]; then
    info "Dry run: stop would use recorded PID identities and container IDs; no signals would be sent."
    return 0
  elif [[ -n ${1:-} ]]; then
    die "Unknown stop option: $1"
  fi

  acquire_lock
  ensure_runtime_dirs
  section "Stopping Lumen development stack"

  for name in web api publisher worker; do
    stop_tracked "$name" || failures=1
  done

  if ! load_state; then
    info "  No launcher state found; no containers will be stopped."
  else
    if engine_from_state; then
      if ! timeout 15 "${ENGINE_CMD[@]}" info >/dev/null 2>>"$LOG_DIR/infrastructure.log"; then
        err "Recorded container engine is unreachable; cannot verify or stop containers."
        failures=1
      else
        container_stop postgres lumen-postgres "${INFRA_POSTGRES_ID:-}" "${INFRA_POSTGRES_OWNED:-0}" "${INFRA_PROJECT:-$COMPOSE_PROJECT}" || failures=1
        container_stop redis lumen-redis "${INFRA_REDIS_ID:-}" "${INFRA_REDIS_OWNED:-0}" "${INFRA_PROJECT:-$COMPOSE_PROJECT}" || failures=1
      fi
    else
      err "Recorded container engine is unavailable; cannot verify or stop containers."
      failures=1
    fi
  fi

  if [[ $failures == 0 ]]; then
    rm -f "$STATE_FILE"
    info ""
    info "${C_GREEN}Launcher-owned processes and containers are stopped.${C_RESET}"
    info "Persistent PostgreSQL/Redis volumes and logs were left intact."
    return 0
  fi

  err "Some resources could not be stopped. State was kept so a later stop can retry."
  return 1
}

cmd_status() {
  local rc=0
  if [[ -n ${1:-} ]]; then
    die "Unknown status option: $1"
  fi
  select_node
  report_status || rc=1
  return "$rc"
}

resolve_log_files() {
  local request=$1
  case $request in
    all) printf '%s\n' api worker publisher web infrastructure ;;
    api|worker|publisher|web|infrastructure) printf '%s\n' "$request" ;;
    *)
      err "Unknown log service '$request'. Use api, worker, publisher, web, infrastructure, or all."
      return 1
      ;;
  esac
}

cmd_logs() {
  local request=all follow=1 arg line file
  local files=()
  for arg in "$@"; do
    case $arg in
      --no-follow) follow=0 ;;
      -*) err "Unknown logs option: $arg"; return 2 ;;
      *) [[ $request == all ]] || { err "Only one log service may be selected."; return 2; }; request=$arg ;;
    esac
  done

  resolve_log_files "$request" >/dev/null || return 2
  [[ -d $LOG_DIR ]] || die "No logs directory exists yet at $LOG_DIR."
  while IFS= read -r line; do
    file="$LOG_DIR/$line.log"
    [[ -f $file ]] && files+=("$file")
  done < <(resolve_log_files "$request") || return 2

  [[ ${#files[@]} -gt 0 ]] || die "No log files exist for '$request' yet."
  if [[ $follow == 1 ]]; then
    info "Following $(format_cmd "${files[@]}") (Ctrl+C to stop)..."
    tail -n 100 -F "${files[@]}"
  else
    tail -n 200 "${files[@]}"
  fi
}

cmd_restart() {
  if [[ -n ${1:-} && ${1:-} != "--dry-run" ]]; then
    die "Unknown restart option: $1"
  fi
  if [[ ${1:-} == "--dry-run" || $DRY_RUN == 1 ]]; then
    info "Dry run: restart would stop only launcher-owned resources, then start the stack. Nothing was changed."
    cmd_start --dry-run
    return $?
  fi
  cmd_stop || die "Restart stopped because the stack could not be fully stopped."
  cmd_start
}

main() {
  local command=${1:-help}
  shift || true
  case $command in
    start) cmd_start "$@" ;;
    stop) cmd_stop "$@" ;;
    restart) cmd_restart "$@" ;;
    status) cmd_status "$@" ;;
    logs) cmd_logs "$@" ;;
    help|-h|--help) usage ;;
    *)
      err "Unknown command: $command"
      usage >&2
      return 2
      ;;
  esac
}

main "$@"
