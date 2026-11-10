# AI agent instructions: InfluxDB 3 MCP on Kubernetes

This repository is a setup guide and overlay, not an image registry, an InfluxDB Helm chart, or the official MCP server. Read [README.md](README.md) in full before acting. Do not treat the sample node `eruption`, namespace `influxdb3`, query Service name, or NodePort `31300` as universal defaults. Use `$HOME` in instructions and scripts; do not insert a user's absolute home path into published files.

## Scope and authorization

1. Distinguish inspection from changes. Confirm the current Kubernetes context/cluster and the user's authorization before creating Secrets, importing an image on a node, applying resources, or exposing a port. Do not install or reconfigure Enterprise itself.
2. Never push changes to `influxdata/influxdb3_mcp_server` or publish container images without explicit permission. Clone its pinned commit into a separate local checkout, add this repo's `overlay/http.ts` to that checkout, and build there. Do not overwrite a user's existing checkout.
3. Keep `MCP_HTTP_TOKEN` distinct from `INFLUX_DB_TOKEN`. Use a permission-scoped Enterprise database token, not the bootstrap JSON file; preserve raw tokens only in 0600 local files and same-namespace Kubernetes Secrets. Do not reveal tokens in stdout, commands, logs, Git, rendered YAML, or chat.
4. Default to `INFLUX_MCP_TOOL_PROFILE=readonly` and a query-capable Enterprise Service. Do not point SQL at an ingest-only endpoint. Do not enable write/admin tools without a separate explicit request.
5. ClusterIP is in-cluster only. NodePort is optional and should be separately removable. It exposes plain HTTP across all node IPs and is suitable only for a trusted, firewall-restricted LAN. Use TLS and network policy/firewall controls before internet or untrusted-network exposure.

## Preflight before editing or applying

- Read `README.md`, `overlay/http.ts`, and `k8s/*.tmpl`; inspect the actual official source commit, package dependencies, Dockerfile, and HTTP SDK API before using a different upstream version.
- Check `kubectl config current-context`, nodes and architecture, namespace, querier Service and ready endpoints, existing Secrets **by name/key only**, image availability on the chosen node, node taints, and existing NodePorts. Confirm the query URL and selected node with the operator.
- Check that the local source checkout path is absent before cloning. If it exists, inspect it and use a fresh path; never delete or reset existing work.
- Validate a database token's intended scope without printing it. If only a broad admin/ingest token is available, flag that and ask whether a narrower token should be created.

## Execution sequence

1. Build the pinned upstream commit with `overlay/http.ts` copied to `src/http.ts`. The default stdio entry point is unchanged; the HTTP container command is `node build/http.js`.
2. Create the `influxdb3-mcp-db-auth` Secret with key `TOKEN` and the independent `influxdb3-mcp-http-auth` Secret with key `token` in the workload namespace. Use `--from-file` and read back only key names/equality; don't generate a replacement token on retries.
3. Import the built image into containerd's `k8s.io` namespace on the selected node with a temporary privileged node-debug pod. Always delete the debug pod after verifying the import. Pin the example workload to that node; do not assume Docker on the workstation is the Kubernetes node runtime.
4. Render templates with the exact allowed `envsubst` variable list in README, inspect rendered image, selectors, namespace, port, Secret refs, and query URL, then perform server-side dry runs. Apply the ClusterIP base first; apply the NodePort only if permanent LAN exposure was requested.
5. Verify StatefulSet readiness, the headless governing Service, client Service selector matching the pod, and ready EndpointSlices. An existing Deployment is not removed by applying the StatefulSet; only after the new pod and protocol are verified, delete the old Deployment with explicit authorization. Probe the actual MCP protocol (401 without auth, 200 initialization, `tools/list` includes `query_sql` but not `delete_database`, then a permitted database call), through the intended external NodePort if enabled. Test a second node IP when claiming all-node access. Check result status, not merely HTTP 200 on a tool response.
6. Read back exactly what was changed. Report the URL, how to retrieve the protected token locally without disclosing it, validation results, and the limitations (plaintext LAN transport, one-node image pin, no HA). Do not claim production readiness.

## Repository hygiene

- Public files must contain no actual token, license JWT, credential path content, kubeconfig, cluster inventory, user-specific home path, or private image registry credentials. Keep generated YAML and local secrets out of Git; scan staged files before publishing.
- Edit only this guide repo unless changes to other repositories or the live cluster were explicitly requested. Never commit or push the upstream source checkout as a side effect.
- Prefer `$HOME/...` in docs/commands. For Python path construction use `Path.home()`.
