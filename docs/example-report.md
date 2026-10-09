# Kubernetes Health Report

**Status: CRITICAL**  
Context: `kind-devops-agent-demo`  
Scope: all namespaces  
Scanned at: 2026-10-09T12:51:39.399Z

## Summary

| Check | Result |
| --- | --- |
| Nodes ready | 2/2 |
| Pods running | 16/18 |
| Deployments fully ready | 3/7 |
| Warning events (recent) | 11 |
| API server health checks | 37/37 passing |
| etcd database | 3.7 MiB of 2.0 GiB quota (0%), default quota assumed |
| API server certificate | expires in 364 days (2027-10-09) |
| Admission webhooks | 1, 1 unreachable |
| Issues | 12 critical, 0 warning, 0 info |
| Investigated by LLM | 5 problem(s) |

## Investigated problems

### 1. [CRITICAL] Pod `batch-5f5678686c-pmv6m` is unschedulable due to insufficient CPU resources.

**Affected:** Pod agent-test/batch-5f5678686c-pmv6m, Deployment agent-test/batch

**Root cause:** Insufficient CPU resources: 0/2 nodes are available: 1 Insufficient cpu, 1 node(s) had untolerated taint(s).

**Evidence:**

- The pod requires 1000m CPU, but the largest node can only provide 12 CPU cores.
- No node can ever fit this pod: requests cpu=1000, largest node allocatable cpu=12.
- The deployment `agent-test/batch` has 0/1 replicas ready due to the pod being unschedulable.
- The deployment `agent-test/batch` rollout exceeded its progress deadline.

**Suggested fix** (not applied):

1. Reduce the CPU request for the pod in the deployment manifest.
2. Apply the updated deployment configuration: `kubectl apply -f updated-deployment.yaml`.

_Confidence: high · 3 tool call(s)_

### 2. [CRITICAL] Pod and deployment are failing due to an incorrect image name.

**Affected:** Pod agent-test/payments-9877b44c9-fcc6z, Deployment agent-test/payments

**Root cause:** The image name `nginx:1.99.99-doesnotexist` does not exist.

**Evidence:**

