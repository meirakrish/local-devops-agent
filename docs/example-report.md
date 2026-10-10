# Kubernetes Health Report

**Status: CRITICAL**  
Context: `kind-devops-agent-demo`  
Scope: all namespaces  
Scanned at: 2026-10-09T13:41:21.297Z

## Summary

| Check | Result |
| --- | --- |
| Nodes ready | 2/2 |
| Pods running | 16/18 |
| Deployments fully ready | 3/7 |
| Warning events (recent) | 12 |
| Control-plane pods | 4/4 ready; recently restarted or failing probes: kube-apiserver, kube-controller-manager, kube-scheduler |
| API server health checks | 37/37 passing |
| etcd database | 3.7 MiB of 2.0 GiB quota (0%), default quota assumed |
| API server certificate | expires in 364 days (2027-10-09) |
| Admission webhooks | 1, 1 unreachable |
| Issues | 12 critical, 3 warning, 0 info |
| Investigated by LLM | 4 problem(s) |

## Investigated problems

### 1. [CRITICAL] The pod is unschedulable due to insufficient CPU resources.

**Affected:** Pod agent-test/batch-5f5678686c-pmv6m, Deployment agent-test/batch

**Root cause:** Insufficient CPU on available nodes (0/2 nodes are available: 1 Insufficient cpu, 1 node(s) had untolerated taint(s)).

**Evidence:**

- No node can ever fit this pod: requests cpu=1000, largest node allocatable cpu=12.
- ReplicaSet 'batch-5f5678686c' has timed out progressing.
- Pod 'batch-5f5678686c-pmv6m' is pending and unschedulable due to insufficient CPU.
- 0/2 nodes are available: 1 Insufficient cpu, 1 node(s) had untolerated taint(s).

**Suggested fix** (not applied):

1. Lower the CPU request for the pod to a value that fits within the available CPU capacity of the nodes.
2. Redeploy the deployment to apply the updated resource requests.

_Confidence: high · 3 tool call(s)_

### 2. [CRITICAL] Pod and deployment are using a non-existent image tag.

**Affected:** Pod agent-test/payments-9877b44c9-fcc6z, Deployment agent-test/payments

**Root cause:** The image 'nginx:1.99.99-doesnotexist' does not exist in the Docker registry.

**Evidence:**

- The pod is in ImagePullBackOff state with the error: 'ErrImagePull: rpc error: code = NotFound desc = failed to pull and unpack image 'docker.io/library/nginx:1.99.99-doesnotexist': failed to resolve reference 'docker.io/library/nginx:1.99.99-doesnotexist': docker.io/library/nginx:1.99.99-doesnotex…
- The deployment has 0/1 replicas ready and the progress deadline was exceeded.
- The deployment is using the invalid image tag 'nginx:1.99.99-doesnotexist'.
- The pod is pending and the reason is ImagePullBackOff.

**Suggested fix** (not applied):

1. Update the deployment to use a valid image tag, e.g., `nginx:1.19.10`.
2. Verify that the imagePullSecrets are correctly configured if needed.

_Confidence: high · 6 tool call(s)_

### 3. [CRITICAL] Pods in the agent-test/web deployment are crashing due to the missing DATABASE_URL environment variable.

**Affected:** Pod agent-test/web-7db8d69f68-7x2kz, Pod agent-test/web-7db8d69f68-xmr99, Deployment agent-test/web

**Root cause:** FATAL: DATABASE_URL is not set, cannot connect to database

**Evidence:**

- The container logs show: 'FATAL: DATABASE_URL is not set, cannot connect to database'
- The pod is in CrashLoopBackOff with 34 restarts
- The deployment has 0/2 replicas ready
- The pod events indicate that the container is not ready due to the missing environment variable

**Suggested fix** (not applied):

1. Ensure the DATABASE_URL environment variable is set in the deployment's configuration.
2. Apply the updated deployment configuration to the cluster.

_Confidence: high · 2 tool call(s)_

### 4. [CRITICAL] Pod `cache-5cc48794d-2lc5m` is experiencing frequent OOMKills due to insufficient memory limits.

**Affected:** Pod agent-test/cache-5cc48794d-2lc5m, Deployment agent-test/cache

**Root cause:** The container memory limit is too low, causing it to be OOMKilled repeatedly.

**Evidence:**

- Container cache was OOMKilled with exitCode 137.
- Container is in CrashLoopBackOff with 34 restarts.
- Pod is running a simple script 'warming cache' that does not consume excessive resources.
- Current memory limit is 32Mi, which is likely insufficient for the workload.

**Suggested fix** (not applied):

1. Increase the memory limit for the container in the deployment manifest.
2. Apply the updated deployment manifest to update the pod configuration.

_Confidence: high · 2 tool call(s)_

## Other issues (rule-based)

### Critical (1)

#### Validating webhook cronjobs.policy.agent-demo.example.com is unreachable and blocks the requests it matches

- Service agent-test/policy-webhook has no ready endpoints
- failurePolicy=Fail: matching create/update requests are rejected

_Suggested next step:_ Restore the webhook's backend (Service agent-test/policy-webhook and its pods), or delete the ValidatingWebhookConfiguration agent-demo-policy if that component was uninstalled.

