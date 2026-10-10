const fs = require('node:fs/promises');
const path = require('node:path');
const { preview } = require('./project-file.js');

// The projects worked on lately, for the welcome screen: a list of their
// files, the latest first, kept between launches in the program's own data
// folder (recent.json) - not in the projects, which do not know of it.
//
// A file gets to the top of the list when it is opened and when it is saved
// (see project-io.js). One that is no longer where it was stays in the list,
// marked: the disk it is on may only be unplugged. The user takes it out.
//
//   recent:list   -> [{ path, name, opened, missing, preview }], the latest
//                 first; `preview` is the picture inside the project file
//                 (PNG bytes), or null if it has none
//   recent:remove { path }   takes a file out of the list

const LIMIT = 24; // the files remembered

// The same file whatever way its path was written.
const keyOf = (file) => (process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file));

// `file` is where the list is kept. Returns { add(path) }, for whoever opens
// and saves projects.
function registerRecent({ ipcMain, file }) {
  let entries = null; // [{ path, opened }], read when first asked for
  let writing = Promise.resolve();

  const read = async () => {
    if (entries) return entries;
    try {
      const saved = JSON.parse(await fs.readFile(file, 'utf8'));
      entries = saved.filter((entry) => typeof entry?.path === 'string' && Number.isFinite(entry.opened));
    } catch {
      entries = []; // no list yet, or an unreadable one
    }
    return entries;
  };

  // One writing after another, so that two in a row cannot leave half a file.
  const write = () => {
    const text = JSON.stringify(entries, null, 1);
    writing = writing.then(async () => {
      await fs.mkdir(path.dirname(file), { recursive: true });
      const temporary = `${file}.${process.pid}.tmp`;
      await fs.writeFile(temporary, text);
      await fs.rename(temporary, file);
    }).catch(() => {}); // the list is a convenience: a failure to keep it stops nothing
    return writing;
  };

  const without = (list, project) => list.filter((entry) => keyOf(entry.path) !== keyOf(project));

  const add = async (project) => {
    const list = await read();
    entries = [{ path: path.resolve(project), opened: Date.now() }, ...without(list, project)].slice(0, LIMIT);
    await write();
  };

  ipcMain.handle('recent:list', async () => {
    const list = await read();
    return Promise.all(list.map(async (entry) => {
      const shown = { path: entry.path, name: path.basename(entry.path).replace(/\.[^.]*$/, ''), opened: entry.opened, missing: false, preview: null };
      try {
        shown.preview = preview(await fs.readFile(entry.path));
      } catch (error) {
        // Not there; a file that is there and cannot be read is shown without a picture.
        shown.missing = error.code === 'ENOENT';
      }
      return shown;
    }));
  });

  ipcMain.handle('recent:remove', async (_event, { path: project }) => {
    entries = without(await read(), project);
    await write();
  });

  return { add };
}

module.exports = { registerRecent };
