// A newer version of the program, offered on the splash as the program
// starts: taken, it is downloaded and installed there, the splash telling how
// far it has got, and the program starts anew (see src-tauri/src/update.rs);
// put off, the program starts as it is and offers it again next time.
import { ask, tell } from './ask-dialog.js';
import { t } from './i18n.js';

// Resolves when the program is to go on starting - not at all when it is
// being updated, as it closes for that.
export async function offerUpdate(splash) {
  const updates = window.vertex?.updates;
  const found = await updates?.check().catch(() => null);
  if (!found) return;
  const take = await ask({
    title: t('update.title', { version: found.version }),
    detail: found.notes || t('update.detail'),
    buttons: [
      { label: t('update.later'), value: false },
      { label: t('update.install'), value: true, primary: true },
    ],
    cancel: false,
  });
  if (!take) return;
  const status = document.createElement('span');
  status.className = 'splash-status';
  status.textContent = t('update.progress', { percent: 0 });
  splash.append(status);
  try {
    await updates.install((got, total) => {
      status.textContent = total ? t('update.progress', { percent: Math.floor((got / total) * 100) }) : t('update.installing');
    });
  } catch (error) {
    status.remove();
    await tell(t('update.failed'), String(error));
  }
}
