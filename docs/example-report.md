# Kubernetes Health Report

**Status: CRITICAL**  
Context: `kind-devops-agent-demo`  
Scope: all namespaces  
Scanned at: 2026-10-10T07:55:02.320Z

## Summary

| Check | Result |
| --- | --- |
| Nodes ready | 2/2 |
| Pods running | 16/18 |
| Deployments fully ready | 3/8 |
| DaemonSets and StatefulSets fully ready | 2/2 |
| Services without ready endpoints | 3 of 4 |
| Cluster DNS | 2/2 endpoints ready |
| Warning events (recent) | 29 |
| Control-plane pods | 4/4 ready; recently restarted or failing probes: kube-controller-manager, kube-scheduler |
| API server health checks | 37/37 passing |
| etcd database | 6.3 MiB of 2.0 GiB quota (0%), default quota assumed |
| API server certificate | expires in 364 days (2027-10-10) |
| Admission webhooks | 1, 1 unreachable |
| Issues | 16 critical, 3 warning, 0 info |
| Investigated by LLM | 5 problem(s) |

## Investigated problems

### 1. [CRITICAL] Pod is unschedulable due to insufficient CPU resources.

**Affected:** Pod agent-test/batch-5f5678686c-pmv6m, Deployment agent-test/batch

**Root cause:** Insufficient CPU resources on available nodes (0/2 nodes are available: 1 Insufficient cpu, 1 node(s) had untolerated taint(s)).

**Evidence:**

- No node can ever fit this pod: requests cpu=1000, largest node allocatable cpu=12.
- Pod is in Pending state with FailedScheduling condition: 0/2 nodes are available: 1 Insufficient cpu, 1 node(s) had untolerated taint(s).
- ReplicaSet 'batch-5f5678686c' has timed out progressing.
- Deployment 'batch' rollout exceeded its progress deadline.

**Suggested fix** (not applied):

1. Lower the CPU request of the pod to a value that fits within the available resources on the nodes.
2. Add nodes with sufficient CPU capacity to the cluster.

_Confidence: high · 2 tool call(s) · 6,856 prompt + 566 output tokens in 3 LLM call(s), largest prompt 2,480 of 16,384_

### 2. [CRITICAL] The `cache` pod is OOMKilled due to excessive memory usage by the `cache` container.

**Affected:** Pod agent-test/cache-5cc48794d-2lc5m, Deployment agent-test/cache, Deployment agent-test/metrics-agent, Deployment agent-test/payments, Deployment agent-test/web

**Root cause:** The `cache` container is running a script that continuously writes to `/dev/zero`, consuming memory until it is terminated due to OOMKilled.

**Evidence:**

- The `cache` container was OOMKilled with exit code 137.
- The `cache` container has 67 restarts due to OOMKilled.
- The `cache` pod is not ready and has 0/1 replicas ready.
- The `cache` container's memory limit is set to 32Mi, which is insufficient for the script's memory consumption.

**Suggested fix** (not applied):

1. Increase the memory limit for the `cache` container to 128Mi.
2. Review and optimize the script running in the `cache` container to reduce memory usage.

_Confidence: high · 4 tool call(s) · 15,696 prompt + 921 output tokens in 5 LLM call(s), largest prompt 3,581 of 16,384_

### 3. [CRITICAL] Pods in the `web` deployment are crashing due to the missing `DATABASE_URL` environment variable.

**Affected:** Pod agent-test/web-7db8d69f68-7x2kz, Pod agent-test/web-7db8d69f68-xmr99, Service agent-test/web

**Root cause:** The `DATABASE_URL` environment variable is not set, causing the application to exit with an error code 1.

**Evidence:**

- Logs show: `FATAL: DATABASE_URL is not set, cannot connect to database`
- Pod conditions indicate: `Ready=False (ContainersNotReady): containers with unready status: [app]`
- Service has no ready endpoints: `none of its 2 pod(s) is ready`
- Pod events show: `Back-off restarting failed container app in pod web-7db8d69f68-7x2kz_agent-test`

**Suggested fix** (not applied):

1. Ensure the `DATABASE_URL` environment variable is set in the deployment's pod template.
2. Apply the updated deployment configuration to the cluster.
3. Verify the pods are now ready and the service has endpoints.

_Confidence: high · 2 tool call(s) · 8,416 prompt + 594 output tokens in 3 LLM call(s), largest prompt 3,039 of 16,384_

