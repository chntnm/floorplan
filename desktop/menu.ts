/**
 * The application menu, which is mostly an exercise in not stealing keys.
 *
 * The renderer already owns this app's keyboard. Ctrl+S and Ctrl+Shift+S are the save
 * and save-as in `TopBar.tsx`; Ctrl+Z and Ctrl+Y are document undo in `PlanStage.tsx`;
 * bare letters are tools. A menu accelerator is handled *before* the page sees the
 * event, so a File → Save item bound to Ctrl+S would either fire twice or replace the
 * renderer's handler with a different code path that has to be kept in step with it.
 *
 * So the menu deliberately contains nothing the app already binds. New, Open, Save,
 * Save as and Import are buttons in the app's own top bar, which is where a user of
 * this app looks for them; duplicating them here would buy a familiar menu layout at
 * the cost of two implementations of saving.
 *
 * What is left is what only the shell can do — reload, full screen, developer tools —
 * plus the clipboard roles, which macOS text fields do not get without a menu item.
 * The bar is hidden until Alt (`autoHideMenuBar`), because the app has a top bar of
 * its own and two rows of chrome above the plan is one too many.
 */

import { app, BrowserWindow, Menu, dialog, type MenuItemConstructorOptions } from 'electron';

export function buildMenu(version: string): Menu {
  const isMac = process.platform === 'darwin';

  const about = () => {
    const win = BrowserWindow.getFocusedWindow();
    const options = {
      type: 'info' as const,
      title: 'About floorplan',
      message: `floorplan ${version}`,
      detail:
        'Spatial planning for real rooms. Trace a plan, place what you own, ' +
        'walk through it in 3D.\n\n' +
        `Electron ${process.versions['electron']} · Chromium ${process.versions['chrome']}`,
      buttons: ['OK'],
    };
    if (win) void dialog.showMessageBox(win, options);
    else void dialog.showMessageBox(options);
  };

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? ([
          {
            label: app.name,
            submenu: [
              { label: 'About floorplan', click: about },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' },
            ],
          },
        ] satisfies MenuItemConstructorOptions[])
      : []),

    {
      label: '&Edit',
      submenu: [
        // No undo/redo: Ctrl+Z and Ctrl+Y are the document's, not the text field's.
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },

    {
      label: '&View',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },

    {
      label: '&Help',
      submenu: isMac ? [{ role: 'minimize' }, { role: 'zoom' }] : [{ label: 'About floorplan', click: about }],
    },
  ];

  return Menu.buildFromTemplate(template);
}