### Warning (3)

#### Control-plane component kube-apiserver failed health probes 61 time(s) recently

- up to 61 Readiness/Liveness probe failure(s) in the last 60 min, last 2 min ago: Readiness probe failed: HTTP probe failed with statuscode: 500

_Suggested next step:_ Check the kube-apiserver logs and etcd health (k8s_cluster_health). A readiness probe answering HTTP 500 means one of its /readyz checks failed, often etcd. Also check CPU and memory pressure on the control-plane node.

#### Control-plane component kube-controller-manager restarted 3 min ago

- last restart 3 min ago (Error, exit code 1); 3 restart(s) in total
- up to 3 Liveness probe failure(s) in the last 60 min, last 3 min ago: Liveness probe failed: Get "https://127.0.0.1:10257/healthz": dial tcp 127.0.0.1:10257: connect: connection refused

_Suggested next step:_ The controller-manager exits when it loses leader election, usually because the API server or etcd was slow or unavailable. Check its previous logs for "leaderelection lost", then check kube-apiserver health first.

#### Control-plane component kube-scheduler restarted 3 min ago

- last restart 3 min ago (Error, exit code 1); 3 restart(s) in total
- up to 15 Readiness/Liveness probe failure(s) in the last 60 min, last 3 min ago: Readiness probe failed: Get "https://127.0.0.1:10259/readyz": dial tcp 127.0.0.1:10259: connect: connection refused

_Suggested next step:_ The scheduler exits when it loses leader election, usually because the API server or etcd was slow or unavailable. Check its previous logs for "leaderelection lost", then check kube-apiserver health first.

## Recent warning events

| Last seen | Object | Reason | Count | Message |
| --- | --- | --- | --- | --- |
| 2026-10-09 13:41:04 | Pod agent-test/payments-9877b44c9-fcc6z | Failed | 34 | Failed to pull image "nginx:1.99.99-doesnotexist": rpc error: code = NotFound desc = failed to pull and unpack image "d… |
| 2026-10-09 13:39:36 | Pod kube-system/kube-apiserver-devops-agent-demo-control-pl… | Unhealthy | 45 | Readiness probe failed: HTTP probe failed with statuscode: 500 |
| 2026-10-09 13:38:50 | Pod agent-test/batch-5f5678686c-pmv6m | FailedScheduling | 1 | 0/2 nodes are available: 1 Insufficient cpu, 1 node(s) had untolerated taint(s). preemption: 0/2 nodes are available: 2… |
| 2026-10-09 13:38:46 | Pod kube-system/kube-scheduler-devops-agent-demo-control-pl… | Unhealthy | 14 | Readiness probe failed: Get "https://127.0.0.1:10259/readyz": dial tcp 127.0.0.1:10259: connect: connection refused |
| 2026-10-09 13:38:45 | Pod kube-system/kube-controller-manager-devops-agent-demo-c… | Unhealthy | 3 | Liveness probe failed: Get "https://127.0.0.1:10257/healthz": dial tcp 127.0.0.1:10257: connect: connection refused |
| 2026-10-09 13:38:42 | Pod kube-system/kube-apiserver-devops-agent-demo-control-pl… | Unhealthy | 16 | Liveness probe failed: HTTP probe failed with statuscode: 500 |
| 2026-10-09 13:18:36 | Pod agent-test/cache-5cc48794d-2lc5m | BackOff | 121 | Back-off restarting failed container cache in pod cache-5cc48794d-2lc5m_agent-test(c885843e-5061-47d3-bdde-de2360d220b5) |
| 2026-10-09 13:18:24 | Pod agent-test/web-7db8d69f68-xmr99 | BackOff | 126 | Back-off restarting failed container app in pod web-7db8d69f68-xmr99_agent-test(715c9df7-7baa-4c08-b014-717c33de2d98) |
| 2026-10-09 13:17:46 | Pod agent-test/web-7db8d69f68-7x2kz | BackOff | 130 | Back-off restarting failed container app in pod web-7db8d69f68-7x2kz_agent-test(49e6b2f7-eaf8-4e82-8a65-5ac57b98ab72) |
| 2026-10-09 13:17:45 | Pod agent-test/payments-9877b44c9-fcc6z | Failed | 635 | Error: ImagePullBackOff |
| 2026-10-09 13:14:27 | Pod agent-test/batch-5f5678686c-pmv6m | FailedScheduling | 6 | 0/2 nodes are available: 1 Insufficient cpu, 1 node(s) had untolerated taint(s). preemption: 0/2 nodes are available: 2… |
| 2026-10-09 12:48:43 | Pod kube-system/kube-scheduler-devops-agent-demo-control-pl… | Unhealthy | 1 | Liveness probe failed: Get "https://127.0.0.1:10259/livez": dial tcp 127.0.0.1:10259: connect: connection refused |

## Scan notes

- LLM: `qwen2.5:7b-instruct` at http://localhost:11434
- Issues are detected by rules; root causes in "Investigated problems" come from the local LLM and may be wrong.
- Suggested fixes are never applied automatically.