### 4. [CRITICAL] The Deployment `metrics-agent` cannot create pods due to a violation of the Pod Security policy.

**Affected:** ReplicaSet agent-test/metrics-agent-85b44cd58, Deployment agent-test/metrics-agent

**Root cause:** The pod template violates the namespace's Pod Security policy (host namespaces with `hostNetwork=true`).

**Evidence:**

- FailedCreate x18, last at 2026-10-10T07:44:09.000Z: Error creating: pods 'metrics-agent-85b44cd58-mfv7z' is forbidden: violates PodSecurity 'baseline:latest': host namespaces (hostNetwork=true)
- ReplicaSet 'metrics-agent-85b44cd58' has timed out progressing.
- The pod template in the Deployment includes `hostNetwork=true`.
- The namespace's Pod Security policy enforces the 'baseline:latest' level.

**Suggested fix** (not applied):

1. Remove the `hostNetwork=true` setting from the pod template in the `metrics-agent` Deployment.
2. Alternatively, update the namespace's Pod Security policy to allow `hostNetwork=true`.

_Confidence: high · 2 tool call(s) · 7,057 prompt + 576 output tokens in 3 LLM call(s), largest prompt 2,560 of 16,384_

### 5. [CRITICAL] Pod and Deployment are using a non-existent image `nginx:1.99.99-doesnotexist`.

**Affected:** Pod agent-test/payments-9877b44c9-fcc6z, Deployment agent-test/payments

**Root cause:** The image `nginx:1.99.99-doesnotexist` does not exist in the Docker registry.

**Evidence:**

