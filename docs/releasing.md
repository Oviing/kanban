# Releasing

1. Merge your changes to `main` and wait for CI to pass.
2. GitHub → Actions → **release** → **Run workflow** (branch `main`) → choose the bump:
   - `patch`: bug fixes (0.1.0 → 0.1.1)
   - `minor`: new features, backwards compatible (0.1.1 → 0.2.0)
   - `major`: breaking changes (0.2.0 → 1.0.0)
3. The workflow computes the next version, publishes `@joelkischkel/agent-kanban` to npm, then commits `Release vX.Y.Z` to `main`, tags it, pushes the Docker image to GHCR and creates the GitHub Release.
4. If your npm account uses staged publishing, approve the new version under **Staged Packages** on npmjs.com.

Notes:
- The version in `packages/cli/package.json` is changed only by the workflow; don't bump it by hand.
- The repo needs the `NPM_TOKEN` secret (a token that bypasses two-factor authentication), and `main` must allow pushes from `github-actions[bot]` (or exempt it from branch protection), since the workflow commits the version.
- If the publish fails, nothing is committed or tagged, so just run the workflow again.
