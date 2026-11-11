# B1 controlled CI acceptance

This directory is an isolated acceptance fixture for the Cindy PR dashboard. It is not plugin product code.

The acceptance sequence deliberately starts with a failing check: view this PR in Cindy, let the AI diagnose its CI evidence, then fix the fixture and verify the next run passes. Keep both runs as the record; do not merge the deliberately failing state.

Run locally with Node.js 22, without installing dependencies:

```sh
node --test --test-reporter=spec acceptance/fixture/ci-state.test.mjs
```

The workflow only runs on pull requests affecting this fixture or its workflow. It uses read-only repository permission, no repository secrets, and no deployment step. A failing assertion emits a GitHub Actions annotation so its evidence is available through the check-runs API without downloading a log archive.
