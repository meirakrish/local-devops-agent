# Kubernetes Health Report

**Status: CRITICAL**  
Context: `kind-devops-agent-demo`  
Scope: all namespaces  
Scanned at: 2026-10-09T11:09:45.594Z

## Summary

| Check | Result |
| --- | --- |
| Nodes ready | 2/2 |
| Pods running | 16/18 |
| Deployments fully ready | 3/7 |
| Warning events (recent) | 28 |
| Issues | 11 critical, 0 warning, 0 info |
| Investigated by LLM | 4 problem(s) |

## Investigated problems

### 1. [CRITICAL] Pod `batch-5f5678686c-pmv6m` is unschedulable due to insufficient CPU resources.

**Affected:** Pod agent-test/batch-5f5678686c-pmv6m, Deployment agent-test/batch

**Root cause:** Insufficient CPU: 0/2 nodes are available: 1 Insufficient cpu, 1 node(s) had untolerated taint(s). preemption: 0/2 nodes are available: 2 Preemption is not helpful for scheduling.

**Evidence:**

- The pod requires 1000m CPU, but each node has only 12 CPU allocatable.
- No node can ever fit this pod: requests cpu=1000, largest node allocatable cpu=12.
- The pod has been failing to schedule since its creation.
- The cluster has only two nodes, each with 12 CPU allocatable.

**Suggested fix** (not applied):

1. Lower the CPU request for the pod `batch-5f5678686c-pmv6m` to a value that fits within the available CPU resources on the nodes.
2. Consider adjusting the resource requests in the pod's manifest.

_Confidence: high · 3 tool call(s)_

### 2. [CRITICAL] Pod and deployment are failing due to an invalid image name.

**Affected:** Pod agent-test/payments-9877b44c9-fcc6z, Deployment agent-test/payments

**Root cause:** The image `nginx:1.99.99-doesnotexist` does not exist in the Docker registry.

**Evidence:**

- ImagePullBackOff: Back-off pulling image "nginx:1.99.99-doesnotexist": ErrImagePull: rpc error: code = NotFound desc = failed to pull and unpack image "docker.io/library/nginx:1.99.99-doesnotexist": failed to resolve reference "docker.io/library/nginx:1.99.99-doesnotexist": docker.io/library/nginx:…
- Replicas: desired=1 ready=0 available=0 updated=1
- Pods: - agent-test/payments-9877b44c9-fcc6z Pending ready=0/1 restarts=0 reason=ImagePullBackOff node=devops-agent-demo-worker
- Deployment: Progressing=False (ProgressDeadlineExceeded): ReplicaSet "payments-9877b44c9" has timed out progressing.

**Suggested fix** (not applied):

1. Update the deployment to use a valid image.
2. Check and correct the image name in the deployment manifest.
3. Verify the image is available in the Docker registry.

_Confidence: high · 3 tool call(s)_

### 3. [CRITICAL] Pods in the agent-test/web deployment are crashing due to the missing DATABASE_URL environment variable.

**Affected:** Pod agent-test/web-7db8d69f68-7x2kz, Pod agent-test/web-7db8d69f68-xmr99, Deployment agent-test/web

**Root cause:** DATABASE_URL is not set, cannot connect to database

**Evidence:**

- Both pods web-7db8d69f68-7x2kz and web-7db8d69f68-xmr99 are in CrashLoopBackOff state.
- Logs show 'FATAL: DATABASE_URL is not set, cannot connect to database'.
- Deployment agent-test/web has 0/2 replicas ready.
- Desired 2 replicas, but 0 are ready due to MinimumReplicasUnavailable condition.

**Suggested fix** (not applied):

1. Set the DATABASE_URL environment variable for the deployment using `kubectl set env deployment/agent-test/web DATABASE_URL=<your-database-url>`.
2. Apply the updated deployment configuration using `kubectl apply -f <your-deployment-file.yaml>`.

_Confidence: high · 2 tool call(s)_

### 4. [CRITICAL] Pod `cache-5cc48794d-2lc5m` is OOMKilled due to excessive memory usage.

**Affected:** Pod agent-test/cache-5cc48794d-2lc5m, Deployment agent-test/cache

**Root cause:** The container `cache` is consuming more memory than its limit, leading to an OOMKilled error.

**Evidence:**

- Container `cache` was OOMKilled with exit code 137.
- Pod `cache-5cc48794d-2lc5m` has 8 restarts due to `CrashLoopBackOff`.
- Container `cache` has a memory limit of 32Mi, but it is being OOMKilled.
- Deployment `agent-test/cache` has 0 ready replicas.