- The pod is in a `ImagePullBackOff` state with the error `ErrImagePull: rpc error: code = NotFound desc = failed to pull and unpack image 'docker.io/library/nginx:1.99.99-doesnotexist': failed to resolve reference 'docker.io/library/nginx:1.99.99-doesnotexist': docker.io/library/nginx:1.99.99-doesno…
- The deployment has a `ProgressDeadlineExceeded` condition, indicating the new ReplicaSet is not progressing.
- The deployment shows `images: payments=nginx:1.99.99-doesnotexist`.
- The pod is pending and has `ready=0/1` due to `ErrImagePull`.

**Suggested fix** (not applied):

1. Verify the image name in the deployment's configuration and ensure it is correct.
2. If the image name is incorrect, update the deployment to use the correct image.
3. Consider rolling back the deployment using `kubectl rollout undo` if the image name is intended to be different.

_Confidence: high · 3 tool call(s)_

### 3. [CRITICAL] Pods in the `web` deployment are crashing due to missing `DATABASE_URL` environment variable.

**Affected:** Pod agent-test/web-7db8d69f68-7x2kz, Pod agent-test/web-7db8d69f68-xmr99, Deployment agent-test/web

**Root cause:** The `DATABASE_URL` environment variable is not set, causing the application to fail and enter a crash loop.

**Evidence:**

- Logs show: `FATAL: DATABASE_URL is not set, cannot connect to database`
- Pods are in CrashLoopBackOff state with 27 restarts each
- Deployment `web` has 0/2 replicas ready
- No `DATABASE_URL` environment variable is defined in the deployment configuration

**Suggested fix** (not applied):

1. Update the deployment configuration to include the `DATABASE_URL` environment variable.
2. Apply the updated deployment configuration using `kubectl apply -f path/to/deployment.yaml`.

_Confidence: high · 3 tool call(s)_

### 4. [CRITICAL] The pod is OOMKilled due to excessive memory usage by the container.

**Affected:** Pod agent-test/cache-5cc48794d-2lc5m, Deployment agent-test/cache

**Root cause:** The container is running an infinite memory-consuming command (`tail /dev/zero`), causing it to exceed its memory limit.

**Evidence:**

- The container is configured with a memory limit of 32Mi, but it is still OOMKilled.
- The command `tail /dev/zero` is generating an infinite stream of null bytes, consuming memory.
- The pod is in CrashLoopBackOff with the reason `OOMKilled`.
- The deployment has 0/1 replicas ready, indicating the issue affects the entire deployment.

**Suggested fix** (not applied):

1. Increase the memory limit for the container in the deployment manifest.
2. Optimize the application to use less memory.

_Confidence: high · 3 tool call(s)_

### 5. [CRITICAL] The ValidatingWebhookConfiguration agent-demo-policy is unreachable due to a missing or failed Service agent-test/policy-webhook.

**Affected:** ValidatingWebhookConfiguration agent-demo-policy

**Root cause:** Service agent-test/policy-webhook has no ready endpoints

**Evidence:**

- Service agent-test/policy-webhook has no ready endpoints
- failurePolicy=Fail: matching create/update requests are rejected
- Pods in the agent-test namespace are failing due to ImagePullBackOff and BackOff errors

**Suggested fix** (not applied):

1. Restore the backend service for the webhook (Service agent-test/policy-webhook and its pods)
2. Check the deployment or statefulset for the webhook to ensure it is running and properly configured
3. Verify the image references and pod specifications in the webhook's deployment

_Confidence: high · 6 tool call(s)_

## Other issues (rule-based)

None; all issues are covered above.

## Recent warning events

| Last seen | Object | Reason | Count | Message |
| --- | --- | --- | --- | --- |
| 2026-10-09 12:49:27 | Pod agent-test/batch-5f5678686c-pmv6m | FailedScheduling | 1 | 0/2 nodes are available: 1 Insufficient cpu, 1 node(s) had untolerated taint(s). preemption: 0/2 nodes are available: 2… |
| 2026-10-09 12:49:20 | Pod agent-test/web-7db8d69f68-xmr99 | BackOff | 100 | Back-off restarting failed container app in pod web-7db8d69f68-xmr99_agent-test(715c9df7-7baa-4c08-b014-717c33de2d98) |
| 2026-10-09 12:49:02 | Pod agent-test/cache-5cc48794d-2lc5m | BackOff | 96 | Back-off restarting failed container cache in pod cache-5cc48794d-2lc5m_agent-test(c885843e-5061-47d3-bdde-de2360d220b5) |
| 2026-10-09 12:48:58 | Pod kube-system/kube-controller-manager-devops-agent-demo-c… | Unhealthy | 2 | Liveness probe failed: Get "https://127.0.0.1:10257/healthz": dial tcp 127.0.0.1:10257: connect: connection refused |
| 2026-10-09 12:48:56 | Pod kube-system/kube-apiserver-devops-agent-demo-control-pl… | Unhealthy | 35 | Readiness probe failed: HTTP probe failed with statuscode: 500 |
| 2026-10-09 12:48:53 | Pod kube-system/kube-apiserver-devops-agent-demo-control-pl… | Unhealthy | 13 | Liveness probe failed: HTTP probe failed with statuscode: 500 |
| 2026-10-09 12:48:43 | Pod kube-system/kube-scheduler-devops-agent-demo-control-pl… | Unhealthy | 13 | Readiness probe failed: Get "https://127.0.0.1:10259/readyz": dial tcp 127.0.0.1:10259: connect: connection refused |
| 2026-10-09 12:48:43 | Pod kube-system/kube-scheduler-devops-agent-demo-control-pl… | Unhealthy | 1 | Liveness probe failed: Get "https://127.0.0.1:10259/livez": dial tcp 127.0.0.1:10259: connect: connection refused |
| 2026-10-09 12:48:21 | Pod agent-test/web-7db8d69f68-7x2kz | BackOff | 104 | Back-off restarting failed container app in pod web-7db8d69f68-7x2kz_agent-test(49e6b2f7-eaf8-4e82-8a65-5ac57b98ab72) |
| 2026-10-09 12:47:46 | Pod agent-test/payments-9877b44c9-fcc6z | Failed | 504 | Error: ImagePullBackOff |
| 2026-10-09 12:36:08 | Pod agent-test/batch-5f5678686c-pmv6m | FailedScheduling | 18 | 0/2 nodes are available: 1 Insufficient cpu, 1 node(s) had untolerated taint(s). preemption: 0/2 nodes are available: 2… |

## Scan notes

- LLM: `qwen2.5:7b-instruct` at http://localhost:11434
- Issues are detected by rules; root causes in "Investigated problems" come from the local LLM and may be wrong.
- Suggested fixes are never applied automatically.