- The pod is in a `ImagePullBackOff` state with the error: `ErrImagePull: rpc error: code = NotFound desc = failed to pull and unpack image 'docker.io/library/nginx:1.99.99-doesnotexist': failed to resolve reference 'docker.io/library/nginx:1.99.99-doesnotexist': docker.io/library/nginx:1.99.99-doesn…
- The Deployment shows `Progressing=False (ProgressDeadlineExceeded)` due to the non-existent image.
- The pod is pending and has not started due to `ImagePullBackOff`.
- The image `nginx:1.99.99-doesnotexist` is specified in the Deployment's container configuration.

**Suggested fix** (not applied):

1. Update the Deployment to use a valid image.
2. Verify the image exists in the Docker registry.
3. Apply the updated Deployment configuration.

_Confidence: high · 3 tool call(s) · 11,631 prompt + 857 output tokens in 4 LLM call(s), largest prompt 3,173 of 16,384_

## Other issues (rule-based)

### Critical (1)

#### Validating webhook cronjobs.policy.agent-demo.example.com is unreachable and blocks the requests it matches

- Service agent-test/policy-webhook has no ready endpoints
- failurePolicy=Fail: matching create/update requests are rejected

_Suggested next step:_ Restore the webhook's backend (Service agent-test/policy-webhook and its pods), or delete the ValidatingWebhookConfiguration agent-demo-policy if that component was uninstalled.

### Warning (3)

#### Control-plane component kube-controller-manager restarted 37 min ago

- last restart 37 min ago (Unknown, exit code 255); 12 restart(s) in total

_Suggested next step:_ The controller-manager exits when it loses leader election, usually because the API server or etcd was slow or unavailable. Check its previous logs for "leaderelection lost", then check kube-apiserver health first.

#### Control-plane component kube-scheduler restarted 37 min ago

- last restart 37 min ago (Unknown, exit code 255); 11 restart(s) in total

_Suggested next step:_ The scheduler exits when it loses leader election, usually because the API server or etcd was slow or unavailable. Check its previous logs for "leaderelection lost", then check kube-apiserver health first.

#### Service agent-test/storefront selects no pods, so requests to it fail

- selector app=front-end matches no running pods in namespace agent-test
- label values on running pods in agent-test: app: batch, cache, frontend, payments, web

_Suggested next step:_ Compare the selector with the labels of the pod template it is meant for. A typo or a renamed label means the selector must be fixed; if its workload was scaled to zero or removed on purpose, scale it up or delete the Service.

## Recent warning events

| Last seen | Object | Reason | Count | Message |
| --- | --- | --- | --- | --- |
| 2026-10-10 07:54:42 | Pod agent-test/cache-5cc48794d-2lc5m | BackOff | 37 | Back-off restarting failed container cache in pod cache-5cc48794d-2lc5m_agent-test(c885843e-5061-47d3-bdde-de2360d220b5) |
| 2026-10-10 07:54:23 | Pod agent-test/web-7db8d69f68-xmr99 | BackOff | 33 | Back-off restarting failed container app in pod web-7db8d69f68-xmr99_agent-test(715c9df7-7baa-4c08-b014-717c33de2d98) |
| 2026-10-10 07:53:46 | Pod agent-test/batch-5f5678686c-pmv6m | FailedScheduling | 8 | 0/2 nodes are available: 1 Insufficient cpu, 1 node(s) had untolerated taint(s). preemption: 0/2 nodes are available: 2… |
| 2026-10-10 07:53:41 | Pod agent-test/payments-9877b44c9-fcc6z | Failed | 152 | Error: ImagePullBackOff |
| 2026-10-10 07:53:30 | Pod agent-test/web-7db8d69f68-7x2kz | BackOff | 33 | Back-off restarting failed container app in pod web-7db8d69f68-7x2kz_agent-test(49e6b2f7-eaf8-4e82-8a65-5ac57b98ab72) |
| 2026-10-10 07:44:09 | ReplicaSet agent-test/metrics-agent-85b44cd58 | FailedCreate | 9 | (combined from similar events): Error creating: pods "metrics-agent-85b44cd58-mfv7z" is forbidden: violates PodSecurity… |
| 2026-10-10 07:33:15 | ReplicaSet agent-test/metrics-agent-85b44cd58 | FailedCreate | 1 | Error creating: pods "metrics-agent-85b44cd58-4ql9j" is forbidden: violates PodSecurity "baseline:latest": host namespa… |
| 2026-10-10 07:33:14 | ReplicaSet agent-test/metrics-agent-85b44cd58 | FailedCreate | 1 | Error creating: pods "metrics-agent-85b44cd58-fcjqd" is forbidden: violates PodSecurity "baseline:latest": host namespa… |
| 2026-10-10 07:33:14 | ReplicaSet agent-test/metrics-agent-85b44cd58 | FailedCreate | 1 | Error creating: pods "metrics-agent-85b44cd58-pfp78" is forbidden: violates PodSecurity "baseline:latest": host namespa… |
| 2026-10-10 07:33:14 | ReplicaSet agent-test/metrics-agent-85b44cd58 | FailedCreate | 1 | Error creating: pods "metrics-agent-85b44cd58-sjm27" is forbidden: violates PodSecurity "baseline:latest": host namespa… |
| 2026-10-10 07:33:14 | ReplicaSet agent-test/metrics-agent-85b44cd58 | FailedCreate | 1 | Error creating: pods "metrics-agent-85b44cd58-fc5cw" is forbidden: violates PodSecurity "baseline:latest": host namespa… |
| 2026-10-10 07:33:14 | ReplicaSet agent-test/metrics-agent-85b44cd58 | FailedCreate | 1 | Error creating: pods "metrics-agent-85b44cd58-7n528" is forbidden: violates PodSecurity "baseline:latest": host namespa… |
| 2026-10-10 07:33:14 | ReplicaSet agent-test/metrics-agent-85b44cd58 | FailedCreate | 1 | Error creating: pods "metrics-agent-85b44cd58-bh264" is forbidden: violates PodSecurity "baseline:latest": host namespa… |
| 2026-10-10 07:33:14 | ReplicaSet agent-test/metrics-agent-85b44cd58 | FailedCreate | 1 | Error creating: pods "metrics-agent-85b44cd58-f74nz" is forbidden: violates PodSecurity "baseline:latest": host namespa… |
| 2026-10-10 07:33:14 | ReplicaSet agent-test/metrics-agent-85b44cd58 | FailedCreate | 1 | Error creating: pods "metrics-agent-85b44cd58-zdjxf" is forbidden: violates PodSecurity "baseline:latest": host namespa… |

## Scan notes

- LLM: `qwen2.5:7b-instruct` at http://localhost:11434
- LLM usage: 51,111 prompt + 3,954 output tokens in 19 LLM call(s), largest prompt 3,581 of 16,384
- Issues are detected by rules; root causes in "Investigated problems" come from the local LLM and may be wrong.
- Suggested fixes are never applied automatically.
