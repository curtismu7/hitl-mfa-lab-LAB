#!/usr/bin/env bash
# Deploy the MOCK-ONLY build to the SE cluster. The first deploy of each app is OWNER-APPROVED: this script refuses to
# run unless OWNER_APPROVED=1 is set by the owner. It never builds or pushes an image; it applies manifests for an image
# that already exists in the registry.
#
#   OWNER_APPROVED=1 NAMESPACE=<ns> IMAGE=<registry>/<repo>/hitl-mfa-lab:<sha> SE_HOST=<host> INGRESS_CLASS=<class> CLUSTER_ISSUER=<issuer> k8s/deploy.sh [--dry-run]
#
# SE_HOST is a name two labels below the cluster's wildcard (for example agent-preferences.<cluster-host>): the cluster's external-dns creates
# its DNS record from the ingress, and cert-manager issues its certificate through CLUSTER_ISSUER. Both can take a few minutes.
#
# After the deploy (not done by this script): verify by CONTENT, not 200 (GET /api/info must say {mode:mock, simulated:true, hosted:true}),
# check the registry manifest and the pod's imageID match IMAGE, and hand over the full https:// URL after browser proof.
set -euo pipefail
cd "$(dirname "$0")"

[ "${OWNER_APPROVED:-}" = "1" ] || { echo "refusing: the first SE deploy of each app is owner-approved (set OWNER_APPROVED=1)" >&2; exit 2; }
for v in NAMESPACE IMAGE SE_HOST INGRESS_CLASS CLUSTER_ISSUER; do [ -n "${!v:-}" ] || { echo "refusing: set $v (see the usage line)" >&2; exit 2; }; done
case "$IMAGE" in
  *:latest|*:HEAD|*:|*[!A-Za-z0-9._:/@-]*|"") echo "refusing: IMAGE must carry an explicit immutable tag or digest, not latest/HEAD" >&2; exit 2;;
  *:*) ;;
  *) echo "refusing: IMAGE has no tag" >&2; exit 2;;
esac
case "$NAMESPACE" in *[!a-z0-9-]*|"") echo "refusing: NAMESPACE must be a plain name" >&2; exit 2;; esac
case "$SE_HOST" in *[!a-z0-9.-]*|"") echo "refusing: SE_HOST must be a plain host name" >&2; exit 2;; esac
for v in INGRESS_CLASS CLUSTER_ISSUER; do case "${!v}" in *[!a-z0-9.-]*|"") echo "refusing: $v must be a plain name" >&2; exit 2;; esac; done

# Placeholders are the literal tokens __IMAGE__, __SE_HOST__, __INGRESS_CLASS__, __CLUSTER_ISSUER__. Any token left over fails.
render() {
  local out
  out=$(sed -e "s|__IMAGE__|$IMAGE|g" -e "s|__SE_HOST__|$SE_HOST|g" -e "s|__INGRESS_CLASS__|$INGRESS_CLASS|g" -e "s|__CLUSTER_ISSUER__|$CLUSTER_ISSUER|g" "$1")
  if grep -qE '__[A-Z_]+__' <<<"$out"; then echo "refusing: unreplaced __TOKEN__ in $1" >&2; exit 2; fi
  printf '%s\n---\n' "$out"
}
if [ "${1:-}" = "--dry-run" ]; then render deployment.yaml; render service.yaml; render certificate.yaml; render ingress.yaml; exit 0; fi
for f in deployment.yaml service.yaml certificate.yaml ingress.yaml; do render "$f" | kubectl apply -n "$NAMESPACE" -f -; done
kubectl -n "$NAMESPACE" rollout status deployment/hitl-mfa-lab --timeout=120s
# The certificate is issued by cert-manager (DNS-01), which can take a few minutes; the pod is already serving.
kubectl -n "$NAMESPACE" wait certificate/hitl-mfa-lab --for=condition=Ready --timeout=600s || echo "certificate not Ready yet: check 'kubectl -n $NAMESPACE describe certificate hitl-mfa-lab'" >&2
