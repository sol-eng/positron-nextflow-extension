# Contributing

Contributions are welcome. Fork [this repository](https://github.com/nextflow-io/vscode-language-nextflow) and open a pull request to propose changes. Consider submitting an [issue](https://github.com/nextflow-io/vscode-language-nextflow/issues/new) to discuss any proposed changes with the maintainers before submitting a pull request.

## Development

Clone this repository:

```bash
git clone https://github.com/nextflow-io/vscode-language-nextflow
cd vscode-language-nextflow
```

Install dependencies:

```bash
npm install
```

Finally, in VS Code or Cursor, press `F5` to build the extension and launch a new workspace with the extension loaded (alternatively you can run `Debug: Start Debugging` from the command palette).

Alternatively, you can build and run the extension from the command line:

```bash
make test
```

## Project structure

The extension is two programs that run in different places and talk to each other over `postMessage`.

```
src/
  extension.ts        entry point
  auth/               Seqera Cloud login
  languageServer/     language server client
  nextflowLog/        .nextflow.log highlighting and filtering
  telemetry/
  webview/            extension side of the webviews
  shared/             the only code both sides import
  ui/                 the webviews themselves, a React app
```

Everything outside `src/ui` runs in the extension host, which is a Node process with the `vscode` module available. `src/ui` runs in a sandboxed browser iframe where it is not.

`src/shared` holds what both sides need, currently the Seqera URL constants and the Platform API types. It must stay free of both `vscode` and Node, since it is compiled for two runtimes. The UI reaches it through the `@shared/*` alias, declared in `tsconfig.ui.json`, which esbuild reads as well when it bundles the UI.

A webview cannot import `vscode` no matter how the project is arranged. To reach the extension host, including for logging, post a message and handle it in `WebviewProvider`.

## Working on the Positron fork

This repository is a fork of [nextflow-io/vscode-language-nextflow](https://github.com/nextflow-io/vscode-language-nextflow), tracked as the `upstream` remote. To keep upstream merges easy:

- Put Positron-specific code in `src/positron/`, which is the only place that touches the Positron API.
- Keep changes to upstream files to small hooks marked with a `// Positron:` comment.
- Detect Positron with `isPositron()` from `src/positron`. It uses the `acquirePositronApi` global that Positron injects, so `@posit-dev/positron` is only used for types. Gate Positron-only contributions in `package.json` with the `isPositron` context key.

The run manager lives in `src/positron/runs/`. Its pure parts (the event reducer, trace and history parsing, and command-line building in `model.ts`, `events.ts`, `trace.ts` and `launchArgs.ts`) are kept free of `vscode`, and are tested against output captured from real Nextflow runs in `src/positron/test/fixtures/`. Live status comes from the events file written by the `nf-workbench` plugin (`workbench.eventsFile`, in [posit-sdk-nextflow](https://github.com/michaelmayer2/posit-sdk-nextflow)). Changes to the event format need a matching change there.

Every push to `main` publishes a pre-release with the VSIX, numbered `<version>-dev.<run>` (see `.github/workflows/prerelease.yml`); the last five are kept. To release, set the version in `package.json`, add a `CHANGELOG.md` entry noting the upstream base, tag `v<version>` and create a GitHub release with the VSIX. Then bump `package.json` to the next patch version, so pre-releases sort after the release.

Run the unit tests for `src/positron` with `npm run test:positron`, and build and install into Positron with `make install`. `make test` launches Positron with the extension loaded; set `EDITOR_CLI` to use another editor.

Upstream's tags are fetched as `upstream/v*`, because its version numbers overlap the fork's own `v*` tags:

```bash
git config remote.upstream.tagOpt --no-tags
git config --add remote.upstream.fetch '+refs/tags/*:refs/tags/upstream/*'
```

To bring in an upstream release, merge it on a branch rather than rebasing. Keep the fork's `CHANGELOG.md`, and record the new upstream base in the next release's entry:

```bash
git fetch upstream
git checkout -b merge/upstream-v1.9.0
git merge upstream/v1.9.0
```

## Publishing

1. Update the extension version number in `package.json`.
2. Update the changelog in `CHANGELOG.md`.
3. Make a release commit e.g. "Release 1.0.0".
4. Create a release in GitHub e.g. "v1.0.0".
5. Run the "Publish Extension" action to publish the extension to the Visual Studio Marketplace and Open VSX Registry.

## Additional resources

- https://manual.macromates.com/en/language_grammars
- https://code.visualstudio.com/docs/extensions/publish-extension
- https://code.visualstudio.com/docs/extensions/yocode
- https://code.visualstudio.com/docs/extensionAPI/extension-manifest
