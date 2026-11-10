# InfluxDB 3 Enterprise MCP server on Kubernetes

An unofficial, reproducible lab guide for running the [official InfluxDB 3 MCP server](https://github.com/influxdata/influxdb3_mcp_server) as a Streamable HTTP service in Kubernetes. This repository is an installation overlay, **not** a fork or a published container image. The official server's default entry point speaks stdio; `overlay/http.ts` adds a separate HTTP entry point without changing its stdio mode.

The example uses a read-only MCP tool profile, an Enterprise querier endpoint, and two distinct credentials: an InfluxDB database token for the server and an independent HTTP bearer token for MCP clients. The base Service is ClusterIP; the optional NodePort Service exposes a permanent LAN port. Do not use this example to deploy InfluxDB Enterprise itself.

See [AGENTS.md](AGENTS.md) for an AI agent's operational checklist. This guide is tested against official source commit `95f43f82bf15334b8a7fe50f32c91d25ff8e63e5` (MCP server 2.0.1) and a Kubernetes 1.35 lab with containerd. Review the upstream source and SDK before adapting to a different version.

## Prerequisites

- An existing, healthy InfluxDB 3 Enterprise deployment with a query-capable Service.
- `kubectl` with authorization to create Secrets, Services, StatefulSets, and temporary privileged node-debug pods; Docker, `envsubst`, Python 3, Git, and access to pull `node:24-alpine` and `busybox:1.36`.
- A database token with the intended read permissions, saved to a **private local file**. This guide does not create or disclose a database token. Check its actual scope before mounting it.
- A node whose containerd image store accepts a locally imported image, and a free NodePort in the cluster's configured range if LAN access is desired.

This local-image route pins one pod to one node. The NodePort works through other cluster nodes while that node and pod stay healthy, but this is **not** high availability. For production, build/publish the image to an authorized private registry, pin by digest, remove the node selector, and add TLS/network controls.

## 1. Discover the target (read-only)

Set paths and names for *your* cluster; `$HOME` is used rather than a person's absolute home path:

```sh
K="$HOME/.kube/config" # or your kubeconfig, for example "$HOME/.kube/admin.conf"
MCP_NAMESPACE=influxdb3
MCP_NODE=eruption # replace with an actual Ready node
MCP_QUERY_URL="http://db3-influxdb3-enterprise-querier.${MCP_NAMESPACE}.svc.cluster.local:8181"
MCP_NODE_PORT=31300 # optional; choose a free port in your NodePort range
export MCP_NAMESPACE MCP_NODE MCP_QUERY_URL MCP_NODE_PORT
kubectl --kubeconfig "$K" config current-context
kubectl --kubeconfig "$K" get nodes -o wide
kubectl --kubeconfig "$K" -n "$MCP_NAMESPACE" get svc,deploy,sts
kubectl --kubeconfig "$K" -n "$MCP_NAMESPACE" get endpointslices
kubectl --kubeconfig "$K" get svc -A -o wide
```

Confirm the selected Service has ready **querier** endpoints and that the chosen NodePort is unused. The namespace should already exist for Enterprise; do not create or replace its Helm release. The example names `eruption` and `db3-...-querier` are illustrative, not portable defaults.

## 2. Build the overlay image

Run from a clone of **this** guide repository. The official source is pinned independently, and the overlay is copied only into the local checkout:

```sh
GUIDE="$PWD"
SOURCE="$HOME/influxdb3-mcp-source"
git clone https://github.com/influxdata/influxdb3_mcp_server.git "$SOURCE"
git -C "$SOURCE" checkout 95f43f82bf15334b8a7fe50f32c91d25ff8e63e5
cp "$GUIDE/overlay/http.ts" "$SOURCE/src/http.ts"
docker build --platform linux/amd64 -t influxdb3-mcp-server:local-http "$SOURCE"
```

The upstream Dockerfile copies `src/`, runs `pnpm run build`, and defaults to stdio. The StatefulSet overrides the command to `node build/http.js`. Use the target node's platform instead of `linux/amd64` on ARM. No image is pushed to a registry by these commands.

## 3. Create credentials in the Enterprise namespace

Keep token files outside the repository in a 0700 directory. A dedicated read-only Enterprise resource token is preferable to reusing an admin or ingestion token. Never print or commit either credential.

```sh
install -d -m 700 "$HOME/.local/share/influxdb3-mcp"
# Put your existing database token (raw token, not a bootstrap JSON object)
# into this protected file yourself; do not paste it into documentation/chat.
DB_TOKEN_FILE="$HOME/.local/share/influxdb3-mcp/db-token"
test -s "$DB_TOKEN_FILE" && test "$(stat -c %a "$DB_TOKEN_FILE")" = 600
python3 - <<'PY'
from pathlib import Path
from secrets import token_urlsafe
path = Path.home() / '.local/share/influxdb3-mcp/http-token'
with path.open('x') as f:
    f.write(token_urlsafe(48))
path.chmod(0o600)
PY
kubectl --kubeconfig "$K" -n "$MCP_NAMESPACE" create secret generic influxdb3-mcp-db-auth \
  --from-file="TOKEN=$DB_TOKEN_FILE" --dry-run=client -o yaml | \
  kubectl --kubeconfig "$K" apply -f -
kubectl --kubeconfig "$K" -n "$MCP_NAMESPACE" create secret generic influxdb3-mcp-http-auth \
  --from-file="token=$HOME/.local/share/influxdb3-mcp/http-token" --dry-run=client -o yaml | \
  kubectl --kubeconfig "$K" apply -f -
```

`http-token` is for MCP clients; `db-token` is for server-to-Enterprise requests. On a rerun, *do not regenerate* the HTTP token unless you intend to rotate clients. The Python `open('x')` intentionally refuses to replace an existing token. The token files and Kubernetes Secrets are not in this public repository. The temporary command pipeline passes secret YAML to `kubectl` through stdin, not to a tracked file; do not turn on shell tracing (`set -x`).

## 4. Import the local image to the chosen node

The target node uses containerd, not the workstation's Docker image store. A temporary privileged debug pod imports the image into the node's `k8s.io` containerd namespace. This requires elevated cluster privileges; review the node and image before running it.

```sh
kubectl --kubeconfig "$K" -n "$MCP_NAMESPACE" debug "node/$MCP_NODE" \
  --image=busybox:1.36 --profile=sysadmin -- sleep 600
# Copy the pod name printed by kubectl; inspect it before using it.
DEBUG_POD=node-debugger-REPLACE_ME
kubectl --kubeconfig "$K" -n "$MCP_NAMESPACE" wait \
  --for=condition=Ready "pod/$DEBUG_POD" --timeout=90s
set -o pipefail
docker save influxdb3-mcp-server:local-http | \
  kubectl --kubeconfig "$K" -n "$MCP_NAMESPACE" exec -i "$DEBUG_POD" -- \
  chroot /host /usr/bin/ctr -n k8s.io images import -
kubectl --kubeconfig "$K" -n "$MCP_NAMESPACE" delete pod "$DEBUG_POD"
```

For an image rebuild, repeat the import on the same node and then run `kubectl --kubeconfig "$K" -n "$MCP_NAMESPACE" rollout restart sts/influxdb3-mcp-http` and wait for its rollout. A different node needs a separate import or a registry. Do not publish images or change the Enterprise Helm release as part of this procedure.

## 5. Render, validate, and deploy

The templates are not directly applyable. Render only the listed variables, check the output, and keep generated YAML out of Git:

```sh
test -n "$MCP_NAMESPACE" && test -n "$MCP_NODE" && test -n "$MCP_QUERY_URL"
mkdir -p generated
envsubst '${MCP_NAMESPACE} ${MCP_NODE} ${MCP_QUERY_URL}' \
  < k8s/mcp-http.yaml.tmpl > generated/mcp-http.yaml
kubectl --kubeconfig "$K" apply --dry-run=server -f generated/mcp-http.yaml
kubectl --kubeconfig "$K" apply -f generated/mcp-http.yaml
kubectl --kubeconfig "$K" -n "$MCP_NAMESPACE" rollout status sts/influxdb3-mcp-http --timeout=120s
kubectl --kubeconfig "$K" -n "$MCP_NAMESPACE" get endpointslices \
  -l kubernetes.io/service-name=influxdb3-mcp-http
```

The in-cluster MCP endpoint is `http://influxdb3-mcp-http.<namespace>.svc.cluster.local:3000/mcp`. `/healthz` is a probe only; a Ready pod does not prove the Enterprise token works.

The StatefulSet uses `influxdb3-mcp-http-headless` for stable pod DNS and keeps the existing ClusterIP `influxdb3-mcp-http` for clients. It has one replica and no persistent volume: switching controller types does not add storage or HA. If migrating an existing installation, applying this template **does not replace or remove** `deploy/influxdb3-mcp-http`; both controllers may serve through the same Services during the transition. To verify the **new** pod rather than a request routed to the old Deployment, run `kubectl --kubeconfig "$K" -n "$MCP_NAMESPACE" port-forward pod/influxdb3-mcp-http-0 13001:3000` in another terminal, set `MCP_URL=http://127.0.0.1:13001/mcp`, and run the protocol probe in section 6. Only after the new pod passes, and with authorization to retire the old workload, run `kubectl --kubeconfig "$K" -n "$MCP_NAMESPACE" delete deploy/influxdb3-mcp-http`. Confirm the client Service still has a ready EndpointSlice and passes the protocol probe after the old pod terminates.

### Optional: permanent LAN port

```sh
envsubst '${MCP_NAMESPACE} ${MCP_NODE_PORT}' \
  < k8s/mcp-http-nodeport.yaml.tmpl > generated/mcp-http-nodeport.yaml
kubectl --kubeconfig "$K" apply --dry-run=server -f generated/mcp-http-nodeport.yaml
kubectl --kubeconfig "$K" apply -f generated/mcp-http-nodeport.yaml
kubectl --kubeconfig "$K" -n "$MCP_NAMESPACE" get svc/influxdb3-mcp-lan -o wide
NODE_IP=$(kubectl --kubeconfig "$K" get node "$MCP_NODE" \
  -o jsonpath='{.status.addresses[?(@.type=="InternalIP")].address}')
printf 'LAN MCP URL: http://%s:%s/mcp\n' "$NODE_IP" "$MCP_NODE_PORT"
```

NodePort listens through **every cluster node** (`externalTrafficPolicy: Cluster`), not just the image host. The LAN endpoint uses plain HTTP, so a bearer token can be intercepted on untrusted networks. Restrict network access with a firewall and use TLS ingress instead for broader access. To remove LAN exposure independently, run `kubectl --kubeconfig "$K" -n "$MCP_NAMESPACE" delete svc influxdb3-mcp-lan`.

## 6. Verify the actual MCP protocol

From a workstation on the trusted LAN, use the LAN URL; alternatively, forward the ClusterIP Service temporarily. This probe reads the protected HTTP token without printing it and checks authentication, MCP initialization, and tool advertisement:

```sh
MCP_URL=${MCP_URL:-"http://$NODE_IP:$MCP_NODE_PORT/mcp"}
export MCP_URL
python3 - <<'PY'
import json, os, pathlib, urllib.error, urllib.request
url = os.environ['MCP_URL']
token = (pathlib.Path.home() / '.local/share/influxdb3-mcp/http-token').read_text()
headers = {'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json',
           'Accept': 'application/json, text/event-stream'}
for label, auth, body in [
    ('unauthorized', False, {'jsonrpc':'2.0','id':0,'method':'tools/list','params':{}}),
    ('initialize', True, {'jsonrpc':'2.0','id':1,'method':'initialize',
                          'params':{'protocolVersion':'2025-06-18','capabilities':{},
                                    'clientInfo':{'name':'setup-check','version':'1'}}}),
    ('tools/list', True, {'jsonrpc':'2.0','id':2,'method':'tools/list','params':{}}),
    ('list_databases', True, {'jsonrpc':'2.0','id':3,'method':'tools/call',
                              'params':{'name':'list_databases','arguments':{}}}),
]:
    req = urllib.request.Request(url, data=json.dumps(body).encode(),
                                 headers=headers if auth else {'Content-Type':'application/json'},
                                 method='POST')
    try:
        with urllib.request.urlopen(req, timeout=15) as response:
            data = json.load(response)
            if label == 'tools/list':
                names = {tool['name'] for tool in data['result']['tools']}
                assert 'query_sql' in names and 'delete_database' not in names
            if label == 'list_databases':
                assert json.loads(data['result']['content'][0]['text'])['ok'] is True
            print(label, response.status, 'ok')
    except urllib.error.HTTPError as error:
        assert label == 'unauthorized' and error.code == 401
        print(label, error.code, 'ok')
PY
```

An MCP client needs a Streamable HTTP transport URL and `Authorization: Bearer <HTTP token>` header. Never put the credential in a URL. If using a different token with narrower permissions, `list_databases` might be denied while an explicitly authorized database query works; validate the intended operation instead. For workstation-only access without NodePort, `kubectl --kubeconfig "$K" -n "$MCP_NAMESPACE" port-forward svc/influxdb3-mcp-http 13000:3000` and use `http://127.0.0.1:13000/mcp`.

## Troubleshooting and cleanup

- `ImagePullBackOff` with `Never`: image was not imported on the scheduled node, or its tag differs. Inspect node name, local image inventory, and pod events.
- `CreateContainerConfigError`: verify both Secrets are in the workload namespace with keys `TOKEN` and `token`; do not display their values.
- Healthy `/healthz` but MCP operations fail: inspect the querier Service EndpointSlice, database token scope, and bounded pod logs (do not dump environment variables).
- `31300` unavailable: choose another free NodePort in your cluster range; re-render and re-apply only the NodePort Service.
- Removing a local YAML file does **not** remove live Kubernetes objects. Delete the optional NodePort Service first; only delete the StatefulSet, headless Service, and ClusterIP Service if you intend to stop the server. An old Deployment must also be removed separately after a verified migration. Keep credential Secrets unless you explicitly intend to revoke access.

This repository's example is **not** TLS, HA, or production hardening. The MIT license applies to this guide and overlay; the upstream MCP server remains under its own license. No real token, kubeconfig, license, or environment-specific hostname is included here.
