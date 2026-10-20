// The atlases as files on disk, for painting them in another program - the
// window.vertex.atlas of host.js.
//
// A project file holds its atlases inside it, and a painting program cannot
// open a picture that is inside an archive. So while a project is open its
// atlases are also kept as working files, in a folder of the project's own
// in the system's temporary directory - not beside the project, which stays
// one file:
//
//   <tmp>/verTEX/<a name made of the project's path>/
//     house.atlas.png              the atlas main's picture, which the painter opens and saves
//     house.atlas.guide.png        the outlines of its faces, to lay over it there
//     house.<id>.atlas.png         another atlas' (a project with several: see
//     house.<id>.atlas.guide.png   Editor.atlases), by its id
//     project.json                 { project } - whose folder this is
//
// The editor writes them when the unwrap moves something (see atlas-link.js);
// the folder is watched, and what the painter saves is handed to the editor.
//
// The folders are not left to pile up. One is removed when its project moves
// to another file, and all of them are gone through when the program starts
// (see sweep()): a folder is removed if its project is no longer there, if
// its picture is no newer than the project file - then the project has all
// of it - or if nothing in it has been touched for a long time. A picture
// that is newer than its project is kept: it is work that was painted and
// not saved into the project yet, and the project takes it when it is opened.

const MAIN = 'main'; // the atlas whose files have no id in their names (a project's one, as it always was)
const PICTURE = '.atlas.png';
const GUIDE = '.atlas.guide.png';
const STALE_AFTER = 30 * 24 * 60 * 60 * 1000; // ms a folder may lie untouched
// An atlas' working files in a project's folder (`base`: the project's name).
const pictureName = (base, atlas) => (atlas === MAIN ? `${base}${PICTURE}` : `${base}.${atlas}${PICTURE}`);
const guideName = (base, atlas) => (atlas === MAIN ? `${base}${GUIDE}` : `${base}.${atlas}${GUIDE}`);
// The atlas a picture's file is of; null for none of them (a guide, or another file).
function atlasOfFile(base, file) {
  if (!file.endsWith(PICTURE) || file.endsWith(GUIDE)) return null;
  if (file === `${base}${PICTURE}`) return MAIN;
  const middle = file.slice(0, -PICTURE.length);
  return middle.startsWith(`${base}.`) ? middle.slice(base.length + 1) || null : null;
}
const sound = (atlas) => typeof atlas === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(atlas);

// Paths, Windows' way.
const full = (path) => path.replaceAll('/', '\\');
const join = (folder, name) => `${folder.replace(/[\\/]+$/, '')}\\${name}`;
const baseName = (path) => path.split(/[\\/]/).pop();
const withoutExtension = (name) => name.replace(/\.[^.]*$/, '');
const same = (a, b) => a.length === b.length && a.every((byte, i) => byte === b[i]);

