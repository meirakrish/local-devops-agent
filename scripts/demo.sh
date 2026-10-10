#!/usr/bin/env bash
# Demo environment: a kind cluster with deliberately broken workloads.
#
#   scripts/demo.sh up       create the cluster (if needed), deploy workloads, wait until they fail
#   scripts/demo.sh check    run the health check against the demo cluster (extra args are passed on)
#   scripts/demo.sh status   show nodes and demo pods
#   scripts/demo.sh reset    redeploy the workloads from scratch (e.g. after fixing some)
#   scripts/demo.sh down     delete the cluster
#
# The cluster's kubeconfig is written to .demo/kubeconfig, so your current kubectl
# context (e.g. minikube) is never changed. To use kubectl against the demo cluster:
#   export KUBECONFIG="$PWD/.demo/kubeconfig"
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEMO_DIR="$ROOT/.demo"
CLUSTER="devops-agent-demo"
NAMESPACE="agent-test"
KIND_VERSION="v0.33.0"
WAIT_SECONDS="${DEMO_WAIT_SECONDS:-300}"

# Every kubectl/kind call in this script uses the demo kubeconfig only.
export KUBECONFIG="$DEMO_DIR/kubeconfig"

info() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
ok() { printf '  \033[32m✓\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

require_tools() {
  command -v docker >/dev/null || fail "docker is not installed"
  docker info >/dev/null 2>&1 || fail "docker is not running (or your user cannot access it)"
  command -v kubectl >/dev/null || fail "kubectl is not installed: https://kubernetes.io/docs/tasks/tools/"
}

# Linux limits the number of inotify instances per user; each kind node (and any
# minikube node) uses many. Too few makes the API server fail during `kind create`.
# https://kind.sigs.k8s.io/docs/user/known-issues/#pod-errors-due-to-too-many-open-files
check_inotify() {
  local limit_file=/proc/sys/fs/inotify/max_user_instances
  [[ -r "$limit_file" ]] || return 0
  local limit
  limit="$(cat "$limit_file")"
  if ((limit < 512)); then
    printf '\033[1;33mwarning:\033[0m fs.inotify.max_user_instances is %s; kind recommends 512.\n' "$limit" >&2
    printf '  If cluster creation fails (especially with other clusters running), raise it with:\n' >&2
    printf '    sudo sysctl fs.inotify.max_user_instances=512\n' >&2
    printf '  To keep it after reboot: echo fs.inotify.max_user_instances=512 | sudo tee /etc/sysctl.d/99-kind.conf\n' >&2
  fi
}

# Uses kind from PATH if available, otherwise downloads the pinned version into .demo/bin
# (no sudo, nothing installed system-wide) and verifies its checksum.
KIND=""
find_kind() {
  if command -v kind >/dev/null; then
    KIND="$(command -v kind)"
    return
  fi
  KIND="$DEMO_DIR/bin/kind"
  if [[ -x "$KIND" ]] && "$KIND" version | grep -q "$KIND_VERSION"; then
    return
  fi

  local os arch url sum_file
  os="$(uname -s | tr '[:upper:]' '[:lower:]')"
  case "$(uname -m)" in
    x86_64 | amd64) arch="amd64" ;;
    aarch64 | arm64) arch="arm64" ;;
    *) fail "unsupported CPU architecture: $(uname -m)" ;;
  esac
  url="https://github.com/kubernetes-sigs/kind/releases/download/${KIND_VERSION}/kind-${os}-${arch}"

  info "Downloading kind ${KIND_VERSION} to .demo/bin"
  mkdir -p "$DEMO_DIR/bin"
  curl -fsSL -o "$KIND.download" "$url"
  sum_file="$(curl -fsSL "${url}.sha256sum")"
  local expected actual
  expected="${sum_file%% *}"
  if command -v sha256sum >/dev/null; then
    actual="$(sha256sum "$KIND.download" | cut -d' ' -f1)"
  else
    actual="$(shasum -a 256 "$KIND.download" | cut -d' ' -f1)"
  fi
  [[ "$expected" == "$actual" ]] || { rm -f "$KIND.download"; fail "kind checksum mismatch (expected $expected, got $actual)"; }
  chmod +x "$KIND.download"
  mv "$KIND.download" "$KIND"
  ok "kind ${KIND_VERSION} (checksum verified)"
}

cluster_exists() {
  "$KIND" get clusters 2>/dev/null | grep -qx "$CLUSTER"
}

# Prints the value of a jsonpath query over the pods of one demo deployment.
pods_of() {
  kubectl get pods -n "$NAMESPACE" -l "app=$1" -o "jsonpath=$2" 2>/dev/null || true
}

