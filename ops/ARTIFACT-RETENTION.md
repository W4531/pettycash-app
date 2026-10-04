# Artifact Registry retention (2026-10-04)

The Production `shakehands-484108/asia-northeast1/pettycash-repo` repository has three `pettycash-app` versions. The current `v1` tag is protected. Two older, untagged January images have no current Cloud Run service, revision, or job-template reference in either the Production or Staging project; neither is a child of an OCI index.

[`artifact-registry-cleanup-policy.json`](artifact-registry-cleanup-policy.json) was applied with **dry-run enabled** on 2026-10-04. It selects untagged versions older than 30 days and keeps the `v1` release and the newest version. The two older versions are expected candidates, but no deletion is authorized until the actual Artifact Registry `DATA_WRITE` dry-run audit log names are checked against a fresh Cloud Run/Job/Registry reference map. The policy must remain in dry-run until that verification succeeds. No artifact has been deleted.