**Suggested fix** (not applied):

1. Increase the memory limit for the container `cache` in the deployment's pod template.
2. Apply the updated deployment configuration.

_Confidence: high · 3 tool call(s)_

## Other issues (rule-based)

None; all issues are covered above.

## Recent warning events

| Last seen | Object | Reason | Count | Message |
| --- | --- | --- | --- | --- |
| 2026-10-09 11:09:37 | Pod agent-test/web-7db8d69f68-xmr99 | BackOff | 16 | Back-off restarting failed container app in pod web-7db8d69f68-xmr99_agent-test(715c9df7-7baa-4c08-b014-717c33de2d98) |
| 2026-10-09 11:09:18 | Pod agent-test/web-7db8d69f68-7x2kz | BackOff | 17 | Back-off restarting failed container app in pod web-7db8d69f68-7x2kz_agent-test(49e6b2f7-eaf8-4e82-8a65-5ac57b98ab72) |
| 2026-10-09 11:09:08 | Pod agent-test/cache-5cc48794d-2lc5m | BackOff | 16 | Back-off restarting failed container cache in pod cache-5cc48794d-2lc5m_agent-test(c885843e-5061-47d3-bdde-de2360d220b5) |
| 2026-10-09 11:07:50 | Pod agent-test/payments-9877b44c9-fcc6z | Failed | 61 | Error: ImagePullBackOff |
| 2026-10-09 11:07:25 | Pod agent-test/batch-5f5678686c-pmv6m | FailedScheduling | 4 | 0/2 nodes are available: 1 Insufficient cpu, 1 node(s) had untolerated taint(s). preemption: 0/2 nodes are available: 2… |
| 2026-10-09 10:55:51 | Pod agent-test/payments-9877b44c9-fcc6z | Failed | 5 | Failed to pull image "nginx:1.99.99-doesnotexist": rpc error: code = NotFound desc = failed to pull and unpack image "d… |
| 2026-10-09 10:55:51 | Pod agent-test/payments-9877b44c9-fcc6z | Failed | 5 | Error: ErrImagePull |
| 2026-10-09 10:53:09 | Pod agent-test/frontend-69c48cc879-jvkr6 | Unhealthy | 1 | Readiness probe failed: Get "http://10.244.1.5:80/": dial tcp 10.244.1.5:80: connect: connection refused |
| 2026-10-09 10:52:23 | Pod kube-system/kube-apiserver-devops-agent-demo-control-pl… | Unhealthy | 2 | Readiness probe failed: HTTP probe failed with statuscode: 500 |
| 2026-10-09 10:52:10 | Pod kube-system/coredns-559f6c778d-9m9n7 | Unhealthy | 1 | Readiness probe failed: HTTP probe failed with statuscode: 503 |
| 2026-10-09 10:52:01 | Pod agent-test/frontend-69c48cc879-smmqk | FailedScheduling | 1 | 0/2 nodes are available: 2 node(s) had untolerated taint(s). preemption: 0/2 nodes are available: 2 Preemption is not h… |
| 2026-10-09 10:52:00 | Pod agent-test/frontend-69c48cc879-jvkr6 | FailedScheduling | 1 | 0/2 nodes are available: 2 node(s) had untolerated taint(s). preemption: 0/2 nodes are available: 2 Preemption is not h… |
| 2026-10-09 10:51:59 | Pod agent-test/batch-5f5678686c-pmv6m | FailedScheduling | 1 | 0/2 nodes are available: 2 node(s) had untolerated taint(s). preemption: 0/2 nodes are available: 2 Preemption is not h… |
| 2026-10-09 10:51:58 | Pod agent-test/cache-5cc48794d-2lc5m | FailedScheduling | 1 | 0/2 nodes are available: 2 node(s) had untolerated taint(s). preemption: 0/2 nodes are available: 2 Preemption is not h… |
| 2026-10-09 10:51:58 | Pod agent-test/web-7db8d69f68-xmr99 | FailedScheduling | 1 | 0/2 nodes are available: 2 node(s) had untolerated taint(s). preemption: 0/2 nodes are available: 2 Preemption is not h… |

## Scan notes

- LLM: `qwen2.5:7b-instruct` at http://localhost:11434
- Issues are detected by rules; root causes in "Investigated problems" come from the local LLM and may be wrong.
- Suggested fixes are never applied automatically.
