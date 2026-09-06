/**
 * Build what the desktop suite drives: the web app into `dist/`, the shell into
 * `dist-electron/`. The browser suite gets the same guarantee from its `webServer`
 * command; launching Electron has no equivalent hook, so it happens here.
 *
 * Skipped when `FLOORPLAN_APP` names an already-packaged executable — building then
 * would rebuild the sources the installer was made from, which is the one thing that
 * could make the run disagree with the artefact it is supposed to be testing.
 */

import { execSync } from 'node:child_process';

export default function globalSetup(): void {
  if (process.env['FLOORPLAN_APP']) return;
  execSync('pnpm run desktop:build', { stdio: 'inherit' });
}