// `invoke` and `listen` are Tauri's; `word` the interface's words.
export function atlasFiles({ invoke, listen, word }) {
  const read = async (path) => new Uint8Array(await invoke('file_read', { path }));
  const write = (path, bytes) => invoke('file_write', bytes, { headers: { path: encodeURIComponent(path) } });
  const modified = (path) => invoke('file_modified', { path });
  const remove = (path) => invoke('path_remove', { path }).catch(() => {});
  const message = (error) => (typeof error === 'string' ? error : error?.message ?? String(error));
  const home = invoke('temp_folder').then((folder) => join(folder, 'verTEX'));

  // The working folder of a project file: named by the file's path, so that the
  // same project finds its folder again and two projects never share one.
  async function folderOf(project) {
    const path = full(project);
    const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(path.toLowerCase()));
    const key = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('').slice(0, 12);
    const name = withoutExtension(baseName(path)).replace(/[^\p{L}\p{N}_-]+/gu, '_').slice(0, 40) || 'project';
    return join(await home, `${name}-${key}`);
  }

  // Goes through the working folders and removes those that are of no use any
  // more (see the note above). `keep` are folders in use, left alone.
  async function sweep(keep = new Set()) {
    const folder = await home;
    const now = Date.now();
    await Promise.all((await invoke('folder_list', { path: folder })).map(async (name) => {
      const own = join(folder, name);
      if (keep.has(own)) return;
      let project = null;
      try {
        project = JSON.parse(new TextDecoder().decode(await read(join(own, 'project.json')))).project;
      } catch {
        // A folder that does not say whose it is: nobody's.
      }
      const saved = project ? await modified(project) : null;
      const files = await invoke('folder_list', { path: own });
      const times = (await Promise.all(files.map((file) => modified(join(own, file))))).filter((time) => time !== null);
      // (the newest of the atlases' pictures)
      const pictures = (await Promise.all(files.filter((file) => file.endsWith(PICTURE) && !file.endsWith(GUIDE)).map((file) => modified(join(own, file))))).filter((time) => time !== null);
      const picture = pictures.length ? Math.max(...pictures) : null;
      const useless =
        saved === null || // the project is gone
        picture === null || picture <= saved + 1000 || // nothing painted since the project was saved: it has it all
        now - Math.max(0, ...times) > STALE_AFTER;
      if (useless) await remove(own);
    }));
  }
  const swept = sweep().catch(() => {});

  let link = null; // { folder, base, written (atlas id -> bytes), timers }
  const listeners = [];

  // Stops watching. With `clear`, the folder goes too: its project has moved
  // to another file, and has taken what was in it along.
  function drop(clear = false) {
    if (!link) return;
    invoke('folder_watch', { path: null });
    for (const timer of link.timers.values()) clearTimeout(timer);
    if (clear) remove(link.folder);
    link = null;
  }

  // The painter saved an atlas' picture: tell the editor, unless it is our own writing coming back.
  async function changed(own, atlas) {
    let bytes;
    try {
      bytes = await read(join(own.folder, pictureName(own.base, atlas)));
    } catch {
      return; // between a delete and a write: the next event has it
    }
    const written = own.written.get(atlas);
    if (link !== own || bytes.length === 0 || (written && same(bytes, written))) return;
    own.written.set(atlas, bytes);
    for (const callback of listeners) callback(bytes, atlas);
  }

  // The folder is watched, not the files: programs save by writing a new
  // file and moving it over the old one, which a watch on the file loses.
  // Which atlas' picture it was, its name says.
  listen('folder:changed', ({ payload: file }) => {
    const own = link;
    const atlas = own ? atlasOfFile(own.base, file) : null;
    if (!atlas) return;
    clearTimeout(own.timers.get(atlas));
    own.timers.set(atlas, setTimeout(() => changed(own, atlas), 150));
  });

  // { folder, pictures: [{ atlas, path, bytes?, newer }] }: `bytes` is an
  // atlas' picture if there is one, `newer` whether it was saved after the
  // project was.
  async function linkTo(project, atlases = [MAIN]) {
    await swept;
    const folder = await folderOf(project);
    // Another project than before: the old one's folder has had its day.
    drop(Boolean(link) && link.folder !== folder);
    const base = withoutExtension(baseName(full(project)));
    const own = { folder, base, written: new Map(), timers: new Map() };
    link = own;
    await invoke('folder_make', { path: folder });
    await write(join(folder, 'project.json'), new TextEncoder().encode(JSON.stringify({ project: full(project) })));

    // Working files from when they were kept beside the project move in here,
    // if they are the newer ones, and are cleared away from there. (The one
    // atlas there was then: main.)
    const beside = full(project).replace(/\.[^.\\]*$/, '');
    const legacy = { picture: `${beside}${PICTURE}`, guide: `${beside}${GUIDE}` };
    const mainPicture = join(folder, pictureName(base, MAIN));
    const [there, here] = await Promise.all([modified(legacy.picture), modified(mainPicture)]);
    if (there !== null) {
      if (here === null || there > here) await invoke('file_copy', { from: legacy.picture, to: mainPicture }).catch(() => {});
      await Promise.all([remove(legacy.picture), remove(legacy.guide)]);
    }

    const saved = await modified(full(project));
    const pictures = await Promise.all(atlases.filter(sound).map(async (atlas) => {
      const file = join(folder, pictureName(base, atlas));
      let bytes = null;
      let newer = false;
      try {
        bytes = await read(file);
        own.written.set(atlas, bytes);
        // (A copy is as new as the moment it was made: the picture brought in
        // from beside the project is judged by the time it had there.)
        const painted = atlas === MAIN && there !== null && (here === null || there > here) ? there : await modified(file);
        newer = saved !== null && painted > saved + 1000;
      } catch {
        // No picture yet.
      }
      return { atlas, path: file, bytes, newer };
    }));
    if (link === own) await invoke('folder_watch', { path: folder }).catch(() => {}); // no watching here: the picture is still written
    return { folder, pictures };
  }

  return {
    link: linkTo,
    // { atlas, png?, guide? }: writes what is given, of that atlas.
    write: async ({ atlas = MAIN, png, guide }) => {
      if (!link) return { error: 'the project has no file yet' };
      if (!sound(atlas)) return { error: 'no such atlas' };
      const picture = join(link.folder, pictureName(link.base, atlas));
      try {
        if (png) {
          const bytes = new Uint8Array(png);
          link.written.set(atlas, bytes);
          await write(picture, bytes); // (the folder is made if a cleaner has been by)
        }
        if (guide) await write(join(link.folder, guideName(link.base, atlas)), new Uint8Array(guide));
        return { path: picture };
      } catch (error) {
        return { error: message(error) };
      }
    },
    // The project's unsaved changes were thrown away - what was painted and not
    // saved among them: the pictures must not come back as "newer" next time.
    discard: async () => {
      if (!link) return;
      const { folder } = link;
      link.written.clear();
      const files = await invoke('folder_list', { path: folder });
      await Promise.all(files.filter((file) => file.endsWith(PICTURE) || file.endsWith(GUIDE)).map((file) => remove(join(folder, file))));
    },
    // Opens an atlas' picture: in the given program (the path of its
    // executable - the user's external editor), or in the one the system has
    // for such files.
    open: async (program, atlas = MAIN) => {
      if (!link) return { error: 'the project has no file yet' };
      if (!sound(atlas)) return { error: 'no such atlas' };
      const picture = join(link.folder, pictureName(link.base, atlas));
      try {
        await (program ? invoke('open_with', { program, path: picture }) : invoke('open_path', { path: picture }));
        return { path: picture };
      } catch (error) {
        return { error: message(error) };
      }
    },
    // Asks for a program's file -> its path, or null.
    pickProgram: () => invoke('ask_open', {
      ask: {
        title: word('dialog.program.title'),
        filters: [{ name: word('dialog.program.filter'), extensions: ['exe'] }, { name: word('dialog.all-files'), extensions: ['*'] }],
      },
    }),
    // Shows an atlas' picture in the file manager.
    reveal: async (atlas = MAIN) => {
      if (link && sound(atlas)) await invoke('reveal', { path: join(link.folder, pictureName(link.base, atlas)) }).catch(() => {});
    },
    // Stops watching (a new project, one not saved yet).
    unlink: () => drop(),
    // A project is gone (thrown away): so is its working folder.
    forget: async (project) => remove(await folderOf(project)),
    // (bytes, atlas id): the painter saved that atlas' picture.
    onChanged: (callback) => listeners.push(callback),
  };
}