# Waits until every workload shows its intended state, so a check right after
# `up` sees real failures instead of pods that are still starting.
wait_for_failures() {
  info "Waiting for the workloads to reach their broken state (up to ${WAIT_SECONDS}s)"
  local deadline=$((SECONDS + WAIT_SECONDS))
  declare -A reached=()
  local names=(web payments cache batch metrics-agent frontend storefront webhook)
  declare -A labels=(
    [web]="web: CrashLoopBackOff (missing DATABASE_URL)"
    [payments]="payments: ImagePullBackOff (image tag does not exist)"
    [cache]="cache: OOMKilled (32Mi memory limit)"
    [batch]="batch: Unschedulable (requests 1000 CPUs)"
    [metrics-agent]="metrics-agent: pods rejected by Pod Security (hostNetwork)"
    [frontend]="frontend: healthy (2/2 ready)"
    [storefront]="storefront: Service selector matches no pods (typo)"
    [webhook]="agent-demo-policy: webhook with no ready endpoints (failurePolicy=Fail)"
  )

  while ((SECONDS < deadline)); do
    for name in "${names[@]}"; do
      [[ -n "${reached[$name]:-}" ]] && continue
      local hit=""
      case "$name" in
        web) [[ "$(pods_of web '{.items[*].status.containerStatuses[*].restartCount}')" =~ [1-9] ]] && hit=1 ;;
        payments) [[ "$(pods_of payments '{.items[*].status.containerStatuses[*].state.waiting.reason}')" =~ ImagePull|ErrImage ]] && hit=1 ;;
        cache) [[ "$(pods_of cache '{.items[*].status.containerStatuses[*].lastState.terminated.reason} {.items[*].status.containerStatuses[*].state.terminated.reason}')" =~ OOMKilled ]] && hit=1 ;;
        batch) [[ "$(pods_of batch '{.items[*].status.conditions[?(@.type=="PodScheduled")].reason}')" =~ Unschedulable ]] && hit=1 ;;
        metrics-agent) [[ "$(kubectl get events -n "$NAMESPACE" --field-selector reason=FailedCreate -o 'jsonpath={.items[*].involvedObject.name}' 2>/dev/null)" =~ metrics-agent ]] && hit=1 ;;
        storefront) kubectl get service storefront -n "$NAMESPACE" >/dev/null 2>&1 && hit=1 ;;
        frontend) [[ "$(kubectl get deployment frontend -n "$NAMESPACE" -o 'jsonpath={.status.readyReplicas}' 2>/dev/null)" == "2" ]] && hit=1 ;;
        webhook) kubectl get validatingwebhookconfiguration agent-demo-policy >/dev/null 2>&1 &&
          kubectl get service policy-webhook -n "$NAMESPACE" >/dev/null 2>&1 && hit=1 ;;
      esac
      if [[ -n "$hit" ]]; then
        reached[$name]=1
        ok "${labels[$name]}"
      fi
    done
    ((${#reached[@]} == ${#names[@]})) && return 0
    sleep 3
  done

  printf '\n'
  kubectl get pods -n "$NAMESPACE" >&2 || true
  fail "timed out; not every workload reached its expected state (see pods above). Image pulls can be slow on the first run: try 'scripts/demo.sh reset'."
}

deploy_workloads() {
  info "Deploying demo workloads (namespace $NAMESPACE)"
  kubectl apply -f "$ROOT/demo/workloads.yaml"
}

cmd_up() {
  require_tools
  find_kind
  mkdir -p "$DEMO_DIR"
  if cluster_exists; then
    info "Cluster $CLUSTER already exists; reusing it"
    "$KIND" export kubeconfig --name "$CLUSTER" --kubeconfig "$KUBECONFIG" >/dev/null
  else
    check_inotify
    info "Creating kind cluster $CLUSTER (1 control plane + 1 worker; takes about a minute)"
    "$KIND" create cluster --config "$ROOT/demo/kind-cluster.yaml" --kubeconfig "$KUBECONFIG" --wait 180s
  fi
  deploy_workloads
  wait_for_failures
  printf '\n'
  info "Demo is ready. Next:"
  printf '    pnpm demo:check --verbose    # run the agent against the demo cluster\n'
  printf '    pnpm demo:down               # delete the cluster when done\n'
}

require_cluster() {
  require_tools
  find_kind
  cluster_exists || fail "demo cluster is not running; start it with: pnpm demo:up"
  [[ -f "$KUBECONFIG" ]] || "$KIND" export kubeconfig --name "$CLUSTER" --kubeconfig "$KUBECONFIG" >/dev/null
}

cmd_check() {
  require_cluster
  # KUBECONFIG from the environment overrides .env, so the agent scans the demo cluster.
  cd "$ROOT"
  exec pnpm -s check "$@"
}

cmd_status() {
  require_cluster
  kubectl get nodes
  printf '\n'
  kubectl get pods -n "$NAMESPACE" -o wide
}

cmd_reset() {
  require_cluster
  info "Deleting namespace $NAMESPACE"
  kubectl delete namespace "$NAMESPACE" --wait --ignore-not-found
  deploy_workloads
  wait_for_failures
}

cmd_down() {
  require_tools
  find_kind
  if cluster_exists; then
    info "Deleting kind cluster $CLUSTER"
    "$KIND" delete cluster --name "$CLUSTER" --kubeconfig "$KUBECONFIG"
  else
    info "Cluster $CLUSTER does not exist"
  fi
  rm -f "$KUBECONFIG"
}

case "${1:-}" in
  up) cmd_up ;;
  check) shift; cmd_check "$@" ;;
  status) cmd_status ;;
  reset) cmd_reset ;;
  down) cmd_down ;;
  *)
    sed -n '2,13p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
    exit 1
    ;;
esac
